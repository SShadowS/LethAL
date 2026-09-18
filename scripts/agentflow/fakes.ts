/**
 * In-memory ports, for the vertical slice.
 *
 * Every fake records what was asked of it and performs nothing outside this process. The point is
 * not convenience: it is that the dry-run proof needs a witness that would SHOW a write if one
 * leaked, and a fake that silently succeeds proves nothing. So each write appends to `journal`,
 * and the tests assert on that rather than on the absence of an error.
 */

import { type Effect, readEffect, writeEffect } from "./effects.ts";
import type { MutantDiff } from "./gate-outcome.ts";
import type { Leg } from "./gate-table.ts";
import type {
  ContainerPort,
  GatePort,
  GitHubPort,
  GitPort,
  IssueSummary,
  LegResult,
  Ports,
} from "./ports.ts";
import type { ReceiptChallenge } from "./receipt.ts";

export interface FakeWorld {
  /** Every write a port actually performed. Empty after a dry run, always. */
  readonly journal: string[];
  issues: IssueSummary[];
  changedPaths: string[];
  /** Per-leg diffs against the frozen baseline. Absent means the leg matched. */
  legDiffs: Map<Leg, readonly MutantDiff[]>;
  /** Per-leg diffs the CONTROL run found on the base commit. Non-empty means the machine moved. */
  controlDiffs: Map<Leg, readonly MutantDiff[]>;
  /** Per-leg receipt overrides, for testing a stale nonce or a skip. */
  receiptOverrides: Map<Leg, Record<string, unknown>>;
  generations: Record<string, number>;
  qualified: Record<string, number>;
  expectedArtifacts: Record<string, string>;
  observedArtifacts: Record<string, string>;
  bodyHashNow?: string;
  trees: Record<string, string>;
  firstParents: Record<string, string>;
  evidencePaths: string[];
  nextPr: number;
  mergeSha: string;
  /** The candidate head, so `changedPaths` can tell the evidence range from the candidate diff. */
  candidateHead: string;
}

export function emptyWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    journal: [],
    issues: [],
    changedPaths: ["packages/runner/src/store.ts"],
    legDiffs: new Map(),
    controlDiffs: new Map(),
    receiptOverrides: new Map(),
    generations: { "agent-app": 1, "agent-data": 1 },
    qualified: { "agent-app": 1, "agent-data": 1 },
    expectedArtifacts: { target: "sha:t", tests: "sha:x" },
    observedArtifacts: { target: "sha:t", tests: "sha:x" },
    trees: { HEAD: "tree-1", MERGE: "tree-1" },
    firstParents: { MERGE: "base" },
    evidencePaths: [],
    nextPr: 77,
    mergeSha: "MERGE",
    candidateHead: "1111111111111111111111111111111111111111",
    ...over,
  };
}

