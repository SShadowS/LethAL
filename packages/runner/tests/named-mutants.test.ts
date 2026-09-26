import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { InstalledArtifactError } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import {
  type InstalledArtifactRef,
  NamedMutantError,
  baselineTestsOf,
  loadInstalledArtifact,
  resolveNamedMutants,
} from "../src/named-mutants";
import { ResultsStore } from "../src/store";

const ARTIFACT_ID = "0123456789abcdef0123456789abcdef";
const APP_ID = "11111111-1111-1111-1111-111111111111";

const MANIFEST = {
  selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  artifactId: ARTIFACT_ID,
  mutants: [
    { mutantId: "M0001", file: "A.Codeunit.al" },
    { mutantId: "M0002", file: "A.Codeunit.al" },
  ],
};

const sha = (bytes: string | Uint8Array) => Bun.SHA256.hash(bytes, "hex");

describe("loadInstalledArtifact (C02-04b Task 6)", () => {
  let dir: string;
  let store: ResultsStore;
  let runId: number;
  let ref: InstalledArtifactRef;
  const appBytes = "PK-fake-app-bytes";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-named-mutants-"));
    const instrumentedDir = join(dir, "run-1-batch-0");
    await Bun.write(
      join(instrumentedDir, "mutant-manifest.json"),
      JSON.stringify(MANIFEST, null, 2),
    );
    const appPath = join(dir, `${sha(appBytes).slice(0, 16)}-${ARTIFACT_ID}.app`);
    await Bun.write(appPath, appBytes);
    store = new ResultsStore(":memory:");
    runId = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runId, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      sha256: sha(appBytes),
      // The compiler's object, stringified; the file on disk is pretty-printed on purpose, so a
      // hash of the raw file text would not match and the parse-then-stringify rule is exercised.
      manifestSha256: sha(JSON.stringify(MANIFEST)),
    });
    ref = { fromRunId: runId, batchIndex: 0, appPath, instrumentedDir };
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("loadInstalledArtifact refuses a manifest with the recorded id but other mutants", async () => {
    const [first] = MANIFEST.mutants;
    await writeFile(
      join(ref.instrumentedDir, "mutant-manifest.json"),
      JSON.stringify({ ...MANIFEST, mutants: [first] }),
    );
    await expect(loadInstalledArtifact(store, ref)).rejects.toMatchObject({
      reason: "manifest-differs",
    });
  });

  test("loadInstalledArtifact refuses a manifest whose hash matches but whose id does not", async () => {
    // Record the hash of a manifest carrying ANOTHER id: the hash link holds, the id link must not.
    const other = { ...MANIFEST, artifactId: "f".repeat(32) };
    await writeFile(join(ref.instrumentedDir, "mutant-manifest.json"), JSON.stringify(other));
    const runB = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runB, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      sha256: sha(appBytes),
      manifestSha256: sha(JSON.stringify(other)),
    });
    await expect(loadInstalledArtifact(store, { ...ref, fromRunId: runB })).rejects.toMatchObject({
      reason: "manifest-differs",
    });
  });

  test("loadInstalledArtifact refuses a .app that is not the recorded bytes", async () => {
    await appendFile(ref.appPath, "x");
    await expect(loadInstalledArtifact(store, ref)).rejects.toMatchObject({
      reason: "local-copy-differs",
    });
  });

  test("loadInstalledArtifact refuses a missing file and a corrupt manifest as local-copy-unreadable", async () => {
    await rm(ref.appPath);
    const missing = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(InstalledArtifactError);
    expect(missing).toMatchObject({ reason: "local-copy-unreadable" });
    // The cause text is kept, so the refusal says WHICH read failed.
    expect((missing as InstalledArtifactError).detail).toContain(ref.appPath);

    await Bun.write(ref.appPath, appBytes);
    await writeFile(join(ref.instrumentedDir, "mutant-manifest.json"), "{not json");
    const corrupt = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(corrupt).toBeInstanceOf(InstalledArtifactError);
    expect(corrupt).toMatchObject({ reason: "local-copy-unreadable" });

    await rm(join(ref.instrumentedDir, "mutant-manifest.json"));
    await expect(loadInstalledArtifact(store, ref)).rejects.toMatchObject({
      reason: "local-copy-unreadable",
    });
  });

  test("loadInstalledArtifact refuses a run with no record, and a record without the manifest hash", async () => {
    await expect(loadInstalledArtifact(store, { ...ref, batchIndex: 1 })).rejects.toMatchObject({
      reason: "no-record",
    });
    const runB = store.createRun({ projectPath: "P", backend: "bcdev", appVersion: "0.0.0.0" });
    store.recordArtifact(runB, {
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      sha256: sha(appBytes),
    });
    await expect(loadInstalledArtifact(store, { ...ref, fromRunId: runB })).rejects.toMatchObject({
      reason: "no-record",
    });
  });

  test("loadInstalledArtifact returns the parsed manifest whose hash matched", async () => {
    const { artifact, manifest } = await loadInstalledArtifact(store, ref);
    expect(manifest).toEqual(MANIFEST as unknown as typeof manifest);
    expect(artifact).toEqual({
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      sha256: sha(appBytes),
      appPath: ref.appPath,
      instrumentedDir: ref.instrumentedDir,
    });
  });
});

