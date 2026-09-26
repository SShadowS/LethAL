#!/usr/bin/env bun
/**
 * C02-06 Task 8: the live proof of `lethal verify` on `sandbox-app`. NOT a `bun:test` file: a
 * standalone script run by `bun run itest:verify`, never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) unless LETHAL_ITEST_VERIFY=1.
 *
 * Reads the same gitignored fixture files as `itest:bcdev` (launch.local.json and the config
 * `LETHAL_ITEST_CONFIG` selects), and needs `fixtures/sandbox-tests/.alpackages` (gitignored too).
 * Uses a store, instrumented dir and quarantine dir in a fresh temp dir for the full run. Verify
 * itself is driven through `verifyFromCli`, the CLI code path, so it uses the default quarantine
 * dir, as a real `lethal verify` does.
 *
 * Every prediction is pre-committed in
 * docs/superpowers/specs/2026-09-26-c02-06-verify-precommitment.md. The steps:
 *   1. runSession, per mutant equal to bcdev.baseline.json; keep timings and the last artifact;
 *   2. a scratch copy of sandbox-tests with ONE added test that kills the ClampPercent survivor;
 *   3. verify both survivors with it: ClampPercent killed by the new test, LogAudit survived, exit 5;
 *   4. in a finally once 3 began: verify with the unchanged sandbox-tests, both survived, exit 5;
 *   5. refusals against the real store, exit 6 and no lease acquire each;
 *   6. print the wall-time ratio (recorded, not gated).
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { hashPackage } from "../src/baseline-snapshot";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig, verifyFromCli } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import { defaultQuarantineDir, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { MutantOutcome } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { VERIFY_EXIT } from "../src/verify";
import type { VerifyOutput, VerifyResult } from "../src/verify";
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import { diffMutants, normalizeForComparison } from "./mutant-equality";
import type { NormalizedMutant } from "./mutant-equality";

if (!process.env.LETHAL_ITEST_VERIFY) {
  console.log(
    "skipped (set LETHAL_ITEST_VERIFY=1 and populate the gitignored launch.local.json / " +
      "lethal.config.local.json fixture files to run against a live dev server)",
  );
  const challenged = await emitSkipped("verify", "the leg's env var is unset");
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
const NEW_TEST = "ZzC0206ClampRejectsAboveHundred";
const NEW_TEST_QUALIFIED = `${TEST_CODEUNIT.codeunitName}.${NEW_TEST}`;
const NEW_TEST_ERROR = "ZzC0206: ClampPercent(150) must return 0";
/** Microsoft's Base Application: its installed version is the BC build this gate ran against. */
const BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
/** The three frozen rows this gate drives, by identity key suffix in bcdev.baseline.json. */
const CLAMP_KEY = "|Sandbox Logic|ClampPercent|lethal.negate-conditional|";
const LOGAUDIT_KEY = "|Sandbox Logic|LogAudit|lethal.negate-conditional|";
const KILL_KEY = "|Sandbox Logic|IsOverBudget|lethal.return-value|";

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

/** The same key `mutant-equality.ts`'s private `keyOf` builds (as test-app-publish.itest.ts). */
function keyOf(m: MutantOutcome): string {
  const scope = m.procedureName || m.triggerName || "";
  const tuple = `${m.astHash}|${m.codeunitName}|${scope}|${m.operatorName}|${m.operatorMajor}`;
  const ordinal = m.identityOrdinal ?? 0;
  return ordinal > 0 ? `${tuple}|${ordinal}` : tuple;
}

