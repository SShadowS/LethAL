#!/usr/bin/env bun
/**
 * C02-05 Task 7: the live proof that a test app compiled against the INSTALLED guarded build is
 * published under the lease and verified by the server's own bytes. NOT a `bun:test` file: a
 * standalone script run by `bun run itest:testapp`, never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) unless LETHAL_ITEST_TESTAPP=1.
 *
 * Reads the same gitignored fixture files as `itest:bcdev` (launch.local.json and the config
 * `LETHAL_ITEST_CONFIG` selects), and needs `fixtures/sandbox-tests/.alpackages` (gitignored too).
 * Uses a store, instrumented dir and quarantine dir in a fresh temp dir, never
 * `fixtures/sandbox-app/lethal.sqlite`.
 *
 * The steps, each an assertion (see the C02-05 plan, Task 7):
 *   1. runSession as itest:bcdev does, per-mutant equal to bcdev.baseline.json;
 *   2. loadInstalledArtifact on the batch it left installed;
 *   3. pick one frozen kill and one frozen survivor by identity key;
 *   4. a bad reference fails in real alc as TestAppError compile-failed (AL0132), no lease;
 *   5. the marker method is ABSENT at runtime before its publish (StaleTestAppError);
 *   6. the marker build is published under the lease, verified by bytes, and runs green;
 *   7. in a finally once 6 started: the repo's test app is published back, verified by bytes,
 *      and the marker is absent at runtime again.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import type { BoundArtifact, TestMethodRef } from "../src/backend";
import { hashPackage } from "../src/baseline-snapshot";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import { loadInstalledArtifact } from "../src/named-mutants";
import type { NamedMutantRequest } from "../src/named-mutants";
import { runNamedMutants, runSession } from "../src/orchestrator";
import type { LeaseFence, NamedMutantsResult } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { MutantOutcome } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { StaleTestAppError } from "../src/stale-test-app";
import { ResultsStore } from "../src/store";
import { TestAppError } from "../src/test-app-publish";
import type { CompiledTestApp, PublishedTestApp } from "../src/test-app-publish";
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import { diffMutants, normalizeForComparison } from "./mutant-equality";
import type { NormalizedMutant } from "./mutant-equality";

if (!process.env.LETHAL_ITEST_TESTAPP) {
  console.log(
    "skipped (set LETHAL_ITEST_TESTAPP=1 and populate the gitignored launch.local.json / " +
      "lethal.config.local.json fixture files to run against a live dev server)",
  );
  const challenged = await emitSkipped("testapp", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = itestConfigPath(PROJECT_DIR);
const BASELINE_PATH = join(HERE, "bcdev.baseline.json");
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

const TEST_CODEUNIT = { codeunitId: 79100, codeunitName: "Sandbox Tests" } as const;
const TEST_CODEUNIT_FILE = join("src", "SandboxTests.Codeunit.al");
const MARKER = "ZzC0205Marker";
const TEST_APP_VERSION = "1.0.0.2";
/** Microsoft's Base Application: its installed version is the BC build this gate ran against. */
const BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
/** The two frozen rows this gate drives, by identity key suffix in bcdev.baseline.json. */
const KILL_KEY = "|Sandbox Logic|IsOverBudget|lethal.return-value|";
const SURVIVOR_KEY = "|Sandbox Logic|ClampPercent|lethal.negate-conditional|";

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
  return JSON.parse(text) as T;
}

/** The same key `mutant-equality.ts`'s private `keyOf` builds (as scripts/c0204b-live-probe.ts). */
function keyOf(m: MutantOutcome): string {
  const scope = m.procedureName || m.triggerName || "";
  const tuple = `${m.astHash}|${m.codeunitName}|${scope}|${m.operatorName}|${m.operatorMajor}`;
  const ordinal = m.identityOrdinal ?? 0;
  return ordinal > 0 ? `${tuple}|${ordinal}` : tuple;
}

function method(name: string): TestMethodRef {
  return { ...TEST_CODEUNIT, method: name };
}

/** A qualified `Sandbox Tests.<method>` name to a ref. The fixture has one test codeunit. */
function refOf(qualified: string): TestMethodRef {
  const dot = qualified.lastIndexOf(".");
  const codeunitName = qualified.slice(0, dot);
  assert.equal(
    codeunitName,
    TEST_CODEUNIT.codeunitName,
    `covering test ${qualified} is not in ${TEST_CODEUNIT.codeunitName}`,
  );
  return method(qualified.slice(dot + 1));
}

