/**
 * What the tick needs from the outside world, as effect factories.
 *
 * Spec: `docs/superpowers/specs/2026-09-13-issue-orchestrator-design.md`. Every method returns an
 * {@link Effect} rather than a promise, so a port cannot perform anything on its own: only the
 * runner can, and only once it has checked HALT and the dry-run rule. That is what stops a port
 * implementation from quietly becoming a second way to reach GitHub or a container.
 *
 * Kept deliberately small. A port here exists because the tick's decision procedure needs it, not
 * because the real tool has the capability. Everything the real `gh` can do that the tick does not
 * need is absent, so the fake cannot drift into an emulator.
 */

import type { Effect } from "./effects.ts";
import type { Leg } from "./gate-table.ts";
import type { ReceiptChallenge } from "./receipt.ts";

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  /** The committed body hash at the moment it was read. */
  readonly bodyHash: string;
  /** Parsed from the body's `Roadmap: R<n>` line, when present. */
  readonly roadmapId?: string;
}

export interface GitHubPort {
  /** Eligible issues, already filtered deterministically. Oldest first: v1 ranks FIFO. */
  listEligible(): Effect<readonly IssueSummary[]>;
  /** Re-read at merge time, to catch an issue edited since claim. */
  bodyHash(issue: number): Effect<string>;
  claim(issue: number, sessionUrl: string): Effect<void>;
  comment(issue: number, body: string): Effect<void>;
  label(issue: number, add: readonly string[], remove: readonly string[]): Effect<void>;
  createPr(title: string, body: string, head: string): Effect<number>;
  merge(pr: number, expectedHead: string): Effect<{ readonly mergeSha: string }>;
}

export interface GitPort {
  changedPaths(base: string, head: string): Effect<readonly string[]>;
  treeOf(rev: string): Effect<string>;
  firstParentOf(rev: string): Effect<string>;
}

export interface ContainerPort {
  /** Monotonic per container. A bump means it was reset and nothing measured before it applies. */
  generation(container: string): Effect<number>;
  /** The generation this container was last qualified at, if ever. */
  qualifiedAt(container: string): Effect<number | undefined>;
  acquireLease(container: string, runId: string): Effect<void>;
  releaseLease(container: string, runId: string): Effect<void>;
}

/** What a leg run gives back: the raw receipt, and the per-mutant diff the itest computed. */
export interface LegResult {
  readonly rawReceipt: unknown;
  readonly diff: readonly import("./gate-outcome.ts").MutantDiff[];
}

export interface GatePort {
  /** Runs one leg. The challenge carries the nonce the receipt must echo. */
  runLeg(leg: Leg, challenge: ReceiptChallenge, rev: string): Effect<LegResult>;
  /**
   * Runs one leg on the BASE commit, in the same containers. This is the discriminator between
   * "the code moved a verdict" and "the machine did", and it is the only thing that distinguishes
   * a regression from `al-runner` shipping twice that morning.
   */
  runControl(leg: Leg, challenge: ReceiptChallenge, baseRev: string): Effect<LegResult>;
  /** The expected artifact identities built from candidate source. */
  expectedArtifacts(rev: string): Effect<Readonly<Record<string, string>>>;
}

export interface Ports {
  readonly gh: GitHubPort;
  readonly git: GitPort;
  readonly containers: ContainerPort;
  readonly gates: GatePort;
}
