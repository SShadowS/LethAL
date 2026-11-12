/**
 * R896: al-runner v3's `isolation: "auto"`. The baseline decides, per test codeunit, between `test`
 * (the codeunit whole, rollback per test, globals kept) and `method` (each test alone under codeunit
 * isolation, a fresh codeunit per test, as BC's one-method runner). The rules are pure and live here;
 * the orchestrator owns the loop (`scoreBatch`) and the backend the mechanics (`chooseIsolation`).
 */
import type { TestMethodRef, TestVerdict } from "./backend";
import { describeTestPermissionsRefusal } from "./permission-canary";

/** One candidate codeunit's choice, as the report and the `baseline-isolation-chosen` event carry it. */
export interface IsolationChoiceRow {
  readonly codeunitId: number;
  readonly name: string;
  readonly chosen: "test" | "method";
  /** How many of the codeunit's tests the baseline ran in this batch (both passes ran the same). */
  readonly tests: number;
  readonly testPassed: number;
  /** Absent when `method` was never measured for this codeunit (R956: 0 green under `test`). */
  readonly methodPassed?: number;
  readonly reason: string;
  /**
   * Each test that passed under `test` and not under `method`: what `method` OBSERVED (outcome and
   * message), never a cause (review: "BC runs it alone" is an inference).
   */
  readonly lostUnderMethod: readonly {
    readonly test: string;
    readonly outcome: string;
    readonly message?: string;
  }[];
}

type Row = { readonly ref: TestMethodRef; readonly verdict: TestVerdict };

/** R921 (review r1): v3's cascade rows, which name ANOTHER test's refusal or state, not their own. */
const V3_CASCADE_ROW = /^NotRun: (?:out-of-scope: )?an earlier test of this codeunit /;

/**
 * Whether a baseline verdict is red for a reason `method` could change: a `fail`, or a row v3 itself
 * answered with an error or a refusal (`runner-test-error`, `runner-refused`, the cascade "an earlier
 * test of this codeunit was refused" included). Not: transport noise (a transport failure, a deadline,
 * a missing row: no `runnerRow`), a budget stop (`timeout`, which `method` only makes slower), a test
 * LethAL never sent (the TestPage `skip`), or a permission refusal (review 5, plan step 2).
 */
export function isIsolationCandidateVerdict(v: TestVerdict): boolean {
  const red =
    v.outcome === "fail" || v.runnerRow === "runner-test-error" || v.runnerRow === "runner-refused";
  return red && describeTestPermissionsRefusal(v.failureMessage) === undefined;
}

/** The codeunits with at least one candidate verdict, in first-seen order. All-green: never. */
export function isolationCandidates(baseline: readonly Row[]): number[] {
  const out = new Set<number>();
  for (const b of baseline) if (isIsolationCandidateVerdict(b.verdict)) out.add(b.ref.codeunitId);
  return [...out];
}

/**
 * R956: a codeunit with no green test under `test` (every test red or refused) is kept on `test`
 * and never re-baselined one test per process: a tie at 0 decides nothing, and on DO's app the
 * per-test passes cost hours.
 */
export function isZeroGreen(testRows: readonly Row[]): boolean {
  // A cascade row ("an earlier test of this codeunit ...") is a later test v3 never ran because an
  // earlier one was refused: `method` may well pass it (R921), so such a codeunit is measured.
  return testRows.every(
    (r) => r.verdict.outcome !== "pass" && !V3_CASCADE_ROW.test(r.verdict.failureMessage ?? ""),
  );
}

/** The choice row for a zero-green codeunit (R956): kept on `test`, nothing was measured under `method`. */
export function zeroGreenIsolationRow(testRows: readonly Row[]): IsolationChoiceRow {
  const first = testRows[0];
  if (first === undefined) throw new Error("zeroGreenIsolationRow: no test rows (R956)");
  return {
    codeunitId: first.ref.codeunitId,
    name: first.ref.codeunitName,
    chosen: "test",
    tests: testRows.length,
    testPassed: 0,
    reason: "0 green under test: a tie at 0 decides nothing, kept on test (R956)",
    lostUnderMethod: [],
  };
}

