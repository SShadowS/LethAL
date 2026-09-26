#!/usr/bin/env bun
/**
 * C02-04b live probe (plan ruling 3, option b). Runs the bcdev fixture once, exactly as
 * `itest:bcdev` builds its backend, requires that run to match `bcdev.baseline.json` per mutant,
 * then calls `runNamedMutants` against the artifact that run left installed, for three survivors
 * and three kills with their own covering tests, and requires each verdict to equal the baseline's
 * for that mutant's identity key. No quarantine allowed.
 *
 *   LETHAL_PROBE_SCRATCH=<dir> bun run scripts/c0204b-live-probe.ts
 *
 * Uses a scratch store and scratch quarantine dir, never fixtures/sandbox-app/lethal.sqlite.
 * Take the cross-project container lease yourself before running it; this script only takes
 * the BC-side LeaseClient lease, through runSession and runNamedMutants.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMatchesBaseline } from "../packages/runner/itest/baseline-guard";
import type { NormalizedMutant } from "../packages/runner/itest/mutant-equality";
import { ArtifactCompiler, defaultArtifactIo } from "../packages/runner/src/artifact";
import type { TestMethodRef } from "../packages/runner/src/backend";
import { BcDevMcpBackend } from "../packages/runner/src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../packages/runner/src/cli";
import type { LethalConfigFile } from "../packages/runner/src/cli";
import { DeploymentVerifier } from "../packages/runner/src/deployment-verifier";
import { HarnessVerifier } from "../packages/runner/src/harness";
import { LeaseClient } from "../packages/runner/src/lease";
import { runNamedMutants, runSession } from "../packages/runner/src/orchestrator";
import {
  ContainerDeployer,
  defaultAlToolPaths,
  defaultDeployerIo,
} from "../packages/runner/src/publisher";
import type { MutantOutcome } from "../packages/runner/src/report";
import { RunMutantTransport } from "../packages/runner/src/run-mutant-transport";
import { ResultsStore } from "../packages/runner/src/store";

const REPO_ROOT = join(import.meta.dir, "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");
const BASELINE_PATH = join(REPO_ROOT, "packages", "runner", "itest", "bcdev.baseline.json");
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };
const PICK = 3;

/** The same key `mutant-equality.ts`'s private `keyOf` builds. */
function keyOf(m: MutantOutcome): string {
  const scope = m.procedureName || m.triggerName || "";
  const tuple = `${m.astHash}|${m.codeunitName}|${scope}|${m.operatorName}|${m.operatorMajor}`;
  const ordinal = m.identityOrdinal ?? 0;
  return ordinal > 0 ? `${tuple}|${ordinal}` : tuple;
}

