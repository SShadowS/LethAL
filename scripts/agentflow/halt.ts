/**
 * The kill switch, as an allowlist.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`, "HALT". Pure.
 *
 * An earlier draft of the spec said "container mutation under HALT is not a carve-out" and then,
 * two sentences later, permitted the executor to "stop or isolate the container". A reviewer
 * pointed out that stopping a container IS a container mutation, so the rule refuted itself and
 * left the reader to infer which one was meant.
 *
 * The distinction it was reaching for is CONTAINMENT versus RESTORATION, and an allowlist states
 * it without anyone having to infer it. Containment makes the situation smaller and is always
 * safe. Restoration makes the machine usable again, and every part of it is exactly what must not
 * happen while a human has said stop:
 *
 * - Clearing a lease is safe only once the stranded AL is actually dead. Do it early and a fresh
 *   session takes the lease while mutated code still runs underneath it, which is a false verdict,
 *   and the whole lease layer exists to prevent that one thing.
 * - Forceful app removal cascades: unpublishing a target silently uninstalls its dependants, while
 *   app listings can still show them as published.
 *
 * The justification for allowing restoration was that the next run would otherwise be blocked.
 * That justification is void: while HALT exists there IS no next run.
 */

/** Everything the executor may do while `.agent/HALT` exists. */
export const HALT_ALLOWED = [
  /** Write or retain the marker recording that this container is not to be used. */
  "quarantine-marker",
  /** Kill the local process tree of anything this run launched. */
  "kill-local-processes",
  /** `docker stop`. Stop only: never start, restart, exec or rm. */
  "container-stop",
  /** `docker ps`, `Get-NAVAppInfo`, a `HarnessInfo` GET. Observation changes nothing. */
  "read-only-inspection",
  /** Append to the local ledger and run directory. Nothing leaves the machine. */
  "local-ledger-append",
  /** One comment and the label transition on the current issue, so a human sees why it stopped. */
  "terminal-bookkeeping",
  /** The validated revert. The other reason a HALT must not strand `master`. */
  "emergency-rollback",
] as const;

export type HaltAllowedAction = (typeof HALT_ALLOWED)[number];

/**
 * Actions the executor performs that are NOT permitted under HALT.
 *
 * Listed explicitly rather than left as "everything else" so that adding a capability to the
 * executor forces a decision about it here. A new action absent from both lists is refused by
 * {@link assertPermittedUnderHalt}, which is the safe direction.
 */
export const HALT_REFUSED = [
  "lease-acquire",
  "lease-reset",
  "container-start",
  "container-restart",
  "container-requalify",
  "publish-app",
  "unpublish-app",
  "sync-app",
  "run-live-gate",
  "seal-manifest",
  "rerecord-baseline",
  "push-branch",
  "pr-create",
  "pr-merge",
  "file-issue",
  "claim-issue",
] as const;

export type HaltRefusedAction = (typeof HALT_REFUSED)[number];
export type ExecutorAction = HaltAllowedAction | HaltRefusedAction;

/** Thrown when an action is attempted under HALT. Never downgraded to a warning. */
export class HaltError extends Error {}

export function isAllowedUnderHalt(action: string): boolean {
  return (HALT_ALLOWED as readonly string[]).includes(action);
}

/**
 * Refuse anything not on the allowlist while halted.
 *
 * An unrecognised action is refused rather than permitted: a capability someone added to the
 * executor without deciding its HALT status is exactly the case where the conservative answer is
 * the right one.
 */
export function assertPermittedUnderHalt(action: string, halted: boolean): void {
  if (!halted) return;
  if (isAllowedUnderHalt(action)) return;
  const known = (HALT_REFUSED as readonly string[]).includes(action);
  throw new HaltError(
    known
      ? `HALT is set: "${action}" is refused. Only containment is permitted, never restoration.`
      : `HALT is set and "${action}" is not on either HALT list. Refused by default: an action nobody has classified is not one to perform while a human has said stop.`,
  );
}