/**
 * The choice for one codeunit, from its `test` rows and its `method` rows (same tests, same order).
 * `method` is kept iff it passes STRICTLY more of the codeunit's tests; a tie keeps `test` (no gain,
 * more cost).
 */
export function chooseCodeunitIsolation(
  testRows: readonly Row[],
  methodRows: readonly Row[],
): IsolationChoiceRow {
  const first = testRows[0];
  if (first === undefined) throw new Error("chooseCodeunitIsolation: no test rows (R896)");
  const passed = (rows: readonly Row[]) => rows.filter((r) => r.verdict.outcome === "pass").length;
  const testPassed = passed(testRows);
  const methodPassed = passed(methodRows);
  const byKey = new Map(methodRows.map((r) => [`${r.ref.codeunitId}.${r.ref.method}`, r.verdict]));
  const lostUnderMethod = testRows.flatMap((r) => {
    if (r.verdict.outcome !== "pass") return [];
    const m = byKey.get(`${r.ref.codeunitId}.${r.ref.method}`);
    if (m === undefined || m.outcome === "pass") return [];
    return [
      {
        test: `${r.ref.codeunitName}.${r.ref.method}`,
        outcome: m.outcome,
        ...(m.failureMessage !== undefined ? { message: m.failureMessage } : {}),
      },
    ];
  });
  // R916, R921: a tie goes to `method` when v3 refused a test of the codeunit BY NAME and `method`
  // loses none. Under `test` every mutant call runs the codeunit whole, so the refused test runs in
  // each: it spoils a later test that reads its state (R921), and on serve its row makes the warm-up
  // refuse the session (R916). Under `method` it is never sent: it covers nothing. A cascade row
  // ("an earlier test of this codeunit ...") is not a refusal by name of its own test (review r1).
  const refused = testRows.find(
    (r) =>
      r.verdict.runnerRow === "runner-refused" &&
      !V3_CASCADE_ROW.test(r.verdict.failureMessage ?? ""),
  );
  const tieToMethod =
    methodPassed === testPassed && refused !== undefined && lostUnderMethod.length === 0;
  const chosen: "test" | "method" = methodPassed > testPassed || tieToMethod ? "method" : "test";
  const counts = `method passed ${methodPassed} of ${testRows.length}, test passed ${testPassed}`;
  return {
    codeunitId: first.ref.codeunitId,
    name: first.ref.codeunitName,
    chosen,
    tests: testRows.length,
    testPassed,
    methodPassed,
    reason:
      chosen === "method"
        ? tieToMethod && refused !== undefined
          ? `${counts}: a tie, and v3 refused ${refused.ref.codeunitName}.${refused.ref.method} by name, which under test runs in every mutant call of the codeunit, so it moves to method (R921)`
          : counts
        : `${counts}: not strictly more, so it stays on test`,
    lostUnderMethod,
  };
}

/**
 * R896 (review 3): a `--resume` of an `auto` run re-runs its baseline and so re-chooses. Its carried
 * verdicts were measured under the resumed run's choice, so a different choice would mix two modes in
 * one report: refused by name. Compared: the codeunits on `method` (everything else is on `test`).
 */
export class IsolationChoiceChangedError extends Error {
  constructor(resumedRunId: number, was: readonly number[], now: readonly number[]) {
    super(
      `isolation-choice-changed: --resume of run ${resumedRunId}: its "alRunnerV3.isolation": "auto" baseline put codeunit(s) [${was.join(", ")}] on "method", and this session's baseline puts [${now.join(", ")}] there. Its carried verdicts were measured under the other choice, so nothing is carried. Drop the resume flag to run from scratch, or set "alRunnerV3.isolation" to "test" or "method" (R896).`,
    );
    this.name = "IsolationChoiceChangedError";
  }
}

/** The codeunits a stored or chosen map puts on `method`, sorted. */
export function methodCodeunits(choice: Readonly<Record<string, "test" | "method">>): number[] {
  return Object.entries(choice)
    .filter(([, m]) => m === "method")
    .map(([cu]) => Number(cu))
    .sort((a, b) => a - b);
}
