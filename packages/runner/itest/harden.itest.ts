#!/usr/bin/env bun
/**
 * C02-03's gate: `fixtures/sandbox-harden`, five planted survivors, one of them a true equivalent.
 *
 * Env-gated, standalone (`bun run itest:harden`), never picked up by `bun test`. Skips cleanly when
 * LETHAL_ITEST_HARDEN is unset.
 *
 * Two legs, one after the other, each a full `runSession` with the fixture's committed
 * `lethal.equivalent.json` loaded:
 *   A. the base suite, `fixtures/sandbox-harden-tests`: every mutant's verdict and killer against
 *      the pre-committed table in `harden-expected.ts`, the S5 mark, and `harden.baseline.json`;
 *   B. the answer key, `fixtures/sandbox-harden-answers`: S1..S4 killed by name, S5 still survives.
 * The baseline is written only after BOTH legs pass (`recordAfterBothLegs`). Every prediction is
 * pre-committed in docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md.
 *
 * Connection details are never committed; this reads the gitignored
 *   fixtures/sandbox-harden/lethal.config.local.json
 * and both test apps must be published to that container (R56: publishing a test app is the
 * user's own workflow).
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { loadEquivalenceMarks, odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { formatFailure } from "../src/format-failure";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import {
  BaselineRecordedError,
  assertGateBaseline,
  preflightGateBaseline,
  recordRequested,
} from "./baseline-guard";
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  HardenGateError,
  assertHardenAnswers,
  assertHardenMarks,
  assertHardenVerdicts,
  assertSingleBatch,
  recordAfterBothLegs,
} from "./harden-expected";

if (!process.env.LETHAL_ITEST_HARDEN) {
  console.log(
    "skipped (set LETHAL_ITEST_HARDEN=1, populate the gitignored " +
      "fixtures/sandbox-harden/lethal.config.local.json, and publish " +
      "fixtures/sandbox-harden-tests and fixtures/sandbox-harden-answers to that container to run this)",
  );
  const challenged = await emitSkipped("harden", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-harden");
const TESTS_DIR = join(REPO_ROOT, "fixtures", "sandbox-harden-tests");
const ANSWERS_DIR = join(REPO_ROOT, "fixtures", "sandbox-harden-answers");
const CONFIG_LOCAL_PATH = itestConfigPath(PROJECT_DIR);
const BASELINE_PATH = join(HERE, "harden.baseline.json");
/** R169: the top of sandbox-harden's 79500-79549 range, counting down. */
const SELECTOR_IDS = { selectorId: 79547, controlId: 79548, tableId: 79549 };
/** Microsoft's Base Application: its installed version is the BC build this gate ran against. */
const BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md.`,
    );
  }
  return JSON.parse(text) as T;
}

async function runLeg(
  scratchRoot: string,
  leg: "a" | "b",
  testDir: string,
): Promise<SessionReport> {
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc.exe/altool.exe under the AL Language extension install");
  }
  const equivalenceMarks = await loadEquivalenceMarks(PROJECT_DIR);
  if (equivalenceMarks === undefined || equivalenceMarks.length === 0) {
    throw new HardenGateError(`no equivalence marks loaded from ${PROJECT_DIR}`);
  }

  const outputDir = join(scratchRoot, `publish-${leg}`);
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
      ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
    },
    undefined,
    {
      compiler,
      deployer,
      verifier: new DeploymentVerifier(odataCfg),
      harnessVerifier,
    },
    (targetAppId, artifactId, controlState) =>
      new RunMutantTransport(odataCfg, targetAppId, artifactId, undefined, { controlState }),
  );

  const store = new ResultsStore(join(scratchRoot, `harden-${leg}.sqlite`));
  try {
    if (leg === "a") {
      // Printed first, as the other gates do: which control app and BC build this ran against.
      const base = await harnessVerifier.fetchExtensionInstalled(BASE_APPLICATION_ID);
      console.log(`harden itest: LethAL Control ${await harnessVerifier.fetchControlVersion()}`);
      console.log(`harden itest: BC build (Base Application) ${base.versions.join(", ")}`);
    }
    return await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir,
      instrumentedDir: join(scratchRoot, `instr-${leg}`),
      selectorIds: SELECTOR_IDS,
      equivalenceMarks,
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A SCRATCH quarantine dir, never the real ~/.lethal store (see bcdev.itest.ts).
      quarantineDir: join(scratchRoot, `quarantine-${leg}`),
    });
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive.
    await backend.close();
  }
}

function dump(label: string, report: SessionReport): void {
  const c = report.counts;
  console.log(
    `  [${label}] killed=${c.killed} survived=${c.survived} noCoverage=${c.noCoverage} timeoutKilled=${c.timeoutKilled} errors=${c.errors} batches=${report.batches} baselineGreen=${report.baselineGreen} totalMs=${report.timings.totalMs}`,
  );
  for (const m of report.mutants) {
    const killer = m.killingTest !== undefined ? ` by ${m.killingTest}` : "";
    const note = m.failureNote !== undefined ? ` note=${m.failureNote}` : "";
    console.log(
      `    ${m.mutantCode} ${m.verdict}${killer} ${m.file}:${m.line} ${m.operatorName}${note}`,
    );
  }
}

function assertBaselineGreen(label: string, report: SessionReport): void {
  if (!report.baselineGreen) {
    throw new HardenGateError(`${label}: the baseline is not green, so no verdict is meaningful`);
  }
}

async function main(): Promise<void> {
  preflightGateBaseline(BASELINE_PATH, "harden itest");
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-harden-itest-"));
  try {
    const a = await runLeg(scratchRoot, "a", TESTS_DIR);
    dump("leg A, sandbox-harden-tests", a);
    assertBaselineGreen("leg A", a);
    // Batch first: the table checks match S5 and the marks by mutantCode, which restarts per batch.
    assertSingleBatch(a);
    assertHardenVerdicts(a);
    assertHardenMarks(a);
    // Compare early so a mismatch names a mutant before leg B. In record mode the file is absent
    // (preflight) and is written only after leg B, by recordAfterBothLegs.
    if (!recordRequested(BASELINE_PATH)) await assertGateBaseline(a, BASELINE_PATH, "harden itest");

    await recordAfterBothLegs(
      a,
      async () => {
        const b = await runLeg(scratchRoot, "b", ANSWERS_DIR);
        dump("leg B, sandbox-harden-answers", b);
        assertBaselineGreen("leg B", b);
        assertSingleBatch(b);
        assertHardenAnswers(b);
        assertHardenMarks(b);
      },
      BASELINE_PATH,
    );

    console.log("harden itest: PASS");
    await emitPassed("harden", {
      sublegs: ["base-suite", "answer-key"],
      artifacts: { reported: false },
    });
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  // R332: print the reason before any await, so an operator sees it on the console even when
  // the following receipt write is slow or the process is killed before it finishes.
  console.error(formatFailure(err));
  await emitFailed("harden", err instanceof Error ? err.message : String(err));
  process.exit(err instanceof BaselineRecordedError ? 3 : 1);
}
