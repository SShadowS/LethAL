#!/usr/bin/env bun
/**
 * R58's differential gate, plus the cheap per-test coverage oracle that runs before it.
 *
 * Runs ONE fixture through `runSession` twice — identical in every way except `bcdev.coverageMode`
 * — and writes a dump per mode. `probe-r58-compare.ts` then applies the gate rules.
 *
 * Why a probe rather than a `bun:test`: a unit-test pass proves nothing here. All four frozen gates
 * have GREEN baselines, so the whole fenced-coverage mechanism is a no-op for them — the same
 * blindness that made a previous candidate fix for R55 look verified when it was not. The only
 * thing that can catch a wrong line -> procedure mapping is comparing what the two paths actually
 * attribute, per mutant and per test, on live BC.
 *
 * The dump carries three layers, coarsest last:
 *   - `baselineCoverage`: the per-test procedure/object sets that feed `buildCoverageIndex`. This is
 *     the CHEAP ORACLE — a mapping bug shows up here as a `(test, object, procedure)` triple the
 *     fence produces and the hub does not, instead of being laundered through a verdict.
 *   - `mutants`: per-mutant verdict, covering-test set and `attribution`. A mutant that survives in
 *     both runs while the fenced run's covering set is wrong has a corrupted FINDING with an intact
 *     verdict, which is exactly what `CoverageSplit.attribution` exists to make visible.
 *   - `counts`: the aggregate, which is the weakest signal and reported last on purpose.
 *
 * Usage (both modes, then compare):
 *   bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app \
 *     --tests fixtures/sandbox-tests --mode procedure --out u:/tmp/sandbox-procedure.json
 *   bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app \
 *     --tests fixtures/sandbox-tests --mode fenced --out u:/tmp/sandbox-fenced.json
 *   bun scripts/probe-r58-compare.ts u:/tmp/sandbox-procedure.json u:/tmp/sandbox-fenced.json
 *
 * Connection details come from the fixture's own gitignored `.vscode/launch.local.json` +
 * `lethal.config.local.json`, exactly as `bcdev.itest.ts` reads them — this script deliberately
 * mirrors that wiring rather than inventing its own, so what it measures is what the gate measures.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../packages/runner/src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../packages/runner/src/artifact";
import type {
  CoverageMap,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../packages/runner/src/backend";
import { BcDevMcpBackend } from "../packages/runner/src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../packages/runner/src/cli";
import type { LethalConfigFile } from "../packages/runner/src/cli";
import { DeploymentVerifier } from "../packages/runner/src/deployment-verifier";
import { HarnessVerifier } from "../packages/runner/src/harness";
import { LeaseClient } from "../packages/runner/src/lease";
import { runSession } from "../packages/runner/src/orchestrator";
import {
  ContainerDeployer,
  defaultAlToolPaths,
  defaultDeployerIo,
} from "../packages/runner/src/publisher";
import { RunMutantTransport } from "../packages/runner/src/run-mutant-transport";
import { ResultsStore } from "../packages/runner/src/store";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  readonly projectDir: string;
  readonly testDir: string;
  readonly mode: "procedure" | "fenced" | "none";
  readonly out: string;
  readonly configPath: string;
  readonly selectorIds: { selectorId: number; controlId: number; tableId: number };
  /** Overrides `BASELINE_TIMEOUT_DEFAULT`. R58 unknown #4 needs headroom to MEASURE the payload
   *  rather than abort on it — a client timeout tells you nothing about how big or slow it was. */
  readonly baselineTimeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const abs = (p: string): string => (isAbsolute(p) ? p : join(REPO_ROOT, p));
  const projectDir = get("--project");
  const testDir = get("--tests");
  const mode = get("--mode");
  const out = get("--out");
  if (projectDir === undefined || testDir === undefined || out === undefined) {
    throw new Error(
      "usage: --project <dir> --tests <dir> --mode <procedure|fenced|none> --out <f>",
    );
  }
  if (mode !== "procedure" && mode !== "fenced" && mode !== "none") {
    throw new Error(`--mode must be procedure, fenced or none (got ${String(mode)})`);
  }
  const selectorIdsRaw = get("--selector-ids") ?? "79199,79198,79197";
  const [selectorId, controlId, tableId] = selectorIdsRaw.split(",").map(Number);
  if (selectorId === undefined || controlId === undefined || tableId === undefined) {
    throw new Error("--selector-ids expects three comma-separated ids");
  }
  return {
    projectDir: abs(projectDir),
    testDir: abs(testDir),
    mode,
    out: abs(out),
    configPath: get("--config") ?? join(abs(projectDir), "lethal.config.local.json"),
    selectorIds: { selectorId, controlId, tableId },
    baselineTimeoutMs: Number(get("--baseline-timeout-ms") ?? 120_000),
  };
}

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function testKey(ref: TestMethodRef): string {
  return `${ref.codeunitName}.${ref.method}`;
}

/** `<type>:<id>` for an object-level entry, `<type>:<id>::<procedure>` for a member-level one. */
function entryKeys(coverage: CoverageMap | undefined): string[] {
  return [
    ...new Set(
      (coverage?.entries ?? []).map((e) =>
        e.procedure === undefined
          ? `${e.objectType}:${e.objectId}`
          : `${e.objectType}:${e.objectId}::${e.procedure}`,
      ),
    ),
  ].sort();
}

/**
 * Records every BASELINE run's coverage map, keyed by test.
 *
 * A decorator rather than a change to `BcDevMcpBackend`: the thing under test is what the real
 * backend produces, and a probe that reaches into it to read a private field would drift from the
 * production path the moment the field moved. A baseline run is identified as one whose last
 * `activate()` was `null` — the same invariant the fenced-coverage assertion inside the backend
 * relies on.
 */
