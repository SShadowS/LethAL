/**
 * One al-runner test row becomes one verdict: the rule both al-runner backends score through
 * (the .NET al-runner's one-shot and `--server` paths, and al-runner v3's rows). Moved unchanged
 * out of `al-runner-backend.ts` by R654 S1 (plan
 * `docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md`), so v3 keeps it when the
 * .NET backend is retired.
 */
import type { CoverageMap, TestMethodRef, TestVerdict } from "./backend";

/**
 * al-runner's own per-test timeout message — BOTH wordings it has used, because the wording is not
 * stable and we have watched it move.
 *
 * Measured, all on this machine: v1.0.31 said `status: "fail"` with `Test exceeded <n>s timeout`.
 * al-runner **2.0.0.0** said `status: "error"` with `TIMEOUT after <n>s`. al-runner **2.0.1.0**,
 * published the same day and installed hours later, went back to `Test exceeded <n>s timeout.` while
 * KEEPING `status: "error"`. So neither the status nor the text is a stable key on its own, and the
 * union of two literals is a stopgap rather than a design — see `AL_RUNNER_UNCLASSIFIED_ERROR` for
 * the part that does not depend on guessing the wording right.
 *
 * Exported for the R123 wire-contract probe (`al-runner-contract.ts`), which times a real test out
 * on purpose and checks the wording it gets back against THIS regex rather than against a copy of
 * it. A probe with its own spelling could pass while the decode below failed — the two would be
 * measuring different things, which is the one outcome that makes the probe worse than nothing.
 *
 * R534 (M1): ANCHORED to the whole message. `TestExecutor.RaiseAfterTestMethodRun` (43f7617) builds
 * `... (test result before it: <msg>)`, so an unanchored match could read user text that merely
 * contains "Test exceeded 5s timeout" as a timeout.
 */
export const RUNNER_TIMEOUT_MESSAGE = /^(?:Test exceeded \d+s timeout\.|TIMEOUT after \d+s\.?)$/;

/**
 * R534: al-runner's timeout of the test codeunit's OnRun trigger, measured on 2.12.0-main.43f76177
 * on both transports. The OnRun runs under the SAME `TestTimeout()` as a test body, so N is the
 * same stop. Anchored, so user text cannot match it.
 */
export const RUNNER_ONRUN_TIMEOUT_MESSAGE =
  /^The test codeunit's OnRun trigger exceeded the (\d+)s timeout, so none of its test methods ran\.$/;

/**
 * R534 (D3): al-runner REFUSED a surface it does not support. It writes `{Type.Name}: {Message}`
 * and every refusal message starts `out-of-scope: ` (`OutOfScopeMessage.Prefix`), whatever the
 * exception type (`RunnerOutOfScopeException`, and the Cecil-injected `NavNCLDialogException` and
 * `InvalidOperationException` throws); in an OnRun it arrives inside the OnRun-failure sentence.
 * Matched at the TYPE position only: a user `Error('out-of-scope: ...')` would match and lose a
 * kill (the safe direction); a message that merely contains the phrase does not match.
 */
