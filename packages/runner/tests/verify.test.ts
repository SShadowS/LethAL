import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  gapIdOf,
} from "@lethal/schemata";
import { InstalledArtifactError } from "../src/artifact";
import type { CoverageMode, TestMethodRef } from "../src/backend";
import { hashTargetSource } from "../src/baseline-snapshot";
import { EquivalenceMarksError } from "../src/equivalence-marks";
import { explain } from "../src/explain";
import { NamedMutantError } from "../src/named-mutants";
import type { NamedMutantsConfig } from "../src/orchestrator";
import type { MutantOutcome, SessionReport } from "../src/report";
import { identityKeyOf, serializeKey, testKeyOf } from "../src/selection";
import { type MutantVerdict, ResultsStore } from "../src/store";
import { TestAppError } from "../src/test-app-publish";
import { TestPageScanError } from "../src/testpage-scan";
import { TESTPAGE_REFUSED_DIAGNOSIS } from "../src/testpage-unsupported";
import {
  INSTALLED_ARTIFACT_REFUSALS,
  TEST_APP_REFUSALS,
  VERIFY_EXIT,
  VERIFY_REFUSALS,
  type VerifyDeps,
  VerifyError,
  type VerifySource,
  assertSourceUnchanged,
  expandGapIds,
  killedByOf,
  parseVerifyRequest,
  planVerify,
  resolveVerifySource,
  runVerify,
  verifyExitCode,
  verifyRefusalOf,
} from "../src/verify";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

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
  const runId = store.createRun({
    coverageMode: "procedure",
    identityScheme: IDENTITY_SCHEME,
    projectPath,
    backend: "bcdev",
    appVersion: "0.0.0.0",
  });
  store.recordArtifact(runId, artifact(0, artifactId));
  store.recordSourceHash(runId, "5".repeat(64));
  for (const r of rows) store.recordMutant(runId, r);
  return runId;
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
      gapIds: [],
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
    const e = refusal(() => resolveVerifySource(store, { artifactId: A1, ids: [], gapIds: [] }));
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
    const runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
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
    const runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
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
    // Carried item 1: the stored path is resolved, so a relative one names a real place.
    expect(src.projectPath).toBe(resolve("P"));
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
      const runId = store.createRun({
        coverageMode: "procedure",
        identityScheme: IDENTITY_SCHEME,
        projectPath: "P",
        backend: "bcdev",
        appVersion: "0.0.0.0",
      });
      store.recordArtifact(runId, artifact(0, A1, over));
      if (Object.keys(over).length > 0) store.recordSourceHash(runId, "5".repeat(64));
      store.recordMutant(runId, mutantRow("M0001", "survived", { coveringTests: undefined }));
      const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
      expect(e.reason).toBe("source-predates-verify");
      store.close();
    }
  });

  test("source-predates-verify names all four reasons a run records no source hash", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
    store.recordArtifact(runId, artifact(0, A1));
    const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
    expect(e.reason).toBe("source-predates-verify");
    for (const cause of [
      "before lethal verify existed",
      "source changed during the run",
      "the run stopped before the last batch",
      "source tree was unreadable",
    ]) {
      expect(e.detail).toContain(cause);
    }
    store.close();
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
    const runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
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
    const dir = scratch("lethal-verify-src-");
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
      identityScheme: IDENTITY_SCHEME,
      coverageMode: "procedure",
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

  test("a relative project path resolves, and a missing project or app.json is project-unreadable", async () => {
    const store = new ResultsStore(":memory:");
    oneBatchRun(store, A1, [mutantRow("M0001", "survived")], "some/rel/app");
    const src = resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"]));
    expect(src.projectPath).toBe(resolve("some/rel/app"));
    store.close();
    const missing = await assertSourceUnchanged(src, SYMBOLS).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(VerifyError);
    expect((missing as VerifyError).reason).toBe("project-unreadable");
    expect((missing as VerifyError).detail).toContain(resolve("some/rel/app"));

    const { dir, source } = await project();
    rmSync(join(dir, "app.json"));
    const noAppJson = await assertSourceUnchanged(source, SYMBOLS).catch((e: unknown) => e);
    expect(noAppJson).toBeInstanceOf(VerifyError);
    expect((noAppJson as VerifyError).reason).toBe("project-unreadable");
    expect((noAppJson as VerifyError).detail).toContain("app.json");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a source change says so in plain words when the test project is nested in the target", async () => {
    const { dir, source } = await project();
    mkdirSync(join(dir, "test"));
    const nestedSource = { ...source, sourceSha256: await hashTargetSource(dir, SYMBOLS) };
    // Only a TEST file changes, inside the nested test project.
    writeFileSync(join(dir, "test", "T.Codeunit.al"), "codeunit 50200 T { }");
    const nested = await assertSourceUnchanged(nestedSource, SYMBOLS, join(dir, "test")).catch(
      (e: unknown) => e,
    );
    expect((nested as VerifyError).reason).toBe("source-changed");
    expect((nested as VerifyError).detail).toContain("lies inside the target project");
    expect((nested as VerifyError).detail).toContain("editing or adding a test there refuses too");
    // A sibling test project: the same refusal, without the nested-project sentence.
    const sibling = await assertSourceUnchanged(
      nestedSource,
      SYMBOLS,
      join(dir, "..", "sibling-tests"),
    ).catch((e: unknown) => e);
    expect((sibling as VerifyError).reason).toBe("source-changed");
    expect((sibling as VerifyError).detail).not.toContain("lies inside the target project");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unchanged project passes the source check", async () => {
    const { dir, source } = await project();
    await assertSourceUnchanged(source, SYMBOLS);
    rmSync(dir, { recursive: true, force: true });
  });
});
/** R-236c: `Old.A` (green, only when asked), `Old.P` and `New.NP`, both with a reachable call that
 *  may open a TestPage. */
