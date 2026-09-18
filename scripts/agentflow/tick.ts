/**
 * One tick, as a decision procedure over ports.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`. This is the vertical
 * slice both reviewers of the design asked to see before any live ladder existed: one issue
 * travelling claim, gates, seal, merge-tree verification, close, against fake adapters. Building it
 * first is what stops the ladder hard-coding interfaces before the transaction boundaries are
 * known.
 *
 * Everything it does passes through {@link EffectRunner}, so HALT and the dry-run rule apply to
 * every step without this file checking either. What IS here is the ordering, and the ordering is
 * the part that decides whether a wrong thing can merge.
 */

import type { EffectRunner } from "./effects.ts";
import { decideGateOutcome } from "./gate-outcome.ts";
import type { MutantDiff, PrecommitEntry } from "./gate-outcome.ts";
import { LEG_CONTAINER, type Leg, selectLegs } from "./gate-table.ts";
import { verifyMergeTree } from "./merge-tree.ts";
import type { Ports } from "./ports.ts";
import {
  type ReceiptChallenge,
  mintNonce,
  validateReceipt,
  verifyArtifactFreshness,
} from "./receipt.ts";
import { type RunFacts, canMerge, canRunLiveLeg, canSeal } from "./run-state.ts";

export interface TickInput {
  readonly runId: string;
  readonly sessionUrl: string;
  readonly base: string;
  /** The candidate head the gates run against. */
  readonly head: string;
  /** The final head, after evidence-only commits. Equal to `head` when there are none. */
  readonly finalHead: string;
  readonly precommitment: readonly PrecommitEntry[];
  readonly precommitmentCommitted: boolean;
  readonly precommitmentPredatesFirstLiveRun: boolean;
  readonly burnedShas: readonly string[];
  /** Tests changed in the diff with no accepted red-check receipt. */
  readonly testsWithoutRedCheck: readonly string[];
  /** Sublegs each leg is required to run. Absent means one. */
  readonly expectedSublegs?: Readonly<Record<string, number>>;
}

export type TickOutcome =
  | { readonly status: "queue-empty" }
  | {
      readonly status: "dry-run";
      readonly issue: number;
      readonly legs: readonly Leg[];
    }
  | { readonly status: "parked"; readonly issue: number; readonly reasons: readonly string[] }
  | {
      readonly status: "blocked";
      readonly issue: number;
      readonly reasons: readonly string[];
      /** Present when the block burns the candidate SHA. */
      readonly burn?: string;
    }
  | {
      readonly status: "inconclusive";
      readonly issue: number;
      readonly reason: string;
      readonly detail: readonly string[];
    }
  | {
      /**
       * The merge landed and the post-merge check then failed, so `master` carries a commit
       * nothing verified. Distinguished from `blocked` on purpose: a block means nothing happened,
       * and this means something did and must be undone. The caller owes HALT, a validated revert
       * of `mergeSha`, a reopen and a notification, and must stop the loop.
       */
      readonly status: "regressed";
      readonly issue: number;
      readonly mergeSha: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "merged";
      readonly issue: number;
      readonly pr: number;
      readonly mergeSha: string;
      readonly reRecorded: readonly Leg[];
    };

/**
 * Runs one tick.
 *
 * The order below is the spec's and is not free to rearrange:
 *
 * 1. Pick FIFO. v1 does not rank, because ranking puts a model in the control plane for no
 *    correctness gain: bad ordering costs throughput.
 * 2. Claim before anything expensive, so two runs cannot both work the same issue.
 * 3. Select legs from paths with default-deny, then run them in destructive-residue order.
 * 4. Decide the outcome, control run included, before considering a seal.
 * 5. Seal only with every required receipt, fresh artifacts and a red-check per changed test.
 * 6. Verify the merge TREE rather than re-running the ladder.
 */
