import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as engineModule from "@lethal/engine";
import { initParser, parsesSinceStart } from "@lethal/engine";
import {
  IDENTITY_SCHEME,
  type MutantManifest,
  type MutantManifestEntry,
  gapIdOf,
} from "@lethal/schemata";
import { InstalledArtifactError } from "../src/artifact";
import type {
  CoverageEntry,
  CoverageMode,
  TestMethodRef,
  TestOutcome,
  TestVerdict,
} from "../src/backend";
import { hashTargetSource } from "../src/baseline-snapshot";
import {
  DependencyUnreadableError,
  appInputsOfAppJson,
  readAppJsonInputs,
} from "../src/digest-inputs";
import * as discoveryModule from "../src/discovery";
import { discoverTests } from "../src/discovery";
import { EquivalenceMarksError } from "../src/equivalence-marks";
import { explain } from "../src/explain";
import { bundleOfParts } from "../src/installed-bundle";
import { NamedMutantError } from "../src/named-mutants";
import type { NamedMutantsConfig } from "../src/orchestrator";
import type { MutantOutcome, SessionReport } from "../src/report";
import { identityKeyOf, serializeKey, testKeyOf } from "../src/selection";
import { type MutantVerdict, ResultsStore } from "../src/store";
import { TestAppError } from "../src/test-app-publish";
import { testDigests, testDigestsOfModel } from "../src/test-digest";
import { TestPageScanError, buildTestAppModel, readTestAppSources } from "../src/testpage-scan";
import { TESTPAGE_REFUSED_DIAGNOSIS } from "../src/testpage-unsupported";
import {
  INSTALLED_ARTIFACT_REFUSALS,
  TEST_APP_REFUSALS,
  VERIFY_EXIT,
  VERIFY_REFUSALS,
  type VerifyDeps,
  VerifyError,
  type VerifyPlan,
  type VerifySource,
  assertSourceUnchanged,
  expandGapIds,
  killedByOf,
  parseVerifyRequest,
  planVerify,
  resolveVerifySource,
  runVerify,
  verifyDependencyFingerprint,
  verifyExitCode,
  verifyRefusalOf,
} from "../src/verify";
import type { ReachFilterOffReason } from "../src/verify-reach";
import { droppedNewTestsOf } from "../src/verify-read";
import { tinyBundle } from "./helpers/bundle";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/** R-371: a test project's app.json, with no dependency and no build input (a test project
 *  always has one; a missing one is refused). */