function pageTestDir(withGreenA = true): string {
  const dir = scratch("lethal-verify-tp-");
  const a = withGreenA ? "    [Test]\n    procedure A()\n    begin\n    end;\n\n" : "";
  writeFileSync(
    join(dir, "50100.Codeunit.al"),
    `codeunit 50100 "Old"\n{\n    Subtype = Test;\n\n${a}    [Test]\n    procedure P()\n    var\n        Card: TestPage "X";\n    begin\n        Card.OpenView();\n    end;\n}\n`,
  );
  writeFileSync(
    join(dir, "50101.Codeunit.al"),
    `codeunit 50101 "New"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure NP()\n    var\n        Card: TestPage "X";\n    begin\n        Card.Trap();\n    end;\n}\n`,
  );
  return dir;
}

describe("planVerify", () => {
  type Codeunit = { id: number; name: string; methods: readonly string[]; body?: string };

  /** A temp test project with one real `.al` test codeunit per entry. */
  function testDir(codeunits: readonly Codeunit[]): string {
    const dir = scratch("lethal-verify-tests-");
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

  function manifest(mutants: readonly MutantManifestEntry[]): MutantManifest {
    return { selectorIds: { selectorId: 1, controlId: 2, tableId: 3 }, artifactId: A1, mutants };
  }

  /** A project dir holding the given marks file, or none when `marks` is undefined. */
  function project(marks?: unknown): string {
    const dir = scratch("lethal-verify-proj-");
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
      identityScheme: IDENTITY_SCHEME,
      coverageMode: "procedure",
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
      identityScheme: IDENTITY_SCHEME,
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

  // R325: the manifest's keys were made under the source run's identity scheme. A mark made under
  // another may name a different mutant, so it is not applied: the survivor runs.
  test("a mark made under another identity scheme is not applied", async () => {
    const key = "hash-M0001|Logic|Post|lethal.negate-conditional|1";
    const plan = await markedPlan({ marks: [{ key, reason: "same either way" }] }, [
      entry("M0001"),
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.requests.map((r) => r.mutantId)).toEqual(["M0001"]);
    expect(plan.marksUnderOtherScheme.map((m) => [m.key, m.identityScheme])).toEqual([[key, 1]]);
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
      {
        identityScheme: IDENTITY_SCHEME,
        marks: [{ key: "hash-M0001|Logic|OnInsert|lethal.negate-conditional|1", reason: "r" }],
      },
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

  test("R-236c: refused covering and new tests are never planned, and are named as not run", async () => {
    const plan = await planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.A", "Old.P"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "Old", "A"), row(50100, "Old", "P")],
      testDir: pageTestDir(),
    });
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50100::A"]);
    expect(keys(plan.newTests)).toEqual([]);
    expect(plan.notRun.get("M0001")).toEqual(["Old.P", "New.NP"]);
    expect([...plan.testPageRefused.keys()].sort()).toEqual(["50100::P", "50101::NP"]);
    expect(plan.allRefused.size).toBe(0);
  });

  test("R-236c: a reachable parse error is rethrown as TestPageScanError, never a verify refusal", async () => {
    const dir = scratch("lethal-verify-tp-err-");
    writeFileSync(
      join(dir, "50100.Codeunit.al"),
      `codeunit 50100 "T"
{
    Subtype = Test;

    var
        H: Codeunit Helper;

    [Test]
    procedure M()
    begin
        H.Run1();
    end;
}
`,
    );
    writeFileSync(
      join(dir, "50200.Codeunit.al"),
      `codeunit 50200 "Helper"
{
    procedure Run1()
    begin
        if then;
    end;
}
`,
    );
    const e = await planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "T", "M")],
      testDir: dir,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(TestPageScanError);
    expect(verifyRefusalOf(e)).toBeUndefined();
  });

  test("R-236c: a survivor whose every test is refused is planned as all-refused, never as an empty refusal", async () => {
    const plan = await planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.P"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "Old", "P")],
      testDir: pageTestDir(false),
    });
    expect(plan.requests).toEqual([]);
    expect([...plan.allRefused]).toEqual(["M0001"]);
    expect(plan.notRun.get("M0001")).toEqual(["Old.P", "New.NP"]);
  });
});

