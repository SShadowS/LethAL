/**
 * R635: the wire of the v3 `serve` + `entries` transport (plan
 * `docs/superpowers/plans/2026-10-22-r635-v3-serve-entries.md`, r3, §2, §3, §6): the echo test
 * codeunit, the encoder (one GROUP per mutant: its echo entry first, then one entry per covering
 * codeunit, every entry with an explicit `active-mutant.txt` override), and the decoder, which
 * attributes rows only through the table of entries LethAL sent, never through the answer's own
 * grouping. The request shape and every edge used here are measured (`/coord/handoff/R-635/measure.md`).
 */
import { SELECTOR_RESOURCE_NAME } from "@lethal/schemata";
import type { V3Row } from "./al-runner-v3-backend";

/** §2: the echo, a test codeunit in `active/` at the manifest's `selectorIds.controlId`. */
export const SELECTOR_ECHO_FILENAME = "LethALSelectorEcho.Codeunit.al";

/** §2: errors `LETHAL-ECHO:<the override text>:<what the selector's cached read says>`. */
export function emitSelectorEcho(objectId: number): string {
  return `codeunit ${objectId} "LethAL Selector Echo"
{
    Subtype = Test;

    [Test]
    procedure Echo()
    var
        Selector: Codeunit "Mutation Selector";
        t: Text;
        r: Text;
    begin
        t := NavApp.GetResourceAsText('${SELECTOR_RESOURCE_NAME}', TextEncoding::UTF8);
        if Selector.Active(t) then
            r := 'true'
        else
            r := 'false';
        Error('LETHAL-ECHO:%1:%2', t, r);
    end;
}
`;
}

/** The only echo message that vouches for override `m` (exact match, §6). */
export const echoMessage = (m: string): string => `LETHAL-ECHO:${m}:true`;

/** 256 is LethAL's cap per request, not upstream's. */
export const ENTRIES_CHUNK_CAP = 256;

/** One mutant (or `NONE`) and the covering codeunits it needs, in one request. */
export interface EntryGroup {
  /** The override text: `NONE` or a mutant id. */
  readonly mutantId: string;
  /**
   * R778 (A1): the group's own key, when one request holds several groups with one override (a kill
   * pair's `NONE` groups). It is the override itself, or the override, `#` and a suffix. Ids,
   * results and re-sends go by key; the override text never changes. Default: `mutantId`.
   */
  readonly key?: string;
  readonly codeunits: readonly number[];
}

/** One sent entry, as the decoder's table holds it. */
export interface SentEntry {
  readonly id: string;
  /** The override text (`NONE` or a mutant id). */
  readonly mutantId: string;
  /** R778: the group's key (`mutantId` unless the group set one). */
  readonly key: string;
  /** The codeunit the entry selects; for the echo, the echo codeunit. */
  readonly codeunit: number;
  readonly echo: boolean;
  readonly resources: Readonly<Record<string, string>>;
  readonly test: string;
}

/** §3: a request that breaks the encoder's rules. A caller-contract violation: the session stops. */
export class AlRunnerV3EntriesEncodeError extends Error {
  constructor(why: string) {
    super(`al-runner-v3 entries encoder: ${why} (R635 plan §3)`);
    this.name = "AlRunnerV3EntriesEncodeError";
  }
}

/**
 * §3, §6: a refusal by name (`al-runner-v3-entries-no-baseline-rows`, `-batch-refused`,
 * `-warmup-disagrees`). In the prefetch it stops the session; on a live request the causing ref is
 * a transport failure and every later run is too.
 */
export class AlRunnerV3EntriesRefusedError extends Error {
  constructor(
    readonly code: string,
    why: string,
  ) {
    super(`${code}: ${why} (R635 plan §3, §6)`);
    this.name = "AlRunnerV3EntriesRefusedError";
  }
}

/** §3: the entries of `groups`, in order, each group's echo first; checked before it is returned. */
export function encodeGroups(groups: readonly EntryGroup[], echoCodeunit: number): SentEntry[] {
  const out: SentEntry[] = [];
  for (const g of groups) {
    const resources = { [SELECTOR_RESOURCE_NAME]: g.mutantId };
    const key = g.key ?? g.mutantId;
    out.push({
      id: `${key}|echo`,
      mutantId: g.mutantId,
      key,
      codeunit: echoCodeunit,
      echo: true,
      resources,
      test: `Codeunit${echoCodeunit}.`,
    });
    for (const cu of g.codeunits) {
      out.push({
        id: `${key}|${cu}`,
        mutantId: g.mutantId,
        key,
        codeunit: cu,
        echo: false,
        resources,
        test: `Codeunit${cu}.`,
      });
    }
  }
  assertEntriesWellFormed(out, `Codeunit${echoCodeunit}.`);
  return out;
}

