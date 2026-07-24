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
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

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
// Committed per-mutant healthy-path baseline (Task 15, design spec §14) — see baseline-guard.ts.
// Aggregate counts (EXPECTED below) are a smoke test; this catches a per-mutant verdict swap
// that leaves the aggregate counts unchanged.
const BASELINE_PATH = join(HERE, "bcdev.baseline.json");

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

// Sandbox target app id (fixtures/sandbox-app/app.json "id") — the RunMutant `targetAppId` and the
// registry key the artifact guard reads. Static: the fixture app id is frozen.
const TARGET_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
// Test-codeunit ids the probes drive directly (fixtures/sandbox-tests + fixtures/sandbox-probes).
const SANDBOX_TESTS_ID = 79100;
const ORDER_MATTERS_PROBE_ID = 79210;
const FAIL_PROBE_ID = 79211;
const PROBE_TIMEOUT_MS = 120_000;

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

interface RunOnceResult {
  readonly report: SessionReport;
  readonly odataCfg: ActivationConfig;
  readonly instrumentedDir: string;
}

async function runOnce(scratchRoot: string): Promise<RunOnceResult> {
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
  const verifier = new DeploymentVerifier(odataCfg);
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
    { compiler, deployer, verifier, harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );

  // Persistent, NOT `:memory:` — historical run data (priorSurvivorKeys) is a supported
  // workflow. NOTE: app-version monotonicity no longer depends on this DB — since Layer 5A
  // versions are clock-derived via reserveAppVersion (app-version.ts), so deleting
  // lethal.sqlite can no longer break publishing.
  const instrumentedDir = join(scratchRoot, "instrumented");
  const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir,
      selectorIds: SELECTOR_IDS,
    });
    return { report, odataCfg, instrumentedDir };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and
    // this script never exits, even on a fully successful run.
    await backend.close();
  }
}

/**
 * The gate is the per-mutant frozen table PLUS these protocol invariants (spec §11): the table
 * alone cannot catch a runner that runs the wrong method set or leaves a mutant active. Each probe
 * drives RunMutant directly against a fixture whose OUTCOME witnesses the invariant — so a lying
 * server (e.g. one that runs a whole codeunit but reports one line) is caught by behaviour, not by
 * a self-reported count. Uses the artifact the scratchB run just deployed (its id is what the
 * target's baked selector and the registry key on), read from the instrumented manifest on disk.
 */
