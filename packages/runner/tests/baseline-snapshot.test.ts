import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashAlTree, hashPackage, snapshotApplies, testAppHashFor } from "../src/baseline-snapshot";
import type { BaselineSnapshot } from "../src/baseline-snapshot";
import { ResultsStore } from "../src/store";

/**
 * R192, second half. The two hashes are the whole safety argument for reusing a baseline, so each
 * property here is one the orchestrator relies on without re-checking.
 */

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lethal-snapshot-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
  return dir;
}

const BATCH = {
  "A.Codeunit.al": "codeunit 1 A { }",
  "sub/B.Table.al": "table 2 B { }",
  "app.json": '{"version":"1.0.20692.1"}',
};

describe("hashAlTree (R192)", () => {
  test("the same instrumented tree at two paths hashes the same", async () => {
    expect(await hashAlTree(tree(BATCH))).toBe(await hashAlTree(tree(BATCH)));
  });

  test("a one-byte change to an instrumented line changes it", async () => {
    const a = await hashAlTree(tree(BATCH));
    const b = await hashAlTree(tree({ ...BATCH, "A.Codeunit.al": "codeunit 1 A { } " }));
    expect(b).not.toBe(a);
  });

  test("the three control files are invisible: the selector embeds a random artifact id", async () => {
    const a = await hashAlTree(tree(BATCH));
    const b = await hashAlTree(
      tree({
        ...BATCH,
        "MutationSelector.Codeunit.al": "artifact 3f2a...",
        "MutationRegister.Codeunit.al": "x",
        "MutationUpgrade.Codeunit.al": "y",
      }),
    );
    expect(b).toBe(a);
  });

  test("a non-.al file is invisible, since app.json's minted version differs per artifact", async () => {
    const a = await hashAlTree(tree(BATCH));
    const b = await hashAlTree(tree({ ...BATCH, "app.json": '{"version":"1.0.20692.9"}' }));
    expect(b).toBe(a);
  });
});

describe("testAppHashFor (R192)", () => {
  test("prefers the published package when the backend can read it", async () => {
    const dir = tree({ "T.Codeunit.al": "codeunit 9 T { }" });
    const bytes = new TextEncoder().encode("PK...app bytes");
    const h = await testAppHashFor(async () => bytes, dir);
    expect(h).toBe(`package:${hashPackage(bytes)}`);
  });

  test("a failed package read (null) means NO hash, never a fall-back to the source", async () => {
    // A read that failed says nothing about the server's app; hashing the source instead would let
    // a resume reuse a baseline measured against a package this run cannot see.
    const dir = tree({ "T.Codeunit.al": "codeunit 9 T { }" });
    expect(await testAppHashFor(async () => null, dir)).toBeUndefined();
  });

  test("a backend with no package concept (undefined) falls back to the test source tree", async () => {
    const dir = tree({ "T.Codeunit.al": "codeunit 9 T { }" });
    const viaUndefined = await testAppHashFor(async () => undefined, dir);
    const viaNoReader = await testAppHashFor(undefined, dir);
    expect(viaUndefined).toBe(viaNoReader);
    expect(viaNoReader).toBe(`source:${await hashAlTree(dir)}`);
  });

  test("an unreadable test directory means no hash", async () => {
    expect(await testAppHashFor(undefined, join(tmpdir(), "lethal-no-such-dir"))).toBeUndefined();
  });
});

describe("snapshotApplies (R192)", () => {
  const snap: BaselineSnapshot = {
    runId: 3,
    batchIndex: 1,
    batchHash: "b",
    testAppHash: "package:t",
    baseline: [],
  };
  test("both hashes must match", () => {
    expect(snapshotApplies(snap, "b", "package:t")).toBe(true);
    expect(snapshotApplies(snap, "b2", "package:t")).toBe(false);
    expect(snapshotApplies(snap, "b", "package:t2")).toBe(false);
  });
  test("no snapshot, or no test-app hash, never applies", () => {
    expect(snapshotApplies(null, "b", "package:t")).toBe(false);
    expect(snapshotApplies(snap, "b", undefined)).toBe(false);
  });
});

describe("ResultsStore baseline snapshots (R192)", () => {
  test("round-trips a completed baseline under its two hashes, latest first", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    const ref = { codeunitId: 79100, codeunitName: "Tests", method: "A" };
    store.recordBaselineSnapshot({
      runId: id,
      batchIndex: 0,
      batchHash: "b",
      testAppHash: "package:t",
      baseline: [{ ref, verdict: { ref, outcome: "pass", durationMs: 12 } }],
    });
    store.recordBaselineSnapshot({
      runId: id,
      batchIndex: 0,
      batchHash: "b",
      testAppHash: "package:t",
      baseline: [{ ref, verdict: { ref, outcome: "pass", durationMs: 34 } }],
    });
    const found = store.findBaselineSnapshot("b", "package:t");
    expect(found?.runId).toBe(id);
    expect(found?.baseline[0]?.verdict.durationMs).toBe(34);
    expect(store.findBaselineSnapshot("b", "package:other")).toBeNull();
    expect(store.findBaselineSnapshot("other", "package:t")).toBeNull();
  });
});