/**
 * §3: throws unless every entry has a string `test` (#5702 ignores an array), a list
 * `excludeTests` if any, a unique id (#5703), an id prefix (the group key, R778) that is its override
 * text or that text, `#` and a suffix, one override per key, and every key exactly one echo entry
 * (`test` = `echoTest`), first in its one contiguous group (review r1 item 2).
 */
export function assertEntriesWellFormed(entries: readonly object[], echoTest: string): void {
  const ids = new Set<string>();
  const closed = new Set<string>();
  const overrideOf = new Map<string, string>();
  let current: string | undefined;
  for (const x of entries) {
    const e = x as Readonly<Record<string, unknown>>;
    const id = String(e.id);
    if (typeof e.test !== "string") {
      throw new AlRunnerV3EntriesEncodeError(`entry ${id}'s test is not a string (#5702)`);
    }
    if (e.excludeTests !== undefined && !Array.isArray(e.excludeTests)) {
      throw new AlRunnerV3EntriesEncodeError(`entry ${id}'s excludeTests is not a list`);
    }
    if (ids.has(id)) throw new AlRunnerV3EntriesEncodeError(`duplicate entry id ${id} (#5703)`);
    ids.add(id);
    const bar = id.indexOf("|");
    const prefix = bar < 0 ? id : id.slice(0, bar);
    const override = (e.resources as Record<string, unknown> | undefined)?.[SELECTOR_RESOURCE_NAME];
    // R778 (A1): the id prefix is the group's KEY: the override itself, or the override, `#` and a
    // suffix; every entry of a key has the one override.
    if (
      typeof override !== "string" ||
      !(override === prefix || prefix.startsWith(`${override}#`)) ||
      (overrideOf.get(prefix) ?? override) !== override
    ) {
      throw new AlRunnerV3EntriesEncodeError(
        `entry ${id}'s override text ${JSON.stringify(override)} does not belong to its group key ${prefix}`,
      );
    }
    overrideOf.set(prefix, override);
    const isEcho = e.test === echoTest;
    if (prefix !== current) {
      if (current !== undefined) closed.add(current);
      if (closed.has(prefix)) {
        throw new AlRunnerV3EntriesEncodeError(
          `${prefix} has entries in two groups of one request`,
        );
      }
      if (!isEcho) {
        throw new AlRunnerV3EntriesEncodeError(
          `${prefix}'s group does not start with its echo entry`,
        );
      }
      current = prefix;
    } else if (isEcho) {
      throw new AlRunnerV3EntriesEncodeError(`${prefix} has more than one echo entry`);
    }
  }
}

