import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { hashTargetSource } from "../src/baseline-snapshot";
import { EquivalenceMarksError } from "../src/equivalence-marks";
import { type MutantVerdict, ResultsStore } from "../src/store";
import {
  VerifyError,
  type VerifySource,
  assertSourceUnchanged,
  parseVerifyRequest,
  planVerify,
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
  // Review r1 item 3: parseVerifyRequest refuses an empty list, but a caller building the typed
  // request directly must be refused too, or it resolves to zero targets and plans as all-skipped.
  test("an empty id list is refused as malformed-request, never resolved to no targets", () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [mutantRow("M0001", "survived")]);
    const e = refusal(() => resolveVerifySource(store, { artifactId: A1, ids: [] }));
    expect(e.reason).toBe("malformed-request");
    store.close();
  });

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
describe("planVerify", () => {
  type Codeunit = { id: number; name: string; methods: readonly string[]; body?: string };

  /** A temp test project with one real `.al` test codeunit per entry. */
  function testDir(codeunits: readonly Codeunit[]): string {
    const dir = mkdtempSync(join(tmpdir(), "lethal-verify-tests-"));
    for (const c of codeunits) {
      const methods = c.methods
        .map((m) => `    [Test]\n    procedure ${m}()\n    begin\n${c.body ?? ""}    end;\n`)
        .join("\n");
      writeFileSync(
        join(dir, `${c.id}.Codeunit.al`),
        `codeunit ${c.id} "${c.name}"\n{\n    Subtype = Test;\n\n${methods}}\n`,
      );
    }
    return dir;
  }

  function entry(mutantId: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
    return {
      mutantId,
      file: "Logic.Codeunit.al",
      startIndex: 10,
      endIndex: 20,
      startLine: 3,
      operatorName: "lethal.negate-conditional",
      operatorVersion: "1.0.0",
      astHash: `hash-${mutantId}`,
      objectType: "codeunit",
      codeunitId: 50000,
      codeunitName: "Logic",
      procedureName: "Post",
      originalText: "a",
      mutatedText: "b",
      ...over,
    };
  }

  function manifest(mutants: readonly MutantManifestEntry[]): MutantManifest {
    return { selectorIds: { selectorId: 1, controlId: 2, tableId: 3 }, artifactId: A1, mutants };
  }

  /** A project dir holding the given marks file, or none when `marks` is undefined. */
  function project(marks?: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "lethal-verify-proj-"));
    if (marks !== undefined) {
      writeFileSync(
        join(dir, "lethal.equivalent.json"),
        typeof marks === "string" ? marks : JSON.stringify(marks),
      );
    }
    return dir;
  }

  function source(
    projectPath: string,
    targets: ReadonlyArray<{ mutantCode: string; coveringTests: readonly string[] }>,
  ): VerifySource {
    return {
      runId: 1,
      projectPath,
      artifactSha256: "0".repeat(64),
      sourceSha256: "5".repeat(64),
      installed: { fromRunId: 1, batchIndex: 0, appPath: "x.app", instrumentedDir: "d" },
      targets: targets.map((t) => ({ batchIndex: 0, ...t })),
    };
  }

  const row = (codeunitId: number, codeunitName: string | null, method: string) => ({
    codeunitId,
    codeunitName,
    method,
  });
  const keys = (refs: ReadonlyArray<{ codeunitId: number; method: string }>) =>
    refs.map((r) => `${r.codeunitId}::${r.method}`);

  async function planRefusal(p: Promise<unknown>): Promise<VerifyError> {
    const e = await p.then(
      () => undefined,
      (err: unknown) => err,
    );
    if (e instanceof VerifyError) return e;
    throw new Error(`expected a VerifyError, got ${String(e)}`);
  }

  test("covering tests plus new tests, deduplicated, in that order", async () => {
    const plan = await planVerify({
      source: source(project(), [
        { mutantCode: "M0001", coveringTests: ["Old.B", "Old.A", "Old.B"] },
        { mutantCode: "M0002", coveringTests: [] },
      ]),
      manifest: manifest([entry("M0001"), entry("M0002")]),
      sourceBaseline: [row(50100, "Old", "A"), row(50100, "Old", "B")],
      testDir: testDir([
        { id: 50100, name: "Old", methods: ["A", "B"] },
        { id: 50101, name: "New", methods: ["N1", "N2"] },
      ]),
    });
    expect(plan.requests.map((r) => r.mutantId)).toEqual(["M0001", "M0002"]);
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual([
      "50100::B",
      "50100::A",
      "50101::N1",
      "50101::N2",
    ]);
    expect(keys(plan.requests[1]?.methods ?? [])).toEqual(["50101::N1", "50101::N2"]);
    expect(keys(plan.newTests)).toEqual(["50101::N1", "50101::N2"]);
    expect(plan.skipped).toEqual([]);
    expect([...plan.entries.keys()]).toEqual(["M0001", "M0002"]);
  });

  /** One survivor covered by `T.M`, planned against the given baseline and test codeunits. */
  function coveringPlan(baseline: ReturnType<typeof row>[], codeunits: readonly Codeunit[]) {
    return planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: baseline,
      testDir: testDir(codeunits),
    });
  }

  test("a renumbered covering codeunit with the same name and method is refused, never run as the old test", async () => {
    const e = await planRefusal(
      coveringPlan([row(50100, "T", "M")], [{ id: 50199, name: "T", methods: ["M"] }]),
    );
    expect(e.reason).toBe("covering-test-unmatched");
    expect(e.detail).toContain("T.M");
    expect(e.detail).toContain("50100");
    expect(e.detail).toContain("50199");
  });

  test("a renamed covering codeunit with the same id is refused", async () => {
    const e = await planRefusal(
      coveringPlan([row(50100, "T", "M")], [{ id: 50100, name: "T2", methods: ["M"] }]),
    );
    expect(e.reason).toBe("covering-test-unmatched");
    expect(e.detail).toContain("T2");
  });

  test("a removed covering method is refused", async () => {
    const e = await planRefusal(
      coveringPlan([row(50100, "T", "M")], [{ id: 50100, name: "T", methods: ["Other"] }]),
    );
    expect(e.reason).toBe("covering-test-unmatched");
    expect(e.detail).toContain("T.M");
  });

  test("a covering name matching two source baseline rows is refused", async () => {
    const e = await planRefusal(
      coveringPlan(
        [row(50100, "T", "M"), row(50101, "T", "M")],
        [{ id: 50100, name: "T", methods: ["M"] }],
      ),
    );
    expect(e.reason).toBe("covering-test-unmatched");
    expect(e.detail).toContain("50100");
    expect(e.detail).toContain("50101");
  });

  test("a source baseline row without a codeunit name is source-predates-verify", async () => {
    const e = await planRefusal(
      coveringPlan(
        [row(50100, "T", "M"), row(50101, null, "X")],
        [{ id: 50100, name: "T", methods: ["M"] }],
      ),
    );
    expect(e.reason).toBe("source-predates-verify");
  });

  test("a test in the source baseline is not new, even if it is edited", async () => {
    // 50100 A.M is in the source baseline and was edited since; 50101 B.M shares its method name
    // and is genuinely new. Only the second is new. The first does not cover the no-coverage
    // survivor, so it does not run at all: the stated blind spot, pinned as behaviour.
    const plan = await planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: [] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "A", "M")],
      testDir: testDir([
        { id: 50100, name: "A", methods: ["M"], body: "        Error('now asserts');\n" },
        { id: 50101, name: "B", methods: ["M"] },
      ]),
    });
    expect(keys(plan.newTests)).toEqual(["50101::M"]);
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50101::M"]);
  });

  test("an empty source baseline is refused, never read as every test new", async () => {
    const e = await planRefusal(
      planVerify({
        source: source(project(), [{ mutantCode: "M0001", coveringTests: [] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [],
        testDir: testDir([{ id: 50100, name: "T", methods: ["M"] }]),
      }),
    );
    expect(e.reason).toBe("source-predates-verify");
  });

  test("a no-coverage survivor with no new test is refused as no-tests-to-run", async () => {
    const e = await planRefusal(
      planVerify({
        source: source(project(), [
          { mutantCode: "M0001", coveringTests: ["T.M"] },
          { mutantCode: "M0002", coveringTests: [] },
        ]),
        manifest: manifest([entry("M0001"), entry("M0002")]),
        sourceBaseline: [row(50100, "T", "M")],
        testDir: testDir([{ id: 50100, name: "T", methods: ["M"] }]),
      }),
    );
    expect(e.reason).toBe("no-tests-to-run");
    expect(e.detail).toContain("0/M0002");
    expect(e.detail).not.toContain("0/M0001");
  });

  /** Survivors all covered by `T.M`, planned against the given marks file. */
  function markedPlan(marks: unknown, entries: readonly MutantManifestEntry[]) {
    return planVerify({
      source: source(
        project(marks),
        entries.map((e) => ({ mutantCode: e.mutantId, coveringTests: ["T.M"] })),
      ),
      manifest: manifest(entries),
      sourceBaseline: [row(50100, "T", "M")],
      testDir: testDir([{ id: 50100, name: "T", methods: ["M"] }]),
    });
  }

  test("a reader-marked survivor is skipped and gets no request in the plan", async () => {
    const marks = {
      marks: [
        { key: "hash-M0001|Logic|Post|lethal.negate-conditional|1", reason: "same either way" },
      ],
    };
    const plan = await markedPlan(marks, [entry("M0001"), entry("M0002")]);
    expect(plan.requests.map((r) => r.mutantId)).toEqual(["M0002"]);
    expect(plan.skipped.map((s) => s.entry.mutantId)).toEqual(["M0001"]);
    expect(plan.skipped[0]?.mark.reason).toBe("same either way");

    const all = await markedPlan(marks, [entry("M0001")]);
    expect(all.requests).toEqual([]);
    expect(all.skipped.map((s) => s.entry.mutantId)).toEqual(["M0001"]);
  });

  // Review r1 item 3: an empty target list must not come back looking like "every target was
  // reader-marked". The all-skipped plan above has a non-empty `skipped`; this one is refused.
  test("an empty target list is refused as malformed-request, never planned as all skipped", async () => {
    const e = await planRefusal(
      planVerify({
        source: source(project(), []),
        manifest: manifest([]),
        sourceBaseline: [row(50100, "T", "M")],
        testDir: testDir([{ id: 50100, name: "T", methods: ["M"] }]),
      }),
    );
    expect(e.reason).toBe("malformed-request");
  });

  test("equivalenceRisk alone never skips", async () => {
    // remove-assignment declares equivalenceRisk "value-rewrite"; with no mark it still runs.
    const plan = await markedPlan(undefined, [
      entry("M0001", { operatorName: "lethal.remove-assignment" }),
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.requests.map((r) => r.mutantId)).toEqual(["M0001"]);
  });

  test("a trigger mutant's mark matches by triggerName", async () => {
    const plan = await markedPlan(
      { marks: [{ key: "hash-M0001|Logic|OnInsert|lethal.negate-conditional|1", reason: "r" }] },
      [entry("M0001", { procedureName: "", triggerName: "OnInsert" })],
    );
    expect(plan.skipped.map((s) => s.entry.mutantId)).toEqual(["M0001"]);
    expect(plan.requests).toEqual([]);
  });

  test("a malformed marks file is thrown, never read as no marks", async () => {
    const e = await markedPlan("{not json", [entry("M0001")]).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(EquivalenceMarksError);
  });
});
