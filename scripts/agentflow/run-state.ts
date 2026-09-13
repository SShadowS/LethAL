/**
 * What a run is allowed to do next, as a pure guard.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`. Pure: no IO. The executor
 * gathers facts, asks here, and only then acts. Keeping the decision separate from the act is what
 * makes fault injection possible at every transition, and what lets the dangerous rules be tested
 * without a container.
 *
 * The rules here are the ones whose violation produces a WRONG MERGE rather than a failed run.
 * Ordinary sequencing (you cannot push before you commit) is left to the code that does the work;
 * git will say so. What is here is everything git and GitHub cannot notice.
 */

import { type ExecutorAction, assertPermittedUnderHalt } from "./halt.ts";

/** Everything the guard needs to know about a run, gathered by the caller. */
export interface RunFacts {
  readonly halted: boolean;
  /** The candidate commit this run is working on. */
  readonly candidateSha: string;
  /**
   * Candidate SHAs whose live gate returned `candidate-caused-blocked`. TERMINAL: no later
   * pre-commitment generation may be run against one, which is the anti-laundering rule.
   */
  readonly burnedShas: readonly string[];
  /** Does a committed pre-commitment exist for `candidateSha`? */
  readonly precommitmentCommitted: boolean;
  /**
   * Has the executor already launched a live run for `candidateSha`? Used to enforce that the
   * pre-commitment predates the first one.
   */
  readonly liveRunsForCandidate: number;
  /** Is the pre-commitment's commit an ancestor of the first live run's start? */
  readonly precommitmentPredatesFirstLiveRun: boolean;
  /** Containers this run holds a lease on. */
  readonly leasedContainers: readonly string[];
  /** Containers currently qualified, with the generation they were qualified at. */
  readonly qualified: Readonly<Record<string, number>>;
  /** Current generation per container. */
  readonly generations: Readonly<Record<string, number>>;
  /** Legs whose receipts have been accepted for `candidateSha`. */
  readonly acceptedLegs: readonly string[];
  /** Legs the selection requires. */
  readonly requiredLegs: readonly string[];
  /** Tests added or changed in the diff that have no accepted red-check receipt. */
  readonly testsWithoutRedCheck: readonly string[];
  /** Problems from the expected-versus-observed artifact comparison. Empty means fresh. */
  readonly artifactProblems: readonly string[];
  /** Has the issue body changed since claim? */
  readonly issueBodyChanged: boolean;
}