async function quarantineRecords(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Counts every `LeaseClient.acquire`, including the one `verifyFromCli` builds for itself. It is
 * how step 5 proves a refusal took no lease, and step 3 proves the spy observes (a count above 0).
 */
let acquires = 0;
const realAcquire = LeaseClient.prototype.acquire;
LeaseClient.prototype.acquire = function (
  this: LeaseClient,
  ...args: Parameters<LeaseClient["acquire"]>
) {
  acquires++;
  return realAcquire.apply(this, args);
};

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
  const testAppJson = await readJson<{ publisher: string }>(
    join(TEST_DIR, "app.json"),
    "sandbox-tests app.json",
  );
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
  }

  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-verify-"));
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
  const dbPath = join(scratch, "verify.sqlite");
  let store: ResultsStore | undefined = new ResultsStore(dbPath);

  try {
    // Printed first, as the other gates do: which control app and BC build this ran against.
    const base = await harnessVerifier.fetchExtensionInstalled(BASE_APPLICATION_ID);
    console.log(`verify itest: LethAL Control ${await harnessVerifier.fetchControlVersion()}`);
    console.log(`verify itest: BC build (Base Application) ${base.versions.join(", ")}`);

    // ---- 1. The gate-equivalent run: leaves a guarded build installed with a trusted record.
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratch, "instrumented"),
      selectorIds: SELECTOR_IDS,
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A SCRATCH quarantine dir for the full run, for the reason bcdev.itest.ts gives.
      quarantineDir: join(scratch, "quarantine"),
    });
    // Closed before verify opens the same file through the CLI path.
    store.close();
    store = undefined;
    assert.equal(report.quarantined, undefined, "step 1: the full run must not quarantine");
    const committed = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as NormalizedMutant[];
    const diffs = diffMutants(committed, normalizeForComparison(report));
    assert.equal(
      diffs.length,
      0,
      `step 1: per-mutant difference from ${BASELINE_PATH}:\n${diffs.join("\n")}`,
    );
    const lastArtifact = report.artifacts?.at(-1);
    if (lastArtifact === undefined) throw new Error("step 1: the report carries no artifacts[]");
    const fullRunMs = report.timings.totalMs;

    const pick = (suffix: string, verdict: string): string => {
      const rows = committed.filter((b) => b.key.includes(suffix));
      const [row] = rows;
      assert.ok(row !== undefined && rows.length === 1, `step 1: one baseline row for ${suffix}`);
      assert.equal(row.verdict, verdict, `step 1: ${suffix} is frozen ${verdict}`);
      const hits = report.mutants.filter((m) => keyOf(m) === row.key);
      const [hit] = hits;
      assert.ok(hit !== undefined && hits.length === 1, `step 1: one report mutant for ${suffix}`);
      assert.equal(
        hit.batchIndex,
        lastArtifact.batchIndex,
        `step 1: ${suffix} is in the installed batch`,
      );
      return `${hit.batchIndex}/${hit.mutantCode}`;
    };
    const clampId = pick(CLAMP_KEY, "survived");
    const logAuditId = pick(LOGAUDIT_KEY, "survived");
    const killId = pick(KILL_KEY, "killed");
    console.log(
      `step 1 PASS: runSession ${report.counts.killed} killed / ${report.counts.survived} survived / ${report.counts.noCoverage} no-coverage, per mutant equal to bcdev.baseline.json; artifact ${lastArtifact.artifactId} (batch ${lastArtifact.batchIndex}), totalMs ${fullRunMs}; ClampPercent ${clampId}, LogAudit ${logAuditId}, IsOverBudget ${killId}`,
    );

    // ---- 2. A scratch copy of the test project with ONE added test. app.json unchanged.
    // negate-conditional flips `or` to `and` on ClampPercent (measured offline, see the spec's
    // correction), so the mutant differs from the original only OUTSIDE 0..100: at 150 the
    // original returns 0 and the mutant 150. Live run 1 used 50, where the two agree.
    const newTestDir = join(scratch, "tests-with-new-test");
    await cp(TEST_DIR, newTestDir, { recursive: true });
    const codeunitPath = join(newTestDir, TEST_CODEUNIT_FILE);
    const source = await readFile(codeunitPath, "utf8");
    const end = source.lastIndexOf("}");
    assert.ok(end > 0, `step 2: ${codeunitPath} has no closing brace`);
    await writeFile(
      codeunitPath,
      `${source.slice(0, end)}\n    [Test]\n    procedure ${NEW_TEST}()\n    begin\n        if SandboxLogic.ClampPercent(150) <> 0 then\n            Error('${NEW_TEST_ERROR}');\n    end;\n}\n`,
      "utf8",
    );
    console.log(`step 2 PASS: scratch test project at ${newTestDir} with ${NEW_TEST_QUALIFIED}`);

    /** One `lethal verify` through the CLI code path: its printed JSON, exit code and acquires. */
    const verify = async (
      step: string,
      testDir: string,
      artifact: string,
      survivors: readonly string[],
    ): Promise<{ code: number; out: VerifyOutput; acquired: number }> => {
      let text = "";
      const before = acquires;
      const code = await verifyFromCli(
        { mode: "verify", dbPath, artifact, testDir, survivors, configPath: CONFIG_LOCAL_PATH },
        {
          write: (t) => {
            text += t;
          },
        },
      );
      const out = JSON.parse(text) as VerifyOutput;
      console.log(`${step}: lethal verify exit ${code}\n${text}`);
      assert.equal(out.exitCode, code, `${step}: printed exitCode = returned exit code`);
      return { code, out, acquired: acquires - before };
    };
    const rowOf = (step: string, out: VerifyOutput, id: string): VerifyResult => {
      const rows = out.results.filter((r) => r.id === id);
      const [row] = rows;
      assert.ok(row !== undefined && rows.length === 1, `${step}: one result row for ${id}`);
      assert.equal(row.invalidBaseline, undefined, `${step}: ${id} has no invalidBaseline`);
      return row;
    };
    const assertFreshReadBack = async (step: string, out: VerifyOutput): Promise<void> => {
      const app = out.testApp;
      assert.ok(app !== undefined, `${step}: the output names the published test app`);
      const fresh = await backend.fetchPublishedAppPackage({
        publisher: testAppJson.publisher,
        name: app.name,
      });
      assert.ok(fresh instanceof Uint8Array, `${step}: a fresh read-back must answer`);
      assert.equal(hashPackage(fresh), app.sha256, `${step}: testApp.sha256 = fresh read-back`);
    };

    // ---- 3. Verify with the new test. Step 4 runs whatever happens here.
    let verifyMs: number | undefined;
    let step3Err: unknown;
    try {
      const quarantineBefore = await quarantineRecords(defaultQuarantineDir());
      const { code, out, acquired } = await verify("step 3", newTestDir, lastArtifact.artifactId, [
        clampId,
        logAuditId,
      ]);
      assert.equal(code, VERIFY_EXIT.notAllKilled, "step 3: exit 5");
      assert.equal(out.quarantined, undefined, `step 3: no quarantine (${out.quarantined})`);
      assert.equal(out.refused, undefined, `step 3: no refusal (${JSON.stringify(out.refused)})`);
      assert.ok(acquired > 0, "step 3: the lease spy observed verify's acquire");
      await assertFreshReadBack("step 3", out);

      assert.equal(out.newTests.length, 1, "step 3: exactly one new test");
      const [nt] = out.newTests;
      assert.ok(nt !== undefined);
      assert.equal(nt.test, NEW_TEST_QUALIFIED, "step 3: the new test");
      assert.equal(nt.codeunitId, TEST_CODEUNIT.codeunitId, "step 3: the new test's codeunit");
      assert.equal(nt.state, "stable", `step 3: stable (${JSON.stringify(nt)})`);
      const [b, r] = nt.runs;
      assert.ok(b !== undefined && r !== undefined && nt.runs.length === 2, "step 3: two runs");
      for (const run of [b, r]) {
        assert.equal(run.outcome, "pass", `step 3: unmutated run passes (${JSON.stringify(run)})`);
        assert.equal(run.fresh, true, `step 3: unmutated run fresh (${JSON.stringify(run)})`);
      }
      assert.ok(
        b.sessionId !== undefined && r.sessionId !== undefined && b.sessionId !== r.sessionId,
        `step 3: two DIFFERENT sessionIds (${b.sessionId}, ${r.sessionId})`,
      );

      const clamp = rowOf("step 3", out, clampId);
      assert.equal(clamp.verdict, "killed", `step 3: ClampPercent killed (${clamp.failureNote})`);
      assert.deepEqual(
        clamp.killingTest,
        { ...TEST_CODEUNIT, method: NEW_TEST },
        "step 3: killed by the new test in the real codeunit",
      );
      assert.equal(clamp.killedByNewTest, true, "step 3: killedByNewTest");
      assert.equal(
        clamp.killedBy,
        "other",
        "step 3: killedBy other (a bare Error the test raised)",
      );
      assert.ok(
        clamp.killingTestFailure?.includes(NEW_TEST_ERROR),
        `step 3: the kill carries the test's own text: ${clamp.killingTestFailure}`,
      );
      const logAudit = rowOf("step 3", out, logAuditId);
      assert.equal(logAudit.verdict, "survived", "step 3: LogAudit survived");
      assert.ok(
        (logAudit.testsRun ?? []).includes(NEW_TEST_QUALIFIED),
        `step 3: the new test ran against LogAudit (${logAudit.testsRun?.join(", ")})`,
      );
      assert.deepEqual(
        out.counts,
        { killed: 1, survived: 1, error: 0, skipped: 0 },
        "step 3: counts",
      );

      const quarantineAfter = await quarantineRecords(defaultQuarantineDir());
      assert.deepEqual(
        quarantineAfter.filter((n) => !quarantineBefore.includes(n)),
        [],
        "step 3: no new quarantine record",
      );
      const harness = await harnessVerifier.verify();
      const client = new LeaseClient(odataCfg);
      const outcome = await client.acquire(
        `${hostname()}:${process.pid}:verify-check`,
        MAX_TTL_SECONDS,
        randomUUID(),
        harness.serverGeneration,
      );
      assert.ok(
        outcome.granted,
        `step 3: a lease acquire right after must succeed: ${JSON.stringify(outcome)}`,
      );
      await client.release(outcome.lease);
      verifyMs = out.timings.totalMs;
      console.log(
        `step 3 PASS: ${NEW_TEST_QUALIFIED} stable (sessions ${b.sessionId}, ${r.sessionId}); ClampPercent killed by it (other), LogAudit survived; exit 5; read-back equal; lease free`,
      );
    } catch (err) {
      step3Err = err;
    }

    // ---- 4. Restore: the unchanged test project, also the "survived" leg. Always, once 3 began.
    let step4Err: unknown;
    try {
      const { code, out } = await verify("step 4", TEST_DIR, lastArtifact.artifactId, [
        clampId,
        logAuditId,
      ]);
      assert.equal(code, VERIFY_EXIT.notAllKilled, "step 4: exit 5");
      assert.deepEqual(out.newTests, [], "step 4: no new tests");
      assert.equal(rowOf("step 4", out, clampId).verdict, "survived", "step 4: ClampPercent");
      assert.equal(rowOf("step 4", out, logAuditId).verdict, "survived", "step 4: LogAudit");
      await assertFreshReadBack("step 4", out);
      console.log(
        "step 4 PASS: restored; ClampPercent survived, so the new test is gone from the server",
      );
    } catch (err) {
      step4Err = err;
    }
    if (step3Err !== undefined || step4Err !== undefined) {
      const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
      throw new Error(
        [
          step3Err !== undefined ? `step 3 FAILED: ${describe(step3Err)}` : "step 3 passed",
          step4Err !== undefined
            ? `step 4 (restore) FAILED: ${describe(step4Err)}. The container may carry the scratch test app: restore fixtures/sandbox-tests by hand before any gate.`
            : "step 4 (restore) PASSED: ClampPercent survived with the repo's test app",
        ].join("\n"),
      );
    }

    // ---- 5. Refusals against the real store: exit 6, no lease acquire, no verify run.
    const refused = async (
      step: string,
      artifact: string,
      survivors: readonly string[],
      reason: string,
    ): Promise<void> => {
      const { code, out, acquired } = await verify(step, TEST_DIR, artifact, survivors);
      assert.equal(code, VERIFY_EXIT.refused, `${step}: exit 6`);
      assert.equal(out.refused?.reason, reason, `${step}: ${JSON.stringify(out.refused)}`);
      assert.equal(acquired, 0, `${step}: no lease acquire`);
      assert.equal(out.verifyRunId, undefined, `${step}: no verify run row`);
      console.log(`${step} PASS: refused ${reason}, no lease acquire`);
    };
    await refused("step 5a", lastArtifact.artifactId, [killId], "not-a-survivor");
    await refused("step 5b", randomBytes(16).toString("hex"), [clampId], "unknown-artifact");

    // ---- 6. The wall-time ratio. Recorded, not gated (plan decision 9, ruling 4).
    if (verifyMs === undefined) throw new Error("step 6: step 3 recorded no timing");
    console.log(
      `step 6: wall-time ratio verify/full run = ${verifyMs} / ${fullRunMs} ms = ${(verifyMs / fullRunMs).toFixed(3)} (recorded, not gated)`,
    );
  } finally {
    store?.close();
    await backend.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  console.log("verify itest: PASS");
  await emitPassed("verify", { sublegs: ["verify"], artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  await emitFailed("verify", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