/** A scratch copy of the test project with `procedureText` added to the test codeunit. */
async function scratchTestProject(dir: string, procedureText: string): Promise<string> {
  await cp(TEST_DIR, dir, { recursive: true });
  const path = join(dir, TEST_CODEUNIT_FILE);
  const source = await readFile(path, "utf8");
  const end = source.lastIndexOf("}");
  assert.ok(end > 0, `${path} has no closing brace`);
  await writeFile(path, `${source.slice(0, end)}\n${procedureText}\n}\n`, "utf8");
  return dir;
}

async function quarantineRecords(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const alpackages = join(TEST_DIR, ".alpackages");
  const symbols = await readdir(alpackages).catch(() => [] as string[]);
  if (!symbols.some((n) => n.toLowerCase().endsWith(".app"))) {
    throw new Error(
      `${alpackages} holds no .app symbols (it is gitignored). Download the symbols or copy them from a checkout that has them before running this gate.`,
    );
  }

  const launchLocal = await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json");
  const launchCfg = launchLocal.configurations[0];
  if (!launchCfg) throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
  }

  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-testapp-"));
  const outputDir = join(scratch, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
    defaultArtifactIo,
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    defaultDeployerIo,
  );
  const odataCfg = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
      ...(launchCfg.environmentType !== undefined
        ? { environmentType: launchCfg.environmentType }
        : {}),
      ...(launchCfg.environmentName !== undefined
        ? { environmentName: launchCfg.environmentName }
        : {}),
      ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
    },
    undefined,
    { compiler, deployer, verifier: new DeploymentVerifier(odataCfg), harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );
  const quarantineDir = join(scratch, "quarantine");
  const shared = {
    lease: {
      client: new LeaseClient(odataCfg),
      serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
    },
    resourceServer: bcdev.server,
    resourceServerInstance: bcdev.serverInstance,
    // A SCRATCH quarantine dir, never ~/.lethal/quarantine, for the reason bcdev.itest.ts gives.
    quarantineDir,
  };
  const instrumentedDir = join(scratch, "instrumented");
  const store = new ResultsStore(join(scratch, "testapp.sqlite"));

  try {
    // Printed first, as the other gates do: which control app and BC build this ran against.
    const base = await harnessVerifier.fetchExtensionInstalled(BASE_APPLICATION_ID);
    console.log(`testapp itest: LethAL Control ${await harnessVerifier.fetchControlVersion()}`);
    console.log(`testapp itest: BC build (Base Application) ${base.versions.join(", ")}`);

    // ---- 1. The gate-equivalent run: leaves a guarded build installed with a trusted record.
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir,
      selectorIds: SELECTOR_IDS,
      ...shared,
    });
    assert.equal(report.quarantined, undefined, "step 1: the full run must not quarantine");
    const committed = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as NormalizedMutant[];
    const diffs = diffMutants(committed, normalizeForComparison(report));
    assert.equal(
      diffs.length,
      0,
      `step 1: per-mutant difference from ${BASELINE_PATH}:\n${diffs.join("\n")}`,
    );
    console.log(
      `step 1 PASS: runSession ${report.counts.killed} killed / ${report.counts.survived} survived / ${report.counts.noCoverage} no-coverage, per mutant equal to bcdev.baseline.json`,
    );

    // ---- 2. The installed artifact loads from the trusted record.
    const fromRunId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const last = store.db
      .query(
        "SELECT batch_index, artifact_id, artifact_sha256 FROM batch_artifacts WHERE run_id = ? ORDER BY batch_index DESC LIMIT 1",
      )
      .get(fromRunId) as {
      batch_index: number;
      artifact_id: string;
      artifact_sha256: string;
    } | null;
    if (last === null) throw new Error(`step 2: run ${fromRunId} recorded no batch artifacts`);
    const installed = {
      fromRunId,
      batchIndex: last.batch_index,
      appPath: join(outputDir, `${last.artifact_sha256.slice(0, 16)}-${last.artifact_id}.app`),
      instrumentedDir: join(instrumentedDir, `run-${fromRunId}-batch-${last.batch_index}`),
    };
    const { artifact } = await loadInstalledArtifact(store, installed);
    console.log(
      `step 2 PASS: loadInstalledArtifact run ${fromRunId} batch ${installed.batchIndex}, artifact ${artifact.artifactId}`,
    );

    // ---- 3. One frozen kill and one frozen survivor, by identity key.
    const pick = (suffix: string, verdict: string): MutantOutcome => {
      const rows = committed.filter((b) => b.key.includes(suffix));
      const [row] = rows;
      assert.ok(row !== undefined && rows.length === 1, `step 3: one baseline row for ${suffix}`);
      assert.equal(row.verdict, verdict, `step 3: ${suffix} is frozen ${verdict}`);
      const hits = report.mutants.filter((m) => keyOf(m) === row.key);
      const [hit] = hits;
      assert.ok(hit !== undefined && hits.length === 1, `step 3: one report mutant for ${suffix}`);
      assert.equal(hit.batchIndex, installed.batchIndex, `step 3: ${suffix} is in the batch`);
      assert.ok((hit.coveringTests ?? []).length > 0, `step 3: ${suffix} has covering tests`);
      return hit;
    };
    const kill = pick(KILL_KEY, "killed");
    const survivor = pick(SURVIVOR_KEY, "survived");
    assert.ok(
      (kill.coveringTests ?? []).includes(`${TEST_CODEUNIT.codeunitName}.OverBudgetDetected`),
      "step 3: the kill is covered by OverBudgetDetected",
    );
    const survivorMethods = (survivor.coveringTests ?? []).map(refOf);
    console.log(
      `step 3 PASS: kill ${kill.mutantCode} (${kill.coveringTests?.join(", ")}), survivor ${survivor.mutantCode} (${survivor.coveringTests?.join(", ")})`,
    );

    // ---- 4. A bad reference fails in real alc, before any lease.
    const badDir = await scratchTestProject(
      join(scratch, "bad-ref"),
      "    [Test]\n    procedure ZzC0205BadRef()\n    begin\n        SandboxLogic.NoSuchProcedureC0205();\n    end;",
    );
    let badErr: unknown;
    try {
      await backend.compileTestApp(badDir, artifact);
    } catch (err) {
      badErr = err;
    }
    assert.ok(
      badErr instanceof TestAppError,
      `step 4: expected TestAppError, got ${String(badErr)}`,
    );
    assert.equal(badErr.reason, "compile-failed", "step 4: reason compile-failed");
    assert.ok(
      badErr.message.includes("AL0132"),
      `step 4: alc text names AL0132: ${badErr.message}`,
    );
    console.log("step 4 PASS: bad reference is TestAppError compile-failed carrying AL0132");

    // A NEW unfinished run row for every runNamedMutants call.
    let calls = 0;
    let lastNamedRunId = 0;
    const named = (
      requests: readonly NamedMutantRequest[],
      inLease?: (fence: LeaseFence) => Promise<void>,
    ): Promise<NamedMutantsResult> => {
      const runId = store.createRun({
        projectPath: PROJECT_DIR,
        backend: `itest-testapp-${++calls}`,
        appVersion: "0.0.0.0",
      });
      lastNamedRunId = runId;
      return runNamedMutants({
        backend,
        store,
        runId,
        installed,
        requests,
        ...shared,
        ...(inLease !== undefined ? { inLease } : {}),
      });
    };
    const killWithMarker = {
      mutantId: kill.mutantCode,
      methods: [method("OverBudgetDetected"), method(MARKER)],
    };

    // ---- 5 (and 7's repeat). The marker is ABSENT at runtime.
    const assertMarkerAbsent = async (step: string): Promise<void> => {
      let err: unknown;
      try {
        await named([killWithMarker]);
      } catch (e) {
        err = e;
      }
      if (!(err instanceof StaleTestAppError)) {
        throw new Error(
          `${step}: expected StaleTestAppError naming ${MARKER}, got ${err === undefined ? "no error" : String(err)}. The container carries a test app WITH the marker: restore it by hand (compile fixtures/sandbox-tests and publish it) before any gate.`,
        );
      }
      assert.deepEqual(
        err.missingTests,
        [`${TEST_CODEUNIT.codeunitName}.${MARKER}`],
        `${step}: StaleTestAppError must name only the marker`,
      );
      console.log(`${step} PASS: StaleTestAppError names only ${err.missingTests.join(", ")}`);
    };
    await assertMarkerAbsent("step 5");

    // One publish under the lease, then the byte and version checks both legs make.
    const publishLeg = async (
      step: string,
      compiled: CompiledTestApp,
      requests: readonly NamedMutantRequest[],
    ): Promise<{ res: NamedMutantsResult; runId: number }> => {
      let published: PublishedTestApp | undefined;
      const res = await named(requests, async (fence) => {
        published = await backend.publishTestApp(fence, compiled);
      });
      const runId = lastNamedRunId;
      assert.ok(published !== undefined, `${step}: the publish returned no identity`);
      assert.equal(published.sha256, compiled.sha256, `${step}: published sha256 = compiled`);
      const fresh = await backend.fetchPublishedAppPackage({
        publisher: compiled.publisher,
        name: compiled.name,
      });
      assert.ok(fresh instanceof Uint8Array, `${step}: a fresh read-back must answer`);
      assert.equal(hashPackage(fresh), compiled.sha256, `${step}: fresh read-back = compiled`);
      assert.equal(published.version, TEST_APP_VERSION, `${step}: server version`);
      assert.equal(res.quarantined, undefined, `${step}: no quarantine (${res.quarantined})`);
      const [k, s] = res.outcomes;
      assert.ok(k !== undefined && s !== undefined, `${step}: two outcomes`);
      assert.equal(k.mutant.mutantId, kill.mutantCode);
      assert.equal(k.verdict, "killed", `${step}: kill verdict (${k.failureNote ?? ""})`);
      assert.equal(k.killingTest, "OverBudgetDetected", `${step}: killing test`);
      assert.equal(s.mutant.mutantId, survivor.mutantCode);
      assert.equal(s.verdict, "survived", `${step}: survivor verdict (${s.failureNote ?? ""})`);
      console.log(
        `${step}: published ${compiled.name} ${published.version} sha256 ${published.sha256} (compiled against ${published.compiledAgainst.artifactId}); fresh read-back equal; kill ${k.verdict} by ${k.killingTest}, survivor ${s.verdict}`,
      );
      return { res, runId };
    };

    // ---- 6. The marker build, published under the lease. Step 7 runs whatever happens here.
    let step6Err: unknown;
    try {
      const markerDir = await scratchTestProject(
        join(scratch, "marker"),
        `    [Test]\n    procedure ${MARKER}()\n    begin\n    end;`,
      );
      const compiled = await backend.compileTestApp(markerDir, artifact);
      const { runId } = await publishLeg("step 6", compiled, [
        killWithMarker,
        { mutantId: survivor.mutantCode, methods: [...survivorMethods, method(MARKER)] },
      ]);
      const markerRows = store.db
        .query(
          "SELECT outcome FROM test_results WHERE run_id = ? AND mutant_row_id IS NULL AND method = ?",
        )
        .all(runId, MARKER) as Array<{ outcome: string }>;
      assert.deepEqual(
        markerRows.map((r) => r.outcome),
        ["pass"],
        `step 6: one baseline row for ${MARKER}, pass`,
      );
      assert.deepEqual(await quarantineRecords(quarantineDir), [], "step 6: no quarantine record");
      const harness = await harnessVerifier.verify();
      const client = new LeaseClient(odataCfg);
      const outcome = await client.acquire(
        `${hostname()}:${process.pid}:testapp-check`,
        MAX_TTL_SECONDS,
        randomUUID(),
        harness.serverGeneration,
      );
      assert.ok(
        outcome.granted,
        `step 6: a lease acquire right after must succeed: ${JSON.stringify(outcome.granted)}`,
      );
      await client.release(outcome.lease);
      console.log(`step 6 PASS: ${MARKER} baseline pass, no quarantine, the lease was released`);
    } catch (err) {
      step6Err = err;
    }

    // ---- 7. Restore the repo's test app, checked at runtime. Always, once step 6 started.
    let step7Err: unknown;
    try {
      const compiled = await backend.compileTestApp(TEST_DIR, artifact);
      await publishLeg("step 7", compiled, [
        { mutantId: kill.mutantCode, methods: [method("OverBudgetDetected")] },
        { mutantId: survivor.mutantCode, methods: survivorMethods },
      ]);
      await assertMarkerAbsent("step 7 (repeated absence probe)");
      console.log("step 7 PASS: restore published and verified, marker absent again");
    } catch (err) {
      step7Err = err;
    }
    if (step6Err !== undefined || step7Err !== undefined) {
      const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
      throw new Error(
        [
          step6Err !== undefined ? `step 6 FAILED: ${describe(step6Err)}` : "step 6 passed",
          step7Err !== undefined
            ? `step 7 (restore) FAILED: ${describe(step7Err)}. The container may carry the marker build: restore fixtures/sandbox-tests by hand before any gate.`
            : "step 7 (restore) PASSED: the marker is absent at runtime again",
        ].join("\n"),
      );
    }
  } finally {
    store.close();
    await backend.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  console.log("testapp itest: PASS");
  await emitPassed("testapp", { sublegs: ["testapp"], artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  await emitFailed("testapp", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