export interface Guarded {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

const ok: Guarded = { allowed: true, reasons: [] };
const deny = (...reasons: string[]): Guarded => ({ allowed: false, reasons });

/**
 * May this run start a live gate leg on this container?
 *
 * The three conditions that are not obvious from the code that would call it:
 *
 * 1. A burned SHA may never run live again. Not "may not merge", may not RUN: the whole point is
 *    that no second observation of this candidate can be turned into a prediction. Letting it run
 *    and blocking at merge would put the observation back in the agent's hands.
 * 2. The pre-commitment must predate the FIRST live run for this SHA, not this one. Otherwise the
 *    first run is the peek and the second is the theatre.
 * 3. Qualification is per generation. A container qualified at generation 3 and now at 4 was reset
 *    since, and nothing it measured then applies now.
 */
export function canRunLiveLeg(facts: RunFacts, container: string): Guarded {
  assertPermittedUnderHalt("run-live-gate" satisfies ExecutorAction, facts.halted);

  const reasons: string[] = [];

  if (facts.burnedShas.includes(facts.candidateSha)) {
    reasons.push(
      `candidate ${facts.candidateSha} is burned: an unpredicted candidate-caused movement was already observed for it. A retry needs a code change and therefore a new SHA.`,
    );
  }

  if (!facts.precommitmentCommitted) {
    reasons.push(`no committed pre-commitment for ${facts.candidateSha}`);
  } else if (facts.liveRunsForCandidate > 0 && !facts.precommitmentPredatesFirstLiveRun) {
    reasons.push(
      "the pre-commitment does not predate the first live run of this SHA, so it may have been " +
        "written from an observed result",
    );
  }

  if (!facts.leasedContainers.includes(container)) {
    reasons.push(`no lease held on ${container}`);
  }

  const qualifiedAt = facts.qualified[container];
  const now = facts.generations[container];
  if (qualifiedAt === undefined) {
    reasons.push(`${container} is not qualified`);
  } else if (now === undefined) {
    reasons.push(`${container} reports no generation`);
  } else if (qualifiedAt !== now) {
    reasons.push(
      `${container} was qualified at generation ${qualifiedAt} and is now at ${now}: requalify`,
    );
  }

  return reasons.length === 0 ? ok : { allowed: false, reasons };
}

/**
 * May this run seal a manifest?
 *
 * Sealing is the moment evidence becomes usable, so everything the evidence is supposed to prove is
 * checked here rather than at merge, where a partial answer is more tempting.
 */
export function canSeal(facts: RunFacts): Guarded {
  assertPermittedUnderHalt("seal-manifest" satisfies ExecutorAction, facts.halted);

  const reasons: string[] = [];

  const missing = facts.requiredLegs.filter((l) => !facts.acceptedLegs.includes(l));
  if (missing.length > 0) {
    reasons.push(`required legs without an accepted receipt: ${missing.join(", ")}`);
  }

  // A leg that ran and passed but was not required is fine. A leg required and absent is the
  // failure that an exit-code check would have missed entirely.
  if (facts.artifactProblems.length > 0) {
    reasons.push(...facts.artifactProblems.map((p) => `stale artifact: ${p}`));
  }

  if (facts.testsWithoutRedCheck.length > 0) {
    reasons.push(
      `tests changed with no red-check receipt: ${facts.testsWithoutRedCheck.join(", ")}`,
    );
  }

  return reasons.length === 0 ? ok : { allowed: false, reasons };
}

/** May this run merge? Everything `canSeal` proved, plus the things that can change after it. */
export function canMerge(facts: RunFacts, sealed: boolean): Guarded {
  assertPermittedUnderHalt("pr-merge" satisfies ExecutorAction, facts.halted);

  const reasons: string[] = [];
  if (!sealed) reasons.push("no sealed manifest");
  if (facts.burnedShas.includes(facts.candidateSha)) {
    reasons.push(`candidate ${facts.candidateSha} is burned`);
  }
  if (facts.issueBodyChanged) {
    reasons.push(
      "the issue body changed since claim; the acceptance being merged is not the one tested",
    );
  }
  return reasons.length === 0 ? ok : { allowed: false, reasons };
}

/**
 * May this run re-record a baseline?
 *
 * Only from outcome 2, and only after the proof run on `P`. The one-phase version, where the
 * candidate run's own output becomes the new baseline, is how a gate turns into a mirror of
 * whatever the code currently does.
 */
export function canReRecord(
  facts: RunFacts,
  outcome: "predicted" | (string & {}),
  proofRunPassed: boolean,
): Guarded {
  assertPermittedUnderHalt("rerecord-baseline" satisfies ExecutorAction, facts.halted);

  const reasons: string[] = [];
  if (outcome !== "predicted") reasons.push(`outcome is "${outcome}", not "predicted"`);
  if (!proofRunPassed) {
    reasons.push(
      "the proof run against the installed baseline has not passed; a baseline that has not " +
        "compared against itself once is not proven (R29)",
    );
  }
  if (facts.burnedShas.includes(facts.candidateSha)) {
    reasons.push(`candidate ${facts.candidateSha} is burned`);
  }
  return reasons.length === 0 ? ok : { allowed: false, reasons };
}

/** Record that a candidate SHA may never run live again. Returns the new burned set. */
export function burn(burned: readonly string[], sha: string): readonly string[] {
  return burned.includes(sha) ? burned : [...burned, sha];
}
