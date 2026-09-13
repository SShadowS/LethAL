/**
 * Verifying that what merged is what was gated, without paying for a second live ladder.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`, "Verifying the merge".
 * Pure: this module is handed git facts and returns reasons. It runs no git.
 *
 * Five commits matter: `B` the base the gates ran against, `H` the code head they passed on, `P`
 * the optional baseline-proof commit, `F` the final head after evidence-only commits, and `M` the
 * squash merge.
 *
 * A squash merge changes commit identity but not the checked-out tree, so `M.tree === F.tree` plus
 * `M.parent === B` answers "did the merge introduce content nothing gated?" exactly, at the cost of
 * two `git rev-parse` calls rather than 25 to 40 minutes of live gates.
 *
 * What that trade gives up, stated because a cheap check that quietly stops detecting things is
 * worse than an expensive one: it takes no second environmental sample after the merge. It will not
 * see drift that began after the seal, a flake, or contamination arising after qualification. The
 * container generation recheck below covers the third; the first two are accepted and named in the
 * spec's residual risk.
 */

/** The paths an evidence-only commit may touch between `H` and `F`. Everything else refuses. */
export interface EvidenceScope {
  readonly issueNumber: number;
  /** The roadmap id this issue settles, if any. Only that one file may move. */
  readonly roadmapId?: string;
  /** Legs whose baseline the sealed manifest authorises re-recording, if any. */
  readonly reRecordedLegs: readonly string[];
}

/**
 * Is this path allowed to appear in `H..F`?
 *
 * The list is exhaustive and deliberately narrow. Everything here is evidence ABOUT the gated work,
 * never the gated work itself: if a path could change behaviour, it belongs before `H` where the
 * gates can see it.
 */
export function isAllowedEvidencePath(path: string, scope: EvidenceScope): boolean {
  const p = path.replace(/\\/g, "/");
  const n = scope.issueNumber;

  if (p === `.agent/issue-${n}/ledger.md`) return true;
  if (p === `.agent/issue-${n}/findings.json`) return true;

  // Discovery receipts: the git-durable half of a discovery, so an issue body edited or deleted
  // later cannot rewrite what was originally observed.
  if (/^\.agent\/discoveries\/[0-9a-f]{8,64}\.json$/.test(p)) return true;

  // Baselines, only in P, and only for legs the manifest named. A baseline for a leg that did not
  // run, or did not pass, is not authorised by anything.
  const baseline = /^packages\/runner\/itest\/([a-z0-9-]+)\.baseline\.json$/.exec(p);
  if (baseline !== null) {
    const leg = baseline[1];
    return leg !== undefined && scope.reRecordedLegs.includes(leg);
  }

  // The issue's own roadmap row, and only if it has one.
  if (scope.roadmapId !== undefined && p === `docs/roadmap/${scope.roadmapId}.md`) return true;

  // ROADMAP.md is generated, so it may move only alongside a row this issue owns.
  if (p === "ROADMAP.md") return scope.roadmapId !== undefined;

  if (
    new RegExp(`^docs/superpowers/specs/\\d{4}-\\d{2}-\\d{2}-issue-${n}-precommitment\\.md$`).test(
      p,
    )
  ) {
    return true;
  }

  return false;
}

export interface MergeFacts {
  /** `M`'s first parent. */
  readonly mergeParent: string;
  /** `B`, the base the gates ran against. */
  readonly base: string;
  /** `M`'s tree hash. */
  readonly mergeTree: string;
  /** `F`'s tree hash. */
  readonly finalTree: string;
  /** Paths changed in `H..F`. */
  readonly evidencePaths: readonly string[];
  /** Hash of the sealed manifest, recomputed now. */
  readonly manifestHash: string;
  /** Hash recorded when the manifest was sealed. */
  readonly sealedManifestHash: string;
  /** Container generations observed now, keyed by container. */
  readonly containerGenerations: Readonly<Record<string, number>>;
  /** Generations recorded in the sealed manifest. */
  readonly sealedContainerGenerations: Readonly<Record<string, number>>;
  /** Legs the manifest declares as sensitive to commit identity rather than tree content. */
  readonly shaSensitiveLegs: readonly string[];
  /** Legs actually rerun on `M`. */
  readonly rerunOnMerge: readonly string[];
}

/**
 * Returns the reasons the merge cannot be accepted. Empty means accepted.
 *
 * Reasons rather than a boolean: every one of these is something a human will have to act on, and
 * "false" tells them nothing about which of eight checks failed.
 */
export function verifyMergeTree(facts: MergeFacts, scope: EvidenceScope): readonly string[] {
  const reasons: string[] = [];

  if (facts.mergeParent !== facts.base) {
    reasons.push(
      `merge parent ${facts.mergeParent} is not the gated base ${facts.base}: master moved between the seal and the merge`,
    );
  }

  if (facts.mergeTree !== facts.finalTree) {
    reasons.push(
      `merge tree ${facts.mergeTree} differs from the gated tree ${facts.finalTree}: the merge introduced content nothing gated`,
    );
  }

  for (const p of facts.evidencePaths) {
    if (!isAllowedEvidencePath(p, scope)) {
      reasons.push(`${p} is not an allowed evidence path in H..F`);
    }
  }

  if (facts.manifestHash !== facts.sealedManifestHash) {
    reasons.push("the manifest changed after it was sealed");
  }

  // A container reset between the seal and the merge means the environment that produced the
  // evidence no longer exists, and "heartbeat stale does not mean the old writer is dead" is the
  // reason generations exist at all.
  for (const [container, sealed] of Object.entries(facts.sealedContainerGenerations)) {
    const now = facts.containerGenerations[container];
    if (now === undefined) {
      reasons.push(`container ${container} reports no generation; it was ${sealed} at seal`);
    } else if (now !== sealed) {
      reasons.push(
        `container ${container} is at generation ${now}, was ${sealed} at seal: it was reset`,
      );
    }
  }

  for (const leg of facts.shaSensitiveLegs) {
    if (!facts.rerunOnMerge.includes(leg)) {
      reasons.push(`leg ${leg} observes commit identity and was not rerun on the merge commit`);
    }
  }

  return reasons;
}
