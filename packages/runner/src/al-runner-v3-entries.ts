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

/**
 * R987: the memory one request's entries may take. A serve daemon holds every entry's state until
 * the request ends: Contoso Coffee Demo's tests cost about 77 MB an entry, so 256 entries took the
 * daemon to 21 GB (`/coord/handoff/R-972/`). 4 GiB keeps it inside `--peak serve` (8 GiB) with its
 * own floor and LethAL's process beside it.
 */
export const ENTRIES_REQUEST_BUDGET_BYTES = 4 * 1024 ** 3;

/** R987: at most this many entries of codeunits no request has measured yet go in one request. */
export const ENTRIES_UNMEASURED_CAP = 16;

/**
 * R987: how many of `groups`, from the front, the next request takes. `costOf(call)` is the highest
 * cost per entry measured for a call (bytes its daemon grew during a request, over the request's
 * entries), `undefined` if no request has measured it. Groups are taken whole, in order, while the
 * request stays within `ENTRIES_CHUNK_CAP` entries, `ENTRIES_UNMEASURED_CAP` entries of unmeasured
 * calls, and `ENTRIES_REQUEST_BUDGET_BYTES` of measured cost; the first group is always taken (a
 * larger one goes alone, as in `chunkGroups`). An echo entry is LethAL's own codeunit: counted as an
 * entry, never as a cost.
 */
export function groupsThatFit(
  groups: readonly EntryGroup[],
  costOf: (call: number) => number | undefined,
): number {
  let entries = 0;
  let unmeasured = 0;
  let bytes = 0;
  let n = 0;
  for (const g of groups) {
    let gUnmeasured = 0;
    let gBytes = 0;
    for (const cu of g.codeunits) {
      const c = costOf(cu);
      if (c === undefined) gUnmeasured += 1;
      else gBytes += c;
    }
    const gEntries = g.codeunits.length + 1;
    if (
      n > 0 &&
      (entries + gEntries > ENTRIES_CHUNK_CAP ||
        unmeasured + gUnmeasured > ENTRIES_UNMEASURED_CAP ||
        bytes + gBytes > ENTRIES_REQUEST_BUDGET_BYTES)
    )
      break;
    entries += gEntries;
    unmeasured += gUnmeasured;
    bytes += gBytes;
    n += 1;
  }
  return n;
}

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
  /** R857: `--isolate-tests` only: the call id of the one test this entry runs (see `callOf`). */
  readonly call?: number;
  /** R857: `--isolate-tests` only: the longer test names that `test` would also select. */
  readonly excludeTests?: readonly string[];
}

/** The key an entry's rows are kept under: its codeunit, or under `--isolate-tests` its one test. */
export const callOf = (e: SentEntry): number => e.call ?? e.codeunit;

/** R857: what one test's request selects. `test` matches by text, so it needs `excludeTests`. */
export interface IsolatedSelection {
  readonly codeunit: number;
  readonly test: string;
  readonly excludeTests?: readonly string[];
}

/**
 * R857: selects exactly `method` of `codeunit`. Measured on edge 6bb821b98: `Codeunit1.Alpha` also
 * selects `AlphaTwo`, in any case, so every other test whose name starts with it is excluded.
 * `others` are the codeunit's discovered methods; a test discovery did not see gives a second row,
 * which `suiteMissing` refuses.
 */