export function fakePorts(w: FakeWorld): Ports {
  const note = (s: string) => {
    w.journal.push(s);
  };

  const gh: GitHubPort = {
    listEligible: () => readEffect("read-only-inspection", "gh issue list", async () => w.issues),
    bodyHash: (n) =>
      readEffect("read-only-inspection", `gh issue view ${n}`, async () => {
        const found = w.issues.find((i) => i.number === n);
        return w.bodyHashNow ?? found?.bodyHash ?? "";
      }),
    claim: (n, url) =>
      writeEffect(
        "claim-issue",
        `claim #${n}`,
        async () => {
          note(`claim:${n}:${url}`);
        },
        { result: undefined },
      ),
    comment: (n, body) =>
      writeEffect(
        "terminal-bookkeeping",
        `comment on #${n}`,
        async () => {
          note(`comment:${n}:${body.slice(0, 20)}`);
        },
        { result: undefined },
      ),
    label: (n, add, remove) =>
      writeEffect(
        "terminal-bookkeeping",
        `label #${n}`,
        async () => {
          note(`label:${n}:+${add.join(",")}:-${remove.join(",")}`);
        },
        { result: undefined },
      ),
    createPr: (title, _body, head) =>
      writeEffect(
        "pr-create",
        `create PR for ${head}`,
        async () => {
          note(`pr:${title}`);
          return w.nextPr;
        },
        { result: 0 },
      ),
    merge: (pr, expectedHead) =>
      writeEffect(
        "pr-merge",
        `merge PR ${pr}`,
        async () => {
          note(`merge:${pr}:${expectedHead}`);
          return { mergeSha: w.mergeSha };
        },
        { result: { mergeSha: "DRY" } },
      ),
  };

  const git: GitPort = {
    changedPaths: (base, head) =>
      // Keyed on the exact pair rather than a heuristic. The tick asks this twice for different
      // reasons (the candidate diff, then the evidence range), and a fake that guesses which is
      // which will eventually guess wrong in the direction that makes a test pass.
      readEffect("read-only-inspection", `git diff ${base}..${head}`, async () =>
        base === w.candidateHead ? w.evidencePaths : w.changedPaths,
      ),
    treeOf: (rev) =>
      readEffect("read-only-inspection", `git tree ${rev}`, async () => w.trees[rev] ?? "tree-?"),
    firstParentOf: (rev) =>
      readEffect(
        "read-only-inspection",
        `git parent ${rev}`,
        async () => w.firstParents[rev] ?? "?",
      ),
  };

  const containers: ContainerPort = {
    generation: (c) =>
      readEffect("read-only-inspection", `generation ${c}`, async () => w.generations[c] ?? 0),
    qualifiedAt: (c) =>
      readEffect("read-only-inspection", `qualified ${c}`, async () => w.qualified[c]),
    acquireLease: (c, runId) =>
      writeEffect(
        "lease-acquire",
        `lease ${c}`,
        async () => {
          note(`lease-acquire:${c}:${runId}`);
        },
        { result: undefined },
      ),
    releaseLease: (c, runId) =>
      writeEffect(
        "lease-acquire",
        `release ${c}`,
        async () => {
          note(`lease-release:${c}:${runId}`);
        },
        { result: undefined },
      ),
  };

  const gates: GatePort = {
    runLeg: (leg: Leg, challenge: ReceiptChallenge): Effect<LegResult> =>
      // A WRITE, and deliberately one with no dry-run result. Running a leg publishes an
      // instrumented target to a container: the RESULT is evidence, but obtaining it mutates the
      // world and costs tens of minutes. Declaring no dry-run result means a dry run that somehow
      // reached a gate refuses loudly rather than fabricating verdicts.
      writeEffect("run-live-gate", `run ${leg}`, async () => {
        note(`gate:${leg}`);
        const override = w.receiptOverrides.get(leg);
        return {
          rawReceipt: override ?? {
            leg,
            nonce: challenge.nonce,
            candidateSha: challenge.candidateSha,
            containerGeneration: challenge.containerGeneration,
            status: "passed",
            sublegs: Array.from({ length: challenge.expectedSublegs }, (_, i) => `${leg}-${i}`),
            observedArtifacts: w.observedArtifacts,
          },
          diff: w.legDiffs.get(leg) ?? [],
        };
      }),
    runControl: (leg: Leg, challenge: ReceiptChallenge): Effect<LegResult> =>
      writeEffect("run-live-gate", `control ${leg}`, async () => {
        note(`control:${leg}`);
        return {
          rawReceipt: {
            leg,
            nonce: challenge.nonce,
            candidateSha: challenge.candidateSha,
            containerGeneration: challenge.containerGeneration,
            status: "passed",
            sublegs: Array.from({ length: challenge.expectedSublegs }, (_, i) => `${leg}-${i}`),
            observedArtifacts: w.observedArtifacts,
          },
          diff: w.controlDiffs.get(leg) ?? [],
        };
      }),
    expectedArtifacts: () =>
      readEffect("read-only-inspection", "expected artifacts", async () => w.expectedArtifacts),
  };

  return { gh, git, containers, gates };
}