describe("verifyRefusalOf (carried item 2)", () => {
  test("every reason each caught error class can carry maps to a VERIFY_REFUSALS member, and a recycle-leaving publish quarantines", () => {
    // The two maps are `Record`s over the error classes' own reason unions, so a reason added
    // there fails the typecheck until it is mapped; this enumerates them at runtime.
    const members = new Set<string>(VERIFY_REFUSALS);
    const installed = Object.keys(INSTALLED_ARTIFACT_REFUSALS) as Array<
      keyof typeof INSTALLED_ARTIFACT_REFUSALS
    >;
    expect(installed.length).toBe(7);
    for (const reason of installed) {
      const r = verifyRefusalOf(new InstalledArtifactError(reason, "d"));
      expect(r?.kind).toBe("refused");
      expect(members.has(r?.kind === "refused" ? r.reason : "")).toBe(true);
    }
    expect(verifyRefusalOf(new InstalledArtifactError("mismatch", "d"))).toMatchObject({
      reason: "stale-artifact",
    });
    const testApp = Object.keys(TEST_APP_REFUSALS) as Array<keyof typeof TEST_APP_REFUSALS>;
    expect(testApp.length).toBe(9);
    for (const reason of testApp) {
      const r = verifyRefusalOf(new TestAppError(reason, "d"));
      if (reason === "publish-indeterminate" || reason === "publish-anomalous") {
        expect(r?.kind).toBe("quarantined");
      } else {
        expect(r?.kind).toBe("refused");
        expect(members.has(r?.kind === "refused" ? r.reason : "")).toBe(true);
      }
    }
    // Verify refuses every user-reachable NamedMutantError cause upstream, so one that reaches
    // here is verify's own bad call: rethrown (exit 1), never a refusal the user cannot fix.
    expect(verifyRefusalOf(new NamedMutantError("x"))).toBeUndefined();
    // A malformed lethal.equivalent.json is the user's own input to fix.
    expect(verifyRefusalOf(new EquivalenceMarksError("bad marks"))).toEqual({
      kind: "refused",
      reason: "equivalence-marks-unreadable",
      detail: "bad marks",
    });
    expect(verifyRefusalOf(new VerifyError("carried", "d"))).toEqual({
      kind: "refused",
      reason: "carried",
      detail: "d",
    });
    // Anything else is not a refusal: the caller rethrows it (exit 1).
    expect(verifyRefusalOf(new Error("bug"))).toBeUndefined();
  });
});

describe("killedByOf and verifyExitCode (C02-06 Task 5.4)", () => {
  test("killedByOf reads assertion, runtime-error and other from the measured callstack shapes", () => {
    // Verbatim from a measured report, read from the file so no literal can drift from it.
    const demo = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "examples", "credit-limit", "demo.report.json"),
        "utf8",
      ),
    ) as { mutants: Array<{ killingTestFailure?: string }> };
    const texts = demo.mutants.flatMap((m) =>
      m.killingTestFailure === undefined ? [] : [m.killingTestFailure],
    );
    const find = (prefix: string): string => {
      const t = texts.find((x) => x.startsWith(prefix));
      if (t === undefined) throw new Error(`demo.report.json has no kill text "${prefix}"`);
      return t;
    };
    const TESTS = "Credit Limit Demo Tests";
    // An error whose first frame is in the test app itself (a failed Get in the test body). Since
    // the R231 re-freeze the demo's killers moved (R197 killer-first order), and this is the
    // measured test-app-frame shape it now carries.
    const bare = find("The Credit Order does not exist.");
    expect(bare.split("\n")[1]).toStartWith("Credit Limit Tests(CodeUnit 90250)");
    expect(killedByOf(bare, TESTS)).toBe("other");
    // The test's own asserterror expectation failed.
    expect(
      killedByOf(find("Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException"), TESTS),
    ).toBe("assertion");
    // An error raised in the TARGET app (Credit Limit Demo), measured in the same report. The
    // brief allowed this shape to be constructed; the demo has a measured one, so it is used.
    const target = find("An order of 600 would take customer C-10000 over their credit limit.");
    expect(target.split("\n")[1]).toStartWith(
      "Credit Limit Mgt(CodeUnit 90204).CheckCreditLimit line",
    );
    expect(killedByOf(target, TESTS)).toBe("runtime-error");
    // Library Assert's prefix is an assertion wherever it was raised.
    expect(killedByOf("Assert.AreEqual failed. Expected:<1> Actual:<0>.", TESTS)).toBe("assertion");
    // No second line: nothing to read a frame from.
    expect(killedByOf("Expected an order of 400, got 0.", TESTS)).toBe("other");
    expect(killedByOf(undefined, TESTS)).toBe("other");
  });

  test("the exit code precedence is 3, 6, 4, 5, 0", () => {
    const killed = { verdict: "killed" as const };
    const survived = { verdict: "survived" as const };
    const error = { verdict: "error" as const };
    const skipped = { verdict: "skipped" as const };
    const stable = { state: "stable" as const };
    const flaky = { state: "flaky" as const };
    const refused = { reason: "carried", detail: "d" };
    expect(verifyExitCode({ quarantined: "q", refused, results: [error], newTests: [flaky] })).toBe(
      3,
    );
    expect(verifyExitCode({ refused, results: [error], newTests: [flaky] })).toBe(6);
    expect(verifyExitCode({ results: [error, error, skipped], newTests: [flaky] })).toBe(4);
    expect(verifyExitCode({ results: [error, killed], newTests: [stable] })).toBe(5);
    expect(verifyExitCode({ results: [survived, killed], newTests: [stable] })).toBe(5);
    expect(verifyExitCode({ results: [killed, skipped], newTests: [flaky] })).toBe(5);
    expect(verifyExitCode({ results: [killed], newTests: [{ state: "infra-error" }] })).toBe(5);
    expect(verifyExitCode({ results: [killed, skipped], newTests: [stable] })).toBe(0);
    // Every survivor skipped: nothing measured, and nothing wrong either.
    expect(verifyExitCode({ results: [skipped], newTests: [] })).toBe(0);
  });
});
// C02-09 Task 6: gap ids in --survivors.
const GA = "Gaaaaaaaaaaaa";
const GB = "Gbbbbbbbbbbbb";
const GC = "Gcccccccccccc";
const GD = "Gdddddddddddd";

