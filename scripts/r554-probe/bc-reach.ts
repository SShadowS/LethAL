/**
 * R554 probe: run `fixtures/sandbox-wrapped` on bcdev (Cronus28) in both legs of `itest:bcdev-wrapped`
 * (`fenced`, and `procedure` = the hub), KEEP both reports, and print the report arm's rows with their
 * reach (`guardReached`, `reachedBy`) and covering tests. The measurement is pre-committed in
 * docs/superpowers/specs/2026-10-09-r554-request-page-reach-precommitment.md.
 *
 * Same setup as `runLeg` in packages/runner/itest/bcdev-wrapped.itest.ts, and the same gitignored
 * connection files (fixtures/sandbox-app). It asserts nothing and writes no baseline.
 *
 * Usage: bun scripts/r554-probe/bc-reach.ts <out dir>   (hold the Cronus28 lease while it runs)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../../packages/runner/src/artifact";
import { BcDevMcpBackend } from "../../packages/runner/src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../../packages/runner/src/cli";
import type { LethalConfigFile } from "../../packages/runner/src/cli";
import { DeploymentVerifier } from "../../packages/runner/src/deployment-verifier";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { LeaseClient } from "../../packages/runner/src/lease";
import { runSession } from "../../packages/runner/src/orchestrator";
import {
  ContainerDeployer,
  defaultAlToolPaths,
  defaultDeployerIo,
} from "../../packages/runner/src/publisher";
import type { SessionReport } from "../../packages/runner/src/report";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import { ResultsStore } from "../../packages/runner/src/store";
import { itestConfigName, itestConfigPath } from "../../packages/runner/itest/config-path";
import {
  WRAPPED_PROJECT_DIR,
  WRAPPED_SELECTOR_IDS,
  WRAPPED_SYMBOLS,
  WRAPPED_TEST_DIR,
} from "../../packages/runner/itest/wrapped-fixture";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: bun scripts/r554-probe/bc-reach.ts <out dir>");

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTION_DIR = join(HERE, "..", "..", "fixtures", "sandbox-app");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function runLeg(
  scratchRoot: string,
  coverageMode: "fenced" | "procedure",
): Promise<SessionReport> {
  const launch = await readJson<{
    configurations: Array<{
      environmentType?: "OnPrem" | "Sandbox" | "Production";
      environmentName?: string;
    }>;
  }>(join(CONNECTION_DIR, ".vscode", "launch.local.json"));
  const launchCfg = launch.configurations[0];
  if (launchCfg === undefined) throw new Error("launch.local.json has no configurations[0]");
  const configPath = itestConfigPath(CONNECTION_DIR);
  const bcdev = validateBcDevConfig((await readJson<LethalConfigFile>(configPath)).bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) throw new Error(`could not locate alc/altool (config ${itestConfigName()})`);
  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
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
  const store = new ResultsStore(join(scratchRoot, "lethal.sqlite"));
  try {
    return await runSession({
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
      quarantineDir: join(scratchRoot, "quarantine"),
    });
  } finally {
    store.close();
    await backend.close();
  }
}

for (const [leg, mode] of [
  ["fenced", "fenced"],
  ["hub", "procedure"],
] as const) {
  const root = join(out, leg);
  await mkdir(root, { recursive: true });
  const report = await runLeg(root, mode);
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(`== ${leg}: counts ${JSON.stringify(report.counts)}`);
  for (const m of report.mutants) {
    if (!/WrappedYBand/.test(m.file)) continue;
    console.log(
      [
        m.file.replace(/.*\//, ""),
        `L${m.line}`,
        m.triggerName ?? m.procedureName ?? "",
        m.operatorName,
        m.verdict,
        `grain=${m.reachGrain ?? "-"}`,
        `reached=${m.guardReached ?? "-"}`,
        `reachedBy=${JSON.stringify(m.reachedBy ?? null)}`,
        `covering=${JSON.stringify(m.coveringTests ?? null)}`,
      ].join("\t"),
    );
  }
}