async function runProtocolInvariantProbes(run: RunOnceResult): Promise<void> {
  const { report, odataCfg, instrumentedDir } = run;

  const manifest = await readJson<{ artifactId?: unknown }>(
    join(instrumentedDir, "mutant-manifest.json"),
    "mutant-manifest.json",
  );
  if (typeof manifest.artifactId !== "string") {
    throw new Error("mutant-manifest.json has no string artifactId — cannot drive probes");
  }
  const artifactId = manifest.artifactId;

  const tx = new RunMutantTransport(odataCfg, TARGET_APP_ID, artifactId);
  const overBudget: TestMethodRef = {
    codeunitId: SANDBOX_TESTS_ID,
    codeunitName: "Sandbox Tests",
    method: "OverBudgetDetected",
  };

  // Invariant 1 — exactly-one-method-ran (order-matters witness, spec §C1). Requesting only
  // ZzFailsIfMarkerPresent and observing PASS proves AaInsertsMarker did NOT also run: had the
  // server run the whole codeunit, the marker would be present and this method would fail.
  const order = await tx.run({
    ref: {
      codeunitId: ORDER_MATTERS_PROBE_ID,
      codeunitName: "Order Matters Probe",
      method: "ZzFailsIfMarkerPresent",
    },
    mutantId: "",
    attemptId: "probe-order",
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(
    order.outcome,
    "pass",
    `exactly-one-method invariant: RunMutant(ZzFailsIfMarkerPresent) must run ONLY that method; a non-pass means AaInsertsMarker also ran server-side (whole-codeunit run). got ${JSON.stringify(order)}`,
  );

  // Failure round-trip (spec §11): the exact error text survives the identity-validated mapping
  // (result enum 1 -> fail, message carried through).
  const fail = await tx.run({
    ref: { codeunitId: FAIL_PROBE_ID, codeunitName: "Fail Probe", method: "AlwaysFails" },
    mutantId: "",
    attemptId: "probe-fail",
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(fail.outcome, "fail", `fail probe must map to fail, got ${JSON.stringify(fail)}`);
  assert.ok(
    fail.failureMessage?.includes("LETHAL-PROBE-FAIL: exact-error-round-trip"),
    `fail probe must round-trip its exact error, got ${JSON.stringify(fail.failureMessage)}`,
  );

  // Invariant 2 — run-scoped clear (spec §5 step 6, §C2). A killer mutant from the frozen table:
  // RunMutant activating it must make OverBudgetDetected fail (proof it was active during the run),
  // then a baseline RunMutant must pass (proof the same call cleared it — container left unmutated).
  const killer = report.mutants.find((m) => m.verdict === "killed");
  if (!killer) {
    throw new Error("no killed mutant in report — cannot drive the run-scoped-clear probe");
  }
  const mutated = await tx.run({
    ref: overBudget,
    mutantId: killer.mutantCode,
    attemptId: "probe-clear-active",
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(
    mutated.outcome,
    "fail",
    `run-scoped-clear setup: killer mutant ${killer.mutantCode} must make OverBudgetDetected fail ` +
      `(mutant active during the run). got ${JSON.stringify(mutated)}`,
  );
  const cleared = await tx.run({
    ref: overBudget,
    mutantId: "",
    attemptId: "probe-clear-baseline",
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(
    cleared.outcome,
    "pass",
    `run-scoped-clear: after a killer RunMutant, a baseline RunMutant must pass — the container must be left unmutated. got ${JSON.stringify(cleared)}`,
  );

  // Attestation fence (design §G): both `mutated` and `cleared` are real covered runs that drove
  // the deployed target's `Mutation Selector` (IsOverBudget's guard consulted `LC Control State`),
  // so each `ran` verdict must carry a CLEAN attestation — `observedAny` true (a selector was
  // consulted) AND `identityMismatch` false (the live binary's baked (targetAppId, artifactId)
  // matched what we deployed). This is the live proof the running binary is ours; a wrong/stale
  // binary would surface `identityMismatch: true` (already mapped to `error` by the transport, so
  // it never reaches here as a verdict) or, if it ran no guard, `observedAny: false`.
  for (const [label, v] of [
    ["mutated", mutated],
    ["cleared", cleared],
  ] as const) {
    assert.ok(
      v.attestation !== undefined &&
        v.attestation.observedAny === true &&
        v.attestation.identityMismatch === false,
      `attestation §G: covered run "${label}" must cleanly attest the deployed binary's selector ` +
        `(observedAny && !identityMismatch). got ${JSON.stringify(v.attestation)}`,
    );
  }

  // Invariant 3 — artifact-mismatch (spec §C1). A RunMutant whose artifactId differs from the
  // registered one runs nothing and is a typed error, never a verdict.
  const bogusTx = new RunMutantTransport(odataCfg, TARGET_APP_ID, "f".repeat(32));
  const mismatch = await bogusTx.run({
    ref: overBudget,
    mutantId: "",
    attemptId: "probe-artifact-mismatch",
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(
    mismatch.outcome,
    "error",
    `artifact-mismatch must be a typed error, never a verdict. got ${JSON.stringify(mismatch)}`,
  );
  assert.ok(
    mismatch.failureMessage?.includes("artifact-mismatch"),
    `artifact-mismatch probe must surface the mismatch, got ${JSON.stringify(mismatch.failureMessage)}`,
  );

  // Invariant 4 — identity-mismatch rejection (spec §I5). Every real RunMutant above validated the
  // echoed identity tuple; a server that ran something other than requested would have surfaced as
  // an error and failed the assertions here. The client-side rejection of a doctored echo is
  // unit-tested in run-mutant-transport.test.ts.

  console.log("bcdev itest: protocol-invariant probes PASS");
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
    assertVerdictTable(first.report);
    // Per-mutant regression guard against the committed baseline — in addition to the aggregate
    // verdict counts assertVerdictTable already checked. A per-mutant difference fails the
    // itest even when killed/survived/no-coverage totals still match (Task 15, design spec §14).
    await assertMatchesBaseline(first.report, BASELINE_PATH, "bcdev itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second.report);

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first.report),
      shape(second.report),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion)",
    );

    // Gate = the frozen per-mutant table above PLUS the protocol invariants (spec §11). Runs
    // against the artifact scratchB just deployed, before the scratch dirs are cleaned up.
    await runProtocolInvariantProbes(second);
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
