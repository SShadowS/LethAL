/**
 * R557: `fixtures/sandbox-names` on bcdev (Cronus28), fenced. One leg, one session, against the same
 * pre-committed table as `itest:alrunner`'s names legs (pre-commitment B1,
 * docs/superpowers/specs/2026-10-09-r557-names-precommitment.md): every mutant killed by its row's
 * test, verdict and killing test equal to the al-runner legs, kill text carrying the row's
 * `<Proc>(5) must be 6`. It is the first live evidence for non-ASCII (`Blåbær Step`) and
 * special-character test names in BC's `Test Method Line`. Frozen as `bcdev.names.baseline.json`
 * (R332).
 *
 * The connection is `itest:bcdev`'s: `fixtures/sandbox-app`'s gitignored `lethal.config.local.json`
 * and `.vscode/launch.local.json` (the same container). Kept out of `bcdev.itest.ts` so that gate's
 * frozen 3 / 12 / 4 and its baseline cannot move with this one. The test app (`sandbox-names-tests`)
 * is published by the user, as for every bcdev gate (CLAUDE.md, R56).
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_BCDEV is unset.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { devPortOf, odataUrlsOf, validateBcDevConfig } from "../src/cli";
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
import { BaselineRecordedError, assertGateBaseline, preflightGateBaseline } from "./baseline-guard";
import {
  assertLaunchMatchesConfig,
  itestConfigName,
  itestConfigPath,
  itestLaunchPath,
  printItestTarget,
} from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  NAMES_PROJECT_DIR,
  NAMES_SELECTOR_IDS,
  NAMES_TEST_DIR,
  assertNamesRun,
  printNamesTable,
} from "./names-fixture";

if (!process.env.LETHAL_ITEST_BCDEV) {
  console.log(
    "skipped (set LETHAL_ITEST_BCDEV=1 and populate sandbox-app's gitignored launch.local.json / lethal.config.local.json)",
  );
  const challenged = await emitSkipped("bcdev-names", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTION_DIR = join(HERE, "..", "..", "..", "fixtures", "sandbox-app");
const CONFIG_LOCAL_PATH = itestConfigPath(CONNECTION_DIR);
printItestTarget(CONFIG_LOCAL_PATH);
const LAUNCH_LOCAL_PATH = itestLaunchPath(CONNECTION_DIR);
const BASELINE_PATH = join(HERE, "bcdev.names.baseline.json");

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
}

async function runFenced(scratchRoot: string): Promise<SessionReport> {
  const launchCfg = (await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json"))
    .configurations[0];
  if (!launchCfg) throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  assertLaunchMatchesConfig(launchCfg, bcdev, LAUNCH_LOCAL_PATH);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) throw new Error("could not locate alc/altool under the AL Language extension");

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
    defaultArtifactIo,
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      ...devPortOf(bcdev),
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    defaultDeployerIo,
  );
  const odataCfg = {
    ...odataUrlsOf(bcdev),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: NAMES_PROJECT_DIR,
      server: bcdev.server,
      ...devPortOf(bcdev),
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      coverageMode: "fenced",
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
    (targetAppId, artifactId, controlState) =>
      new RunMutantTransport(odataCfg, targetAppId, artifactId, undefined, { controlState }),
  );
  const store = new ResultsStore(join(scratchRoot, "lethal.sqlite"));
  try {
    return await runSession({
      backend,
      store,
      projectDir: NAMES_PROJECT_DIR,
      testDir: NAMES_TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: NAMES_SELECTOR_IDS,
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A scratch quarantine dir, never the real store (see bcdev.itest.ts).
      quarantineDir: join(scratchRoot, "quarantine"),
    });
  } finally {
    store.close();
    await backend.close();
  }
}

async function main(): Promise<void> {
  preflightGateBaseline(BASELINE_PATH, "bcdev names itest");
  const root = await mkdtemp(join(tmpdir(), "lethal-bcdev-names-"));
  try {
    const fenced = await runFenced(join(root, "fenced"));
    printNamesTable(fenced, "fenced");
    assertNamesRun(fenced, "fenced", { coverage: "fenced", transport: "bcdev" });
    const c = fenced.counts;
    console.log(
      `  names leg (bcdev): fenced killed=${c.killed} survived=${c.survived} noCoverage=${c.noCoverage}`,
    );
    await assertGateBaseline(fenced, BASELINE_PATH, "bcdev names itest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("bcdev names itest: PASS");
  await emitPassed("bcdev-names", { sublegs: ["fenced"], artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  console.error(formatFailure(err));
  await emitFailed("bcdev-names", err instanceof Error ? err.message : String(err));
  process.exit(err instanceof BaselineRecordedError ? 3 : 1);
});
