/**
 * Rung-3 fence for the DO campaign's `claude -p` agent — the stdin/stdout shell only.
 *
 * Every rule, and the reasoning behind each, lives in `packages/runner/src/campaign-fence.ts`
 * (`evaluateFenceEvent`). It is there rather than here so the rules are typechecked by
 * `tsc --build` and probed by a committed test that runs in the ordinary `bun test` suite —
 * `packages/runner/tests/campaign-fence.test.ts`, whose 34-case matrix is mirrored for human
 * readers in `fixtures/do-campaign/fence-probe-matrix.md`. The earlier arrangement kept the rules
 * here and the probe matrix in a scratch script whose report was gitignored: the evidence for the
 * campaign's threat-model decision could not be committed.
 *
 * **The threat model for rung 3 is ACCIDENT, not adversary** (campaign owner's decision,
 * 2026-08-04). Shell substitution (`$()`, `$VAR`) defeats this hook and is an accepted residual,
 * left open on purpose — see `fence-probe-matrix.md` §"Accepted residuals" and README.md. What
 * actually guarantees what: the agent's workspace does not contain the LethAL source tree
 * (removes the accidental-reference path, does NOT make it unreachable), and
 * `assertRunSizeAcceptable` in the product refuses an unnarrowed run before anything publishes.
 * This hook is the remaining layer, and it is not claimed to be more than best-effort.
 *
 * `preflight.ts` closes the fail-open half: a `PreToolUse` hook that fails to spawn, crashes, or
 * never answers lets the tool call through SILENTLY, so rung 3 does not start until preflight has
 * seen this hook answer known probes correctly.
 */
import { type FenceEvent, evaluateFenceEvent } from "../../packages/runner/src/campaign-fence";

const raw = await Bun.stdin.text();
const event = JSON.parse(raw) as FenceEvent;
const decision = evaluateFenceEvent(event, process.cwd());

if (decision.decision === "deny") {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }),
  );
} else {
  console.log(JSON.stringify({}));
}