async function main(): Promise<void> {
  const scratch =
    process.env.LETHAL_PROBE_SCRATCH ?? (await mkdtemp(join(tmpdir(), "c0204b-probe-")));
  await mkdir(scratch, { recursive: true });
  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };
  say(`scratch: ${scratch}`);

  const launch = JSON.parse(
    await readFile(join(PROJECT_DIR, ".vscode", "launch.local.json"), "utf8"),
  ) as {
    configurations: Array<{
      environmentType?: "OnPrem" | "Sandbox" | "Production";
      environmentName?: string;
    }>;
  };
  const launchCfg = launch.configurations[0];
  if (launchCfg === undefined) throw new Error("launch.local.json has no configurations[0]");
  const configFile = JSON.parse(
    await readFile(join(PROJECT_DIR, "lethal.config.local.json"), "utf8"),
  ) as LethalConfigFile;
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) throw new Error("could not locate alc.exe/altool.exe");

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
  const lease = {
    client: new LeaseClient(odataCfg),
    serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
  };
  const shared = {
    lease,
    resourceServer: bcdev.server,
    resourceServerInstance: bcdev.serverInstance,
    quarantineDir: join(scratch, "quarantine"),
  };
  const instrumentedDir = join(scratch, "instrumented");
  const store = new ResultsStore(join(scratch, "probe.sqlite"));
  let failed = false;
  try {
    // 1. The gate-equivalent run. A per-mutant mismatch here is a gate failure: stop.
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir,
      selectorIds: SELECTOR_IDS,
      ...shared,
    });
    if (report.quarantined !== undefined) {
      throw new Error(`first run quarantined: ${JSON.stringify(report.quarantined)}`);
    }
    await assertMatchesBaseline(report, BASELINE_PATH, "c0204b first run");
    const counts = (v: string) => report.mutants.filter((m) => m.verdict === v).length;
    say(
      `first run: ${report.mutants.length} mutants, killed ${counts("killed")} / survived ${counts("survived")} / no-coverage ${counts("no-coverage")} / error ${counts("error")}; per-mutant equal to bcdev.baseline.json`,
    );
    const fromRunId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const batches = store.db
      .query(
        "SELECT batch_index, artifact_id, artifact_sha256 FROM batch_artifacts WHERE run_id = ? ORDER BY batch_index",
      )
      .all(fromRunId) as Array<{
      batch_index: number;
      artifact_id: string;
      artifact_sha256: string;
    }>;
    const last = batches.at(-1);
    if (last === undefined) throw new Error(`run ${fromRunId} recorded no batch artifacts`);
    const batchIndex = last.batch_index;
    const appPath = join(outputDir, `${last.artifact_sha256.slice(0, 16)}-${last.artifact_id}.app`);
    const installed = {
      fromRunId,
      batchIndex,
      appPath,
      instrumentedDir: join(instrumentedDir, `run-${fromRunId}-batch-${batchIndex}`),
    };
    say(
      `run ${fromRunId}: ${batches.length} batch(es); installed batch ${batchIndex}, artifact ${last.artifact_id}`,
    );

    // 2. Pick three survivors and three kills from the installed batch, with their covering tests.
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as NormalizedMutant[];
    const baselineByKey = new Map<string, NormalizedMutant[]>();
    for (const b of baseline) baselineByKey.set(b.key, [...(baselineByKey.get(b.key) ?? []), b]);
    const refByName = new Map<string, TestMethodRef>();
    const baseRows = store.db
      .query(
        "SELECT DISTINCT codeunit_id, method FROM test_results WHERE run_id = ? AND mutant_row_id IS NULL",
      )
      .all(fromRunId) as Array<{ codeunit_id: number; method: string }>;
    const refFor = (qualified: string): TestMethodRef => {
      const cached = refByName.get(qualified);
      if (cached !== undefined) return cached;
      const dot = qualified.lastIndexOf(".");
      const codeunitName = qualified.slice(0, dot);
      const method = qualified.slice(dot + 1);
      const hits = baseRows.filter((r) => r.method === method);
      const [hit] = hits;
      if (hit === undefined || hits.length !== 1) {
        throw new Error(`cannot map ${qualified} to exactly one baseline test (${hits.length})`);
      }
      const ref = { codeunitId: hit.codeunit_id, codeunitName, method };
      refByName.set(qualified, ref);
      return ref;
    };
    const pick = (verdict: string) =>
      report.mutants
        .filter((m) => m.batchIndex === batchIndex && m.verdict === verdict)
        .filter((m) => (baselineByKey.get(keyOf(m)) ?? []).length === 1)
        .slice(0, PICK);
    const chosen = [...pick("survived"), ...pick("killed")];
    if (chosen.length !== 2 * PICK) {
      throw new Error(`wanted ${PICK} survivors and ${PICK} kills, found ${chosen.length}`);
    }
    const requests = chosen.map((m) => {
      if (m.coveringTests.length === 0) throw new Error(`${m.mutantCode} has no covering tests`);
      return { mutantId: m.mutantCode, methods: m.coveringTests.map(refFor) };
    });

    // 3. A NEW unfinished run row, then the named call against the installed artifact.
    const runId = store.createRun({
      projectPath: PROJECT_DIR,
      backend: "c0204b-live-probe",
      appVersion: "0.0.0.0",
    });
    const res = await runNamedMutants({
      backend,
      store,
      runId,
      installed,
      requests,
      ...shared,
    });
    say(
      `named run ${runId}: quarantined=${res.quarantined === undefined ? "none" : res.quarantined}`,
    );
    if (res.quarantined !== undefined) failed = true;
    if (res.outcomes.length !== chosen.length) {
      throw new Error(`got ${res.outcomes.length} outcomes for ${chosen.length} requests`);
    }
    say("| mutant | identity key | covering methods | baseline | probe | match |");
    say("|---|---|---|---|---|---|");
    chosen.forEach((m, i) => {
      const o = res.outcomes[i];
      const [b] = baselineByKey.get(keyOf(m)) ?? [];
      if (o === undefined || b === undefined)
        throw new Error(`missing outcome or baseline for ${m.mutantCode}`);
      if (o.mutant.mutantId !== m.mutantCode) {
        throw new Error(`outcome ${i} is ${o.mutant.mutantId}, expected ${m.mutantCode}`);
      }
      const ok = o.verdict === b.verdict;
      if (!ok) failed = true;
      const methods = requests[i]?.methods.map((r) => `${r.codeunitId}::${r.method}`).join(", ");
      const probe = `${o.verdict}${o.killingTest !== undefined ? ` (${o.killingTest})` : ""}${o.failureNote !== undefined ? ` note: ${o.failureNote}` : ""}`;
      const base = `${b.verdict}${b.killingTest !== null ? ` (${b.killingTest})` : ""}`;
      say(
        `| ${m.mutantCode} | ${keyOf(m)} | ${methods} | ${base} | ${probe} | ${ok ? "yes" : "NO"} |`,
      );
    });
  } catch (err) {
    failed = true;
    say(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  } finally {
    store.close();
    await backend.close();
  }
  say(failed ? "RESULT: FAIL" : "RESULT: PASS");
  await writeFile(join(scratch, "probe-output.md"), `${log.join("\n")}\n`, "utf8");
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
