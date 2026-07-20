#!/usr/bin/env bun
/**
 * Env-gated integration test against a live bc-dev-mcp + Business Central
 * dev server. NOT a `bun:test` file — standalone script invoked via
 * `bun run itest:bcdev` (root package.json), never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_BCDEV is unset.
 *
 * This is also where the assumptions pinned during implementation (without
 * a live server to check against) get verified against real infra, and, if
 * wrong, fixed in one commit each:
 *   - `bcdev_test_run` MCP payload shape (Task 7, bcdev-backend.ts)
 *   - `altool` flag spellings (Task 8, publisher.ts)
 *   - OData `MutationControl_*` action parameter/return shape (Task 9, activation.ts)
 *
 * Connection details are never committed: this script reads
 *   fixtures/sandbox-app/.vscode/launch.local.json  (AL server/tenant/environment — gitignored)
 *   fixtures/sandbox-app/lethal.config.local.json    (LethAL bcdev section — gitignored)
 * See fixtures/README.md for the expected shape of both files.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MutationControlClient } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";

if (!process.env.LETHAL_ITEST_BCDEV) {
  console.log(
    "skipped (set LETHAL_ITEST_BCDEV=1 and populate the gitignored launch.local.json / " +
      "lethal.config.local.json fixture files to run against a live dev server)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");

// Must live inside the fixture's declared idRanges (79000-79199, see fixtures/README.md) —
// the real alc.exe enforces app.json idRanges (AL0297) for every compiled object, including
// these injected ones; verified against a real BC server 2026-07-18.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

// Hand-computed against fixtures/sandbox-app/src (see fixtures/README.md §Expected verdict table).
// bcdev reports procedure-level coverage, so DiscountedPrice (never called by any test) is
// reported as "no-coverage" rather than "survived".
//
// 16 since the parenthesized-operand operator bug was fixed (findOperatorToken in
// packages/builtin-tier1/src/mutate-helpers.ts): ClampPercent's `(Value < 0) or
// (Value > 100)` now yields its negate-conditional mutant. It survives — ClampPercentRuns
// calls ClampPercent(50) and asserts nothing, and 50 satisfies neither operand, so or/and
// is not observable there anyway.
const EXPECTED = {
  totalMutantSites: 16,
  killed: 3,
  survived: 10,
  noCoverage: 3,
};

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly server?: string;
    readonly serverInstance?: string;
    readonly tenant?: string;
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

async function runOnce(scratchRoot: string): Promise<SessionReport> {
  const launchLocal = await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json");
  const launchCfg = launchLocal.configurations[0];
  if (!launchCfg) {
    throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  }

  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);

  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
  }

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    {
      alcPath: toolPaths.alcPath,
      packageCachePath: bcdev.packageCachePath,
      outputDir,
    },
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
  const activation = new MutationControlClient(odataCfg);
  const verifier = new DeploymentVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
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
    { compiler, deployer, verifier },
    activation,
  );

  // Persistent, NOT `:memory:` — historical run data (priorSurvivorKeys) is a supported
  // workflow. NOTE: app-version monotonicity no longer depends on this DB — since Layer 5A
  // versions are clock-derived via reserveAppVersion (app-version.ts), so deleting
  // lethal.sqlite can no longer break publishing.
  const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
  try {
    return await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: SELECTOR_IDS,
    });
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and
    // this script never exits, even on a fully successful run.
    await backend.close();
  }
}

function assertVerdictTable(report: SessionReport): void {
  assert.equal(
    report.baselineGreen,
    true,
    "baseline must be green (both fixture tests pass unmutated)",
  );
  assert.equal(report.counts.killed, EXPECTED.killed, "killed count mismatch");
  assert.equal(report.counts.survived, EXPECTED.survived, "survived count mismatch");
  assert.equal(report.counts.noCoverage, EXPECTED.noCoverage, "no-coverage count mismatch");

  const killed = report.mutants.filter((m) => m.verdict === "killed");
  assert.equal(killed.length, EXPECTED.killed);
  for (const m of killed) {
    assert.ok(
      m.file.includes("SandboxLogic"),
      `expected every killed mutant in SandboxLogic.Codeunit.al (IsOverBudget), got ${m.file}`,
    );
  }

  const noCoverage = report.mutants.filter((m) => m.verdict === "no-coverage");
  assert.equal(noCoverage.length, EXPECTED.noCoverage);
  for (const m of noCoverage) {
    assert.ok(
      m.file.includes("SandboxPricing"),
      `expected every no-coverage mutant in SandboxPricing.Codeunit.al (DiscountedPrice, never called), got ${m.file}`,
    );
  }
}

async function main(): Promise<void> {
  const files = await generateMutationSet(join(PROJECT_DIR, "src"));
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the fixture, generated ${total}`,
  );

  const scratchA = await mkdtemp(join(tmpdir(), "lethal-itest-bcdev-a-"));
  const scratchB = await mkdtemp(join(tmpdir(), "lethal-itest-bcdev-b-"));
  try {
    const first = await runOnce(scratchA);
    assertVerdictTable(first);

    const second = await runOnce(scratchB);
    assertVerdictTable(second);

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first),
      shape(second),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion)",
    );
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }

  console.log("bcdev itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
