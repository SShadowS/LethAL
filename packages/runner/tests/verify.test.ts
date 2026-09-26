import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTargetSource } from "../src/baseline-snapshot";
import { type MutantVerdict, ResultsStore } from "../src/store";
import {
  VerifyError,
  type VerifySource,
  assertSourceUnchanged,
  parseVerifyRequest,
  resolveVerifySource,
} from "../src/verify";

const A1 = "a".repeat(32);
const A2 = "b".repeat(32);
const APP = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";

function artifact(batchIndex: number, artifactId: string, over: Record<string, unknown> = {}) {
  return {
    batchIndex,
    appVersion: `1.0.1.${batchIndex}`,
    appId: APP,
    artifactId,
    sha256: String(batchIndex).repeat(64),
    manifestSha256: "c".repeat(64),
    appPath: `C:/s/b${batchIndex}/x.app`,
    instrumentedDir: `C:/s/b${batchIndex}`,
    ...over,
  };
}

function mutantRow(mutantCode: string, verdict: MutantVerdict, over: Record<string, unknown> = {}) {
  return {
    mutantCode,
    astHash: "abc123",
    codeunitName: "Sample",
    procedureName: "Post",
    operatorName: "conditional-boundary",
    operatorMajor: 1,
    file: "Sample.Codeunit.al",
    line: 12,
    verdict,
    durationMs: 40,
    batchIndex: 0,
    carried: false,
    coveringTests: ["Sandbox Tests.A"],
    ...over,
  };
}

/** One finished-shape run with one batch, a recorded source hash, and the given mutant rows. */
function oneBatchRun(
  store: ResultsStore,
  artifactId: string,
  rows: ReturnType<typeof mutantRow>[],
  projectPath = "P",
): number {
  const runId = store.createRun({ projectPath, backend: "bcdev", appVersion: "0.0.0.0" });
  store.recordArtifact(runId, artifact(0, artifactId));
  store.recordSourceHash(runId, "5".repeat(64));
  for (const r of rows) store.recordMutant(runId, r);
  return runId;
}

function refusal(fn: () => unknown): VerifyError {
  try {
    fn();
  } catch (e) {
    if (e instanceof VerifyError) return e;
    throw e;
  }
  throw new Error("expected a VerifyError, got none");
}

describe("parseVerifyRequest", () => {
  test("parseVerifyRequest refuses a non-hex artifact, a bare M0004, 0/, M4x and a repeat", () => {
    const ok = parseVerifyRequest(A1, ["0/M0004,0/M0005", "1/M0001"]);
    expect(ok).toEqual({
      artifactId: A1,
      ids: [
        { batchIndex: 0, mutantCode: "M0004" },
        { batchIndex: 0, mutantCode: "M0005" },
        { batchIndex: 1, mutantCode: "M0001" },
      ],
    });
    for (const art of ["A".repeat(32), "a".repeat(31), `${"a".repeat(31)}g`, ""]) {
      expect(refusal(() => parseVerifyRequest(art, ["0/M0004"])).reason).toBe("malformed-request");
    }
    for (const s of [["M0004"], ["0/"], ["0/M4x"], ["M4x"], [], [""], ["0/M0004,"], ["01/M0004"]]) {
      expect(refusal(() => parseVerifyRequest(A1, s)).reason).toBe("malformed-request");
    }
    const rep = refusal(() => parseVerifyRequest(A1, ["0/M0004", "0/M0005,0/M0004"]));
    expect(rep.reason).toBe("malformed-request");
    expect(rep.detail).toContain("0/M0004");
  });
});

