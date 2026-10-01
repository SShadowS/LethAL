import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { InstalledArtifactError } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import type { InstalledBundleWrite } from "../src/installed-bundle";
import { bundleOfParts } from "../src/installed-bundle";
import {
  type InstalledArtifactRef,
  NamedMutantError,
  baselineTestsOf,
  loadInstalledArtifact,
  resolveNamedMutants,
} from "../src/named-mutants";
import { ResultsStore } from "../src/store";
import { verifyRefusalOf } from "../src/verify";
import { bundleFor } from "./helpers/bundle";

const ARTIFACT_ID = "0123456789abcdef0123456789abcdef";
const APP_ID = "11111111-1111-1111-1111-111111111111";

const MANIFEST = {
  selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  artifactId: ARTIFACT_ID,
  mutants: [
    { mutantId: "M0001", file: "A.Codeunit.al", objectType: "codeunit", codeunitId: 79000 },
    {
      mutantId: "M0002",
      file: "A.Codeunit.al",
      objectType: "codeunit",
      codeunitId: 79000,
      coverageArmNames: ["Pick", "Choose"],
    },
  ],
};

const APP_JSON = '{ "idRanges": [{ "from": 79000, "to": 79099 }] }';
const AL_SOURCE = 'codeunit 79000 "A" { }';

const sha = (bytes: string | Uint8Array) => Bun.SHA256.hash(bytes, "hex");

