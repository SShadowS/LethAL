// The row verdict both al-runner backends score through (`verdictFromRunnerTest`, R534, R517),
// now in `al-runner-rows.ts` (R654 S1, plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md).
// `parseReportedStopMs (R517)`, T1b, T4 and the T5 near-miss moved here unchanged from
// `al-runner-backend.test.ts`. The "direct" describe is NEW (r1 M2): the R534 rules that the v2
// file checks only through `AlRunnerBackend`, asserted on the function itself.
import { describe, expect, test } from "bun:test";
import {
  AL_RUNNER_UNCLASSIFIED_ERROR,
  V3_TYPE_PREFIX,
  isV3RefusalText,
  parseReportedStopMs,
  verdictFromRunnerTest,
} from "../src/al-runner-rows";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
/** What al-runner v2 both filters on and reports back for `ref` — see `qualifiedTestName`. */
const QUALIFIED = "Codeunit79100.PostingUpdatesTotal";
const ONRUN_MESSAGE_20 =
  "The test codeunit's OnRun trigger exceeded the 20s timeout, so none of its test methods ran.";

describe("parseReportedStopMs (R517)", () => {
  test("reads N from al-runner's whole timeout message, and nothing else", () => {
    expect(parseReportedStopMs("Test exceeded 180s timeout.")).toBe(180_000);
    expect(parseReportedStopMs("Test exceeded 1s timeout.")).toBe(1_000);
    expect(parseReportedStopMs("Test exceeded 0s timeout.")).toBeUndefined();
    expect(parseReportedStopMs("TIMEOUT after 5s")).toBeUndefined();
    expect(parseReportedStopMs("Test exceeded 180s timeout. (and more)")).toBeUndefined();
    expect(parseReportedStopMs("Error: Test exceeded 180s timeout.")).toBeUndefined();
    expect(parseReportedStopMs("Assert failed")).toBeUndefined();
    expect(parseReportedStopMs(undefined)).toBeUndefined();
  });

  test("a timeout verdict carries it; a timeout in another wording, a fail and an error do not", () => {
    const r = { codeunitId: 1, codeunitName: "T", method: "M" };
    const v = (status: string, message: string) =>
      verdictFromRunnerTest(r, "Codeunit1.M", { status, message }, 10, undefined);
    expect([
      v("error", "Test exceeded 60s timeout.").outcome,
      v("error", "Test exceeded 60s timeout.").reportedStopMs,
    ]).toEqual(["timeout", 60_000]);
    expect([
      v("error", "TIMEOUT after 5s").outcome,
      v("error", "TIMEOUT after 5s").reportedStopMs,
    ]).toEqual(["timeout", undefined]);
    expect(v("fail", "Test exceeded 60s timeout.").reportedStopMs).toBeUndefined();
    expect(v("error", "SMTP is out of scope").reportedStopMs).toBeUndefined();
  });
});

describe("verdictFromRunnerTest: an answered row never aborts (R534)", () => {
  test("T1b: a body timeout row, in either measured wording, records timeoutIn body", () => {
    for (const message of ["Test exceeded 40s timeout.", "TIMEOUT after 30s"]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, { status: "error", message }, 10, undefined);
      expect([v.outcome, v.timeoutIn], message).toEqual(["timeout", "body"]);
    }
  });

  test("T4: near-miss timeout wordings stay runner-test-error, never a timeout", () => {
    for (const message of [
      "The test codeunit's OnRun trigger exceeded the timeout, so none of its test methods ran.",
      `${ONRUN_MESSAGE_20} Later`,
      `TIMEOUT ${ONRUN_MESSAGE_20}`,
      "An OnAfterTestMethodRun subscriber (codeunit 50100) failed: boom (test result before it: Test exceeded 5s timeout.)",
      "Test exceeded 5s timeout. extra",
      // Final review I-A: a user OnBeforeTestMethodRun subscriber raising the timeout wording.
      // Only `^` refuses these (`$` matches them), so a lost `^` alone would be a false kill.
      "An OnBeforeTestMethodRun subscriber (codeunit 50100) failed, so the test did not run: NavNCLDialogException: Test exceeded 5s timeout.",
      `An OnBeforeTestMethodRun subscriber (codeunit 50100) failed, so the test did not run: NavNCLDialogException: ${ONRUN_MESSAGE_20}`,
    ]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, { status: "error", message }, 10, undefined);
      expect([v.outcome, v.runnerRow, v.reportedStopMs, v.timeoutIn], message).toEqual([
        "error",
        "runner-test-error",
        undefined,
        undefined,
      ]);
    }
  });

  test("T5 near-miss: a user message that merely CONTAINS the phrase stays a fail (a kill)", () => {
    // The second is final review M-b: a type-shaped word later in the message. Only `^` refuses it.
    for (const message of [
      "NavNCLDialogException: expected 3, got out-of-scope: x",
      "NavNCLDialogException: wrapped Foo: out-of-scope: x",
    ]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, { status: "fail", message }, 10, undefined);
      expect([v.outcome, v.runnerRow], message).toEqual(["fail", undefined]);
    }
  });
});

