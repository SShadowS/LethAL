/**
 * R59 — naming the hub/fence runner disagreement instead of calling it flakiness.
 *
 * **What R59 feared, and why it cannot happen.** The entry says a test the hub PASSES but the fence
 * would FAIL enters the green set and then "fails against every mutant it covers on the verdict
 * path, and each of those reads as a KILL: a false kill". Read `runMutantsOnBackend`'s
 * `v.outcome === "fail"` branch before believing it: a failing covering run does not produce a
 * kill. The orchestrator deactivates the mutant (`activate(null)`) and re-runs the SAME test
 * through the fenced transport (`coverage: "none"`), and only `confirm.outcome === "pass"` yields
 * `killed`. A hub-green / fence-red test fails that confirmation and lands in the `unstable`
 * branch. The unsafe direction is contained — by a mechanism built for a different reason.
 *
 * **What was actually missing.** The user is then told their test is `unstable`, which reads as
 * flakiness in their own suite. In a HUB coverage mode the deterministic cause is nameable: the
 * green set was measured on a `GuiAllowed=Yes` / `ClientType=Web` session and every verdict comes
 * from a `GuiAllowed=No` / `ClientType=ODataV4` one (R57, measured — 12 of 56 Document Output tests
 * disagree, in the safe direction). Sending a developer to debug flakiness when the answer is "your
 * two runners are different session types" is R27/R35's shape exactly.
 *
 * **Zero extra runs.** In a hub mode every covering test reached the mutant loop by being in the
 * hub-produced green set, so a failed confirmation IS an observation of "passed on the hub, failed
 * on the fence". Nothing is re-run; an observation already in hand stops being discarded.
 *
 * **What one confirmation cannot settle, and this note therefore does not claim:** a deterministic
 * disagreement and an ordinary flaky test both present as one failed confirm. The note names both
 * and points at the mode where the question disappears. A second confirmation would separate them
 * and is deliberately not spent: `"procedure"` is scheduled for deletion after one release, and the
 * actionable half is "stop measuring the green set somewhere else", not "prove it is deterministic".
 */
import type { CoverageMode } from "./backend";

/**
 * Coverage modes whose BASELINE runs on the bc-dev-mcp hub while every verdict comes from the
 * fenced `RunMutant` transport — the two-runner configuration this diagnosis is about.
 *
 * Must stay in lockstep with `BcDevMcpBackend.run`'s routing predicate
 * (`opts.coverage === "procedure" || opts.coverage === "line"`). Widening one without the other
 * either produces the diagnosis where there is only one runner (a lie) or withholds it where there
 * are two (the silence R59 filed).
 */
const HUB_COVERAGE_MODES: ReadonlySet<CoverageMode> = new Set<CoverageMode>(["procedure", "line"]);

export function isHubCoverageMode(mode: CoverageMode): boolean {
  return HUB_COVERAGE_MODES.has(mode);
}

/**
 * The sentence appended to an `unstable` failure note when the session runs a hub coverage mode.
 *
 * Exported because the producer and any consumer that greps for it must share one literal — a
 * reworded copy is how a diagnosis silently stops being recognisable (R31 records that exact
 * failure). Deliberately free of the words `TestPermissions`, so it cannot be mistaken for R27's
 * diagnosis by a test asserting on either.
 */
export const RUNNER_DISAGREEMENT_NOTE =
  "note: this session collects coverage on the bc-dev-mcp hub, so its GREEN SET was measured on a " +
  "different session type (GuiAllowed=Yes/ClientType=Web) from every verdict (the fenced " +
  "GuiAllowed=No/ClientType=ODataV4 path, R57) — a test that passes there and fails here is a " +
  'runner disagreement, not necessarily a flaky test. Re-run with coverageMode "fenced" (one ' +
  "runner for both) to tell the two apart";

/**
 * The diagnosis for a test that failed its kill-confirmation under a hub coverage mode, or
 * `undefined` when the mode has only one runner and the diagnosis would be false.
 *
 * A pure predicate on the MODE, not on the failure text: unlike R27's permissions refusal there is
 * no message to match, because the disagreement produces the suite's own ordinary assertion
 * failures (R55 measured `Assert.IsTrue failed` and `Unhandled UI: Confirm …` alike). What makes
 * the observation sound is structural — in a hub mode the test was hub-green by construction, or
 * it would not have been a covering test at all.
 */
export function describeRunnerDisagreement(mode: CoverageMode): string | undefined {
  return isHubCoverageMode(mode) ? RUNNER_DISAGREEMENT_NOTE : undefined;
}