export const RUNNER_REFUSAL =
  /^(?:The test codeunit's OnRun trigger failed, so none of its test methods ran \(as in BC\): )?[A-Za-z_][\w.]*: out-of-scope: /;

/**
 * R517: the stop al-runner says it ENFORCED, from a timeout row's whole message
 * (`Test exceeded {N}s timeout.`, built in `TestExecutor.RunOne` from the timeout it used, or
 * R534's OnRun-trigger wording, built from the same timeout), in ms.
 * Anchored and N > 0, so a wording that moved gives `undefined`, never a guessed figure: on
 * `--server` that leaves the timeout unconfirmed (a lost kill, never a false one).
 */
export function parseReportedStopMs(message: string | undefined): number | undefined {
  const m =
    message === undefined
      ? null
      : (/^Test exceeded (\d+)s timeout\.$/.exec(message) ??
        RUNNER_ONRUN_TIMEOUT_MESSAGE.exec(message));
  const n = m?.[1] === undefined ? 0 : Number(m[1]);
  return n > 0 ? n * 1000 : undefined;
}

/** R534: where a timeout row's stop fired, or `undefined` when the row is not a timeout. */
function timeoutLocation(t: {
  readonly status: string;
  readonly message?: string;
}): "body" | "onrun" | undefined {
  if (t.status === "pass" || t.status === "fail" || t.message === undefined) return undefined;
  if (RUNNER_TIMEOUT_MESSAGE.test(t.message)) return "body";
  if (RUNNER_ONRUN_TIMEOUT_MESSAGE.test(t.message)) return "onrun";
  return undefined;
}

/** A row al-runner reported as a timeout: the `timeout` case of `verdictFromRunnerTest`. Exported
 *  for the R123 contract probe's `timeout-exit-readable` fact (R518), so the rule is spelled once. */
export function isTimeoutRow(t: { readonly status: string; readonly message?: string }): boolean {
  return timeoutLocation(t) !== undefined;
}

/**
 * Prefix on the `failureMessage` of an al-runner `status: "error"` this build could not classify.
 *
 * Exported so a test can pin the behaviour by NAME rather than by quoting the sentence, and so a
 * reader meeting one in a report can grep for where it came from. The verdict such a run produces is
 * `error` — not measured — never `fail`; see `run()` for why that asymmetry is the whole design.
 */
export const AL_RUNNER_UNCLASSIFIED_ERROR =
  "al-runner reported an error this build cannot classify";

/**
 * One al-runner test row becomes one verdict, and the rule is FAIL-CLOSED on purpose.
 *
 * SHARED by the one-shot CLI path and the `--server` path deliberately. The classification below
 * is the part of this backend that has already been wrong once in a way that inverted a verdict
 * ([[R94]]), so having two copies of it -- one per transport -- is how the two would drift until a
 * timeout scored as a kill on one and not the other.
 *
 * `fail` is al-runner's word for "the test's own assertion went red", so it is a kill. `error` is
 * its word for several different things: a timeout it enforced, and (per its own
 * `RunnerOutOfScopeException`) a test that reached SMTP, outbound HTTP, printing, external file
 * I/O or web-service publishing, which v2 raises on instead of faking a return value.
 *
 * Only ONE of those is a verdict about the mutant. So an `error` positively classified as a
 * timeout scores `timeout` (the orchestrator reads that as `timeout-killed`), and an `error` that
 * CANNOT be classified scores `error` -- not measured -- rather than falling through to `fail` and
 * crediting the suite with a kill it did not earn.
 *
 * That asymmetry is what makes this survive the next release. al-runner ships several times a day:
 * within one session the timeout wording was measured as `TIMEOUT after <n>s` on 2.0.0.0 and back
 * to `Test exceeded <n>s timeout.` on 2.0.1.0, hours apart. Under the old rule -- anything not
 * `pass` and not matching the regex is `fail` -- that single string change silently turned every
 * hung mutant into a KILL. Under this one the same change costs a mutant its verdict and says so
 * out loud, which is the direction this project is willing to be wrong in. R93's argument that a
 * measured contract beats a version-branched decode matrix.
 *
 * R534: a row is an ANSWER (al-runner ran the test, reported and exited), so an `error` from here
 * is `completed-accepted` with a `runnerRow` cause: never re-sent, never a spec §11 abort. A
 * timeout records where it fired (`timeoutIn`); a refusal (`RUNNER_REFUSAL`, `fail` or `error`) is
 * `runner-refused`; any other non-verdict row, `skipped` included, is `runner-test-error`.
 */
export function verdictFromRunnerTest(
  ref: TestMethodRef,
  wanted: string,
  t: {
    readonly status: string;
    readonly message?: string;
    readonly durationMs?: number;
    /** R534 (D1b): an exit-3 TEST-TIMEOUT-ABORT line names this row (one-shot only). */
    readonly abortProven?: boolean;
  },
  durationMs: number,
  coverage: CoverageMap | undefined,
): TestVerdict {
  if (t.status === "pass") {
    // R272: the runner's OWN per-test figure, for the report and (R517) the figure a position-1
    // timeout confirm is judged on, being timed on the same clock as the in-run stop. `durationMs`
    // stays wall clock for the timeout budget; under `--server` it is the whole suite's.
    const own = t.durationMs;
    return {
      ref,
      outcome: "pass",
      durationMs,
      ...(typeof own === "number" && Number.isFinite(own) && own >= 0
        ? { measuredDurationMs: own }
        : {}),
      ...(coverage !== undefined ? { coverage } : {}),
    };
  }
  // Wall-clock `durationMs`, NOT the runner's in-VM figure: the orchestrator derives each mutant's
  // timeout budget from it and must include round-trip cost.
  const timeoutIn = timeoutLocation(t);
  if (timeoutIn !== undefined) {
    // R517: the stop al-runner says it enforced. Absent when the wording does not parse.
    const reportedStopMs = parseReportedStopMs(t.message);
    return {
      ref,
      outcome: "timeout",
      durationMs,
      ...(reportedStopMs !== undefined ? { reportedStopMs } : {}),
      timeoutIn,
      ...(t.message !== undefined ? { failureMessage: t.message } : {}),
    };
  }
  // R534 (D1b): al-runner proved it stopped this row at its timeout, in wording neither regex
  // knows. Still never a kill; the flag makes the orchestrator say so once per session.
  const unknownTimeout = t.status !== "pass" && t.status !== "fail" && t.abortProven === true;
  // R534 (D3): a refusal, in a test body (`fail`) or an OnRun (`error`), is not a kill.
  if (
    !unknownTimeout &&
    (t.status === "fail" || t.status === "error") &&
    t.message !== undefined &&
    RUNNER_REFUSAL.test(t.message)
  ) {
    return {
      ref,
      outcome: "error",
      durationMs,
      failureMessage: `${t.message} [al-runner refused this surface (out-of-scope), so whether the mutant changes this test's outcome on BC is unknown: NOT scored as a kill; measure this test on bcdev (R534)]`,
      operation: "completed-accepted",
      runnerRow: "runner-refused",
    };
  }
  if (t.status === "fail") {
    return {
      ref,
      outcome: "fail",
      durationMs,
      ...(t.message !== undefined ? { failureMessage: t.message } : {}),
    };
  }
  return {
    ref,
    outcome: "error",
    durationMs,
    failureMessage: `${AL_RUNNER_UNCLASSIFIED_ERROR}: al-runner reported status ${JSON.stringify(
      t.status,
    )} for ${wanted} with message ${JSON.stringify(t.message ?? "<none>")}. That is not an assertion failure, so it is NOT scored as a kill. al-runner answered, so it is not re-sent and does not stop the session (R534); if this is a timeout whose wording changed again, add it to RUNNER_TIMEOUT_MESSAGE.`,
    // R534: the test RAN and al-runner answered, so this is not pre-dispatch: re-sending it is
    // no recovery (option (c)), and a §11 abort would throw away an answer (option (b)).
    operation: "completed-accepted",
    runnerRow: "runner-test-error",
    ...(unknownTimeout ? { timeoutWordingUnknown: true } : {}),
  };
}