class CoverageRecordingBackend implements ExecutionBackend {
  readonly baselineCoverage = new Map<string, string[]>();
  readonly baselineOutcome = new Map<string, string>();
  /** Kept because a baseline that stops after one `error` verdict says nothing about WHY. */
  readonly baselineFailure = new Map<string, string>();
  private active: string | null = null;

  constructor(private readonly inner: BcDevMcpBackend) {}

  capabilities() {
    return this.inner.capabilities();
  }
  status() {
    return this.inner.status();
  }
  deploy(dir: string) {
    return this.inner.deploy(dir);
  }
  compileCheck(dir: string) {
    return this.inner.compileCheck(dir);
  }
  async activate(id: string | null): Promise<void> {
    this.active = id;
    await this.inner.activate(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const v = await this.inner.run(ref, opts);
    if (this.active === null) {
      this.baselineCoverage.set(testKey(ref), entryKeys(v.coverage));
      this.baselineOutcome.set(testKey(ref), v.outcome);
      if (v.failureMessage !== undefined) this.baselineFailure.set(testKey(ref), v.failureMessage);
    }
    return v;
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  setLease(lease: Parameters<BcDevMcpBackend["setLease"]>[0]): void {
    this.inner.setLease(lease);
  }
}

/**
 * Reads the whole body itself and reports headers-time, total time and byte count per call.
 *
 * R58 unknown #4 (payload size and response time) cannot be answered from a verdict: a client that
 * gives up mid-body reports "the operation timed out" and nothing about WHAT timed out. Returning a
 * fresh `Response` over the buffered text leaves the transport's own parsing untouched.
 */
const measuringFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const started = Date.now();
  const res = await fetch(url, init);
  const headersMs = Date.now() - started;
  const body = await res.text();
  const action = String(url).split("/").pop()?.split("?")[0] ?? "?";
  console.log(
    `[r58] ${action} status=${res.status} headers=${headersMs}ms total=${Date.now() - started}ms bytes=${body.length}`,
  );
  return new Response(body, { status: res.status });
}) as typeof fetch;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // OPTIONAL, exactly as `tables.itest.ts` treats it: the sandbox-data fixture has no
  // `launch.local.json` at all, and the two fields it would supply are themselves optional.
  const launchCfg =
    (await readJson<LaunchLocalConfig>(join(args.projectDir, ".vscode", "launch.local.json"))
      .then((l) => l.configurations[0])
      .catch(() => undefined)) ?? {};
  const configFile = await readJson<LethalConfigFile>(args.configPath);
  const bcdev = validateBcDevConfig(configFile.bcdev);

  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) throw new Error("could not locate alc.exe/altool.exe");

  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-r58-"));
  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });

  const odataCfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const inner = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: args.projectDir,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      coverageMode: args.mode,
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
    {
      compiler: new ArtifactCompiler(
        {
          alcPath: toolPaths.alcPath,
          packageCachePath: bcdev.packageCachePath,
          outputDir,
        },
        defaultArtifactIo,
      ),
      deployer: new ContainerDeployer(
        {
          altoolPath: toolPaths.altoolPath,
          server: bcdev.server,
          serverInstance: bcdev.serverInstance,
          username: bcdev.username,
          password: bcdev.password,
          ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
        },
        defaultDeployerIo,
      ),
      verifier: new DeploymentVerifier(odataCfg),
      harnessVerifier,
    },
    (targetAppId, artifactId) =>
      new RunMutantTransport(odataCfg, targetAppId, artifactId, measuringFetch),
  );
  const backend = new CoverageRecordingBackend(inner);

  const store = new ResultsStore(join(scratchRoot, "probe.sqlite"));
  const started = Date.now();
  const report = await runSession({
    backend,
    store,
    projectDir: args.projectDir,
    testDir: args.testDir,
    instrumentedDir: join(scratchRoot, "instrumented"),
    selectorIds: args.selectorIds,
    lease: {
      client: new LeaseClient(odataCfg),
      serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
    },
    resourceServer: bcdev.server,
    resourceServerInstance: bcdev.serverInstance,
    quarantineDir: join(scratchRoot, "quarantine"),
    baselineTimeoutMs: args.baselineTimeoutMs,
  });
  await backend.close();
  store.close();

  const dump = {
    mode: args.mode,
    project: args.projectDir,
    durationMs: Date.now() - started,
    counts: report.counts,
    baselineGreen: report.baselineGreen,
    baselineOutcomes: Object.fromEntries([...backend.baselineOutcome].sort()),
    baselineFailures: Object.fromEntries([...backend.baselineFailure].sort()),
    baselineCoverage: Object.fromEntries([...backend.baselineCoverage].sort()),
    mutants: report.mutants.map((m) => ({
      mutantCode: m.mutantCode,
      file: m.file,
      line: m.line,
      operatorName: m.operatorName,
      verdict: m.verdict,
      attribution: m.coverageAttribution ?? null,
      coveringTests: [...m.coveringTests].sort(),
    })),
  };
  await writeFile(args.out, `${JSON.stringify(dump, null, 1)}\n`, "utf8");
  console.log(
    `r58 probe [${args.mode}]: killed=${report.counts.killed} survived=${report.counts.survived} ` +
      `noCoverage=${report.counts.noCoverage} error=${report.counts.errors} ` +
      `baselineGreen=${report.baselineGreen} -> ${args.out}`,
  );
}

await main();
