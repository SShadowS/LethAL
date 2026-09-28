/**
 * R270: pure helpers for the verify-at-scale measurement (`verify-scale.itest.ts`). Nothing here
 * touches a server; every function either returns an exact value or throws VerifyScaleError.
 *
 * Survivor ids are verify's own form, `<batchIndex>/<mutantCode>` (`parseVerifyRequest` accepts it,
 * and every `VerifyResult.id` echoes it). New-test names are `qualifiedTestName`'s
 * `<codeunitName>.<method>`, the form `NewTestResult.test` carries.
 */
import type { TestMethodRef } from "../src/backend";
import { discoverTests } from "../src/discovery";
import type { RunEvent } from "../src/events";
import type { SessionReport } from "../src/report";
import { VERIFY_EXIT, type VerifyOutput } from "../src/verify";
import { type NormalizedMutant, keyOf } from "./mutant-equality";

export class VerifyScaleError extends Error {}

/** Every survivor of the report's LAST batch as `<batchIndex>/<mutantCode>`, ordered by keyOf.
 *  Throws when the report has more than one batch or the count differs from `expected`. */
export function allSurvivorIds(report: SessionReport, expected: number): string[] {
  if (!Number.isInteger(expected) || expected < 1) {
    throw new VerifyScaleError(`expected=${expected}: a scale point needs at least one survivor`);
  }
  const batchIndexes = new Set(report.mutants.map((m) => m.batchIndex));
  if (report.batches !== 1 || batchIndexes.size > 1) {
    throw new VerifyScaleError(
      `the report has ${report.batches} batch(es) and mutants in ${batchIndexes.size}; expected exactly one`,
    );
  }
  const survivors = report.mutants
    .filter((m) => m.verdict === "survived")
    .map((m) => ({ key: keyOf(m), id: `${m.batchIndex}/${m.mutantCode}` }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (survivors.length !== expected) {
    throw new VerifyScaleError(`${survivors.length} survivors, expected ${expected}`);
  }
  for (let i = 1; i < survivors.length; i++) {
    if (survivors[i]?.key === survivors[i - 1]?.key) {
      throw new VerifyScaleError(`two survivors share the key ${survivors[i]?.key}`);
    }
  }
  return survivors.map((s) => s.id);
}

/** The first k of allSurvivorIds (scaling points only). Throws when k < 1 or k > the pool. */
export function firstSurvivorIds(report: SessionReport, expected: number, k: number): string[] {
  const all = allSurvivorIds(report, expected);
  if (!Number.isInteger(k) || k < 1 || k > all.length) {
    throw new VerifyScaleError(`k=${k} is outside 1..${all.length}`);
  }
  return all.slice(0, k);
}

/** One line for the log, printed BEFORE any diff: a quarantined or empty run shows here. */
export function runSummary(report: SessionReport): string {
  const c = report.counts;
  const q = report.quarantined !== undefined ? `, QUARANTINED: ${report.quarantined.reason}` : "";
  return `${report.mutants.length} mutants, killed/survived/noCoverage ${c.killed}/${c.survived}/${c.noCoverage}, errors ${c.errors}${q}`;
}

/** Per-identity VERDICT differences only (never killingTest). Throws on a key present twice on
 *  either side, on a quarantined report, and on a report with no mutants against a non-empty
 *  baseline: a session quarantined before scoring returns zero mutants, which a diff would
 *  otherwise print as every baseline key "missing" (R270 s1). Returns one line per missing, extra
 *  or differing key. */
export function verdictDiffs(
  committed: readonly NormalizedMutant[],
  report: SessionReport,
): string[] {
  if (report.quarantined !== undefined) {
    throw new VerifyScaleError(
      `the run quarantined: ${report.quarantined.reason}; its ${report.mutants.length} mutant(s) are not a measurement`,
    );
  }
  if (report.mutants.length === 0 && committed.length > 0) {
    throw new VerifyScaleError(
      `the report has no mutants against a baseline of ${committed.length}: nothing was scored`,
    );
  }
  const index = (pairs: ReadonlyArray<readonly [string, string]>, side: string) => {
    const m = new Map<string, string>();
    for (const [k, v] of pairs) {
      if (m.has(k)) throw new VerifyScaleError(`${side}: key ${k} occurs twice`);
      m.set(k, v);
    }
    return m;
  };
  const want = index(
    committed.map((c) => [c.key, c.verdict] as const),
    "baseline",
  );
  const got = index(
    report.mutants.map((m) => [keyOf(m), m.verdict] as const),
    "report",
  );
  const diffs: string[] = [];
  for (const [k, v] of want) {
    const g = got.get(k);
    if (g === undefined) diffs.push(`${k}: missing from the report`);
    else if (g !== v) diffs.push(`${k}: baseline ${v}, report ${g}`);
  }
  for (const k of got.keys()) if (!want.has(k)) diffs.push(`${k}: not in the baseline`);
  return diffs;
}

const EXPECTED_TESTPAGE_REFUSAL = "Data Tests.PageActionComputesNonZero";

/** R-236c, as tables.itest.ts pins it: no test failed at baseline, exactly that TestPage test was
 *  refused before sending, the refusal is named as a caveat, and BC's own TestPage refusal (which
 *  would mean one was SENT) is absent. Throws otherwise. */
export function assertOnlyExpectedTestPageRefusal(report: SessionReport): void {
  const u = report.unsupportedTests;
  if (u.length !== 0) {
    throw new VerifyScaleError(`baseline failures ${JSON.stringify(u)}, expected none`);
  }
  const refused = report.testPageRefused?.tests ?? [];
  if (refused.length !== 1 || refused[0] !== EXPECTED_TESTPAGE_REFUSAL) {
    throw new VerifyScaleError(
      `TestPage refusals ${JSON.stringify(refused)}, expected exactly [${JSON.stringify(EXPECTED_TESTPAGE_REFUSAL)}]`,
    );
  }
  const caveats = report.validity.caveats;
  if (!caveats.includes("tests-testpage-refused")) {
    throw new VerifyScaleError("the report does not name the refusal (no tests-testpage-refused)");
  }
  if (caveats.includes("tests-testpage-unsupported")) {
    throw new VerifyScaleError(
      "BC refused a TestPage test, so one was SENT: the pre-refusal did not engage",
    );
  }
}

/** Throws unless `got` has no duplicate and equals `want` (itself duplicate-free) as a set. */
function assertSameSet(what: string, got: readonly string[], want: readonly string[]): void {
  const g = new Set(got);
  const w = new Set(want);
  if (w.size !== want.length) throw new VerifyScaleError(`expected ${what} name one twice`);
  if (g.size !== got.length) throw new VerifyScaleError(`${what}: an entry occurs twice`);
  const missing = want.filter((x) => !g.has(x));
  const extra = got.filter((x) => !w.has(x));
  if (missing.length > 0 || extra.length > 0) {
    throw new VerifyScaleError(
      `${what}: missing ${JSON.stringify(missing)}, not requested ${JSON.stringify(extra)}`,
    );
  }
}

/** Throws unless: exit 5; the result ids, with no duplicate, EQUAL `requestedIds` as a set; every
 *  row "survived"; the new tests' names EQUAL `newTestNames` as a set, all "stable". */
export function assertVerifyMeasured(
  out: VerifyOutput,
  requestedIds: readonly string[],
  newTestNames: readonly string[],
): void {
  if (out.exitCode !== VERIFY_EXIT.notAllKilled) {
    throw new VerifyScaleError(
      `verify exited ${out.exitCode}, expected ${VERIFY_EXIT.notAllKilled}${out.refused !== undefined ? ` (refused: ${out.refused.reason})` : ""}`,
    );
  }
  if (requestedIds.length === 0 || newTestNames.length === 0) {
    throw new VerifyScaleError("nothing requested: an empty id or new-test list measures nothing");
  }
  assertSameSet(
    "result ids",
    out.results.map((r) => r.id),
    requestedIds,
  );
  const notSurvived = out.results.filter((r) => r.verdict !== "survived");
  if (notSurvived.length > 0) {
    throw new VerifyScaleError(
      `rows not survived: ${notSurvived.map((r) => `${r.id} ${r.verdict}`).join(", ")}`,
    );
  }
  assertSameSet(
    "new tests",
    out.newTests.map((t) => t.test),
    newTestNames,
  );
  const unstable = out.newTests.filter((t) => t.state !== "stable");
  if (unstable.length > 0) {
    throw new VerifyScaleError(
      `new tests not stable: ${unstable.map((t) => `${t.test} ${t.state}`).join(", ")}`,
    );
  }
}

/** max(verify) / min(denominator). Throws on an empty list or a non-positive value. */
export function worstRatio(verifyMs: readonly number[], denominatorsMs: readonly number[]): number {
  for (const [name, xs] of [
    ["verify", verifyMs],
    ["denominator", denominatorsMs],
  ] as const) {
    if (xs.length === 0) throw new VerifyScaleError(`no ${name} times`);
    if (xs.some((x) => !(x > 0))) {
      throw new VerifyScaleError(`a non-positive ${name} time: ${JSON.stringify(xs)}`);
    }
  }
  return Math.max(...verifyMs) / Math.min(...denominatorsMs);
}

export interface StampedEvent {
  readonly at: number;
  readonly event: RunEvent;
}

/** Library-level timeline of ONE runVerify call. Labelled library, never "lethal verify". */
export interface LibraryTimeline {
  readonly totalMs: number;
  readonly compileMs: number;
  readonly publishMs: number;
  readonly baselineMs: number;
  readonly mutantsMs: number;
  /** reruns + teardown + return work, not separable from events (fact 3). */
  readonly postMutantsMixedMs: number;
  /** totalMs minus everything above: pre-lease reads, lease open, status. Never negative. */
  readonly unattributedMs: number;
}

export function foldLibraryTimeline(
  out: Pick<VerifyOutput, "timings">,
  events: readonly StampedEvent[],
  returnedAt: number,
): LibraryTimeline {
  const { totalMs, compileMs, publishMs } = out.timings;
  if (compileMs === undefined || publishMs === undefined) {
    throw new VerifyScaleError("no compile or publish time: verify refused before measuring");
  }
  const one = (phase: "baseline" | "mutants") => {
    const hits = events.filter((s) => s.event.type === "phase-left" && s.event.phase === phase);
    const [hit] = hits;
    if (hit === undefined || hits.length !== 1 || hit.event.type !== "phase-left") {
      throw new VerifyScaleError(`${hits.length} phase-left ${phase} events, expected 1`);
    }
    return { at: hit.at, ms: hit.event.elapsedMs };
  };
  const baseline = one("baseline");
  const mutants = one("mutants");
  const postMutantsMixedMs = returnedAt - mutants.at;
  const unattributedMs =
    totalMs - compileMs - publishMs - baseline.ms - mutants.ms - postMutantsMixedMs;
  if (unattributedMs < 0) {
    throw new VerifyScaleError(`named parts exceed totalMs by ${-unattributedMs} ms`);
  }
  return {
    totalMs,
    compileMs,
    publishMs,
    baselineMs: baseline.ms,
    mutantsMs: mutants.ms,
    postMutantsMixedMs,
    unattributedMs,
  };
}

/** An AL test codeunit with n [Test] methods that touch no target object. Its procedures are
 *  `VerifyScaleNoOp1` .. `VerifyScaleNoOp<n>`, so verify names them `<name>.VerifyScaleNoOp<i>`. */
export function noOpTestCodeunit(id: number, name: string, n: number): string {
  if (!Number.isInteger(id) || id < 1) throw new VerifyScaleError(`bad codeunit id ${id}`);
  if (!Number.isInteger(n) || n < 1) throw new VerifyScaleError(`bad test count ${n}`);
  if (name === "" || name.length > 30 || name.includes('"')) {
    throw new VerifyScaleError(`bad codeunit name ${JSON.stringify(name)}`);
  }
  const procs = Array.from(
    { length: n },
    (_, i) =>
      `    [Test]\n    procedure VerifyScaleNoOp${i + 1}()\n    var\n        X: Integer;\n    begin\n        X := ${i + 1};\n    end;\n`,
  );
  return `codeunit ${id} "${name}"\n{\n    Subtype = Test;\n\n${procs.join("\n")}}\n`;
}

/** The restore's carrier test as the product's own discovery reports it, `file` included: the
 *  TestPage scan (R-236c) refuses a ref without one. Throws when the suite does not declare it. */
export async function discoveredTestRef(
  testDir: string,
  codeunitName: string,
  method: string,
): Promise<TestMethodRef> {
  const ref = (await discoverTests(testDir)).find(
    (r) => r.codeunitName === codeunitName && r.method === method,
  );
  if (ref === undefined) {
    throw new VerifyScaleError(`${testDir} declares no test ${codeunitName}.${method}`);
  }
  return ref;
}
