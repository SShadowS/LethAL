import { describe, expect, test } from "bun:test";
import {
  type EvidenceScope,
  type MergeFacts,
  isAllowedEvidencePath,
  verifyMergeTree,
} from "./merge-tree.ts";

const SCOPE: EvidenceScope = {
  issueNumber: 42,
  roadmapId: "R213",
  reRecordedLegs: ["tables"],
};

const CLEAN: MergeFacts = {
  mergeParent: "base-sha",
  base: "base-sha",
  mergeTree: "tree-1",
  finalTree: "tree-1",
  evidencePaths: [".agent/issue-42/ledger.md", ".agent/issue-42/findings.json"],
  manifestHash: "m1",
  sealedManifestHash: "m1",
  containerGenerations: { "agent-app": 3, "agent-data": 5 },
  sealedContainerGenerations: { "agent-app": 3, "agent-data": 5 },
  shaSensitiveLegs: [],
  rerunOnMerge: [],
};

describe("a clean merge", () => {
  test("accepts with no reasons", () => {
    expect(verifyMergeTree(CLEAN, SCOPE)).toEqual([]);
  });
});

describe("the merge introduced content nothing gated", () => {
  test("a differing tree refuses", () => {
    const r = verifyMergeTree({ ...CLEAN, mergeTree: "tree-2" }, SCOPE);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("nothing gated");
  });

  test("a moved base refuses", () => {
    // This is what replaces "did master move?" as a separate check: if it moved, M's parent is not
    // B, and the squash carries a merge nothing gated.
    const r = verifyMergeTree({ ...CLEAN, mergeParent: "other-sha" }, SCOPE);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("master moved");
  });

  test("a manifest edited after sealing refuses", () => {
    const r = verifyMergeTree({ ...CLEAN, manifestHash: "m2" }, SCOPE);
    expect(r).toEqual(["the manifest changed after it was sealed"]);
  });
});

describe("allowed evidence paths in H..F", () => {
  test("the ledger and findings for THIS issue are allowed", () => {
    expect(isAllowedEvidencePath(".agent/issue-42/ledger.md", SCOPE)).toBe(true);
    expect(isAllowedEvidencePath(".agent/issue-42/findings.json", SCOPE)).toBe(true);
  });

  test("another issue's ledger is not", () => {
    expect(isAllowedEvidencePath(".agent/issue-43/ledger.md", SCOPE)).toBe(false);
  });

  test("a discovery receipt is allowed", () => {
    expect(isAllowedEvidencePath(".agent/discoveries/deadbeef.json", SCOPE)).toBe(true);
    expect(isAllowedEvidencePath(".agent/discoveries/not-hex.json", SCOPE)).toBe(false);
  });

  test("a baseline is allowed only for a leg the manifest re-recorded", () => {
    expect(isAllowedEvidencePath("packages/runner/itest/tables.baseline.json", SCOPE)).toBe(true);
    // bcdev was not re-recorded, so its baseline moving after the gates is unauthorised by
    // anything, which is how a candidate would quietly widen what it re-records.
    expect(isAllowedEvidencePath("packages/runner/itest/bcdev.baseline.json", SCOPE)).toBe(false);
  });

  test("only the issue's own roadmap row is allowed", () => {
    expect(isAllowedEvidencePath("docs/roadmap/R213.md", SCOPE)).toBe(true);
    expect(isAllowedEvidencePath("docs/roadmap/R089.md", SCOPE)).toBe(false);
  });

  test("ROADMAP.md moves only alongside a row this issue owns", () => {
    expect(isAllowedEvidencePath("ROADMAP.md", SCOPE)).toBe(true);
    const noRow: EvidenceScope = { issueNumber: 42, reRecordedLegs: [] };
    expect(isAllowedEvidencePath("ROADMAP.md", noRow)).toBe(false);
  });

  test("the pre-commitment for this issue is allowed", () => {
    expect(
      isAllowedEvidencePath("docs/superpowers/specs/2026-09-14-issue-42-precommitment.md", SCOPE),
    ).toBe(true);
    expect(
      isAllowedEvidencePath("docs/superpowers/specs/2026-09-14-issue-43-precommitment.md", SCOPE),
    ).toBe(false);
  });

  test("source is never an allowed evidence path", () => {
    // The line the whole check defends: if a path could change behaviour, it belongs before H,
    // where the gates can see it.
    expect(isAllowedEvidencePath("packages/runner/src/store.ts", SCOPE)).toBe(false);
    expect(isAllowedEvidencePath("fixtures/sandbox-data/src/DataMain.Table.al", SCOPE)).toBe(false);
    expect(isAllowedEvidencePath("scripts/agentflow/gate-table.ts", SCOPE)).toBe(false);
  });

  test("a forbidden path in H..F refuses the merge", () => {
    const r = verifyMergeTree(
      { ...CLEAN, evidencePaths: [".agent/issue-42/ledger.md", "packages/runner/src/store.ts"] },
      SCOPE,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("packages/runner/src/store.ts");
  });

  test("Windows separators are normalised", () => {
    expect(isAllowedEvidencePath(".agent\\issue-42\\ledger.md", SCOPE)).toBe(true);
  });
});

describe("container generation", () => {
  test("a container reset between the seal and the merge refuses", () => {
    // "Heartbeat stale" never means "the old writer is dead", which is why generations exist. A
    // container that was reset is not the environment that produced the evidence.
    const r = verifyMergeTree(
      { ...CLEAN, containerGenerations: { "agent-app": 4, "agent-data": 5 } },
      SCOPE,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("was reset");
  });

  test("a container that reports no generation refuses", () => {
    const r = verifyMergeTree({ ...CLEAN, containerGenerations: { "agent-data": 5 } }, SCOPE);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("no generation");
  });
});

describe("SHA-sensitive legs", () => {
  test("a leg that observes commit identity must be rerun on the merge commit", () => {
    const r = verifyMergeTree({ ...CLEAN, shaSensitiveLegs: ["hang"], rerunOnMerge: [] }, SCOPE);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("observes commit identity");
  });

  test("rerunning it satisfies the check", () => {
    expect(
      verifyMergeTree({ ...CLEAN, shaSensitiveLegs: ["hang"], rerunOnMerge: ["hang"] }, SCOPE),
    ).toEqual([]);
  });
});

describe("reasons accumulate", () => {
  test("several problems are all reported, not just the first", () => {
    // A boolean would tell a human nothing about which of eight checks failed.
    const r = verifyMergeTree(
      {
        ...CLEAN,
        mergeParent: "other",
        mergeTree: "tree-9",
        evidencePaths: ["src/x.ts"],
        manifestHash: "m9",
      },
      SCOPE,
    );
    expect(r).toHaveLength(4);
  });
});