/** §3: chunks of at most `cap` entries, cut only BETWEEN groups; a larger group goes alone. */
export function chunkGroups(
  groups: readonly EntryGroup[],
  cap: number = ENTRIES_CHUNK_CAP,
): EntryGroup[][] {
  const out: EntryGroup[][] = [];
  let chunk: EntryGroup[] = [];
  let size = 0;
  for (const g of groups) {
    const n = g.codeunits.length + 1;
    if (chunk.length > 0 && size + n > cap) {
      out.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(g);
    size += n;
  }
  if (chunk.length > 0) out.push(chunk);
  return out;
}

/** What `AlRunnerServer.runEntries` hands back: the raw lines, grouped by type only. */
export interface EntriesAnswer {
  readonly tests: readonly Readonly<Record<string, unknown>>[];
  readonly entrySummaries: readonly Readonly<Record<string, unknown>>[];
  readonly summary: Readonly<Record<string, unknown>>;
}

const COUNT_KEYS = ["passed", "failed", "errors", "notRun", "total"] as const;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;

function countsOf(rows: readonly V3Row[]): Counts {
  return {
    passed: rows.filter((r) => r.status === "pass" && !r.notRun).length,
    failed: rows.filter((r) => r.status === "fail" && !r.notRun).length,
    errors: rows.filter((r) => r.status === "error").length,
    notRun: rows.filter((r) => r.notRun).length,
    total: rows.length,
  };
}

/** One serve test line as a `V3Row` (`Codeunit<n>.<method>`), or why it is not one. */
export function serveRow(line: Readonly<Record<string, unknown>>): V3Row | string {
  const { name, status, message, notRun, durationMs } = line;
  const m = typeof name === "string" ? /^Codeunit(\d+)\.([^.]+)$/.exec(name) : null;
  if (
    m === null ||
    (status !== "pass" && status !== "fail" && status !== "error") ||
    (message !== undefined && typeof message !== "string") ||
    (notRun !== undefined && typeof notRun !== "boolean") ||
    (durationMs !== undefined && typeof durationMs !== "number")
  ) {
    return `a test line without v3's row shape: ${JSON.stringify(line).slice(0, 200)}`;
  }
  return {
    codeunit: Number(m[1]),
    method: m[2] ?? "",
    name: String(name),
    status,
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    ...(typeof message === "string" ? { message } : {}),
    notRun: notRun === true,
  };
}

/**
 * §3, §6: the rows of each SENT entry, or why the whole request is invalid. The answer's grouping
 * is never trusted: `entrySummary` ids equal the sent ids in sent order; every row names a sent
 * id; an entry's rows are all of its sent codeunit (the echo: exactly one row); no `(entry, name)`
 * twice; each `entrySummary` equals its rows; the `summary` equals the sums.
 */
export function decodeEntriesAnswer(
  sent: readonly SentEntry[],
  answer: EntriesAnswer,
): { readonly rows: ReadonlyMap<string, readonly V3Row[]> } | { readonly why: string } {
  const ids = answer.entrySummaries.map((s) => String(s.entry));
  if (ids.join("\n") !== sent.map((e) => e.id).join("\n")) {
    return { why: `entrySummary ids [${ids.join(", ")}] are not the sent ids in sent order` };
  }
  const byId = new Map(sent.map((e) => [e.id, e]));
  const rows = new Map<string, V3Row[]>(sent.map((e) => [e.id, []]));
  for (const t of answer.tests) {
    const id = String(t.entry);
    const e = byId.get(id);
    if (e === undefined) return { why: `a row names entry ${id}, which was not sent` };
    const r = serveRow(t);
    if (typeof r === "string") return { why: r };
    if (r.codeunit !== e.codeunit) {
      return { why: `entry ${id} holds ${r.name}, not a row of codeunit ${e.codeunit}` };
    }
    const mine = rows.get(id) ?? [];
    if (mine.some((x) => x.name === r.name)) return { why: `entry ${id} names ${r.name} twice` };
    mine.push(r);
    rows.set(id, mine);
  }
  const sums: Counts = { passed: 0, failed: 0, errors: 0, notRun: 0, total: 0 };
  for (const e of sent) {
    // The echo's "exactly one row" is `echoMismatch`'s: a wrong echo errors its group.
    const c = countsOf(rows.get(e.id) ?? []);
    const s = answer.entrySummaries.find((x) => String(x.entry) === e.id) ?? {};
    for (const k of COUNT_KEYS) {
      if (s[k] !== c[k]) {
        return {
          why: `entry ${e.id}'s entrySummary ${k} ${String(s[k])} is not its ${c[k]} row(s)`,
        };
      }
      sums[k] += c[k];
    }
  }
  for (const k of COUNT_KEYS) {
    if (answer.summary[k] !== sums[k]) {
      return {
        why: `the summary's ${k} ${String(answer.summary[k])} is not the entries' ${sums[k]}`,
      };
    }
  }
  return { rows };
}

/** §6: why the echo rows do not vouch for override `m`, or `undefined` when they do (exact match). */
export function echoMismatch(rows: readonly V3Row[], m: string): string | undefined {
  const r = rows[0];
  if (rows.length !== 1 || r === undefined) return `the echo has ${rows.length} row(s)`;
  if (r.notRun) return `the echo did not run (notRun: ${r.message ?? ""})`;
  if (r.status === "pass") return "the echo passed, so it never reported what it read";
  if (r.message !== echoMessage(m)) {
    return `the echo said ${JSON.stringify(r.message ?? "")}, not ${JSON.stringify(echoMessage(m))}`;
  }
  return undefined;
}

/**
 * §6 (review r1 item 7, N3): every row of every entry is `notRun` with ONE reason that is not a
 * timeout and not one of `isSafe`: the whole request was refused (an install-time resource read
 * refuses every override entry). Returns the reason.
 */
export function batchRefusalReason(
  rows: ReadonlyMap<string, readonly V3Row[]>,
  isSafe: (message: string) => boolean,
  isTimeout: (message: string) => boolean,
): string | undefined {
  const all = [...rows.values()];
  if (all.some((rs) => rs.length === 0)) return undefined;
  const flat = all.flat();
  const first = flat[0]?.message;
  if (first === undefined || isSafe(first) || isTimeout(first)) return undefined;
  return flat.every((r) => r.notRun && r.message === first) ? first : undefined;
}