describe("loadInstalledArtifact (C02-04b Task 6)", () => {
  let dir: string;
  let store: ResultsStore;
  let runId: number;
  let ref: InstalledArtifactRef;
  let bundle: InstalledBundleWrite;
  const appBytes = "PK-fake-app-bytes";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-named-mutants-"));
    const instrumentedDir = join(dir, "run-1-batch-0");
    await Bun.write(
      join(instrumentedDir, "mutant-manifest.json"),
      JSON.stringify(MANIFEST, null, 2),
    );
    await Bun.write(join(instrumentedDir, "app.json"), APP_JSON);
    await Bun.write(join(instrumentedDir, "src", "A.Codeunit.al"), AL_SOURCE);
    const appPath = join(dir, `${sha(appBytes).slice(0, 16)}-${ARTIFACT_ID}.app`);
    await Bun.write(appPath, appBytes);
    bundle = await bundleFor(instrumentedDir, appPath);
    store = new ResultsStore(":memory:");
    runId = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
    store.recordArtifact(runId, {
      bundle,
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

  /** R360: records a fresh run whose stored bundle holds these parts, with `over` on the row. */
  function recordStored(
    parts: { manifestText?: string; app?: string },
    over: { manifestSha256?: string; sha256?: string } = {},
  ): InstalledArtifactRef {
    const runB = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
    store.recordArtifact(runB, {
      bundle: bundleOfParts({
        appBytes: new TextEncoder().encode(parts.app ?? appBytes),
        appJsonText: APP_JSON,
        manifestText: parts.manifestText ?? JSON.stringify(MANIFEST, null, 2),
        files: [{ path: "src/A.Codeunit.al", text: AL_SOURCE }],
      }),
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      sha256: over.sha256 ?? sha(appBytes),
      manifestSha256: over.manifestSha256 ?? sha(JSON.stringify(MANIFEST)),
    });
    return { ...ref, fromRunId: runB };
  }

  test("loadInstalledArtifact refuses a manifest with the recorded id but other mutants", async () => {
    const [first] = MANIFEST.mutants;
    const r = recordStored({ manifestText: JSON.stringify({ ...MANIFEST, mutants: [first] }) });
    await expect(loadInstalledArtifact(store, r)).rejects.toMatchObject({
      reason: "manifest-differs",
    });
  });

  test("loadInstalledArtifact refuses a manifest whose hash matches but whose id does not", async () => {
    // Record the hash of a manifest carrying ANOTHER id: the hash link holds, the id link must not.
    const other = { ...MANIFEST, artifactId: "f".repeat(32) };
    const r = recordStored(
      { manifestText: JSON.stringify(other) },
      { manifestSha256: sha(JSON.stringify(other)) },
    );
    await expect(loadInstalledArtifact(store, r)).rejects.toMatchObject({
      reason: "manifest-differs",
    });
  });

  test("loadInstalledArtifact refuses a stored .app that is not the recorded bytes", async () => {
    const r = recordStored({ app: `${appBytes}x` });
    await expect(loadInstalledArtifact(store, r)).rejects.toMatchObject({
      reason: "local-copy-differs",
    });
  });

  test("loadInstalledArtifact refuses a stored manifest that does not parse", async () => {
    const r = recordStored({ manifestText: "{not json" });
    await expect(loadInstalledArtifact(store, r)).rejects.toMatchObject({
      reason: "manifest-differs",
    });
  });

  // R360 C1: the .al text feeds the coverage line map, and before R360 nothing checked it.
  test("C1: one changed byte of one stored .al is refused, naming the payload digest", async () => {
    store.db
      .query("UPDATE installed_bundle_files SET text_gz = ? WHERE run_id = ?")
      .run(gzipSync(AL_SOURCE.replace("A", "B")), runId);
    const err = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstalledArtifactError);
    expect(err).toMatchObject({ reason: "payload-differs" });
    expect(verifyRefusalOf(err)).toMatchObject({
      kind: "refused",
      reason: "artifact-files-unusable",
      detail: expect.stringContaining("instrumented payload digest"),
    });
  });

  test("a store that lost the installed files is refused as payload-differs, never read as empty", async () => {
    store.db.query("DELETE FROM installed_bundles WHERE run_id = ?").run(runId);
    await expect(loadInstalledArtifact(store, ref)).rejects.toMatchObject({
      reason: "payload-differs",
    });
  });

  // R360: no path fallback. The files are still on disk here, and the row is refused anyway.
  test("a row recorded before R360 is refused as predating R360, even with its files on disk", async () => {
    store.db.query("UPDATE batch_artifacts SET payload_sha256 = NULL WHERE run_id = ?").run(runId);
    const err = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "no-record" });
    expect((err as InstalledArtifactError).detail).toContain("recorded before R360");
    expect(verifyRefusalOf(err)).toMatchObject({ reason: "source-predates-verify" });
  });

  test("a pruned row is refused as replaced, naming the run that pruned it", async () => {
    store.db.query("UPDATE batch_artifacts SET bundle_pruned_by = 9 WHERE run_id = ?").run(runId);
    const err = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "replaced" });
    expect((err as InstalledArtifactError).detail).toContain(
      `run ${runId}'s installed files were pruned when run 9 finished (same app, no recorded server)`,
    );
    expect(verifyRefusalOf(err)).toMatchObject({ reason: "artifact-files-unusable" });
  });

  test("the replaced text says what pruned it: no server claimed for a NULL key, and a deleted environment", async () => {
    // This fixture's run recorded no server (resource_key NULL).
    store.db.query("UPDATE batch_artifacts SET bundle_pruned_by = 9 WHERE run_id = ?").run(runId);
    const noServer = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect((noServer as InstalledArtifactError).detail).not.toContain("same server");
    expect((noServer as InstalledArtifactError).detail).toContain("no recorded server");
    store.db.query("UPDATE runs SET resource_key = 'srv|bc' WHERE id = ?").run(runId);
    const sameServer = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect((sameServer as InstalledArtifactError).detail).toContain("same server");
    store.db.query("UPDATE batch_artifacts SET bundle_pruned_by = 0 WHERE run_id = ?").run(runId);
    const torn = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(torn).toMatchObject({ reason: "replaced" });
    expect((torn as InstalledArtifactError).detail).toContain("deleted at teardown");
  });

  test("loadInstalledArtifact refuses a run with no record, and a record without the manifest hash", async () => {
    await expect(loadInstalledArtifact(store, { ...ref, batchIndex: 1 })).rejects.toMatchObject({
      reason: "no-record",
    });
    const runB = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
    store.recordArtifact(runB, {
      bundle,
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

  // Review r1 fix 3: the trusted record is validated here, as a typed refusal, never a plain Error.
  test("loadInstalledArtifact refuses a record whose artifactId is not 32 lowercase hex", async () => {
    const bad = { ...MANIFEST, artifactId: ARTIFACT_ID.toUpperCase() };
    await writeFile(join(ref.instrumentedDir, "mutant-manifest.json"), JSON.stringify(bad));
    const runB = store.createRun({
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      projectPath: "P",
      backend: "bcdev",
      appVersion: "0.0.0.0",
    });
    store.recordArtifact(runB, {
      bundle,
      batchIndex: 0,
      appVersion: "1.0.1.1",
      appId: APP_ID,
      artifactId: bad.artifactId,
      sha256: sha(appBytes),
      manifestSha256: sha(JSON.stringify(bad)),
    });
    const err = await loadInstalledArtifact(store, { ...ref, fromRunId: runB }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InstalledArtifactError);
    expect(err).toMatchObject({ reason: "no-record" });
    expect((err as InstalledArtifactError).detail).toContain(bad.artifactId);
  });

  test("loadInstalledArtifact refuses a record whose run has no app id", async () => {
    store.db.query("UPDATE runs SET app_id = NULL WHERE id = ?").run(runId);
    const err = await loadInstalledArtifact(store, ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstalledArtifactError);
    expect(err).toMatchObject({ reason: "no-record" });
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
      appBytes: new Uint8Array(Buffer.from(appBytes)),
      appJsonText: APP_JSON,
      alSources: [{ path: "src/A.Codeunit.al", text: AL_SOURCE }],
      // R318: from the VERIFIED manifest, for the fenced line map `attach` builds.
      renamedMemberNames: new Map([["codeunit:79000", [["Pick", "Choose"]]]]),
      // R-307 section 4: the verified manifest's object keys, which `attach` checks.
      manifestObjectKeys: new Set(["codeunit:79000"]),
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