type Seed = {
  readonly entry: MutantManifestEntry;
  readonly verdict: MutantVerdict;
  readonly carried?: boolean;
  /** No store row: the source run stopped before scoring it. */
  readonly unrecorded?: boolean;
};

function seed(
  mutantId: string,
  gapId: string | undefined,
  verdict: MutantVerdict,
  over: Partial<MutantManifestEntry> & {
    readonly carried?: boolean;
    readonly unrecorded?: boolean;
  } = {},
): Seed {
  const { carried, unrecorded, ...rest } = over;
  return {
    entry: entry(mutantId, {
      startLine: Number(mutantId.slice(1)),
      ...(gapId !== undefined ? { gapId } : {}),
      ...rest,
    }),
    verdict,
    ...(carried !== undefined ? { carried } : {}),
    ...(unrecorded !== undefined ? { unrecorded } : {}),
  };
}

/** A one-batch run whose installed files are on disk, so `loadInstalledArtifact` runs for real. */
function installedRun(
  store: ResultsStore,
  artifactId: string,
  seeds: readonly Seed[],
  projectPath = "P",
  sourceSha256 = "5".repeat(64),
  coveringTests: readonly string[] = ["T.M"],
): number {
  const dir = scratch("lethal-verify-gap-");
  const manifest: MutantManifest = {
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    artifactId,
    mutants: seeds.map((s) => s.entry),
  };
  const manifestText = JSON.stringify(manifest);
  writeFileSync(join(dir, "mutant-manifest.json"), manifestText);
  writeFileSync(join(dir, "app.json"), "{}");
  const appBytes = new TextEncoder().encode(`app-${artifactId}`);
  writeFileSync(join(dir, "x.app"), appBytes);
  const runId = store.createRun({
    coverageMode: "procedure",
    identityScheme: IDENTITY_SCHEME,
    projectPath,
    backend: "bcdev",
    appVersion: "0.0.0.0",
  });
  store.recordArtifact(
    runId,
    artifact(0, artifactId, {
      sha256: Bun.SHA256.hash(appBytes, "hex"),
      manifestSha256: Bun.SHA256.hash(manifestText, "hex"),
      appPath: join(dir, "x.app"),
      instrumentedDir: dir,
    }),
  );
  store.recordSourceHash(runId, sourceSha256);
  for (const s of seeds) {
    if (s.unrecorded === true) continue;
    store.recordMutant(
      runId,
      mutantRow(s.entry.mutantId, s.verdict, {
        astHash: s.entry.astHash,
        codeunitName: s.entry.codeunitName,
        procedureName: s.entry.procedureName,
        operatorName: s.entry.operatorName,
        file: s.entry.file,
        line: s.entry.startLine,
        carried: s.carried ?? false,
        coveringTests: [...coveringTests],
      }),
    );
  }
  return runId;
}

async function asyncRefusal(p: Promise<unknown>): Promise<VerifyError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (e instanceof VerifyError) return e;
  throw new Error(`expected a VerifyError, got ${String(e)}`);
}

/** What the user reads: the refusal's detail with its advice, as verify prints it. */
function printedDetail(e: VerifyError): string {
  const r = verifyRefusalOf(e);
  if (r?.kind !== "refused") throw new Error("not a refusal");
  return r.detail;
}

const idsOf = (req: {
  readonly ids: ReadonlyArray<{ readonly batchIndex: number; readonly mutantCode: string }>;
}) => req.ids.map((i) => `${i.batchIndex}/${i.mutantCode}`);

