/**
 * R706 classifier and outcome table (pre-commitment §6). Pure: no server, no files.
 * The two constants are compared byte for byte (no trim, no case folding, no prefix match).
 */

/** `BC_HTTP_INTERNAL_TEXT` in packages/runner/src/al-runner-v3-contract.ts (r639, bc1). */
export const BLOCKED =
  "The request was blocked by the runtime to prevent accidental use of production services.";
/** v3's one-shot row for the unhandled localhost call; also the text upstream quotes in #5700. */
export const SECURITY =
  "There was an error while executing the HTTP request, the connecting endpoint violates security requirements. Make sure you are connecting to a valid endpoint.";

export type Cls = "BLOCKED" | "SECURITY" | "OTHER" | "NONE";
export type PathCls = Cls | "SPLIT";

export interface Reading {
  readonly cls: Cls;
  /** The first line, raw. Null for NONE. */
  readonly raw: string | null;
  /** 92911 only: the `[%2]` of its MEASURED line. */
  readonly code: string | null;
  /** Code and text disagree (92911 only). The class still follows the text. */
  readonly codeMismatch: boolean;
}

export const NONE: Reading = { cls: "NONE", raw: null, code: null, codeMismatch: false };

/** M-b from r639: `raw`/`rawCode` of the one `MEASURED [raw] [code]` line. */
export function parseMeasured(text: string): { raw: string; rawCode: string } {
  const s = text.indexOf("MEASURED [");
  if (s < 0 || text.indexOf("MEASURED [", s + 1) >= 0)
    throw new Error("parseMeasured: need exactly one `MEASURED [`");
  const e = text.lastIndexOf("] [");
  if (e < s) throw new Error("parseMeasured: no `] [` after `MEASURED [`");
  const z = text.indexOf("]", e + 3);
  if (z < 0) throw new Error("parseMeasured: no closing `]`");
  if (z + 1 < text.length && text[z + 1] !== "\n")
    throw new Error("parseMeasured: the closing `]` is not followed by a newline or the end");
  return { raw: text.slice(s + 10, e), rawCode: text.slice(e + 3, z) };
}

const firstLine = (s: string): string => s.split(/\r?\n/)[0] ?? "";

/** Row 2 (hub unmeasured) with a web-service reading that is not BLOCKED contradicts r639. */
export const contradictsR639 = (row: number, runs: readonly RunClasses[]): boolean =>
  row === 2 && runs.some((r) => r.ws.cls !== "BLOCKED");

function clsOf(line: string): Cls {
  return line === BLOCKED ? "BLOCKED" : line === SECURITY ? "SECURITY" : "OTHER";
}

/**
 * The reading of one test's failure text. 92911 prints `MEASURED [raw] [code]`: the reading is the
 * first line of `raw`. 92910: the first line of the failure message. No text at all is NONE.
 */
export function readingOf(codeunit: 92910 | 92911, failureText: string | undefined): Reading {
  if (failureText === undefined || failureText === "") return NONE;
  if (codeunit === 92910) {
    const raw = firstLine(failureText);
    return { cls: clsOf(raw), raw, code: null, codeMismatch: false };
  }
  let parsed: { raw: string; rawCode: string };
  try {
    parsed = parseMeasured(failureText);
  } catch {
    // Not a MEASURED line: keep what the text says, as a third text.
    return { cls: "OTHER", raw: firstLine(failureText), code: null, codeMismatch: false };
  }
  const raw = firstLine(parsed.raw);
  const cls = clsOf(raw);
  // Text BLOCKED with a code other than HttpRequest, or the reverse (code HttpRequest, text not BLOCKED).
  const codeMismatch = (cls === "BLOCKED") !== (parsed.rawCode === "HttpRequest");
  return { cls, raw, code: parsed.rawCode, codeMismatch };
}

/** What a path class compares on: the class, plus the raw text for a third text. */
export const classKey = (c: PathCls, raw: string | null): string =>
  c === "OTHER" ? `OTHER:${raw ?? ""}` : c;

export interface PathClass {
  readonly cls: PathCls;
  readonly raw: string | null;
}

/** The class of one path in one run: the two readings if they agree, else SPLIT. */
export function pathClass(a: Reading, b: Reading): PathClass {
  const agree = a.cls === b.cls && (a.cls !== "OTHER" || a.raw === b.raw);
  return agree ? { cls: a.cls, raw: a.raw } : { cls: "SPLIT", raw: null };
}

export interface RunClasses {
  readonly ws: PathClass;
  readonly hub: PathClass;
}

export interface Outcome {
  /** 1-7 as in the table; 0 is the gap row (a web-service NONE, which the table does not name). */
  readonly row: number;
  readonly outcome: string;
}

/** §6, top to bottom; row 7 is checked before rows 3-6 (the table's own note). */
export function outcomeOf(runs: readonly RunClasses[]): Outcome {
  const paths = ["ws", "hub"] as const;
  const split = runs.some((r) => r.ws.cls === "SPLIT" || r.hub.cls === "SPLIT");
  const [first, ...rest] = runs;
  const disagree =
    first !== undefined &&
    rest.some((r) =>
      paths.some((p) => classKey(r[p].cls, r[p].raw) !== classKey(first[p].cls, first[p].raw)),
    );
  if (split || disagree) return { row: 1, outcome: "Unsettled" };
  if (runs.some((r) => r.hub.cls === "NONE")) return { row: 2, outcome: "Hub unmeasured" };
  if (runs.some((r) => r.ws.cls === "OTHER" || r.hub.cls === "OTHER"))
    return { row: 7, outcome: "Record the text" };
  // After row 7, so the gap row never changes a committed row.
  if (runs.some((r) => r.ws.cls === "NONE"))
    return { row: 0, outcome: "Web-service unmeasured (no table row)" };
  // Runs agree and no class is SPLIT/NONE/OTHER, so the first run speaks for all.
  const ws = first?.ws.cls;
  const hub = first?.hub.cls;
  if (hub === "SECURITY" && ws === "BLOCKED") return { row: 3, outcome: "Outcome A" };
  if (hub === "BLOCKED" && ws === "BLOCKED") return { row: 4, outcome: "v3 is wrong" };
  if (hub === "SECURITY" && ws === "SECURITY")
    return { row: 5, outcome: "No conclusion on #5700 (bc1 changed since r639)" };
  if (hub === "BLOCKED" && ws === "SECURITY") return { row: 6, outcome: "Unexplained" };
  throw new Error(`outcomeOf: no row for ${JSON.stringify(runs)}`);
}
