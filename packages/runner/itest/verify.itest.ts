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
 * docs/superpowers/specs/2026-09-26-c02-06-verify-precommitment.md, and the C02-09 gap steps in
 * docs/superpowers/specs/2026-09-26-c02-09-gap-precommitment.md. The steps:
 *   1. runSession, per mutant equal to bcdev.baseline.json; keep timings and the last artifact;
 *      then explain's 4 gaps and 1 no-coverage block, by identity key (C02-09);
 *   2. a scratch copy of sandbox-tests with ONE added test that kills the ClampPercent survivor;
 *   3. verify both survivors with it: ClampPercent killed by the new test, LogAudit survived, exit 5;
 *   4. in a finally once 3 began: verify with the unchanged sandbox-tests, both survived, exit 5;
 *   4b. only once 4 passed: verify the LogAudit then-block gap BY ID, the artifact and the gap id
 *      both read from explain's gap entry: its 2 survivors, both survived, exit 5 (C02-09);
 *   5. refusals against the real store, exit 6 and no lease acquire each, including an unknown
 *      gap id and a gap with no survivor (C02-09);
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
import { explain } from "../src/explain";
import type { ExplainGap } from "../src/explain";
import { formatFailure } from "../src/format-failure";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import { defaultQuarantineDir, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { VERIFY_EXIT, runVerify } from "../src/verify";
import type { VerifyOutput, VerifyResult } from "../src/verify";
import { preflightReadOnlyBaseline } from "./baseline-guard";
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import { diffMutants, keyOf, normalizeForComparison } from "./mutant-equality";
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
/** The only source covering test of ClampPercent and LogAudit (R-384 pre-commitment). */
const COVERING_TEST = `${TEST_CODEUNIT.codeunitName}.ClampPercentRuns`;
/** R-384: the reach filter's state lines, as the blind pre-commitment predicts them. */
const REACH_STEP3 =
  "[lethal] verify: reach filter on (fenced coverage): 1 new test(s), 0 joined every survivor because their coverage could not be used; 1 mutant run(s) instead of 2 without the filter; 1 survivor(s) no new test reaches.";
const REACH_NO_NEW_TESTS =
  "[lethal] verify: reach filter on (fenced coverage): 0 new test(s), 0 joined every survivor because their coverage could not be used; 0 mutant run(s) instead of 0 without the filter; 2 survivor(s) no new test reaches.";
const REACH_UNREACHED_PREFIX = "[lethal] verify: survivors no new test reaches: ";
/** Microsoft's Base Application: its installed version is the BC build this gate ran against. */
const BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
/** The three frozen rows this gate drives, by identity key suffix in bcdev.baseline.json. */
const CLAMP_KEY = "|Sandbox Logic|ClampPercent|lethal.negate-conditional|";
const LOGAUDIT_KEY = "|Sandbox Logic|LogAudit|lethal.negate-conditional|";
const KILL_KEY = "|Sandbox Logic|IsOverBudget|lethal.return-value|";

/**
 * C02-09: explain's gaps and no-coverage block on the step-1 report, measured offline before the
 * run (see the gap pre-commitment). Full identity keys from bcdev.baseline.json.
 */
const CLAMP_GAP = {
  name: "ClampPercent body",
  gapId: "G72826da4c976",
  keys: [
    "b03dba085d6a4498f41e5e223ecb64c66e6eee1d2d2ef7ab55f84fa7c63835d7|Sandbox Logic|ClampPercent|lethal.empty-block|1",
    "241fff269e9c9b9a336099e4588ad85b0198a155d98dccc6e48adf1e551f6341|Sandbox Logic|ClampPercent|lethal.negate-conditional|1",
    "fc15ec3036dca5e21a2e79675b48f28e5815811f32dff4eb3426e0ff803575bb|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1",
    "58ade303c82ea175e1cabd4e46b8cd818e3a59a66b60578ef4d85077548d40e9|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1",
    "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Sandbox Logic|ClampPercent|lethal.return-value|1",
  ],
};
const APPLY_GAP = {
  name: "ApplyAudit body",
  gapId: "G140fcb49d7d2",
  keys: [
    "2b34811c1b253fde93b24824f30d18d933316b7f64723b67d413a3b0d16956a6|Sandbox Logic|ApplyAudit|lethal.empty-block|1",
    "9b4f290c51c1ef232af4a294bb9a0a4c404064f20bac6e893fab28b45cdf7785|Sandbox Logic|ApplyAudit|lethal.void-method-call|1",
  ],
};
const LOG_BODY_GAP = {
  name: "LogAudit body",
  gapId: "G4e97ec8a420a",
  keys: [
    "63c4f230d49983a82f9a54edf57f787ba2196df2de23c5374a9921c523fc408f|Sandbox Logic|LogAudit|lethal.empty-block|1",
    "5cba655a6ac203ce40d31b0b4974a7b2f308cfec342a35d8e1a4f8d8c09c5c03|Sandbox Logic|LogAudit|lethal.negate-conditional|1",
    "63b9fa65d3452236af3d725f80a805268813f9012185c0296fe552908eae1d6d|Sandbox Logic|LogAudit|lethal.shift-integer|1",
  ],
};
const LOG_THEN_GAP = {
  name: "LogAudit then-block",
  gapId: "Gd09a2f841d4e",
  keys: [
    "77ee7e3d0adfcd76e1ae34e9067dcebc5c466f1172a857c730b0d43f7085d15c|Sandbox Logic|LogAudit|lethal.empty-block|1",
    "d8f839f87361f4d85b7ccd435b318285a82e1e3610237d66488e17b8bdd61de3|Sandbox Logic|LogAudit|lethal.remove-assignment|1",
  ],
};
const PREDICTED_GAPS = [CLAMP_GAP, APPLY_GAP, LOG_BODY_GAP, LOG_THEN_GAP];
const PREDICTED_NO_COVERAGE_KEYS = [
  "e7216a276891ae7f02f66d83d4fad98fdc3ca56552d617d1f70fa371f7cfc667|Sandbox Pricing|DiscountedPrice|lethal.empty-block|1",
  "4b61c09033d7c8404656624ea1865b451a890db32d8212d97f8a77e9a5c2634a|Sandbox Pricing|DiscountedPrice|lethal.conditional-boundary|1",
  "98656555452a91ccc91c88a8a0bc3f58192db5f5153792b959447d06cff62cf1|Sandbox Pricing|DiscountedPrice|lethal.return-value|1",
  "d7143458adf859fcca3a104795916421514185dbe83b5e6366d0f68f86e9389d|Sandbox Pricing|DiscountedPrice|lethal.swap-additive|1",
];
const OVER_BUDGET_GAP_ID = "G9890e48cccd0";
/** A well-formed gap id that no block of sandbox-app has (step 5c asserts that first). */
const UNKNOWN_GAP_ID = "G000000000000";

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
  preflightReadOnlyBaseline(BASELINE_PATH, "verify itest");
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

    // ---- 1 (C02-09). explain's gaps and no-coverage block, by identity key.
    const keyById = new Map(
      report.mutants.map((m) => [`${m.batchIndex}/${m.mutantCode}`, keyOf(m)]),
    );
    const keysOf = (step: string, batchIndex: number, codes: readonly string[]): string[] =>
      codes
        .map((c) => {
          const k = keyById.get(`${batchIndex}/${c}`);
          assert.ok(k !== undefined, `${step}: ${batchIndex}/${c} is a mutant of the report`);
          return k;
        })
        .sort();
    const explained = explain(report);
    const gaps = explained.gaps;
    const blocks = explained.noCoverageBlocks;
    assert.ok(gaps !== undefined && blocks !== undefined, "step 1: explain lists gaps and blocks");
    assert.equal(gaps.length, 4, `step 1: exactly 4 gaps (${JSON.stringify(gaps)})`);
    let memberTotal = 0;
    for (const p of PREDICTED_GAPS) {
      const hits: readonly ExplainGap[] = gaps.filter((x) => x.gapId === p.gapId);
      const [g] = hits;
      assert.ok(g !== undefined && hits.length === 1, `step 1: one gap ${p.gapId} (${p.name})`);
      assert.deepEqual(
        keysOf("step 1", g.batchIndex, g.members),
        [...p.keys].sort(),
        `step 1: ${p.name} members`,
      );
      assert.equal(g.survived, p.keys.length, `step 1: ${p.name} survived`);
      assert.deepEqual([g.killed, g.noCoverage, g.other], [0, 0, 0], `step 1: ${p.name} counts`);
      assert.equal(g.unobservedBlock, true, `step 1: ${p.name} unobservedBlock`);
      assert.equal(g.artifactId, lastArtifact.artifactId, `step 1: ${p.name} artifactId`);
      memberTotal += g.members.length;
    }
    assert.equal(memberTotal, 12, "step 1: 12 gap members in total");
    assert.equal(memberTotal, report.counts.survived, "step 1: every survivor is in a gap");
    assert.equal(
      blocks.length,
      1,
      `step 1: exactly 1 no-coverage block (${JSON.stringify(blocks)})`,
    );
    const [block] = blocks;
    assert.ok(block !== undefined);
    assert.equal(block.procedureName, "DiscountedPrice", "step 1: the no-coverage block");
    assert.deepEqual(
      keysOf("step 1", block.batchIndex, block.members),
      [...PREDICTED_NO_COVERAGE_KEYS].sort(),
      "step 1: DiscountedPrice no-coverage members",
    );
    const overBudget = report.mutants.filter((m) => m.procedureName === "IsOverBudget");
    assert.equal(overBudget.length, 3, "step 1: three IsOverBudget rows");
    assert.ok(
      overBudget.every((m) => m.verdict === "killed"),
      "step 1: IsOverBudget rows all killed",
    );
    assert.deepEqual(
      [...new Set(overBudget.map((m) => m.gapId))],
      [OVER_BUDGET_GAP_ID],
      "step 1: IsOverBudget's rows carry one gap id",
    );
    const overBudgetGapId = overBudget[0]?.gapId;
    assert.ok(overBudgetGapId !== undefined, "step 1: the IsOverBudget gap id, read off its rows");
    assert.ok(
      !gaps.some((g) => g.gapId === OVER_BUDGET_GAP_ID) &&
        !blocks.some((b) => b.procedureName === "IsOverBudget"),
      "step 1: IsOverBudget is in neither list",
    );
    const thenGap = gaps.find((g) => g.gapId === LOG_THEN_GAP.gapId);
    const thenArtifact = thenGap?.artifactId;
    assert.ok(
      thenGap !== undefined && thenArtifact !== undefined,
      "step 1: the then-block gap names its artifact",
    );
    console.log(
      `step 1 PASS (C02-09): explain lists 4 gaps (${gaps.map((g) => `${g.gapId}:${g.members.length}`).join(", ")}), 12 members, all unobservedBlock, all on artifact ${lastArtifact.artifactId}; 1 no-coverage block of 4; IsOverBudget ${OVER_BUDGET_GAP_ID} in neither`,
    );
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

    /**
     * One `lethal verify` through the CLI code path: its printed JSON, exit code, acquires, and the
     * reach filter's state lines. R-384: `verifyFromCli` hands `runVerify` a `log` that writes to
     * stderr; the gate wraps its `runVerify` seam to capture those lines (still echoed to stderr).
     */
    const verify = async (
      step: string,
      testDir: string,
      artifact: string,
      survivors: readonly string[],
    ): Promise<{ code: number; out: VerifyOutput; acquired: number; reachLog: string[] }> => {
      let text = "";
      const reachLog: string[] = [];
      const before = acquires;
      const code = await verifyFromCli(
        { mode: "verify", dbPath, artifact, testDir, survivors, configPath: CONFIG_LOCAL_PATH },
        {
          write: (t) => {
            text += t;
          },
          runVerify: (args, deps) =>
            runVerify(args, {
              ...deps,
              log: (line) => {
                reachLog.push(line);
                process.stderr.write(`${line}\n`);
              },
            }),
        },
      );
      const out = JSON.parse(text) as VerifyOutput;
      console.log(`${step}: lethal verify exit ${code}\n${text}`);
      assert.equal(out.exitCode, code, `${step}: printed exitCode = returned exit code`);
      return { code, out, acquired: acquires - before, reachLog };
    };
    /** R-384 pre-commitment: a row's `testsRun` is exactly this SET of qualified names. */
    const assertTestsRun = (
      step: string,
      row: VerifyResult,
      expected: readonly string[],
      what: string,
    ): void => {
      assert.ok(row.testsRun !== undefined, `${step}: ${what} carries testsRun`);
      assert.deepEqual(
        [...row.testsRun].sort(),
        [...expected].sort(),
        `${step}: ${what} testsRun (${row.testsRun.join(", ")})`,
      );
    };
    /**
     * R-384 pre-commitment: the reach log is exactly `first`, then (when `unreached` is given) the
     * "no new test reaches" line naming exactly that SET of ids. Order is checked only when the
     * pre-commitment decides it, i.e. when there is one id.
     */
    const assertReachLog = (
      step: string,
      reachLog: readonly string[],
      first: string,
      unreached: readonly string[],
    ): void => {
      if (unreached.length === 0) {
        assert.deepEqual(reachLog, [first], `${step}: the reach log`);
        return;
      }
      assert.equal(reachLog.length, 2, `${step}: two reach lines (${JSON.stringify(reachLog)})`);
      const [line1, line2] = reachLog;
      assert.equal(line1, first, `${step}: the reach state line`);
      assert.ok(line2 !== undefined, `${step}: the second reach line`);
      assert.ok(
        line2.startsWith(REACH_UNREACHED_PREFIX),
        `${step}: the second reach line names the unreached survivors (${line2})`,
      );
      assert.deepEqual(
        line2.slice(REACH_UNREACHED_PREFIX.length).split(", ").sort(),
        [...unreached].sort(),
        `${step}: the unreached survivors (${line2})`,
      );
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
      const { code, out, acquired, reachLog } = await verify(
        "step 3",
        newTestDir,
        lastArtifact.artifactId,
        [clampId, logAuditId],
      );
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
      // R-384 pre-commitment: the new test reaches ClampPercent and joins it.
      assertTestsRun("step 3", clamp, [COVERING_TEST, NEW_TEST_QUALIFIED], "ClampPercent");
      const logAudit = rowOf("step 3", out, logAuditId);
      assert.equal(logAudit.verdict, "survived", "step 3: LogAudit survived");
      // R-384 pre-commitment: the new test calls only ClampPercent and never reaches the local
      // LogAudit, so the reach filter does NOT send it there (pre-R-384 it joined every survivor).
      assertTestsRun("step 3", logAudit, [COVERING_TEST], "LogAudit (the new test filtered out)");
      assertReachLog("step 3", reachLog, REACH_STEP3, [logAuditId]);
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
        `step 3 PASS: ${NEW_TEST_QUALIFIED} stable (sessions ${b.sessionId}, ${r.sessionId}); ClampPercent killed by it (other), LogAudit survived without it (reach filter); reach lines as pre-committed; exit 5; read-back equal; lease free`,
      );
    } catch (err) {
      step3Err = err;
    }

    // ---- 4. Restore: the unchanged test project, also the "survived" leg. Always, once 3 began.
    let step4Err: unknown;
    let step4Run: { out: VerifyOutput; reachLog: string[] } | undefined;
    try {
      const { code, out, reachLog } = await verify("step 4", TEST_DIR, lastArtifact.artifactId, [
        clampId,
        logAuditId,
      ]);
      assert.equal(code, VERIFY_EXIT.notAllKilled, "step 4: exit 5");
      assert.deepEqual(out.newTests, [], "step 4: no new tests");
      assert.equal(rowOf("step 4", out, clampId).verdict, "survived", "step 4: ClampPercent");
      assert.equal(rowOf("step 4", out, logAuditId).verdict, "survived", "step 4: LogAudit");
      await assertFreshReadBack("step 4", out);
      step4Run = { out, reachLog };
      console.log(
        "step 4 PASS: restored; ClampPercent survived, so the new test is gone from the server",
      );
    } catch (err) {
      step4Err = err;
    }
    // ---- 4 (R-384). The reach pins, apart from the restore proof: a wrong reach line is not a
    // failed restore, so it must neither claim the container is dirty nor stop step 4b.
    let step4ReachErr: unknown;
    if (step4Run !== undefined) {
      try {
        const { out, reachLog } = step4Run;
        assertTestsRun("step 4", rowOf("step 4", out, clampId), [COVERING_TEST], "ClampPercent");
        assertTestsRun("step 4", rowOf("step 4", out, logAuditId), [COVERING_TEST], "LogAudit");
        // The "on" line prints with zero new tests too; the two ids' order is not pre-committed.
        assertReachLog("step 4", reachLog, REACH_NO_NEW_TESTS, [clampId, logAuditId]);
        console.log("step 4 PASS (R-384): testsRun and reach lines as pre-committed");
      } catch (err) {
        step4ReachErr = err;
      }
    }
    // ---- 4b (C02-09). One gap by id, with the repo's test app. Only once step 4 restored it.
    let step4bErr: unknown;
    if (step4Err === undefined) {
      try {
        const { code, out, acquired, reachLog } = await verify("step 4b", TEST_DIR, thenArtifact, [
          thenGap.gapId,
        ]);
        assert.equal(code, VERIFY_EXIT.notAllKilled, "step 4b: exit 5");
        assert.equal(
          out.refused,
          undefined,
          `step 4b: no refusal (${JSON.stringify(out.refused)})`,
        );
        assert.equal(out.quarantined, undefined, `step 4b: no quarantine (${out.quarantined})`);
        assert.equal(acquired, 1, "step 4b: exactly one lease acquire");
        assert.equal(out.results.length, 2, "step 4b: exactly two results");
        const keys = out.results
          .map((r) => {
            const k = keyById.get(r.id);
            assert.ok(k !== undefined, `step 4b: ${r.id} is a mutant of the step-1 report`);
            return k;
          })
          .sort();
        assert.deepEqual(keys, [...LOG_THEN_GAP.keys].sort(), "step 4b: the then-block's two");
        for (const r of out.results) {
          assert.equal(r.verdict, "survived", `step 4b: ${r.id} survived`);
          assert.equal(r.gapId, thenGap.gapId, `step 4b: ${r.id} carries the requested gap id`);
          assertTestsRun("step 4b", r, [COVERING_TEST], r.id);
        }
        // R-384 pre-commitment: the gap's two members, in an order it does not decide.
        assertReachLog(
          "step 4b",
          reachLog,
          REACH_NO_NEW_TESTS,
          out.results.map((r) => r.id),
        );
        console.log(
          `step 4b PASS: verify --artifact ${thenArtifact} --survivors ${thenGap.gapId} ran ${out.results.map((r) => r.id).join(", ")}, both survived, exit 5, one lease acquire`,
        );
      } catch (err) {
        step4bErr = err;
      }
    }
    if (
      step3Err !== undefined ||
      step4Err !== undefined ||
      step4ReachErr !== undefined ||
      step4bErr !== undefined
    ) {
      const describe = (e: unknown) => formatFailure(e);
      throw new Error(
        [
          step3Err !== undefined ? `step 3 FAILED: ${describe(step3Err)}` : "step 3 passed",
          step4Err !== undefined
            ? `step 4 (restore) FAILED: ${describe(step4Err)}. The container may carry the scratch test app: restore fixtures/sandbox-tests by hand before any gate. Step 4b did not run.`
            : "step 4 (restore) PASSED: ClampPercent survived with the repo's test app",
          ...(step4ReachErr !== undefined
            ? [`step 4 (R-384 reach pins) FAILED: ${describe(step4ReachErr)}`]
            : []),
          ...(step4bErr !== undefined ? [`step 4b FAILED: ${describe(step4bErr)}`] : []),
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
      const { code, out, acquired, reachLog } = await verify(step, TEST_DIR, artifact, survivors);
      assert.equal(code, VERIFY_EXIT.refused, `${step}: exit 6`);
      // R-384 pre-commitment: a refusal comes before `narrow`, so no reach line is printed.
      assert.deepEqual(reachLog, [], `${step}: no reach line`);
      assert.equal(out.refused?.reason, reason, `${step}: ${JSON.stringify(out.refused)}`);
      assert.equal(acquired, 0, `${step}: no lease acquire`);
      assert.equal(out.verifyRunId, undefined, `${step}: no verify run row`);
      console.log(`${step} PASS: refused ${reason}, no lease acquire`);
    };
    await refused("step 5a", lastArtifact.artifactId, [killId], "not-a-survivor");
    await refused("step 5b", randomBytes(16).toString("hex"), [clampId], "unknown-artifact");
    assert.ok(
      !report.mutants.some((m) => m.gapId === UNKNOWN_GAP_ID),
      `step 5c: ${UNKNOWN_GAP_ID} is not the gap id of any report row`,
    );
    await refused("step 5c", lastArtifact.artifactId, [UNKNOWN_GAP_ID], "unknown-gap");
    await refused("step 5d", lastArtifact.artifactId, [overBudgetGapId], "gap-has-no-survivor");

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
  // R332: print the reason before any await, so an operator sees it on the console even when
  // the following receipt write is slow or the process is killed before it finishes.
  console.error(formatFailure(err));
  await emitFailed("verify", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
