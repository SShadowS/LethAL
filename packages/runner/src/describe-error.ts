/**
 * R65 — turning a thrown value into a diagnosis that is never empty.
 *
 * A Bun spawn failure arrives as an `Error` whose `message` is the EMPTY STRING: everything you
 * need is on the errno fields (`code`, `syscall`, `path`) instead. Catches that stringified
 * `err.message` alone therefore reported NOTHING. That is how R64's wrong-platform binary
 * presented — a bare `Error` with no text, several layers above the real cause — and it cost a
 * long external debugging session to trace back to a `bin/win32/` path on a Linux host.
 *
 * R64 removed one CAUSE. The class stays open without this: a missing exec bit on
 * `bin/linux/alc` (the AL extension's own activation is what chmods those, so an
 * unpacked-but-never-activated VSIX has them non-executable), a pinned `bcdev.alcPath` typo, and
 * a partial install all still land in the same catch.
 *
 * Two contracts, both load-bearing, both pinned by tests:
 *
 * 1. **Never returns an empty or whitespace-only string.** Reporting an empty cause is the
 *    empty-vs-empty "match" that is this project's signature bug — the caller cannot tell "no
 *    diagnosis available" from "no problem", so it must never be handed one.
 * 2. **Never throws.** This runs INSIDE catch blocks. A describer that throws replaces the real
 *    error with its own, which is R65's failure mode made worse: `ArtifactCompiler.compile` would
 *    never construct its `ArtifactPrepareError`, and a raw `TypeError` would escape into
 *    classification code that reads error types to decide whether a publish is terminal.
 *    `String(err)` alone does not satisfy this — `Object.create(null)` and any object with a
 *    throwing `toString`/`Symbol.toPrimitive` make it raise.
 */

/**
 * Errno-ish fields Bun and Node put on spawn/fs failures, in the order worth reading.
 *
 * DELIBERATELY NARROW, and widening it is a credential decision, not a diagnostic one: two of the
 * three call sites (`artifact.ts`, `publisher.ts`) do NOT redact what they print, and they are
 * safe only because every field here is a path the surrounding message already prints verbatim.
 * Node also hangs `spawnargs`, `cmd` and `env` on spawn failures — `publisher.ts` passes
 * `BC_SERVER_PASSWORD` through `opts.env`, so adding any of those would leak a credential into an
 * unredacted error string. A test pins this list for exactly that reason.
 */
const ERRNO_FIELDS = ["code", "syscall", "path"] as const;

/** The list above, exported so a test can pin it without reaching into module internals. */
export const DESCRIBED_ERRNO_FIELDS: readonly string[] = ERRNO_FIELDS;

/** Reads a field as a non-empty string, tolerating the numeric `errno` shape. */
function readField(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * `message` is read defensively: `err instanceof Error` does NOT guarantee `message` is a string
 * (a deserialized, cross-realm, or hand-assembled error can carry anything), and `.trim()` on a
 * non-string throws — inside a catch block.
 */
function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function errnoDetail(err: unknown, message: string): string[] {
  if (typeof err !== "object" || err === null) return [];
  const detail: string[] = [];
  for (const key of ERRNO_FIELDS) {
    const value = readField(err, key);
    if (value === undefined) continue;
    // Node's own spawn messages already embed the code ("spawn alc ENOENT") — don't say it twice.
    // Only string codes dedup: a NUMERIC code stringifies to a digit that trivially appears inside
    // an unrelated message ("timed out after 1200ms" contains "2"), which would silently drop the
    // one field the caller most needs.
    const raw = (err as Record<string, unknown>)[key];
    if (key === "code" && typeof raw === "string" && message.includes(raw)) continue;
    // `code` reads on its own ("ENOENT"); the rest need saying what they are.
    detail.push(key === "code" ? value : `${key} ${value}`);
  }
  return detail;
}

/**
 * Last resort when there is neither a message nor an errno field: the thrown value itself, or a
 * statement of what was thrown. Never empty, and never a string that only *looks* like content —
 * `String({})` is `"[object Object]"`, which is non-empty and tells the reader nothing, so it is
 * treated as no diagnosis rather than allowed to satisfy contract 1 on a technicality.
 */
function lastResort(err: unknown): string {
  if (err === null) return "null was thrown (no message, code or path)";
  if (err === undefined) return "undefined was thrown (no message, code or path)";
  const asString = (typeof err === "string" ? err : String(err)).trim();
  const saysNothing =
    asString.length === 0 ||
    asString === "Error" ||
    asString === "Error:" ||
    asString === "[object Object]";
  if (!saysNothing) return asString;
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return `${name} was thrown with no message, code or path`;
}

function describe(err: unknown): string {
  const message = messageOf(err);
  const detail = errnoDetail(err, message);
  if (message.length > 0) {
    return detail.length > 0 ? `${message} (${detail.join(", ")})` : message;
  }
  if (detail.length > 0) return detail.join(", ");
  return lastResort(err);
}

/**
 * Describes a caught value for a human reading a failure report. Guaranteed non-empty, guaranteed
 * not to throw.
 *
 * Prefer this over `err instanceof Error ? err.message : String(err)` at EVERY catch that reports
 * a spawn or filesystem failure — that idiom is what R65 is about.
 */
export function describeThrown(err: unknown): string {
  try {
    return describe(err);
  } catch {
    // Reached only by a thrown value that is hostile to inspection (`Object.create(null)`, a
    // throwing `toString`). Saying so beats letting this function's own failure impersonate the
    // caller's.
    return "a value was thrown that cannot be described (inspecting it threw)";
  }
}