describe("verdictFromRunnerTest, direct (R654 S1 r1 M2): the R534 rules on the function itself", () => {
  // measure.md A rows OosInBody and AfterOosOnRun verbatim (as in al-runner-backend.test.ts T5).
  const OOS_TASK =
    "RunnerOutOfScopeException: out-of-scope: TaskScheduler.TaskExists — task-scheduler — the runner has no scheduler and no scheduled-task store, so it cannot say whether a task exists; BC's real body queries the scheduled-task table over a SQL connection that does not exist here. Nothing is ever scheduled: CanCreateTask() is false and CreateTask() is refused by BC's own guard, so no task can have been created either — see docs/scope.md#jobs";
  const refusals: ReadonlyArray<{ status: string; message: string }> = [
    { status: "fail", message: OOS_TASK },
    {
      status: "fail",
      message:
        "InvalidOperationException: out-of-scope: NavReport.Run — reports — see docs/scope.md",
    },
    {
      status: "error",
      message: `The test codeunit's OnRun trigger failed, so none of its test methods ran (as in BC): ${OOS_TASK}`,
    },
  ];

  test("a refusal in a fail or an error row is runner-refused, completed-accepted, never a kill", () => {
    for (const row of refusals) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, row, 10, undefined);
      expect([v.outcome, v.operation, v.runnerRow], row.message).toEqual([
        "error",
        "completed-accepted",
        "runner-refused",
      ]);
      expect(v.failureMessage?.startsWith(row.message), row.message).toBe(true);
    }
  });

  test("a plain fail row is a fail (a kill), with its message", () => {
    const v = verdictFromRunnerTest(
      ref,
      QUALIFIED,
      { status: "fail", message: "Assert.AreEqual failed. Expected:<3> Actual:<4>" },
      10,
      undefined,
    );
    expect([v.outcome, v.runnerRow, v.failureMessage]).toEqual([
      "fail",
      undefined,
      "Assert.AreEqual failed. Expected:<3> Actual:<4>",
    ]);
  });

  test("a skipped row and an unexecuted UI handler are runner-test-error, completed-accepted", () => {
    for (const row of [
      { status: "skipped" },
      { status: "error", message: "The following UI handlers were not executed: ConfirmYes" },
    ]) {
      const v = verdictFromRunnerTest(ref, QUALIFIED, row, 10, undefined);
      const label = row.message ?? row.status;
      expect([v.outcome, v.operation, v.runnerRow], label).toEqual([
        "error",
        "completed-accepted",
        "runner-test-error",
      ]);
      expect(v.failureMessage, label).toContain(AL_RUNNER_UNCLASSIFIED_ERROR);
    }
  });

  test("an exit-3-proven row in no known timeout wording is runner-test-error flagged timeoutWordingUnknown, never a kill", () => {
    const v = verdictFromRunnerTest(
      ref,
      QUALIFIED,
      { status: "error", message: "Watchdog stop.", abortProven: true },
      10,
      undefined,
    );
    expect([v.outcome, v.runnerRow, v.timeoutWordingUnknown]).toEqual([
      "error",
      "runner-test-error",
      true,
    ]);
    const w = verdictFromRunnerTest(
      ref,
      QUALIFIED,
      { status: "error", message: "Watchdog stop." },
      10,
      undefined,
    );
    expect(w.timeoutWordingUnknown).toBeUndefined();
  });

  test("a pass carries the runner's own duration as measuredDurationMs", () => {
    const v = verdictFromRunnerTest(
      ref,
      QUALIFIED,
      { status: "pass", durationMs: 7 },
      10,
      undefined,
    );
    expect([v.outcome, v.durationMs, v.measuredDurationMs]).toEqual(["pass", 10, 7]);
  });
});

// R672 (plan docs/superpowers/plans/2026-10-23-r672-v3-refusal-prefix.md §2): K1(a) and leg C's
// `message-has-no-type-prefix` read ONE prefix. The fact's regex is `^V3_TYPE_PREFIX`.
describe("R672: V3_TYPE_PREFIX ties K1(a) to the leg-C fact", () => {
  const fact = new RegExp(`^${V3_TYPE_PREFIX}`);
  const REFUSAL = "NotRun: out-of-scope: x";
  const PREFIXES = [
    "X: ",
    "X.Y: ",
    "NavNCLDialogException: ",
    "Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException: ",
    "Error: ",
    "_a1: ",
    "Runtime error: ",
    "a::b: ",
    "x ",
    "Assert.AreEqual failed. Expected: ",
    "1X: ",
    ": ",
  ];
  test("for each prefix, the fact matches p+boom exactly when K1 matches p+refusal", () => {
    for (const p of PREFIXES) {
      expect([p, fact.test(`${p}boom`)]).toEqual([p, isV3RefusalText(`${p}${REFUSAL}`)]);
    }
    // The six one-word prefixes are seen by both; the other six by neither.
    expect(PREFIXES.filter((p) => isV3RefusalText(`${p}${REFUSAL}`))).toEqual(PREFIXES.slice(0, 6));
  });
  test("the empty prefix: K1 true (today's unprefixed refusal), the fact false", () => {
    expect([isV3RefusalText(REFUSAL), fact.test("boom")]).toEqual([true, false]);
  });
  test("A: B: (a chain): the fact true (it refuses the build), K1 false", () => {
    expect([fact.test("A: B: boom"), isV3RefusalText(`A: B: ${REFUSAL}`)]).toEqual([true, false]);
  });
  test("undefined is no refusal", () => {
    expect(isV3RefusalText(undefined)).toBe(false);
  });
});