const TEST_APP_JSON = '{"name":"Tests","publisher":"P","version":"1.0.0.0"}';
/** R-371: the dependency fingerprint the planVerify fixtures record and verify with. */
const DEPS = "fixture-dependencies";
/** R-371: the digest inputs of a test project without an app.json, as `planVerify` reads them. */
const INPUTS = { dependencies: DEPS, buildInputs: appInputsOfAppJson({}).buildInputs };

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
    bundle: tinyBundle(artifactId),
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
    buildSymbols: [],
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
      buildSymbols: [],
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
      buildSymbols: [],
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

  test("a record with no stored files, a pruned one, or no source hash is refused before any mutant row is read", () => {
    // Each row has a NULL covering_tests list, on which batchMutantRows throws. The typed refusal
    // must come first. R360: the installed files are the stored bundle, with no path fallback.
    const cases = [
      {
        sql: "UPDATE batch_artifacts SET payload_sha256 = NULL",
        hash: true,
        reason: "source-predates-verify",
        text: "recorded before R360",
      },
      {
        sql: "UPDATE batch_artifacts SET bundle_pruned_by = 9",
        hash: true,
        reason: "artifact-files-unusable",
        text: "pruned when run 9 finished",
      },
      {
        sql: undefined,
        hash: false,
        reason: "source-predates-verify",
        text: "did not record its source hash",
      },
    ] as const;
    for (const c of cases) {
      const store = new ResultsStore(":memory:");
      const runId = store.createRun({
        coverageMode: "procedure",
        identityScheme: IDENTITY_SCHEME,
        buildSymbols: [],
        projectPath: "P",
        backend: "bcdev",
        appVersion: "0.0.0.0",
      });
      store.recordArtifact(runId, artifact(0, A1));
      if (c.sql !== undefined) store.db.exec(c.sql);
      if (c.hash) store.recordSourceHash(runId, "5".repeat(64));
      store.recordMutant(runId, mutantRow("M0001", "survived", { coveringTests: undefined }));
      const e = refusal(() => resolveVerifySource(store, parseVerifyRequest(A1, ["0/M0001"])));
      expect(e.reason).toBe(c.reason);
      expect(e.detail).toContain(c.text);
      store.close();
    }
  });

  test("source-predates-verify names all four reasons a run records no source hash", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      buildSymbols: [],
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
      buildSymbols: [],
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
  writeFileSync(join(dir, "app.json"), TEST_APP_JSON);
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
    writeFileSync(join(dir, "app.json"), TEST_APP_JSON);
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
      buildSymbols: [],
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

  /** `planVerify` against a source run that recorded the test project's CURRENT digests: every
   *  test in it reads as unchanged since the source run (R-278). */
  async function planUnchanged(
    a: Omit<Parameters<typeof planVerify>[0], "sourceTestDigests" | "dependencies" | "coverage"> & {
      /** R-384: verify's coverage mode; default `procedure`, a hub mode, so the filter is off. */
      readonly coverage?: CoverageMode;
    },
  ): Promise<VerifyPlan> {
    const recorded = await testDigests(a.testDir, await discoverTests(a.testDir), INPUTS);
    // A source run records a digest for every test it ran (or none): a baseline test that is gone
    // from the project now still had one then.
    for (const r of a.sourceBaseline)
      recorded[`${r.codeunitId}::${r.method.toLowerCase()}`] ??= `v2:${"0".repeat(64)}`;
    return planVerify({
      coverage: "procedure",
      ...a,
      sourceTestDigests: recorded,
      dependencies: DEPS,
    });
  }

  async function planRefusal(p: Promise<unknown>): Promise<VerifyError> {
    const e = await p.then(
      () => undefined,
      (err: unknown) => err,
    );
    if (e instanceof VerifyError) return e;
    throw new Error(`expected a VerifyError, got ${String(e)}`);
  }

  test("covering tests plus new tests, deduplicated, in that order", async () => {
    const plan = await planUnchanged({
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

  // R403: the parser is initialised BEFORE discovery (arm-aware discovery parses each test file),
  // and discovery receives the test app's derived symbol set. Order by a call log, never timing.
  test("R403: planVerify initialises the parser before discovery, and passes the test build set", async () => {
    const dir = testDir([{ id: 50100, name: "Old", methods: ["A"] }]);
    const recorded = await testDigests(dir, await discoverTests(dir), INPUTS);
    const order: string[] = [];
    const realInit = engineModule.initParser;
    const realDiscover = discoveryModule.discoverTests;
    const init = spyOn(engineModule, "initParser").mockImplementation(() => {
      order.push("initParser");
      return realInit();
    });
    const discover = spyOn(discoveryModule, "discoverTests").mockImplementation(((
      d: string,
      o?: { readonly buildSymbols?: readonly string[] },
    ) => {
      order.push(`discoverTests:${JSON.stringify(o?.buildSymbols ?? null)}`);
      return (realDiscover as (d: string, o?: unknown) => Promise<unknown>)(d, o);
    }) as unknown as typeof realDiscover);
    try {
      await planVerify({
        coverage: "procedure",
        source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.A"] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [row(50100, "Old", "A")],
        sourceTestDigests: recorded,
        dependencies: DEPS,
        testDir: dir,
        testBuildSymbols: ["LETHALX"],
      });
    } finally {
      init.mockRestore();
      discover.mockRestore();
    }
    expect(order).toEqual(["initParser", 'discoverTests:["LETHALX"]']);
  });

  // R403 review: verify compiles the test app ITSELF from the derived set and publishes that, so
  // the suite it runs is the FILTERED one (the al-runner-like case). A source run whose bcdev
  // session had compiled evidence ran the filtered suite too, so its baseline has no row for a
  // compiled-out test: reading it as new would count it toward maxNewTests and rerun it.
  function onlyUnderXDir(): { dir: string; recorded: Promise<Record<string, string>> } {
    const dir = testDir([{ id: 50100, name: "Old", methods: ["A"] }]);
    const recorded = discoverTests(dir).then((refs) => testDigests(dir, refs, INPUTS));
    writeFileSync(
      join(dir, "50101.Codeunit.al"),
      `codeunit 50101 "New"\n{\n    Subtype = Test;\n\n#if LETHALX\n    [Test]\n    procedure OnlyUnderX()\n    begin\n    end;\n#endif\n}\n`,
    );
    return { dir, recorded };
  }

  test("R403: a test compiled out under the test build set is neither new nor rerun, and never counts toward maxNewTests", async () => {
    const { dir, recorded } = onlyUnderXDir();
    const plan = await planVerify({
      coverage: "procedure",
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.A"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "Old", "A")],
      sourceTestDigests: await recorded,
      dependencies: DEPS,
      testDir: dir,
      testBuildSymbols: [],
      maxNewTests: 0,
    });
    expect(keys(plan.newTests)).toEqual([]);
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50100::A"]);
  });

  test("R403 control: the same test with LETHALX in the test build set and no baseline row IS new", async () => {
    const { dir, recorded } = onlyUnderXDir();
    const plan = await planVerify({
      coverage: "procedure",
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.A"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "Old", "A")],
      sourceTestDigests: await recorded,
      dependencies: DEPS,
      testDir: dir,
      testBuildSymbols: ["LETHALX"],
    });
    expect(keys(plan.newTests)).toEqual(["50101::OnlyUnderX"]);
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50100::A", "50101::OnlyUnderX"]);
  });

  /** One survivor covered by `T.M`, planned against the given baseline and test codeunits. */
  function coveringPlan(baseline: ReturnType<typeof row>[], codeunits: readonly Codeunit[]) {
    return planUnchanged({
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

  /** The digests a source run recorded over `codeunits`, taken before any later edit. */
  async function recordedOver(codeunits: readonly Codeunit[]): Promise<Record<string, string>> {
    const dir = testDir(codeunits);
    return testDigests(dir, await discoverTests(dir), INPUTS);
  }

  // R258: 50100 A.M is in the source baseline and was edited since, and does not cover the
  // survivor; 50101 B.M shares its method name and is genuinely new. Both are new, so both run.
  test("R258: an edited NON-covering test is new, so it joins every survivor's request", async () => {
    const before = [
      { id: 50100, name: "A", methods: ["M"] },
      { id: 50101, name: "B", methods: ["M"] },
    ];
    const plan = await planVerify({
      coverage: "procedure",
      source: source(project(), [
        { mutantCode: "M0001", coveringTests: [] },
        { mutantCode: "M0002", coveringTests: [] },
      ]),
      manifest: manifest([entry("M0001"), entry("M0002")]),
      sourceBaseline: [row(50100, "A", "M")],
      sourceTestDigests: await recordedOver(before.slice(0, 1)),
      dependencies: DEPS,
      testDir: testDir([
        { id: 50100, name: "A", methods: ["M"], body: "        Error('now asserts');\n" },
        { id: 50101, name: "B", methods: ["M"] },
      ]),
    });
    expect(keys(plan.newTests)).toEqual(["50100::M", "50101::M"]);
    expect(plan.requests.map((r) => keys(r.methods))).toEqual([
      ["50100::M", "50101::M"],
      ["50100::M", "50101::M"],
    ]);
  });

  test("R-278: an edited COVERING test is new, and is in its survivor's request once", async () => {
    const plan = await planVerify({
      coverage: "procedure",
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M", "T.K"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "T", "M"), row(50100, "T", "K")],
      sourceTestDigests: await recordedOver([{ id: 50100, name: "T", methods: ["M", "K"] }]),
      dependencies: DEPS,
      testDir: testDir([
        {
          id: 50100,
          name: "T",
          methods: ["M", "K"],
          body: "        Error('now asserts');\n",
        },
      ]),
    });
    expect(keys(plan.newTests)).toEqual(["50100::M", "50100::K"]);
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50100::M", "50100::K"]);
  });

  // A non-NULL map that lacks a discovered test's key must never read as "unchanged".
  // External review r1 #5 (R-371): a run records a digest for every test or for none, so a map
  // that misses a baseline test, or an empty one, is not a run this build recorded. Before R-371
  // the missing test was read as new; it is now refused, which is the stricter reading.
  test("R-371: a baseline test with no recorded digest in a non-NULL map is source-predates-verify", async () => {
    const codeunits = [{ id: 50100, name: "T", methods: ["M", "K"] }];
    const recorded = await recordedOver(codeunits);
    const { "50100::k": _dropped, ...withoutK } = recorded;
    for (const map of [withoutK, {}]) {
      const e = await planRefusal(
        planVerify({
          coverage: "procedure",
          source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
          manifest: manifest([entry("M0001")]),
          sourceBaseline: [row(50100, "T", "M"), row(50100, "T", "K")],
          sourceTestDigests: map,
          dependencies: DEPS,
          testDir: testDir(codeunits),
        }),
      );
      expect(e.reason).toBe("source-predates-verify");
      expect(e.detail).toContain("50100::K");
    }
  });

  test("R-278: an unchanged test in the source baseline is not new", async () => {
    const codeunits = [{ id: 50100, name: "T", methods: ["M", "K"] }];
    const plan = await planVerify({
      coverage: "procedure",
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "T", "M"), row(50100, "T", "K")],
      sourceTestDigests: await recordedOver(codeunits),
      dependencies: DEPS,
      testDir: testDir(codeunits),
    });
    expect(keys(plan.newTests)).toEqual([]);
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50100::M"]);
  });

  test("R-278: a source run with no recorded test digests is source-predates-verify, never planned", async () => {
    const e = await planRefusal(
      planVerify({
        coverage: "procedure",
        source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [row(50100, "T", "M")],
        sourceTestDigests: null,
        dependencies: DEPS,
        testDir: testDir([{ id: 50100, name: "T", methods: ["M"] }]),
      }),
    );
    expect(e.reason).toBe("source-predates-verify");
    expect(e.detail).toContain("test digests");
  });

  // R-371: a v1 digest (R-278's, no scheme tag) covers the method only; no comparison with it
  // means anything, so verify refuses once instead of reading every test as edited.
  test("R-371: a source run that recorded v1 digests is source-predates-verify, naming the scheme", async () => {
    const codeunits = [{ id: 50100, name: "T", methods: ["M"] }];
    const v2 = await recordedOver(codeunits);
    const v1 = Object.fromEntries(Object.entries(v2).map(([k, d]) => [k, d.replace(/^v2:/, "")]));
    const e = await planRefusal(
      planVerify({
        coverage: "procedure",
        source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [row(50100, "T", "M")],
        sourceTestDigests: v1,
        dependencies: DEPS,
        testDir: testDir(codeunits),
        maxNewTests: 1000,
      }),
    );
    expect(e.reason).toBe("source-predates-verify");
    expect(e.detail).toContain("R-278's scheme");
    expect(e.detail).toContain("once per source run");
  });

  // Review r1 #4: verify reads the test project's build inputs from its app.json; an unreadable
  // one is a dependency-unreadable refusal, never empty inputs.
  test("R-371: a test project whose app.json is missing is refused, never digested over empty inputs", async () => {
    const codeunits = [{ id: 50100, name: "T", methods: ["M"] }];
    const recorded = await recordedOver(codeunits);
    const dir = testDir(codeunits);
    rmSync(join(dir, "app.json"));
    const e = await planVerify({
      coverage: "procedure",
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "T", "M")],
      sourceTestDigests: recorded,
      dependencies: DEPS,
      testDir: dir,
      maxNewTests: 1000,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(DependencyUnreadableError);
    expect(verifyRefusalOf(e)).toMatchObject({ kind: "refused", reason: "dependency-unreadable" });
  });

  // R-371: the scheme check reads no package, so it comes before the dependency read: a v1 source
  // with an unreadable dependency is source-predates-verify, and no package is read at all.
  test("R-371: a v1 source with an unreadable dependency refuses source-predates-verify, reading no package", async () => {
    const codeunits = [{ id: 50100, name: "T", methods: ["M"] }];
    const v2 = await recordedOver(codeunits);
    const v1 = Object.fromEntries(Object.entries(v2).map(([k, d]) => [k, d.replace(/^v2:/, "")]));
    let reads = 0;
    const e = await planRefusal(
      planVerify({
        coverage: "procedure",
        source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [row(50100, "T", "M")],
        sourceTestDigests: v1,
        dependencies: async () => {
          reads += 1;
          throw new DependencyUnreadableError("fixture: the package cannot be read");
        },
        testDir: testDir(codeunits),
        maxNewTests: 1000,
      }),
    );
    expect(e.reason).toBe("source-predates-verify");
    expect(reads).toBe(0);
  });

  describe("R-371: --max-new-tests", () => {
    // One covered survivor and three tests the source run never recorded.
    const capPlan = (maxNewTests: number) =>
      planUnchanged({
        source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [row(50100, "T", "M")],
        testDir: testDir([
          { id: 50100, name: "T", methods: ["M"] },
          { id: 50101, name: "New", methods: ["N1", "N2", "N3"] },
        ]),
        maxNewTests,
      });

    test("exactly at the limit is planned", async () => {
      const plan = await capPlan(3);
      expect(keys(plan.newTests)).toEqual(["50101::N1", "50101::N2", "50101::N3"]);
    });

    // R-384 C1: with the filter off the budget is today's boundary, N = max passes, N = max + 1
    // refuses, and the text says why the filter is off.
    test("R-384 C1: filter off, N = max + 1 refuses with the off text", async () => {
      const e = await planRefusal(capPlan(2));
      expect(e.reason).toBe("too-many-new-tests");
      expect(e.detail).toBe(
        '3 tests are new or edited since run 1. The coverage filter is off (coverage mode "procedure" is a hub mode), so they need 9 extra test runs (6 unmutated, 3 against 1 survivor(s)). The budget is --max-new-tests 2 x (1 survivor(s) + 2) = 6 extra test runs. Edit classes: added: 3 test(s), added or renamed tests. To run them all, pass --max-new-tests 3; or run lethal run again so this source is the recorded one',
      );
    });

    test("R-384 C1: --no-reach-filter under fenced is the same boundary, naming the flag", async () => {
      const plan = (max: number) =>
        planUnchanged({
          source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
          manifest: manifest([entry("M0001")]),
          sourceBaseline: [row(50100, "T", "M")],
          testDir: testDir([
            { id: 50100, name: "T", methods: ["M"] },
            { id: 50101, name: "New", methods: ["N1", "N2", "N3"] },
          ]),
          maxNewTests: max,
          coverage: "fenced",
          noReachFilter: true,
        });
      expect(keys((await plan(3)).newTests)).toHaveLength(3);
      const e = await planRefusal(plan(2));
      expect(e.detail).toContain("The coverage filter is off (--no-reach-filter)");
    });

    // R-384 C2, moved by R-427 (ruling 3): filter on, check 1 is N > B, the baseline runs alone,
    // since a test sent to no survivor is not rerun. With S = 1 the budget is 3 x max; N = B
    // passes, N = B + 1 refuses, before anything is sent.
    const checkOne = (methods: readonly string[], max: number) =>
      planUnchanged({
        source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
        manifest: manifest([entry("M0001")]),
        sourceBaseline: [row(50100, "T", "M")],
        testDir: testDir([
          { id: 50100, name: "T", methods: ["M"] },
          { id: 50101, name: "New", methods },
        ]),
        maxNewTests: max,
        coverage: "fenced",
      });

    const sixNew = ["N1", "N2", "N3", "N4", "N5", "N6"];

    test("R-427 C2: filter on, N = B passes check 1 (2N = 2B, which R-384 refused)", async () => {
      const plan = await checkOne(sixNew, 2);
      expect(keys(plan.newTests)).toHaveLength(6);
    });

    test("R-427 C2: filter on, N = B + 1 refuses with the check-1 text", async () => {
      const e = await planRefusal(checkOne([...sixNew, "N7"], 2));
      expect(e.reason).toBe("too-many-new-tests");
      expect(e.detail).toBe(
        "7 tests are new or edited since run 1. Each runs at least once unmutated, 7 extra test runs, and the coverage filter cannot lower that; without the filter they would need 21. The budget is --max-new-tests 2 x (1 survivor(s) + 2) = 6 extra test runs. Edit classes: added: 7 test(s), added or renamed tests. To run them all, pass --max-new-tests 7; or run lethal run again so this source is the recorded one",
      );
    });

    test("one above the limit is too-many-new-tests, naming N, the value to pass and the edit class", async () => {
      const e = await planRefusal(capPlan(2));
      expect(e.reason).toBe("too-many-new-tests");
      expect(e.detail).toContain("3 tests are new or edited");
      expect(e.detail).toContain("pass --max-new-tests 3");
      expect(e.detail).toContain("added: 3 test(s)");
    });

    // Ruling 2: the refusal names the edit class, read from the recorded parts.
    test("a subscriber edit is named by its class and its procedure", async () => {
      const codeunits = [{ id: 50100, name: "T", methods: ["M", "K"] }];
      const sub = (v: number) =>
        `codeunit 50120 "Sub"\n{\n    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Lib", 'OnX', '', false, false)]\n    local procedure OnX()\n    begin\n        S := ${v};\n    end;\n}\n`;
      const dirWith = (s: number) => {
        const dir = testDir(codeunits);
        writeFileSync(join(dir, "Sub.al"), sub(s));
        return dir;
      };
      await initParser();
      const before = dirWith(1);
      const { digests, parts } = testDigestsOfModel(
        buildTestAppModel(await readTestAppSources(before)),
        await discoverTests(before),
        INPUTS,
      );
      const refuse = async (dir: string) =>
        planRefusal(
          planVerify({
            coverage: "procedure",
            source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
            manifest: manifest([entry("M0001")]),
            sourceBaseline: [row(50100, "T", "M"), row(50100, "T", "K")],
            sourceTestDigests: digests,
            sourceTestDigestParts: parts,
            dependencies: DEPS,
            testDir: dir,
            maxNewTests: 1,
          }),
        );
      const s = await refuse(dirWith(2));
      expect(s.reason).toBe("too-many-new-tests");
      expect(s.detail).toContain("subscriber: 2 test(s)");
      expect(s.detail).toContain("pass --max-new-tests 2");
      expect(s.detail).toContain("Changed procedures: Sub.OnX");
    });
  });

  // R-371: the TestPage scan and the digests share ONE parse of the test app.
  test("R-371: planVerify parses each test-app file once", async () => {
    const dir = testDir([
      { id: 50100, name: "T", methods: ["M"] },
      { id: 50101, name: "U", methods: ["K"] },
    ]);
    const recorded = await testDigests(dir, await discoverTests(dir), INPUTS);
    const before = parsesSinceStart();
    await planVerify({
      coverage: "procedure",
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["T.M"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "T", "M"), row(50101, "U", "K")],
      sourceTestDigests: recorded,
      dependencies: DEPS,
      testDir: dir,
    });
    expect(parsesSinceStart() - before).toBe(2);
  });

  test("an empty source baseline is refused, never read as every test new", async () => {
    const e = await planRefusal(
      planUnchanged({
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
      planUnchanged({
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
  function markedPlan(
    marks: unknown,
    entries: readonly MutantManifestEntry[],
    /** R214: the source run's effective build symbols. */
    buildSymbols: readonly string[] = [],
  ) {
    return planUnchanged({
      source: {
        ...source(
          project(marks),
          entries.map((e) => ({ mutantCode: e.mutantId, coveringTests: ["T.M"] })),
        ),
        buildSymbols,
      },
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

  // R214: a key names a site within one build, so a mark made under other preprocessor symbols
  // than the source run's build is stale and not applied: the survivor runs.
  test("a mark made under other build symbols than the source run's is stale, never applied", async () => {
    const key = "hash-M0001|Logic|Post|lethal.negate-conditional|1";
    const marks = (preprocessorSymbols: readonly string[]) => ({
      identityScheme: IDENTITY_SCHEME,
      marks: [{ key, reason: "same either way", preprocessorSymbols }],
    });
    const other = await markedPlan(marks(["LETHALA"]), [entry("M0001")], ["LETHALB"]);
    expect(other.skipped).toEqual([]);
    expect(other.requests.map((r) => r.mutantId)).toEqual(["M0001"]);
    expect(other.marksUnderOtherScheme.map((m) => [m.key, m.preprocessorSymbols])).toEqual([
      [key, ["LETHALA"]],
    ]);
    // Control: the same mark under the source run's own set is applied.
    const same = await markedPlan(marks(["LETHALB"]), [entry("M0001")], ["LETHALB"]);
    expect(same.skipped.map((x) => x.entry.mutantId)).toEqual(["M0001"]);
    expect(same.marksUnderOtherScheme).toEqual([]);
  });

  // Review r1 item 3: an empty target list must not come back looking like "every target was
  // reader-marked". The all-skipped plan above has a non-empty `skipped`; this one is refused.
  test("an empty target list is refused as malformed-request, never planned as all skipped", async () => {
    const e = await planRefusal(
      planUnchanged({
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
    const plan = await planUnchanged({
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
    const e = await planUnchanged({
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
    const plan = await planUnchanged({
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
    expect(installed.length).toBe(10); // R360 added payload-differs, payload-too-large, replaced
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

  // R-427 (ruling 2): a test sent to no survivor gated no verdict, so it does not block exit 0.
  test("R-427: not-rerun does not block exit 0; it does not mask another state", () => {
    const killed = { verdict: "killed" as const };
    const notRerun = { state: "not-rerun" as const };
    expect(verifyExitCode({ results: [killed], newTests: [notRerun] })).toBe(0);
    expect(verifyExitCode({ results: [killed], newTests: [{ state: "stable" }, notRerun] })).toBe(
      0,
    );
    expect(verifyExitCode({ results: [killed], newTests: [notRerun, { state: "flaky" }] })).toBe(5);
    expect(verifyExitCode({ results: [{ verdict: "survived" }], newTests: [notRerun] })).toBe(5);
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
    buildSymbols: [],
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
      bundle: bundleOfParts({ appBytes, appJsonText: "{}", manifestText, files: [] }),
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
      /** R-278: `null` records no test digests on the source run (a run from before R-278). */
      readonly sourceDigests?: null;
      /** R-384: verify's stderr line sink, its event sink, and `--no-reach-filter`. */
      readonly log?: VerifyDeps["log"];
      readonly emit?: VerifyDeps["emit"];
      readonly noReachFilter?: boolean;
      readonly maxNewTests?: number;
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
      writeFileSync(join(testDir, "app.json"), TEST_APP_JSON);
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
    // R-278: the source run recorded the test project's digests as it is now (NULL on request).
    store.db.run("UPDATE runs SET test_digests = ? WHERE id = ?", [
      over.sourceDigests === null
        ? null
        : JSON.stringify(
            await testDigests(testDir, await discoverTests(testDir), {
              dependencies: await verifyDependencyFingerprint({}, testDir, projectDir),
              buildInputs: (await readAppJsonInputs(testDir)).buildInputs,
            }),
          ),
      runId,
    ]);
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
      log: over.log ?? (() => {}),
      ...(over.emit !== undefined ? { emit: over.emit } : {}),
    };
    const verify = (survivors: readonly string[]) =>
      runVerify(
        {
          artifact: A1,
          survivors,
          testDir,
          ...(over.noReachFilter !== undefined ? { noReachFilter: over.noReachFilter } : {}),
          ...(over.maxNewTests !== undefined ? { maxNewTests: over.maxNewTests } : {}),
        },
        deps,
      );
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
    // R-425: never planned, so the filter never decided for this row.
    expect(r !== undefined && "reachNarrowed" in r).toBe(false);
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
  test("R-278: runVerify refuses a source run with no recorded test digests, before any run row", async () => {
    const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
      sourceDigests: null,
      runNamed: async () => {
        throw new Error("runNamed must not be called when verify refuses");
      },
    });
    const out = await w.verify(["0/M0001"]);
    expect(out.refused?.reason).toBe("source-predates-verify");
    expect(out.refused?.detail).toContain("test digests");
    expect(w.store.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
    w.store.close();
  });

  test("R214: runVerify refuses a source run with no recorded build symbols, before any run row", async () => {
    const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
      runNamed: async () => {
        throw new Error("runNamed must not be called when verify refuses");
      },
    });
    // The shape of a row recorded before R214: the column exists but holds NULL, never `[]`.
    w.store.db.run("UPDATE runs SET build_symbols = NULL");
    const out = await w.verify(["0/M0001"]);
    expect(out.refused?.reason).toBe("source-predates-verify");
    expect(out.refused?.detail).toContain("recorded no build symbols (before R214)");
    expect(w.store.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
    w.store.close();
  });

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

  // R-384 Task 3: verify's reach filter, wired. `T.M` is the source run's covering test; `New.N1`
  // and `New.N2` are new. The `runNamed` below stands in for the server: it measures every
  // requested method's baseline with the coverage given per method, calls `narrow` exactly where
  // runNamedMutants does, and answers each mutant left with a method `survived` (`error` when one
  // of its methods was not green, decision 13's rule).
  describe("R-384: the reach filter in runVerify", () => {
    const POST = [{ objectType: "Codeunit", objectId: 50000, procedure: "Post" }];
    const OTHER = [{ objectType: "Codeunit", objectId: 50000, procedure: "Other" }];

    function reachTestDir(newMethods: readonly string[] = ["N1", "N2"]): string {
      const dir = scratch("lethal-verify-reach-");
      writeFileSync(join(dir, "app.json"), TEST_APP_JSON);
      const proc = (m: string) => `    [Test]\n    procedure ${m}()\n    begin\n    end;\n`;
      writeFileSync(
        join(dir, "50100.Codeunit.al"),
        `codeunit 50100 "T"\n{\n    Subtype = Test;\n\n${proc("M")}}\n`,
      );
      writeFileSync(
        join(dir, "50101.Codeunit.al"),
        `codeunit 50101 "New"\n{\n    Subtype = Test;\n\n${newMethods.map(proc).join("\n")}}\n`,
      );
      return dir;
    }

    function reachRunNamed(
      coverage: Readonly<Record<string, readonly CoverageEntry[]>>,
      o: {
        readonly seen?: NamedMutantsConfig[];
        readonly alSources?: readonly { path: string; text: string }[];
        readonly outcome?: Readonly<Record<string, TestOutcome>>;
        /** R-427: a backend that ignores `notRerun`: reruns every method, reports no notRerun. */
        readonly ignoreNotRerun?: boolean;
        /** R-427: a broken backend that answers a notRerun method in `rerun` as well. */
        readonly rerunAll?: boolean;
        /** R-427: these methods' baseline answers are reported not fresh (narrow saw them fresh). */
        readonly staleBaseline?: readonly string[];
      } = {},
    ): NonNullable<VerifyDeps["runNamed"]> {
      return async (cfg) => {
        o.seen?.push(cfg);
        const keys = new Set<string>();
        const refs = cfg.requests
          .flatMap((r) => r.methods)
          .filter((m) => !keys.has(testKeyOf(m)) && keys.add(testKeyOf(m)) !== undefined);
        const rows = refs.map((ref, i) => {
          const entries = coverage[ref.method];
          const verdict: TestVerdict = {
            ref,
            outcome: o.outcome?.[ref.method] ?? "pass",
            durationMs: 1,
            sessionId: i + 1,
            testRunsBefore: 0,
            ...(entries !== undefined ? { coverage: { granularity: "line", entries } } : {}),
          };
          return { ref, verdict };
        });
        const n = cfg.narrow?.(rows, { coverage: "fenced", alSources: o.alSources ?? [] });
        const unreached = n === undefined ? undefined : [...n.unreached];
        const outcomes = cfg.requests
          .filter((r) => !(unreached ?? []).includes(r.mutantId))
          .map((r) => {
            const methods = n?.methods.get(r.mutantId) ?? r.methods;
            const red = methods.some(
              (m) =>
                rows.find((x) => testKeyOf(x.ref) === testKeyOf(m))?.verdict.outcome !== "pass",
            );
            return {
              mutant: entry(r.mutantId),
              verdict: red ? ("error" as const) : ("survived" as const),
              batchIndex: 0,
            };
          });
        const unmutated = (ref: TestMethodRef, outcome: TestOutcome, fresh = true) => ({
          ref,
          outcome,
          fresh,
          sessionId: 90,
          testRunsBefore: 0,
        });
        // R-427: as runNamedMutants does, a notRerun method runs its baseline only.
        const skip = o.ignoreNotRerun === true ? new Set<string>() : (n?.notRerun ?? new Set());
        const rerunRefs = cfg.rerunOnUnmutated ?? [];
        const notRerun =
          n === undefined || o.ignoreNotRerun === true
            ? undefined
            : rerunRefs.map(testKeyOf).filter((k) => skip.has(k));
        return {
          outcomes,
          ...(unreached !== undefined ? { unreached } : {}),
          baseline: rows.map((r) =>
            unmutated(r.ref, r.verdict.outcome, !(o.staleBaseline ?? []).includes(r.ref.method)),
          ),
          rerun: rerunRefs
            .filter((ref) => o.rerunAll === true || !skip.has(testKeyOf(ref)))
            .map((ref) => unmutated(ref, "pass")),
          ...(notRerun !== undefined ? { notRerun } : {}),
        };
      };
    }

    const fenced = { sourceCoverage: "fenced", backendCoverage: "fenced" } as const;
    const T_M = { codeunitId: 50100, codeunitName: "T", method: "M" };

    test("a new test whose coverage does not reach the survivor is not sent to it", async () => {
      const lines: string[] = [];
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        ...fenced,
        testDir: reachTestDir(),
        baseline: [T_M],
        runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }),
        log: (l) => lines.push(l),
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.refused).toBeUndefined();
      expect(out.results.map((r) => [r.verdict, r.testsRun])).toEqual([
        ["survived", ["T.M", "New.N1"]],
      ]);
      // R-425: the JSON records the state; on carries no reason.
      expect(out.reachFilter).toEqual({ state: "on" });
      // R-425: New.N2 was left out of this survivor's request.
      expect(out.results.map((r) => r.reachNarrowed)).toEqual([true]);
      // Both new tests are still reported (decision 11); since R-427 New.N2, sent to no
      // survivor, runs once (see the R-427 describe below).
      expect(out.newTests.map((t) => t.test)).toEqual(["New.N1", "New.N2"]);
      expect(lines).toEqual([
        "[lethal] verify: reach filter on (fenced coverage): 2 new test(s), 0 joined every survivor because their coverage could not be used; 1 mutant run(s) instead of 2 without the filter; 0 survivor(s) no new test reaches.",
      ]);
      w.store.close();
    });

    test("a survivor no new test reaches, with no covering test, stays survived and nothing is run", async () => {
      const lines: string[] = [];
      const w = await verifyWorld([seed("M0001", undefined, "no-coverage")], [], {
        ...fenced,
        testDir: reachTestDir(),
        baseline: [T_M],
        coveringTests: [],
        runNamed: reachRunNamed({ N1: OTHER, N2: OTHER }),
        log: (l) => lines.push(l),
      });
      const out = await w.verify(["0/M0001"]);
      const [r] = out.results;
      expect(r?.verdict).toBe("survived");
      expect(r?.testsRun).toEqual([]);
      expect(r?.failureNote).toBe(
        "no new test reaches it: the coverage of the 2 new test(s) that could be read shows none of them running Post, so nothing was run (R-384)",
      );
      expect(out.exitCode).toBe(VERIFY_EXIT.notAllKilled);
      // R-425: an unreached survivor with new tests left out is narrowed.
      expect(r?.reachNarrowed).toBe(true);
      expect(lines).toEqual([
        "[lethal] verify: reach filter on (fenced coverage): 2 new test(s), 0 joined every survivor because their coverage could not be used; 0 mutant run(s) instead of 2 without the filter; 1 survivor(s) no new test reaches.",
        "[lethal] verify: survivors no new test reaches: 0/M0001",
      ]);
      w.store.close();
    });

    // RO: refusedObjects come from the INSTALLED sources narrow is handed, never the project on
    // disk (which holds `Logic` unwrapped here).
    test("RO: a survivor in an #if-wrapped object of the stored sources takes every new test", async () => {
      const events: Array<{ code: string; message: string }> = [];
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        ...fenced,
        testDir: reachTestDir(),
        baseline: [T_M],
        runNamed: reachRunNamed(
          { M: POST, N1: POST, N2: OTHER },
          {
            alSources: [
              {
                path: "src/Logic.Codeunit.al",
                text: '#if FOO\ncodeunit 50000 "Logic"\n{\n    procedure Post()\n    begin\n    end;\n}\n#endif\n',
              },
            ],
          },
        ),
        emit: [
          (e) => {
            if (e.type === "warning") events.push({ code: e.code, message: e.message });
          },
        ],
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.results.map((r) => r.testsRun)).toEqual([["T.M", "New.N1", "New.N2"]]);
      expect(events).toEqual([
        {
          code: "verify-reach-fail-closed",
          message:
            "1 survivor(s) take every new test because coverage cannot place their code (R175/R298): 0/M0001",
        },
      ]);
      w.store.close();
    });

    test("a fallback-2 table trigger and a red new test are named in verify-reach-fail-closed warnings", async () => {
      const events: Array<{ code: string; message: string }> = [];
      const trig = seed("M0001", undefined, "survived", {
        objectType: "table",
        codeunitId: 50200,
        procedureName: "",
        triggerName: "OnInsert",
      });
      const w = await verifyWorld([trig], [], {
        ...fenced,
        testDir: reachTestDir(),
        baseline: [T_M],
        runNamed: reachRunNamed({ M: POST, N1: OTHER, N2: OTHER }, { outcome: { N2: "fail" } }),
        emit: [
          (e) => {
            if (e.type === "warning") events.push({ code: e.code, message: e.message });
          },
        ],
      });
      await w.verify(["0/M0001"]);
      expect(events).toEqual([
        {
          code: "verify-reach-fail-closed",
          message:
            "1 new test(s) join every survivor because their coverage could not be used: New.N2 (fail)",
        },
        {
          code: "verify-reach-fail-closed",
          message:
            "1 table-trigger survivor(s) take all 1 new test(s) whose coverage could be read, because none of them touched that table: 0/M0001",
        },
      ]);
      w.store.close();
    });

    test("decision 13: a red new test joins every survivor, so every survivor is error, as before", async () => {
      const seen: NamedMutantsConfig[] = [];
      const w = await verifyWorld(
        [seed("M0001", undefined, "survived"), seed("M0002", undefined, "survived")],
        [],
        {
          ...fenced,
          testDir: reachTestDir(),
          baseline: [T_M],
          runNamed: reachRunNamed(
            { M: POST, N1: POST, N2: OTHER },
            { seen, outcome: { N2: "fail" } },
          ),
        },
      );
      const out = await w.verify(["0/M0001,0/M0002"]);
      expect(out.results.map((r) => [r.verdict, r.testsRun])).toEqual([
        ["error", ["T.M", "New.N1", "New.N2"]],
        ["error", ["T.M", "New.N1", "New.N2"]],
      ]);
      w.store.close();
    });

    test("case 9: a coverage-mode change is still refused first, and no state line is written", async () => {
      const lines: string[] = [];
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        sourceCoverage: "procedure",
        backendCoverage: "fenced",
        testDir: reachTestDir(),
        baseline: [T_M],
        runNamed: async () => {
          throw new Error("runNamed must not be called when verify refuses");
        },
        log: (l) => lines.push(l),
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.refused?.reason).toBe("coverage-mode-changed");
      expect(lines).toEqual([]);
      // R-425: refused before the filter was decided, so the field is absent.
      expect("reachFilter" in out).toBe(false);
      w.store.close();
    });

    test("R-425: a malformed request is refused before the decision, so reachFilter is absent", async () => {
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        ...fenced,
        testDir: reachTestDir(),
        baseline: [T_M],
        runNamed: async () => {
          throw new Error("runNamed must not be called when verify refuses");
        },
      });
      const out = await w.verify(["not-an-id"]);
      expect(out.refused?.reason).toBe("malformed-request");
      expect("reachFilter" in out).toBe(false);
      w.store.close();
    });

    test("R-425: check 1 of the cap refuses after the decision, so reachFilter is present", async () => {
      // Filter on, S = 1, max 1: B = 3, and N = 4 > B refuses in planVerify, before the lease.
      // (R-427: check 1 is N > B; R-384's 2N > B refused this at N = 2.)
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        ...fenced,
        testDir: reachTestDir(["N1", "N2", "N3", "N4"]),
        baseline: [T_M],
        maxNewTests: 1,
        runNamed: async () => {
          throw new Error("runNamed must not be called when verify refuses");
        },
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.refused?.reason).toBe("too-many-new-tests");
      expect(out.verifyRunId).toBeUndefined();
      expect(out.reachFilter).toEqual({ state: "on" });
      w.store.close();
    });

    const offCases: Array<
      [string, Partial<Parameters<typeof verifyWorld>[2]>, string, ReachFilterOffReason]
    > = [
      [
        "--no-reach-filter",
        { ...fenced, noReachFilter: true },
        "--no-reach-filter",
        "no-reach-filter",
      ],
      [
        "hub mode procedure",
        { sourceCoverage: "procedure", backendCoverage: "procedure" },
        'coverage mode "procedure" is a hub mode',
        "coverage-mode-procedure",
      ],
      [
        "hub mode line",
        { sourceCoverage: "line", backendCoverage: "line" },
        'coverage mode "line" is a hub mode',
        "coverage-mode-line",
      ],
      [
        "mode none",
        { sourceCoverage: "none", backendCoverage: "none" },
        'coverage mode "none"',
        "coverage-mode-none",
      ],
    ];
    for (const [name, modes, , reason] of offCases) {
      test(`R-425: filter off (${name}): reachFilter is off with reason ${reason}, and no other key`, async () => {
        const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
          ...modes,
          testDir: reachTestDir(),
          baseline: [T_M],
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }),
          log: () => {},
        });
        const out = await w.verify(["0/M0001"]);
        expect(out.reachFilter).toEqual({ state: "off", reason });
        expect(Object.keys(out.reachFilter ?? {}).sort()).toEqual(["reason", "state"]);
        // R-425: off cannot narrow; with the filter on, this fixture narrows M0001 (New.N2).
        expect(out.results.map((r) => r.reachNarrowed)).toEqual([false]);
        w.store.close();
      });
    }

    test("R-425: filter on, reachNarrowed is per survivor, from the filter's own answer", async () => {
      const w = await verifyWorld(
        [
          seed("M0001", undefined, "survived"),
          seed("M0002", undefined, "survived", { procedureName: "Other" }),
        ],
        [],
        {
          ...fenced,
          testDir: reachTestDir(),
          baseline: [T_M],
          runNamed: reachRunNamed({ M: POST, N1: [...POST, ...OTHER], N2: OTHER }),
        },
      );
      const out = await w.verify(["0/M0001,0/M0002"]);
      expect(out.results.map((r) => [r.mutantCode, r.testsRun, r.reachNarrowed])).toEqual([
        ["M0001", ["T.M", "New.N1"], true],
        ["M0002", ["T.M", "New.N1", "New.N2"], false],
      ]);
      w.store.close();
    });

    // R-425: the dropped list is not stored, because it is derivable. On every reach fixture of this
    // describe, the reader's derivation (newTests minus testsRun) equals the unfiltered request
    // runNamed was handed minus what was sent, and is non-empty exactly when the row says narrowed.
    test("R-425 invariant: droppedNewTestsOf equals request minus sent on every reach fixture", async () => {
      const at = (procedure: string) => [{ objectType: "Codeunit", objectId: 50000, procedure }];
      const fixtures: Array<{
        seeds: Seed[];
        ids: string;
        newMethods?: string[];
        coverage: Record<string, readonly CoverageEntry[]>;
        outcome?: Record<string, TestOutcome>;
        coveringTests?: string[];
      }> = [
        {
          seeds: [seed("M0001", undefined, "survived")],
          ids: "0/M0001",
          coverage: { M: POST, N1: POST, N2: OTHER },
        },
        {
          seeds: [seed("M0001", undefined, "no-coverage")],
          ids: "0/M0001",
          coverage: { N1: OTHER, N2: OTHER },
          coveringTests: [],
        },
        {
          seeds: [
            seed("M0001", undefined, "survived"),
            seed("M0002", undefined, "survived", { procedureName: "Other" }),
          ],
          ids: "0/M0001,0/M0002",
          coverage: { M: POST, N1: [...POST, ...OTHER], N2: OTHER },
        },
        {
          seeds: [
            seed("M0001", undefined, "survived"),
            seed("M0002", undefined, "survived", { procedureName: "Other" }),
            seed("M0003", undefined, "survived", { procedureName: "Third" }),
          ],
          ids: "0/M0001,0/M0002,0/M0003",
          newMethods: ["T1", "T2", "T3"],
          coverage: {
            M: POST,
            T1: [...at("Post"), ...at("Other")],
            T2: at("Post"),
            T3: at("Other"),
          },
        },
        {
          seeds: [seed("M0001", undefined, "survived"), seed("M0002", undefined, "survived")],
          ids: "0/M0001,0/M0002",
          coverage: { M: POST, N1: POST, N2: OTHER },
          outcome: { N2: "fail" },
        },
      ];
      let narrowedRows = 0;
      for (const f of fixtures) {
        const seen: NamedMutantsConfig[] = [];
        const w = await verifyWorld(f.seeds, [], {
          ...fenced,
          testDir: reachTestDir(f.newMethods),
          baseline: [T_M],
          ...(f.coveringTests !== undefined ? { coveringTests: f.coveringTests } : {}),
          runNamed: reachRunNamed(f.coverage, {
            seen,
            ...(f.outcome !== undefined ? { outcome: f.outcome } : {}),
          }),
        });
        const out = await w.verify([f.ids]);
        expect(out.refused).toBeUndefined();
        const [cfg] = seen;
        if (cfg === undefined) throw new Error("runNamed was not called");
        for (const row of out.results) {
          const request = cfg.requests.find((q) => q.mutantId === row.mutantCode);
          if (request === undefined) throw new Error(`no request for ${row.mutantCode}`);
          const sent = new Set(row.testsRun ?? []);
          const requestMinusSent = request.methods
            .map((m) => `${m.codeunitName}.${m.method}`)
            .filter((n) => !sent.has(n));
          const dropped = droppedNewTestsOf(out, row);
          expect(dropped ?? []).toEqual(requestMinusSent);
          expect(row.reachNarrowed).toBe(requestMinusSent.length > 0);
          if (row.reachNarrowed === true) narrowedRows += 1;
        }
        w.store.close();
      }
      // The fixtures do reach both sides of the invariant.
      expect(narrowedRows).toBeGreaterThan(0);
    });

    test("R-425: a skipped (marked equivalent) row has no reachNarrowed", async () => {
      const w = await verifyWorld(
        [seed("M0001", undefined, "survived"), seed("M0002", undefined, "survived")],
        ["M0001"],
        {
          ...fenced,
          testDir: reachTestDir(),
          baseline: [T_M],
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }),
        },
      );
      const out = await w.verify(["0/M0001,0/M0002"]);
      expect(out.reachFilter).toEqual({ state: "on" });
      expect(out.results.map((r) => [r.mutantCode, r.verdict, "reachNarrowed" in r])).toEqual([
        ["M0001", "skipped", false],
        ["M0002", "survived", true],
      ]);
      w.store.close();
    });

    test("R-425: filter on but narrow never called (session latched unsafe): error rows have no reachNarrowed", async () => {
      const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
        ...fenced,
        testDir: reachTestDir(),
        baseline: [T_M],
        // Stands in for runNamedMutants latching unsafe before `select`: no `narrow`, every
        // requested mutant `error`, the unfiltered methods.
        runNamed: async (cfg) => ({
          outcomes: cfg.requests.map((r) => ({
            mutant: entry(r.mutantId),
            verdict: "error" as const,
            batchIndex: 0,
          })),
          baseline: (cfg.rerunOnUnmutated ?? []).map((ref) => ({
            ref,
            outcome: "not-run" as const,
            fresh: false,
          })),
          rerun: (cfg.rerunOnUnmutated ?? []).map((ref) => ({
            ref,
            outcome: "not-run" as const,
            fresh: false,
          })),
        }),
      });
      const out = await w.verify(["0/M0001"]);
      expect(out.reachFilter).toEqual({ state: "on" });
      const [r] = out.results;
      expect(r?.verdict).toBe("error");
      expect(r?.testsRun).toEqual(["T.M", "New.N1", "New.N2"]);
      expect(r !== undefined && "reachNarrowed" in r).toBe(false);
      w.store.close();
    });
    for (const [name, modes, why] of offCases) {
      test(`filter off (${name}): every new test joins every survivor, and the off line says why`, async () => {
        const lines: string[] = [];
        const seen: NamedMutantsConfig[] = [];
        const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
          ...modes,
          testDir: reachTestDir(),
          baseline: [T_M],
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }, { seen }),
          log: (l) => lines.push(l),
        });
        const out = await w.verify(["0/M0001"]);
        expect(seen.map((c) => c.narrow)).toEqual([undefined]);
        expect(out.results.map((r) => r.testsRun)).toEqual([["T.M", "New.N1", "New.N2"]]);
        expect(lines).toEqual([
          `[lethal] verify: reach filter off (${why}): every new test runs against every survivor.`,
        ]);
        w.store.close();
      });
    }

    // R-427: a filterable new test sent to no survivor is not rerun. N1 reaches M0001 (Post); N2
    // reaches only `Other`, which no survivor is in.
    describe("R-427: a new test sent to no survivor is not rerun", () => {
      const world = (over: Partial<Parameters<typeof verifyWorld>[2]> = {}) =>
        verifyWorld([seed("M0001", undefined, "survived")], [], {
          ...fenced,
          testDir: reachTestDir(),
          baseline: [T_M],
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }),
          log: () => {},
          ...over,
        });
      const shapeOf = (out: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["verify"]>>) =>
        out.newTests.map((t) => [t.test, t.state, t.runs.length, "failure" in t]);

      test("acceptance 1: N1 is stable with two runs; N2 is not-rerun with its one fresh baseline run", async () => {
        const seen: NamedMutantsConfig[] = [];
        const w = await world({
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }, { seen }),
        });
        const out = await w.verify(["0/M0001"]);
        expect(out.refused).toBeUndefined();
        expect(shapeOf(out)).toEqual([
          ["New.N1", "stable", 2, false],
          ["New.N2", "not-rerun", 1, false],
        ]);
        expect(out.newTests[1]?.runs).toEqual([
          { outcome: "pass", fresh: true, sessionId: 90, testRunsBefore: 0 },
        ]);
        // Both are still asked for a rerun; runNamedMutants is told, through narrow, to skip N2.
        expect(seen[0]?.rerunOnUnmutated?.map(testKeyOf)).toEqual(["50101::N1", "50101::N2"]);
        // Ruling 2: had every row been killed, these new tests would not block exit 0.
        expect(
          verifyExitCode({
            results: out.results.map(() => ({ verdict: "killed" as const })),
            newTests: out.newTests,
          }),
        ).toBe(VERIFY_EXIT.ok);
        w.store.close();
      });

      const failClosed: Array<[string, Partial<Parameters<typeof verifyWorld>[2]>, string]> = [
        ["--no-reach-filter", { noReachFilter: true }, "stable"],
        [
          "hub mode procedure",
          { sourceCoverage: "procedure", backendCoverage: "procedure" },
          "stable",
        ],
        [
          "N2 red",
          {
            runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }, { outcome: { N2: "fail" } }),
          },
          "red",
        ],
        [
          "N2 with empty coverage",
          { runNamed: reachRunNamed({ M: POST, N1: POST, N2: [] }) },
          "stable",
        ],
      ];
      for (const [name, over, state] of failClosed) {
        test(`fail-closed (${name}): N2 is rerun, never not-rerun`, async () => {
          const w = await world(over);
          const out = await w.verify(["0/M0001"]);
          expect(out.refused).toBeUndefined();
          expect(shapeOf(out).map(([t, s, n]) => [t, s, n])).toEqual([
            ["New.N1", "stable", 2],
            ["New.N2", state, 2],
          ]);
          w.store.close();
        });
      }

      test("REQUIRED: a backend that ignores notRerun is refused, never read as stable", async () => {
        const w = await world({
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }, { ignoreNotRerun: true }),
        });
        await expect(w.verify(["0/M0001"])).rejects.toThrow(
          "the reach filter sent 50101::N2 to no survivor, but runNamedMutants did not skip its rerun",
        );
        w.store.close();
      });

      test("a backend answering a test in both rerun and notRerun is refused", async () => {
        const w = await world({
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }, { rerunAll: true }),
        });
        await expect(w.verify(["0/M0001"])).rejects.toThrow(
          "runNamedMutants answered new test 50101::N2 both rerun and not rerun",
        );
        w.store.close();
      });

      test("a notRerun test whose baseline answer is not a fresh pass is refused", async () => {
        const w = await world({
          runNamed: reachRunNamed({ M: POST, N1: POST, N2: OTHER }, { staleBaseline: ["N2"] }),
        });
        await expect(w.verify(["0/M0001"])).rejects.toThrow(
          "new test 50101::N2 was not rerun, but its baseline was not a fresh pass",
        );
        w.store.close();
      });
    });

    // R-384 The cap (R4): check 2 counts EXECUTIONS after the filter, E = 2N + P, against
    // B = max x (S + 2), with S fixed in planVerify before any filtering. Since R-427,
    // E = N + R + P, R being the new tests sent to at least one survivor (R = N gives 2N + P).
    describe("check 2", () => {
      const at = (procedure: string) => [{ objectType: "Codeunit", objectId: 50000, procedure }];
      // Two survivors, `Post` and `Other`, both covered by T.M; four new tests; max 2, so B = 8.
      const twoSurvivors = () => [
        seed("M0001", undefined, "survived"),
        seed("M0002", undefined, "survived", { procedureName: "Other" }),
      ];
      const fourNew = ["N1", "N2", "N3", "N4"];

      test("C3: E = B passes", async () => {
        const w = await verifyWorld(twoSurvivors(), [], {
          ...fenced,
          testDir: reachTestDir(fourNew),
          baseline: [T_M],
          maxNewTests: 2,
          runNamed: reachRunNamed({
            M: POST,
            N1: at("Third"),
            N2: at("Third"),
            N3: at("Third"),
            N4: at("Third"),
          }),
        });
        const out = await w.verify(["0/M0001,0/M0002"]);
        expect(out.refused).toBeUndefined();
        expect(out.results.map((r) => r.testsRun)).toEqual([["T.M"], ["T.M"]]);
        w.store.close();
      });

      // R-427: every new test here reaches a survivor (R = N), so E = 2N + P and the text keeps
      // R-384's exact form. (R-384's own fixture left three tests unsent; since R-427 they are not
      // rerun, so it no longer refuses: see the R-427 boundary tests below.)
      test("C3/C4: E = B + 1 refuses after the baseline, naming ceil(E / (S + 2))", async () => {
        const w = await verifyWorld(twoSurvivors(), [], {
          ...fenced,
          testDir: reachTestDir(["N1", "N2", "N3"]),
          baseline: [T_M],
          maxNewTests: 2,
          runNamed: reachRunNamed({
            M: POST,
            N1: POST,
            N2: at("Other"),
            N3: POST,
          }),
        });
        const out = await w.verify(["0/M0001,0/M0002"]);
        expect(out.refused?.reason).toBe("too-many-new-tests");
        expect(out.refused?.detail).toBe(
          "3 tests are new or edited since run 1. After the coverage filter they need 9 extra test runs (6 unmutated, 3 against 2 survivor(s); 0 test(s) joined every survivor because their coverage could not be used); without the filter they would need 12. The budget is --max-new-tests 2 x (2 survivor(s) + 2) = 8 extra test runs. The unmutated runs had already run when this was found. Edit classes: added: 3 test(s), added or renamed tests. To run them all, pass --max-new-tests 3; or run lethal run again so this source is the recorded one",
        );
        // Refused after the run row was made: the output names it.
        expect(out.verifyRunId).toBeDefined();
        // R-425: refused after the decision, so the state is recorded.
        expect(out.reachFilter).toEqual({ state: "on" });
        expect(out.results).toEqual([]);
        expect(out.exitCode).toBe(VERIFY_EXIT.refused);
        w.store.close();
      });

      // R-427: E = N + R + P, where R is the new tests sent to at least one survivor; a test sent
      // to none runs its baseline only. N = 3, S = 2, max 2, B = 8.
      test("R-427: E = N + R + P = B passes where R-384's 2N + P = B + 1 refused", async () => {
        // N1 reaches Post and Other, N2 Post, N3 neither: R = 2, P = 3, E = 8; 2N + P = 9.
        const w = await verifyWorld(twoSurvivors(), [], {
          ...fenced,
          testDir: reachTestDir(["N1", "N2", "N3"]),
          baseline: [T_M],
          maxNewTests: 2,
          runNamed: reachRunNamed({
            M: POST,
            N1: [...at("Post"), ...at("Other")],
            N2: at("Post"),
            N3: at("Third"),
          }),
        });
        const out = await w.verify(["0/M0001,0/M0002"]);
        expect(out.refused).toBeUndefined();
        expect(out.results.map((r) => r.testsRun)).toEqual([
          ["T.M", "New.N1", "New.N2"],
          ["T.M", "New.N1"],
        ]);
        expect(out.newTests.map((t) => [t.test, t.state])).toEqual([
          ["New.N1", "stable"],
          ["New.N2", "stable"],
          ["New.N3", "not-rerun"],
        ]);
        w.store.close();
      });

      test("R-427: E = B + 1 with R < N refuses with the not-rerun breakdown", async () => {
        // N1 and N2 reach Post and Other, N3 neither: R = 2, P = 4, E = 9.
        const w = await verifyWorld(twoSurvivors(), [], {
          ...fenced,
          testDir: reachTestDir(["N1", "N2", "N3"]),
          baseline: [T_M],
          maxNewTests: 2,
          runNamed: reachRunNamed({
            M: POST,
            N1: [...at("Post"), ...at("Other")],
            N2: [...at("Post"), ...at("Other")],
            N3: at("Third"),
          }),
        });
        const out = await w.verify(["0/M0001,0/M0002"]);
        expect(out.refused?.reason).toBe("too-many-new-tests");
        expect(out.refused?.detail).toBe(
          "3 tests are new or edited since run 1. After the coverage filter they need 9 extra test runs (5 unmutated: 3 baseline, 2 rerun, 1 test(s) sent to no survivor are not rerun; 4 against 2 survivor(s); 0 test(s) joined every survivor because their coverage could not be used); without the filter they would need 12. The budget is --max-new-tests 2 x (2 survivor(s) + 2) = 8 extra test runs. The unmutated runs had already run when this was found. Edit classes: added: 3 test(s), added or renamed tests. To run them all, pass --max-new-tests 3; or run lethal run again so this source is the recorded one",
        );
        expect(out.verifyRunId).toBeDefined();
        expect(out.exitCode).toBe(VERIFY_EXIT.refused);
        w.store.close();
      });

      test("C5: S is fixed before filtering, so a survivor no new test reaches still counts", async () => {
        // Survivors A (Post), B (Other), C (Third); T1 reaches A and B, T2 A, T3 B, none C.
        // P = 4, E = 10; S = 3, B = 2 x 5 = 10: passes.
        const w = await verifyWorld(
          [
            seed("M0001", undefined, "survived"),
            seed("M0002", undefined, "survived", { procedureName: "Other" }),
            seed("M0003", undefined, "survived", { procedureName: "Third" }),
          ],
          [],
          {
            ...fenced,
            testDir: reachTestDir(["T1", "T2", "T3"]),
            baseline: [T_M],
            maxNewTests: 2,
            runNamed: reachRunNamed({
              M: POST,
              T1: [...at("Post"), ...at("Other")],
              T2: at("Post"),
              T3: at("Other"),
            }),
          },
        );
        const out = await w.verify(["0/M0001,0/M0002,0/M0003"]);
        expect(out.refused).toBeUndefined();
        expect(out.results.map((r) => r.testsRun)).toEqual([
          ["T.M", "New.T1", "New.T2"],
          ["T.M", "New.T1", "New.T3"],
          ["T.M"],
        ]);
        w.store.close();
      });

      test("C6: filter on, every new test fail-closed, N = max passes", async () => {
        const w = await verifyWorld([seed("M0001", undefined, "survived")], [], {
          ...fenced,
          testDir: reachTestDir(),
          baseline: [T_M],
          maxNewTests: 2,
          runNamed: reachRunNamed(
            { M: POST, N1: POST, N2: POST },
            { outcome: { N1: "fail", N2: "fail" } },
          ),
        });
        const out = await w.verify(["0/M0001"]);
        expect(out.refused).toBeUndefined();
        expect(out.results.map((r) => r.testsRun)).toEqual([["T.M", "New.N1", "New.N2"]]);
        w.store.close();
      });
    });
  });
});
