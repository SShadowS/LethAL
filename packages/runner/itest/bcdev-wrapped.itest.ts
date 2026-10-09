/**
 * R497: `fixtures/sandbox-wrapped` on bcdev (Cronus28), the live leg for the BC paths' admission of
 * the `#if`-wrapped shapes R-300b measured. Two legs, one session each: `coverageMode: "fenced"` and
 * `coverageMode: "procedure"` (the hub). Each must equal the pre-committed table per mutant
 * (docs/superpowers/specs/2026-10-08-r497-bcdev-wrapped-precommitment.md, `EXPECTED_WRAPPED_BC`),
 * with strict twin parity and no refusal of a fixture object; the hub leg must equal the fenced leg
 * per mutant; the fenced leg is frozen in `bcdev.wrapped.baseline.json` (R332).
 *
 * The connection is `itest:bcdev`'s: `fixtures/sandbox-app`'s gitignored `lethal.config.local.json`
 * and `.vscode/launch.local.json` (the same container). Kept out of `bcdev.itest.ts` so that gate's
 * frozen 3 / 12 / 4 and its baseline cannot move with this one.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_BCDEV is unset.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
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
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  WRAPPED_PROJECT_DIR,
  WRAPPED_SELECTOR_IDS,
  WRAPPED_SYMBOLS,
  WRAPPED_TEST_DIR,
  assertBcWrappedRun,
  assertWrappedLegsEqual,
  printWrappedTable,
} from "./wrapped-fixture";

if (!process.env.LETHAL_ITEST_BCDEV) {
  console.log(
    "skipped (set LETHAL_ITEST_BCDEV=1 and populate sandbox-app's gitignored launch.local.json / lethal.config.local.json)",
  );
  const challenged = await emitSkipped("bcdev-wrapped", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTION_DIR = join(HERE, "..", "..", "..", "fixtures", "sandbox-app");
const LAUNCH_LOCAL_PATH = join(CONNECTION_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = itestConfigPath(CONNECTION_DIR);
const BASELINE_PATH = join(HERE, "bcdev.wrapped.baseline.json");

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

async function runLeg(
  scratchRoot: string,
  coverageMode: "fenced" | "procedure",
): Promise<{ report: SessionReport; warnings: string[] }> {
  const launchCfg = (await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json"))
    .configurations[0];
  if (!launchCfg) throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) throw new Error("could not locate alc/altool under the AL Language extension");

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  // alc must compile under the SAME config symbols generation enumerated under (`/define`), or it
  // compiles the other arm: R-307's manifest check refused exactly that on the first run.
  const compiler = new ArtifactCompiler(
    {
      alcPath: toolPaths.alcPath,
      packageCachePath: bcdev.packageCachePath,
      outputDir,
      preprocessorSymbols: WRAPPED_SYMBOLS,
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
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: WRAPPED_PROJECT_DIR,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      coverageMode,
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
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
    original(...args);
  };
  const store = new ResultsStore(join(scratchRoot, "lethal.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: WRAPPED_PROJECT_DIR,
      testDir: WRAPPED_TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: WRAPPED_SELECTOR_IDS,
      preprocessorSymbols: WRAPPED_SYMBOLS,
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A scratch quarantine dir, never the real store (see bcdev.itest.ts).
      quarantineDir: join(scratchRoot, "quarantine"),
    });
    return { report, warnings };
  } finally {
    console.warn = original;
    store.close();
    await backend.close();
  }
}

async function main(): Promise<void> {
  preflightGateBaseline(BASELINE_PATH, "bcdev wrapped itest");
  const root = await mkdtemp(join(tmpdir(), "lethal-bcdev-wrapped-"));
  try {
    const fenced = await runLeg(join(root, "fenced"), "fenced");
    printWrappedTable(fenced.report, "fenced");
    const hub = await runLeg(join(root, "hub"), "procedure");
    printWrappedTable(hub.report, "hub");
    const problems: string[] = [];
    for (const [leg, r] of [
      ["fenced", fenced],
      ["hub", hub],
    ] as const) {
      try {
        assertBcWrappedRun(r.report, leg, r.warnings);
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    try {
      assertWrappedLegsEqual(fenced.report, hub.report, "hub vs fenced");
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const c = fenced.report.counts;
    console.log(
      `  wrapped legs (bcdev): fenced killed=${c.killed} survived=${c.survived} noCoverage=${c.noCoverage}, hub identical`,
    );
    await assertGateBaseline(fenced.report, BASELINE_PATH, "bcdev wrapped itest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("bcdev wrapped itest: PASS");
  await emitPassed("bcdev-wrapped", { sublegs: ["fenced", "hub"], artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  console.error(formatFailure(err));
  await emitFailed("bcdev-wrapped", err instanceof Error ? err.message : String(err));
  process.exit(err instanceof BaselineRecordedError ? 3 : 1);
});