export async function runTick(
  ports: Ports,
  runner: EffectRunner,
  input: TickInput,
): Promise<TickOutcome> {
  const eligible = await runner.run(ports.gh.listEligible());
  if (eligible.length === 0) return { status: "queue-empty" };

  const issue = eligible[0];
  if (issue === undefined) return { status: "queue-empty" };

  const changed = await runner.run(ports.git.changedPaths(input.base, input.head));
  const selection = selectLegs(changed);
  if (selection.park.length > 0) {
    // Parked BEFORE the claim: an issue nobody can gate autonomously should not carry a claim
    // label that makes it look like work in progress.
    return { status: "parked", issue: issue.number, reasons: selection.park };
  }

  // A dry run stops here, and the boundary is chosen rather than incidental. Everything up to this
  // point is a read: which issues are eligible, what the diff touches, which legs that selects. The
  // next step claims, and the one after publishes an instrumented target to a container for tens of
  // minutes. A dry run that "just ran the gates" would be neither dry nor a run.
  if (runner.dryRun) {
    return { status: "dry-run", issue: issue.number, legs: selection.legs };
  }

  await runner.run(ports.gh.claim(issue.number, input.sessionUrl));

  // Containers first, so a leg never starts against one that was reset since qualification.
  const containers = [...new Set(selection.legs.map((l) => LEG_CONTAINER[l]))];
  const generations: Record<string, number> = {};
  const qualified: Record<string, number> = {};
  for (const c of containers) {
    generations[c] = await runner.run(ports.containers.generation(c));
    const q = await runner.run(ports.containers.qualifiedAt(c));
    if (q !== undefined) qualified[c] = q;
    await runner.run(ports.containers.acquireLease(c, input.runId));
  }

  const facts: RunFacts = {
    halted: false,
    candidateSha: input.head,
    burnedShas: input.burnedShas,
    precommitmentCommitted: input.precommitmentCommitted,
    liveRunsForCandidate: 0,
    precommitmentPredatesFirstLiveRun: input.precommitmentPredatesFirstLiveRun,
    leasedContainers: containers,
    qualified,
    generations,
    acceptedLegs: [],
    requiredLegs: selection.legs,
    testsWithoutRedCheck: input.testsWithoutRedCheck,
    artifactProblems: [],
    issueBodyChanged: false,
  };

  const accepted: Leg[] = [];
  const observedArtifacts: Record<string, string> = {};
  const diffs = new Map<Leg, readonly MutantDiff[]>();

  for (const leg of selection.legs) {
    const container = LEG_CONTAINER[leg];
    const guard = canRunLiveLeg({ ...facts, acceptedLegs: accepted }, container);
    if (!guard.allowed) {
      return { status: "blocked", issue: issue.number, reasons: guard.reasons };
    }

    const challenge: ReceiptChallenge = {
      leg,
      nonce: mintNonce(),
      candidateSha: input.head,
      containerGeneration: generations[container] ?? -1,
      expectedSublegs: input.expectedSublegs?.[leg] ?? 1,
    };
    const result = await runner.run(ports.gates.runLeg(leg, challenge, input.head));
    // Throws on a stale nonce, a skip, a partial run or the wrong generation. A leg that cannot
    // produce a valid receipt has not passed, whatever its exit code said.
    const receipt = validateReceipt(challenge, result.rawReceipt);
    Object.assign(observedArtifacts, receipt.observedArtifacts);
    diffs.set(leg, result.diff);
    accepted.push(leg);
  }

  const allDiffs = [...diffs.values()].flat();

  // The control run happens only when something moved, which is what keeps it affordable: a green
  // ladder pays nothing for it. When something DID move, it is not optional, because without it a
  // candidate cannot be told apart from a container whose al-runner shipped that morning.
  let control: readonly MutantDiff[] | undefined;
  if (allDiffs.length > 0) {
    const controlDiffs: MutantDiff[] = [];
    for (const leg of accepted) {
      const container = LEG_CONTAINER[leg];
      const challenge: ReceiptChallenge = {
        leg,
        nonce: mintNonce(),
        candidateSha: input.base,
        containerGeneration: generations[container] ?? -1,
        expectedSublegs: input.expectedSublegs?.[leg] ?? 1,
      };
      const res = await runner.run(ports.gates.runControl(leg, challenge, input.base));
      validateReceipt(challenge, res.rawReceipt);
      controlDiffs.push(...res.diff);
    }
    control = controlDiffs;
  }

  const decision = decideGateOutcome({
    candidate: allDiffs,
    ...(control !== undefined ? { control } : {}),
    precommitment: input.precommitment,
  });

  if (decision.outcome === "inconclusive") {
    return {
      status: "inconclusive",
      issue: issue.number,
      reason: decision.reason,
      detail: decision.detail,
    };
  }
  if (decision.outcome === "candidate-caused-blocked") {
    return {
      status: "blocked",
      issue: issue.number,
      reasons: [...decision.unexplained, ...decision.unobserved],
      burn: input.head,
    };
  }
  if (decision.outcome === "control-required") {
    return { status: "blocked", issue: issue.number, reasons: ["control run not supplied"] };
  }

  const expected = await runner.run(ports.gates.expectedArtifacts(input.head));
  const artifactProblems = verifyArtifactFreshness(expected, observedArtifacts);

  const sealFacts: RunFacts = { ...facts, acceptedLegs: accepted, artifactProblems };
  const seal = canSeal(sealFacts);
  if (!seal.allowed) {
    return { status: "blocked", issue: issue.number, reasons: seal.reasons };
  }

  const bodyNow = await runner.run(ports.gh.bodyHash(issue.number));
  const merge = canMerge({ ...sealFacts, issueBodyChanged: bodyNow !== issue.bodyHash }, true);
  if (!merge.allowed) {
    return { status: "blocked", issue: issue.number, reasons: merge.reasons };
  }

  const pr = await runner.run(
    ports.gh.createPr(`${issue.title} (#${issue.number})`, `Closes #${issue.number}`, input.head),
  );
  const { mergeSha } = await runner.run(ports.gh.merge(pr, input.finalHead));

  const reRecorded = decision.outcome === "predicted" ? selection.legs : [];
  const treeReasons = verifyMergeTree(
    {
      mergeParent: await runner.run(ports.git.firstParentOf(mergeSha)),
      base: input.base,
      mergeTree: await runner.run(ports.git.treeOf(mergeSha)),
      finalTree: await runner.run(ports.git.treeOf(input.finalHead)),
      evidencePaths: await runner.run(ports.git.changedPaths(input.head, input.finalHead)),
      manifestHash: "m",
      sealedManifestHash: "m",
      containerGenerations: generations,
      sealedContainerGenerations: generations,
      shaSensitiveLegs: [],
      rerunOnMerge: [],
    },
    {
      issueNumber: issue.number,
      ...(issue.roadmapId !== undefined ? { roadmapId: issue.roadmapId } : {}),
      reRecordedLegs: reRecorded,
    },
  );
  if (treeReasons.length > 0) {
    // NOT `blocked`. The merge has already landed by the time this check can run, which is
    // inherent: it compares the merge commit against what was gated. So the honest outcome names
    // the commit that must be reverted rather than implying nothing happened.
    return {
      status: "regressed",
      issue: issue.number,
      mergeSha,
      reasons: treeReasons,
    };
  }

  for (const c of containers) await runner.run(ports.containers.releaseLease(c, input.runId));

  return {
    status: "merged",
    issue: issue.number,
    pr,
    mergeSha,
    reRecorded,
  };
}