describe("C02-09: gap ids", () => {
  test("G0123456789ab is a gap id; g0123..., G012 and 0/G0123456789ab are malformed-request", () => {
    expect(parseVerifyRequest(A1, ["G0123456789ab"])).toEqual({
      artifactId: A1,
      ids: [],
      gapIds: ["G0123456789ab"],
    });
    for (const bad of ["g0123456789ab", "G012", "0/G0123456789ab", "G0123456789AB"]) {
      const e = refusal(() => parseVerifyRequest(A1, [bad]));
      expect(e.reason).toBe("malformed-request");
      // The message names both accepted forms.
      expect(e.detail).toContain("0/M0004");
      expect(e.detail).toContain("G0123456789ab");
    }
  });

  test("a mix of a gap id and a mutant id parses into both lists", () => {
    expect(parseVerifyRequest(A1, ["G0123456789ab,0/M0004", "1/M0002"])).toEqual({
      artifactId: A1,
      ids: [
        { batchIndex: 0, mutantCode: "M0004" },
        { batchIndex: 1, mutantCode: "M0002" },
      ],
      gapIds: ["G0123456789ab"],
    });
  });

  test("the same gap id twice is malformed-request", () => {
    const e = refusal(() => parseVerifyRequest(A1, ["G0123456789ab", "G0123456789ab"]));
    expect(e.reason).toBe("malformed-request");
    expect(e.detail).toContain("G0123456789ab");
  });

  test("a gap id expands to its survived members, in the named artifact", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "survived"),
      seed("M0003", GA, "killed"),
    ]);
    const req = await expandGapIds(store, parseVerifyRequest(A1, [GA]));
    expect(idsOf(req)).toEqual(["0/M0001", "0/M0002"]);
    expect(req.gapIds).toEqual([]);
    store.close();
  });

  test("an unknown gap id is refused as unknown-gap, and the detail names an edited block, a moved block and the last-batch rule", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [seed("M0001", GA, "survived")]);
    const e = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [GB])));
    expect(e.reason).toBe("unknown-gap");
    const detail = printedDetail(e);
    expect(detail).toContain(GB);
    expect(detail).toContain("an edited or moved block");
    expect(detail).toContain("only the run's last batch stays installed");
    store.close();
  });

  test("a stale id fails: the id of a block's old text is unknown-gap against a manifest built from its new text", async () => {
    const now = gapIdOf("Logic.Codeunit.al", 40, 60, "begin X := 2; end");
    const old = gapIdOf("Logic.Codeunit.al", 40, 60, "begin X := 1; end");
    expect(old).not.toBe(now);
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [seed("M0001", now, "survived")]);
    const err = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [old])));
    expect(err.reason).toBe("unknown-gap");
    expect(err.detail).toContain(old);
    // The current id still expands.
    expect(idsOf(await expandGapIds(store, parseVerifyRequest(A1, [now])))).toEqual(["0/M0001"]);
    store.close();
  });

  test("a block with no survived row is refused as gap-has-no-survivor, with its counts", async () => {
    const killed = new ResultsStore(":memory:");
    installedRun(killed, A1, [
      seed("M0001", GA, "killed"),
      seed("M0002", GA, "timeout-killed"),
      seed("M0003", GA, "error"),
    ]);
    const k = await asyncRefusal(expandGapIds(killed, parseVerifyRequest(A1, [GA])));
    expect(k.reason).toBe("gap-has-no-survivor");
    expect(k.detail).toContain(GA);
    expect(k.detail).toContain("survived 0, killed 2, no-coverage 0, other 1");
    expect(k.detail).not.toContain("noCoverageBlocks");
    killed.close();

    const noCov = new ResultsStore(":memory:");
    installedRun(noCov, A1, [seed("M0001", GA, "no-coverage"), seed("M0002", GA, "no-coverage")]);
    const n = await asyncRefusal(expandGapIds(noCov, parseVerifyRequest(A1, [GA])));
    expect(n.reason).toBe("gap-has-no-survivor");
    expect(n.detail).toContain("no-coverage 2");
    expect(n.detail).toContain("noCoverageBlocks");
    expect(n.detail).toContain("0/M0001, 0/M0002");
    noCov.close();
  });

  // Review fix round 1: a run that quarantined or threw partway through its last batch records its
  // artifact, but its unscored manifest entries have no row. Those are not measured, not corruption.
  // `installedRun` never calls `finishRun`, so these runs are UNFINISHED, which is what allows it.
  test("a gap with one recorded survivor and one unrecorded entry expands to the survivor", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "survived", { unrecorded: true }),
    ]);
    expect(idsOf(await expandGapIds(store, parseVerifyRequest(A1, [GA])))).toEqual(["0/M0001"]);
    store.close();
  });

  test("a gap whose recorded rows hold no survivor refuses gap-has-no-survivor, unrecorded entries or not", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [
      seed("M0001", GA, "killed"),
      seed("M0002", GA, "survived", { unrecorded: true }),
      seed("M0003", GB, "survived", { unrecorded: true }),
    ]);
    const a = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [GA])));
    expect(a.reason).toBe("gap-has-no-survivor");
    expect(a.detail).toContain("survived 0, killed 1, no-coverage 0, other 0, not measured 1");
    // No recorded row at all: the manifest still carries the id, so it is not unknown.
    const b = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [GB])));
    expect(b.reason).toBe("gap-has-no-survivor");
    expect(b.detail).toContain("not measured 1");
    store.close();
  });

  // Review r1 finding 1: "not measured" is allowed ONLY on a run that did not finish. A finished
  // run scored every manifest entry, so a missing row is a lost row, and reading it as "not
  // measured" would silently drop a survivor (or turn a gap into gap-has-no-survivor).
  test("on a FINISHED run, a manifest entry with no row throws as a corrupt store, never a refusal or a smaller expansion", async () => {
    const store = new ResultsStore(":memory:");
    const runId = installedRun(store, A1, [
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "survived", { unrecorded: true }),
      seed("M0003", GB, "survived", { unrecorded: true }),
    ]);
    store.finishRun(runId, { batchCount: 1, baselineGreen: true });
    for (const g of [GA, GB]) {
      const e = await expandGapIds(store, parseVerifyRequest(A1, [g])).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(VerifyError);
      expect((e as Error).message).toContain("run 1 finished");
      expect((e as Error).message).toContain("M0002, M0003");
      expect((e as Error).message).toContain("(a corrupt store)");
    }
    store.close();
  });

  test("on a FINISHED run with every row recorded, a gap still expands", async () => {
    const store = new ResultsStore(":memory:");
    const runId = installedRun(store, A1, [
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "killed"),
    ]);
    store.finishRun(runId, { batchCount: 1, baselineGreen: true });
    expect(idsOf(await expandGapIds(store, parseVerifyRequest(A1, [GA])))).toEqual(["0/M0001"]);
    store.close();
  });

  test("two rows for one mutant still throw as a corrupt store, never a refusal", async () => {
    const store = new ResultsStore(":memory:");
    const runId = installedRun(store, A1, [seed("M0001", GA, "survived")]);
    store.recordMutant(runId, mutantRow("M0001", "survived", { line: 1 }));
    const e = await expandGapIds(store, parseVerifyRequest(A1, [GA])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(VerifyError);
    expect((e as Error).message).toContain("a mutant twice (a corrupt store)");
    store.close();
  });

  test("every offending gap id is named", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [seed("M0001", GA, "killed"), seed("M0002", GB, "survived")]);
    const e = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [GA, GC, GB])));
    // Unknown before empty; both named, the good one not.
    expect(e.reason).toBe("unknown-gap");
    expect(e.detail).toContain(`${GC} (unknown-gap`);
    expect(e.detail).toContain(`${GA} (gap-has-no-survivor`);
    expect(e.detail).not.toContain(GB);
    store.close();
  });

  test("a gap id against a manifest with no gap ids is source-predates-verify, and a mutant id against the same artifact still resolves", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [seed("M0001", undefined, "survived")]);
    const e = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [GA])));
    expect(e.reason).toBe("source-predates-verify");
    expect(e.detail).toContain(GA);
    const ids = await expandGapIds(store, parseVerifyRequest(A1, ["0/M0001"]));
    expect(resolveVerifySource(store, ids).targets.map((t) => t.mutantCode)).toEqual(["M0001"]);
    store.close();
  });

  test("a mutant named directly and through its gap is malformed-request, naming both spellings", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [seed("M0001", GA, "survived"), seed("M0002", GA, "survived")]);
    const e = await asyncRefusal(expandGapIds(store, parseVerifyRequest(A1, [`${GA},0/M0002`])));
    expect(e.reason).toBe("malformed-request");
    expect(e.detail).toContain(`0/M0002 and ${GA}`);
    expect(e.detail).not.toContain("0/M0001");
    store.close();
  });

  test("a carried member refuses the whole request as carried, naming the member", async () => {
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "survived", { carried: true }),
    ]);
    const req = await expandGapIds(store, parseVerifyRequest(A1, [GA]));
    const e = refusal(() => resolveVerifySource(store, req));
    expect(e.reason).toBe("carried");
    expect(e.detail).toContain("0/M0002");
    expect(e.detail).not.toContain("0/M0001");
    store.close();
  });

  test("expansion reads the named artifact, not the id's origin", async () => {
    // Two runs of the same, unchanged source: the same gap id, different verdicts per run.
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, [seed("M0001", GA, "survived"), seed("M0002", GA, "killed")]);
    installedRun(store, A2, [seed("M0001", GA, "killed"), seed("M0002", GA, "survived")]);
    expect(idsOf(await expandGapIds(store, parseVerifyRequest(A1, [GA])))).toEqual(["0/M0001"]);
    expect(idsOf(await expandGapIds(store, parseVerifyRequest(A2, [GA])))).toEqual(["0/M0002"]);
    store.close();
  });

  /** A real project, test project, baseline and installed artifact: `runVerify` end to end, with
   *  the `runNamed` seam standing in for the server (every requested mutant survives). */
  async function verifyWorld(
    seeds: readonly Seed[],
    markCodes: readonly string[] = [],
    /** R-236c: another test project, its source baseline, the covering names, a `runNamed`. */
    over: {
      readonly testDir?: string;
      readonly baseline?: readonly TestMethodRef[];
      readonly coveringTests?: readonly string[];
      readonly runNamed?: VerifyDeps["runNamed"];
      /** R354: the coverage mode verify's backend reports (default `procedure`). */
      readonly backendCoverage?: CoverageMode;
      /** R354: the source run's recorded mode, written by SQL (`null` for a pre-R354 row). */
      readonly sourceCoverage?: CoverageMode | null;
    } = {},
  ) {
    const projectDir = scratch("lethal-verify-gap-proj-");
    writeFileSync(join(projectDir, "app.json"), '{"id":"x"}');
    mkdirSync(join(projectDir, "src"));
    writeFileSync(join(projectDir, "src", "Logic.Codeunit.al"), 'codeunit 50000 "Logic" { }');
    const marks = seeds
      .filter((s) => markCodes.includes(s.entry.mutantId))
      .map((s) => ({ key: serializeKey(identityKeyOf(s.entry)), reason: "same either way" }));
    if (marks.length > 0) {
      writeFileSync(
        join(projectDir, "lethal.equivalent.json"),
        JSON.stringify({ identityScheme: IDENTITY_SCHEME, marks }),
      );
    }
    const testDir = over.testDir ?? scratch("lethal-verify-gap-tests-");
    if (over.testDir === undefined) {
      writeFileSync(
        join(testDir, "50100.Codeunit.al"),
        'codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure M()\n    begin\n    end;\n}\n',
      );
    }
    const store = new ResultsStore(":memory:");
    const runId = installedRun(
      store,
      A1,
      seeds,
      projectDir,
      await hashTargetSource(projectDir, []),
      over.coveringTests,
    );
    for (const ref of over.baseline ?? [{ codeunitId: 50100, codeunitName: "T", method: "M" }]) {
      store.recordTestResult(runId, null, null, ref, "pass", 1);
    }
    if (over.sourceCoverage !== undefined) {
      store.db.run("UPDATE runs SET coverage_mode = ? WHERE id = ?", [over.sourceCoverage, runId]);
    }
    const boom = (): never => {
      throw new Error("verify.test.ts gap fixture: not used on this path");
    };
    const byId = new Map(seeds.map((s) => [s.entry.mutantId, s.entry] as const));
    const deps: VerifyDeps = {
      store,
      backend: {
        capabilities: () => ({
          coverage: over.backendCoverage ?? "procedure",
          deploy: "publish",
          isolation: "session",
          authoritative: true,
        }),
        status: async () => boom(),
        deploy: async () => boom(),
        compileCheck: async () => boom(),
        activate: async () => boom(),
        run: async () => boom(),
        compileTestApp: async (_dir, target) => ({
          appPath: "t.app",
          sha256: "e".repeat(64),
          appId: APP,
          name: "T",
          publisher: "p",
          version: "1.0.0.0",
          compiledAgainst: { artifactId: target.artifactId, sha256: target.sha256 },
        }),
        publishTestApp: async () => boom(),
      },
      lease: {
        client: {
          acquire: async () => boom(),
          renew: async () => boom(),
          release: async () => boom(),
          beginPublish: async () => boom(),
          endPublish: async () => boom(),
          getOperationStatus: async () => boom(),
          recoverOp: async () => boom(),
        },
        serverGeneration: async () => boom(),
      },
      resourceServer: "http://gap-fixture",
      resourceServerInstance: "BC",
      preprocessorSymbols: [],
      runNamed:
        over.runNamed ??
        (async (cfg) => ({
          outcomes: cfg.requests.map((r) => {
            const mutant = byId.get(r.mutantId);
            if (mutant === undefined) throw new Error(`no seed ${r.mutantId}`);
            return { mutant, verdict: "survived" as const, batchIndex: 0 };
          }),
          baseline: [],
          rerun: [],
        })),
    };
    const verify = (survivors: readonly string[]) =>
      runVerify({ artifact: A1, survivors, testDir }, deps);
    return { store, verify };
  }

  const OLD_A = { codeunitId: 50100, codeunitName: "Old", method: "A" };
  const OLD_P = { codeunitId: 50100, codeunitName: "Old", method: "P" };

  test("R-236c: verify of a survivor whose every test is refused sends nothing and says so", async () => {
    const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
      testDir: pageTestDir(false),
      baseline: [OLD_P],
      coveringTests: ["Old.P"],
      runNamed: async () => {
        throw new Error("runNamed must not be called when every test is refused");
      },
    });
    const out = await w.verify(["0/M0001"]);
    expect(out.refused).toBeUndefined();
    expect(out.newTests).toEqual([]);
    const [r] = out.results;
    expect(r?.verdict).toBe("error");
    expect(r?.notRun).toEqual(["Old.P", "New.NP"]);
    expect(r?.testsRun).toEqual([]);
    expect(r?.failureNote).toContain("TestPage refused, not run");
    expect(out.testPageRefused?.tests).toEqual(["New.NP", "Old.P"]);
    expect(out.testPageRefused?.diagnosis).toBe(TESTPAGE_REFUSED_DIAGNOSIS);
    expect(out.exitCode).toBe(VERIFY_EXIT.nothingMeasured);
    w.store.close();
  });

  test("R-236c: verify of a survivor with one runnable test sends only that one, and hands runNamed the refusal as a guard", async () => {
    const seen: NamedMutantsConfig[] = [];
    const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
      testDir: pageTestDir(),
      baseline: [OLD_A, OLD_P],
      coveringTests: ["Old.A", "Old.P"],
      runNamed: async (cfg) => {
        seen.push(cfg);
        return {
          outcomes: [{ mutant: entry("M0001"), verdict: "survived", batchIndex: 0 }],
          baseline: [],
          rerun: [],
        };
      },
    });
    const out = await w.verify(["0/M0001"]);
    expect(seen.map((c) => c.requests.map((r) => r.methods.map(testKeyOf)))).toEqual([
      [["50100::A"]],
    ]);
    expect([...(seen[0]?.testPageRefused?.keys() ?? [])].sort()).toEqual(["50100::P", "50101::NP"]);
    expect(seen[0]?.rerunOnUnmutated).toEqual([]);
    const [r] = out.results;
    expect(r?.verdict).toBe("survived");
    expect(r?.testsRun).toEqual(["Old.A"]);
    expect(r?.notRun).toEqual(["Old.P", "New.NP"]);
    expect(out.newTests).toEqual([]);
    expect(out.testPageRefused?.tests).toEqual(["New.NP", "Old.P"]);
    w.store.close();
  });

  test("every result carries its entry's gapId, named directly or through a gap", async () => {
    const w = await verifyWorld([
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "survived"),
      seed("M0003", GB, "survived"),
    ]);
    const out = await w.verify([`0/M0003,${GA}`]);
    expect(out.refused).toBeUndefined();
    expect(out.results.map((r) => [r.id, r.gapId, r.verdict])).toEqual([
      ["0/M0003", GB, "survived"],
      ["0/M0001", GA, "survived"],
      ["0/M0002", GA, "survived"],
    ]);
    w.store.close();
  });

  // R354: verify runs the source run's covering tests on its survived and no-coverage verdicts,
  // all attributed under the source's coverage mode, so a mode difference REFUSES, by name.
  describe("R354: verify refuses a source run measured under another coverage mode", () => {
    const neverRun: VerifyDeps["runNamed"] = async () => {
      throw new Error("runNamed must not be called when verify refuses");
    };
    for (const [from, to] of [
      ["none", "procedure"],
      ["procedure", "none"],
      ["fenced", "procedure"],
    ] as const) {
      test(`source ${from}, verify ${to}: refused as coverage-mode-changed`, async () => {
        const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
          sourceCoverage: from,
          backendCoverage: to,
          runNamed: neverRun,
        });
        const out = await w.verify(["0/M0001"]);
        expect(out.refused?.reason).toBe("coverage-mode-changed");
        expect(out.refused?.detail).toContain(`coverage mode ${from}`);
        expect(out.refused?.detail).toContain(`verify measures under coverage mode ${to}`);
        expect(out.refused?.detail).toContain("R354");
        expect(out.exitCode).toBe(VERIFY_EXIT.refused);
        expect(out.results).toEqual([]);
        // Nothing recorded: no verify run row was created.
        expect(w.store.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
        w.store.close();
      });
    }

    test("a source run from before R354 (no recorded mode) is refused as unrecorded", async () => {
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        sourceCoverage: null,
        runNamed: neverRun,
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.refused?.reason).toBe("coverage-mode-changed");
      expect(out.refused?.detail).toContain("an unrecorded coverage mode (the run predates R354)");
      w.store.close();
    });

    test("control: the same mode measures, and the verify run records its own mode", async () => {
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        sourceCoverage: "fenced",
        backendCoverage: "fenced",
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.refused).toBeUndefined();
      expect(out.results.map((r) => r.verdict)).toEqual(["survived"]);
      expect(
        w.store.db.query("SELECT coverage_mode FROM runs WHERE backend = 'lethal-verify'").all(),
      ).toEqual([{ coverage_mode: "fenced" }]);
      w.store.close();
    });
  });

  test("a gap of reader-marked survivors reads exactly like naming them one by one", async () => {
    const w = await verifyWorld(
      [seed("M0001", GA, "survived"), seed("M0002", GA, "survived"), seed("M0003", GA, "killed")],
      ["M0001", "M0002"],
    );
    const byGap = await w.verify([GA]);
    const byIds = await w.verify(["0/M0001,0/M0002"]);
    expect(byGap.exitCode).toBe(0);
    expect(byGap.results.map((r) => r.verdict)).toEqual(["skipped", "skipped"]);
    const sorted = (rs: typeof byGap.results) => [...rs].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(byGap.results)).toEqual(sorted(byIds.results));
    expect(byGap.counts).toEqual(byIds.counts);
    w.store.close();
  });

  test("explain and verify agree on a gap's members", async () => {
    // ONE set of rows, read by both commands. GA holds a no-coverage row between two survivors,
    // GB a killed row beside its survivor; GC is no-coverage only and GD killed only.
    const seeds = [
      seed("M0001", GA, "survived"),
      seed("M0002", GA, "no-coverage"),
      seed("M0003", GA, "survived"),
      seed("M0004", GB, "killed"),
      seed("M0005", GB, "survived"),
      seed("M0006", GC, "no-coverage"),
      seed("M0007", GD, "killed"),
    ];
    const store = new ResultsStore(":memory:");
    installedRun(store, A1, seeds);
    const blockOf: Record<string, number> = { [GA]: 1, [GB]: 4, [GC]: 6, [GD]: 7 };
    const demo = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "examples", "credit-limit", "demo.report.json"),
        "utf8",
      ),
    ) as SessionReport;
    const template = demo.mutants.find((m) => m.verdict === "survived");
    if (template === undefined) throw new Error("demo.report.json has no survivor");
    const { triggerName: _trigger, ...base } = template;
    const mutants: MutantOutcome[] = seeds.map((s) => {
      const gapId = s.entry.gapId ?? "";
      const start = blockOf[gapId] ?? 0;
      return {
        ...base,
        mutantCode: s.entry.mutantId,
        file: s.entry.file,
        line: s.entry.startLine,
        procedureName: s.entry.procedureName,
        verdict: s.verdict,
        batchIndex: 0,
        gapId,
        blockStartLine: start,
        blockEndLine: start + 2,
      };
    });
    const report: SessionReport = {
      ...demo,
      mutants,
      artifacts: [{ batchIndex: 0, artifactId: A1, sha256: "0".repeat(64), appVersion: "1.0.1.0" }],
    };
    const { gaps } = explain(report);
    if (gaps === undefined) throw new Error("explain emitted no gaps");
    expect(gaps.map((g) => g.gapId).sort()).toEqual([GA, GB]);
    for (const g of gaps) {
      if (g.artifactId === undefined) throw new Error(`gap ${g.gapId} has no artifact`);
      const req = await expandGapIds(store, parseVerifyRequest(g.artifactId, [g.gapId]));
      expect(req.ids.map((i) => i.mutantCode)).toEqual([...g.members]);
    }
    store.close();
  });
});