export function isolatedSelection(
  codeunit: number,
  method: string,
  others: readonly string[],
): IsolatedSelection {
  const name = `Codeunit${codeunit}.${method}`;
  const lower = method.toLowerCase();
  const longer = others.filter((o) => {
    const m = o.toLowerCase();
    return m !== lower && m.startsWith(lower);
  });
  return {
    codeunit,
    test: name,
    ...(longer.length > 0 ? { excludeTests: longer.map((o) => `Codeunit${codeunit}.${o}`) } : {}),
  };
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

/**
 * §3: the entries of `groups`, in order, each group's echo first; checked before it is returned.
 * R857: `isolated` turns a call id of a group into its one test; absent, or `undefined` for an id,
 * the id is a codeunit. R1004: `excluded` names the tests (`Codeunit<id>.<method>`) a plain
 * codeunit entry leaves out (`excludeTests`); absent, or empty for a codeunit, it runs them all.
 */
export function encodeGroups(
  groups: readonly EntryGroup[],
  echoCodeunit: number,
  isolated?: (call: number) => IsolatedSelection | undefined,
  excluded?: (codeunit: number) => readonly string[] | undefined,
): SentEntry[] {
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
      const one = isolated?.(cu);
      if (one !== undefined) {
        out.push({
          id: `${key}|${one.codeunit}|${Math.abs(cu)}`,
          mutantId: g.mutantId,
          key,
          codeunit: one.codeunit,
          echo: false,
          resources,
          test: one.test,
          call: cu,
          ...(one.excludeTests !== undefined ? { excludeTests: one.excludeTests } : {}),
        });
        continue;
      }
      const leftOut = excluded?.(cu);
      out.push({
        id: `${key}|${cu}`,
        mutantId: g.mutantId,
        key,
        codeunit: cu,
        echo: false,
        resources,
        test: `Codeunit${cu}.`,
        ...(leftOut !== undefined && leftOut.length > 0 ? { excludeTests: leftOut } : {}),
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
  /**
   * R895: present only on a PARTIAL answer, cut at a streamed timeout row (`stopAtTimeout`): the
   * entry id and test name of that row. Such an answer has no entry summaries and an empty summary.
   */
  readonly cut?: { readonly entry: string; readonly test: string };
}

/** R895: where a partial answer was cut: the entry id and the test of the timeout row. */
export interface SentCut {
  readonly entry: string;
  readonly test: string;
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

/**
 * One serve test line as a `V3Row` (`Codeunit<n>.<method>`), or why it is not one. R782: with
 * `fields` (a build whose pin records #5798 fixed) the codeunit and method come from the row's own
 * `codeunit` and `method`, both required, and `name` must equal `Codeunit<codeunit>.<method>`;
 * without it the name is parsed and a dotted method never matches (today's refusal).
 */
export function serveRow(line: Readonly<Record<string, unknown>>, fields = false): V3Row | string {
  const { name, status, message, stackTrace, notRun, durationMs, flagged } = line;
  let m: RegExpExecArray | string[] | null = null;
  if (fields) {
    const { codeunit, method } = line;
    if (typeof codeunit === "number" && Number.isInteger(codeunit) && typeof method === "string") {
      if (name !== `Codeunit${codeunit}.${method}`) {
        return `a test line whose codeunit/method disagree with its name (R782): ${JSON.stringify(line).slice(0, 200)}`;
      }
      m = [String(name), String(codeunit), method];
    }
  } else if (typeof name === "string") {
    m = /^Codeunit(\d+)\.([^.]+)$/.exec(name);
  }
  if (
    m === null ||
    (status !== "pass" && status !== "fail" && status !== "error") ||
    (message !== undefined && typeof message !== "string") ||
    (stackTrace !== undefined && typeof stackTrace !== "string") ||
    (notRun !== undefined && typeof notRun !== "boolean") ||
    (flagged !== undefined && typeof flagged !== "boolean") ||
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
    ...(typeof stackTrace === "string" ? { stackTrace } : {}),
    notRun: notRun === true,
    ...(flagged === true ? { flagged: true as const } : {}),
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
  fields = false,
):
  | { readonly rows: ReadonlyMap<string, readonly V3Row[]>; readonly cut?: SentCut }
  | { readonly why: string } {
  const cut = answer.cut;
  const cutIndex = cut === undefined ? -1 : sent.findIndex((e) => e.id === cut.entry);
  if (cut !== undefined) {
    // R895: a partial answer is accepted only with its marker, and the marker must name a sent
    // entry; it carries no summaries at all (they come at the end of a request).
    if (cutIndex < 0) return { why: `the cut marker names entry ${cut.entry}, which was not sent` };
    if (answer.entrySummaries.length > 0) {
      return { why: "a partial (cut) answer carries entrySummary lines" };
    }
    const last = answer.tests.at(-1);
    if (last === undefined || String(last.entry) !== cut.entry || String(last.name) !== cut.test) {
      return {
        why: `the cut marker (${cut.entry}, ${cut.test}) is not the answer's last test line`,
      };
    }
  } else {
    const ids = answer.entrySummaries.map((s) => String(s.entry));
    if (ids.join("\n") !== sent.map((e) => e.id).join("\n")) {
      return { why: `entrySummary ids [${ids.join(", ")}] are not the sent ids in sent order` };
    }
  }
  const byId = new Map(sent.map((e) => [e.id, e]));
  const rows = new Map<string, V3Row[]>(sent.map((e) => [e.id, []]));
  for (const t of answer.tests) {
    const id = String(t.entry);
    const e = byId.get(id);
    if (e === undefined) return { why: `a row names entry ${id}, which was not sent` };
    const r = serveRow(t, fields);
    if (typeof r === "string") return { why: r };
    if (r.codeunit !== e.codeunit) {
      return { why: `entry ${id} holds ${r.name}, not a row of codeunit ${e.codeunit}` };
    }
    if (cutIndex >= 0 && sent.indexOf(e) > cutIndex) {
      return { why: `entry ${id} has a row after the cut at entry ${cut?.entry ?? "?"}` };
    }
    const mine = rows.get(id) ?? [];
    if (mine.some((x) => x.name === r.name)) return { why: `entry ${id} names ${r.name} twice` };
    mine.push(r);
    rows.set(id, mine);
  }
  if (cut !== undefined) return { rows, cut: { entry: cut.entry, test: cut.test } };
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