describe("resolveVerifySource", () => {
  test("verify refuses an artifact id the store does not hold", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [mutantRow("M0001", "survived")]);
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A2, ["0/M0001"])));
    expect(e.reason).toBe("unknown-artifact");
    expect(e.detail).toContain(A2);
    store.close();
  });

  test("verify refuses an artifact that is not its run's highest batch", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, artifact(0, A1));
    store.recordArtifact(runId, artifact(1, A2));
    store.recordSourceHash(runId, "5".repeat(64));
    store.recordMutant(runId, mutantRow("M0001", "survived"));
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(e.reason).toBe("batch-not-installed");
    store.close();
  });

  test("an id from another batch of the same artifact's run is wrong-batch, even when that batch has the same code", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, artifact(0, A2));
    store.recordArtifact(runId, artifact(1, A1));
    store.recordSourceHash(runId, "5".repeat(64));
    store.recordMutant(runId, mutantRow("M0001", "survived", { batchIndex: 0 }));
    store.recordMutant(runId, mutantRow("M0001", "survived", { batchIndex: 1 }));
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(e.reason).toBe("wrong-batch");
    expect(e.detail).toContain("0/M0001");
    // The artifact's own batch resolves.
    const ok = resolveVerifySource(store, parseVerifyRequest(A1, ["1/M0001"]));
    expect(ok.installed).toEqual({
      fromRunId: runId,
      batchIndex: 1,
      appPath: "C:/s/b1/x.app",
      instrumentedDir: "C:/s/b1",
    });
    store.close();
  });

  test("an id copied from an older run is resolved in the named artifact only", () => {
    const store = new ResultsStore(":memory:");
    const run1 = oneBatchRun(store, A1, [
      mutantRow("M0004", "survived", { coveringTests: ["Run One.T"] }),
    ]);
    // Run 2 is newer and holds the same code with another identity and verdict.
    const run2 = oneBatchRun(
      store,
      A2,
      [mutantRow("M0004", "no-coverage", { astHash: "zzz", coveringTests: ["Run Two.T"] })],
      "P2",
    );
    const src = resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0004"]));
    expect(src.runId).toBe(run1);
    expect(src.projectPath).toBe("P");
    expect(src.artifactSha256).toBe("0".repeat(64));
    expect(src.sourceSha256).toBe("5".repeat(64));
    expect(src.targets).toEqual([
      { batchIndex: 0, mutantCode: "M0004", coveringTests: ["Run One.T"] },
    ]);
    expect(resolveVerifySource(store, parseVerifyRequest(A2, ["0/M0004"])).runId).toBe(run2);
    store.close();
  });

  test("verify refuses a carried row", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [mutantRow("M0001", "survived", { carried: true })]);
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(e.reason).toBe("carried");
    store.close();
  });

  test("verify refuses a row recorded before the carried column existed", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [mutantRow("M0001", "survived", { carried: undefined })]);
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(e.reason).toBe("source-predates-verify");
    store.close();
  });

  test("a record with no installed files or source hash is source-predates-verify, before any mutant row is read", () => {
    // Each row has a NULL covering_tests list, on which batchMutantRows throws. The typed refusal
    // must come first.
    for (const over of [{ appPath: undefined }, { instrumentedDir: undefined }, {}]) {
      const store = new ResultsStore(":memory:");
      const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
      store.recordArtifact(runId, artifact(0, A1, over));
      if (Object.keys(over).length > 0) store.recordSourceHash(runId, "5".repeat(64));
      store.recordMutant(runId, mutantRow("M0001", "survived", { coveringTests: undefined }));
      const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
      expect(e.reason).toBe("source-predates-verify");
      store.close();
    }
  });

  test("a killed or known-survivor row is not-a-survivor, and a no-coverage row is accepted", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [
      mutantRow("M0001", "killed"),
      mutantRow("M0002", "known-survivor"),
      mutantRow("M0003", "no-coverage", { coveringTests: [] }),
      mutantRow("M0004", "survived"),
    ]);
    const killed = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(killed.reason).toBe("not-a-survivor");
    const known = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0002"])));
    expect(known.reason).toBe("not-a-survivor");
    expect(known.detail).toContain("re-run without --skip-known-survivors");
    const ok = resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0003,0/M0004"]));
    expect(ok.targets.map((t) => t.mutantCode)).toEqual(["M0003", "M0004"]);
    expect(ok.targets[0]?.coveringTests).toEqual([]);
    store.close();
  });

  test("an artifact id the store records twice is refused as unknown-artifact, a corrupt store", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [mutantRow("M0001", "survived")]);
    oneBatchRun(store, A1, [mutantRow("M0001", "survived")]);
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(e.reason).toBe("unknown-artifact");
    expect(e.detail).toContain("twice");
    store.close();
  });

  test("a request mixing a wrong-batch id and a carried id refuses as wrong-batch and names both", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, artifact(0, A2));
    store.recordArtifact(runId, artifact(1, A1));
    store.recordSourceHash(runId, "5".repeat(64));
    store.recordMutant(runId, mutantRow("M0001", "survived", { batchIndex: 1, carried: true }));
    const e = refusal(() =>
      resolveVerifySource(store, parseVerifyRequest(A1, ["1/M0001,0/M0002"])),
    );
    expect(e.reason).toBe("wrong-batch");
    expect(e.detail).toContain("1/M0001");
    expect(e.detail).toContain("0/M0002");
    store.close();
  });

  test("every offending id is named, not only the first", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [
      mutantRow("M0001", "survived"),
      mutantRow("M0002", "killed"),
      mutantRow("M0003", "killed"),
    ]);
    const unknown = refusal(() =>
      resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0009,0/M0001,0/M0008"])),
    );
    expect(unknown.reason).toBe("unknown-mutant");
    expect(unknown.detail).toContain("0/M0009");
    expect(unknown.detail).toContain("0/M0008");
    expect(unknown.detail).not.toContain("0/M0001");
    // Different reasons in one request: every offender is still named.
    const mixed = refusal(() =>
      resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0002,0/M0009,0/M0003"])),
    );
    expect(mixed.reason).toBe("unknown-mutant");
    for (const id of ["0/M0002", "0/M0009", "0/M0003"]) expect(mixed.detail).toContain(id);
    store.close();
  });
});

describe("assertSourceUnchanged", () => {
  const SYMBOLS = ["CLEAN24"];

  async function project(): Promise<{ dir: string; source: VerifySource }> {
    const dir = mkdtempSync(join(tmpdir(), "lethal-verify-src-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "app.json"), '{"id":"x"}');
    writeFileSync(join(dir, "src", "Logic.Codeunit.al"), "codeunit 50100 Logic { }");
    writeFileSync(join(dir, "src", "Helper.Codeunit.al"), "codeunit 50101 Helper { }");
    const source: VerifySource = {
      runId: 1,
      projectPath: dir,
      artifactSha256: "0".repeat(64),
      sourceSha256: await hashTargetSource(dir, SYMBOLS),
      installed: { fromRunId: 1, batchIndex: 0, appPath: "x.app", instrumentedDir: "d" },
      targets: [{ batchIndex: 0, mutantCode: "M0001", coveringTests: [] }],
    };
    return { dir, source };
  }

  test("an edit to a helper outside every mutated procedure is refused as source-changed", async () => {
    const { dir, source } = await project();
    writeFileSync(
      join(dir, "src", "Helper.Codeunit.al"),
      "codeunit 50101 Helper { var x: Integer; }",
    );
    const e = await assertSourceUnchanged(source, SYMBOLS).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(VerifyError);
    expect((e as VerifyError).reason).toBe("source-changed");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unchanged project passes the source check", async () => {
    const { dir, source } = await project();
    await assertSourceUnchanged(source, SYMBOLS);
    rmSync(dir, { recursive: true, force: true });
  });
});