// Copied from orchestrator.test.ts's `fakeManifestEntry` (search by name; line numbers drift).
function fakeManifestEntry(mutantId: string): MutantManifestEntry {
  return {
    mutantId,
    file: "SandboxLogic.Codeunit.al",
    operatorName: "conditional-boundary",
    operatorVersion: "1.0.0",
    startIndex: 100,
    endIndex: 110,
    startLine: 5,
    objectType: "codeunit",
    codeunitId: 79000,
    codeunitName: "Sandbox Logic",
    procedureName: "IsOverBudget",
    originalText: "Original();",
    mutatedText: "",
    astHash: "hash",
  };
}

describe("resolveNamedMutants and baselineTestsOf (C02-04b Task 7)", () => {
  const RESOLVE_MANIFEST: MutantManifest = {
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    artifactId: ARTIFACT_ID,
    mutants: [fakeManifestEntry("M0001"), fakeManifestEntry("M0002"), fakeManifestEntry("M0003")],
  };
  const T1: TestMethodRef = { codeunitId: 1, codeunitName: "T", method: "T1" };
  const T2: TestMethodRef = { codeunitId: 1, codeunitName: "T", method: "T2" };

  test("resolveNamedMutants refuses ids the artifact does not contain, naming all of them", () => {
    expect(() =>
      resolveNamedMutants(RESOLVE_MANIFEST, [
        { mutantId: "M0001", methods: [T1] },
        { mutantId: "M0099", methods: [T1] },
        { mutantId: "M0100", methods: [T1] },
      ]),
    ).toThrow(/M0099.*M0100/s);
  });

  test("resolveNamedMutants refuses an empty request list and a request with no methods", () => {
    expect(() => resolveNamedMutants(RESOLVE_MANIFEST, [])).toThrow(NamedMutantError);
    expect(() =>
      resolveNamedMutants(RESOLVE_MANIFEST, [{ mutantId: "M0001", methods: [] }]),
    ).toThrow(NamedMutantError);
  });

  test("resolveNamedMutants refuses a repeated id and a repeated method", () => {
    expect(() =>
      resolveNamedMutants(RESOLVE_MANIFEST, [
        { mutantId: "M0001", methods: [T1] },
        { mutantId: "M0001", methods: [T1] },
      ]),
    ).toThrow(NamedMutantError);
    expect(() =>
      resolveNamedMutants(RESOLVE_MANIFEST, [{ mutantId: "M0001", methods: [T1, T1] }]),
    ).toThrow(NamedMutantError);
  });

  test("resolveNamedMutants returns the manifest's own entry objects, in request order", () => {
    const out = resolveNamedMutants(RESOLVE_MANIFEST, [
      { mutantId: "M0003", methods: [T1] },
      { mutantId: "M0001", methods: [T1] },
    ]);
    expect(out[0]?.mutant).toBe(RESOLVE_MANIFEST.mutants[2]);
    expect(out[1]?.mutant).toBe(RESOLVE_MANIFEST.mutants[0]);
  });

  test("baselineTestsOf deduplicates across requests", () => {
    const named = resolveNamedMutants(RESOLVE_MANIFEST, [
      { mutantId: "M0001", methods: [T1] },
      { mutantId: "M0002", methods: [T1, T2] },
    ]);
    expect(baselineTestsOf(named)).toEqual([T1, T2]);
  });
});
