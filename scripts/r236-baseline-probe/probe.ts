/**
 * R236 probe: runs narrowed sandbox-data sessions (compile, publish, the 22-test baseline, no
 * mutant) and records, per BC call, the HTTP timeline from `traceFetch`. When a RunMutant call
 * breaks it reads the control app's op marker at once (fast path); after the session it reads the
 * marker again and asks the BC server itself whether the BC session that ran the call has ended
 * (slow path). Only both together count as "the whole action ended"; anything less stops the probe
 * (exit 3) so the operator can run the recovery procedure.
 *
 * LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm <label> --sessions <n>
 *   --out <file.ndjson> [--segment <n>] [--control-app <path.app>] [--no-trace]
 *
 * Exit codes: 0 all sessions ran; 2 harness fault; 3 stopped because a broken call's action could
 * not be confirmed ended; 4 stopped on a thrown session.
 *
 * Paths are absolute so the same file runs from a worktree of an older client (R236 Task 4 step 5).
 * The runner imports are kept to APIs that exist unchanged at 7b7fff3.
 */
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ActivationConfig, FetchFn } from "../../packages/runner/src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../../packages/runner/src/artifact";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { type BcDevConfig, BcDevMcpBackend } from "../../packages/runner/src/bcdev-backend";
import type { LethalConfigFile } from "../../packages/runner/src/cli";
import { odataBaseUrl, validateBcDevConfig } from "../../packages/runner/src/cli";
import { DeploymentVerifier } from "../../packages/runner/src/deployment-verifier";
import type { RunEvent } from "../../packages/runner/src/events";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import type { OperationStatus } from "../../packages/runner/src/lease";
import { LeaseClient } from "../../packages/runner/src/lease";
import { runSession } from "../../packages/runner/src/orchestrator";
import {
  ContainerDeployer,
  defaultAlToolPaths,
  defaultDeployerIo,
} from "../../packages/runner/src/publisher";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import { ResultsStore } from "../../packages/runner/src/store";
import { type CallTrace, type TraceHooks, traceFetch } from "./fetch-trace";

const PROJECT_DIR = "U:/Git/LethAL/fixtures/sandbox-data";
const TEST_DIR = "U:/Git/LethAL/fixtures/sandbox-data-tests";
const CONFIG_PATH = `${PROJECT_DIR}/lethal.config.local.json`;
const LAUNCH_LOCAL_PATH = `${PROJECT_DIR}/.vscode/launch.local.json`;
const SELECTOR_IDS = { selectorId: 79399, controlId: 79398, tableId: 79397 };
/** The fixture's one `return-value` mutant, covered only by the TestPage test: no mutant runs. */
const ONLY = ["src/DataValueSource.Codeunit.al"];
const CONTAINER = "Cronus28";
const HIT = "baseline test in-flight-unknown running PageActionComputesNonZero";
const OTHER_BASELINE_IN_FLIGHT =
  /baseline test in-flight-unknown running (?!PageActionComputesNonZero)/;
/** A marker read must never hang the probe on a stuck server. */
const MARKER_READ_TIMEOUT_MS = 15_000;

export interface MarkerRead {
  readonly atMs: number;
  readonly status?: OperationStatus;
  readonly error?: string;
}

export interface BrokenCall {
  readonly attemptId: string;
  readonly opSeq: number;
  readonly reads: readonly MarkerRead[];
  readonly sessionId: number | null;
  readonly nstSessions: number[] | null;
  readonly actionEnded: boolean;
  readonly nstEvidence: string;
}

interface PostFence {
  readonly method: string;
  readonly coverageRunMs?: number;
  readonly coverageSerializeMs?: number;
  readonly coverageScannedRows?: number;
  readonly coverageEmittedRows?: number;
  readonly parseError?: string;
}

interface SessionRecord {
  readonly arm: string;
  readonly index: number;
  readonly segment: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly traced: boolean;
  readonly afterHit: boolean;
  readonly controlVersion: string;
  readonly clientCommit: string;
  readonly appVersion: string | null;
  readonly quarantined: string | null;
  readonly hit: boolean;
  readonly otherBaselineInFlight: boolean;
  readonly baseline: ReadonlyArray<{
    method: string;
    outcome: string;
    durationMs: number;
    failureHead: string | null;
  }>;
  readonly calls: readonly CallTrace[];
  readonly postFence: readonly PostFence[];
  readonly broken: readonly BrokenCall[];
  readonly warnings: ReadonlyArray<{ code: string; message: string }>;
  readonly stopReason: string | null;
  /** Not in the plan's shape: where the session's instrumented tree and scratch store live. */
  readonly scratchDir: string;
}

/**
 * Task 2 requirement 7c. True only when the marker says THIS op completed, the control app's own
 * progress row names exactly one BC session for it, the server's session list was read, and that
 * session is not in it. A `completed: true` for a DIFFERENT op than ours does not count: only
 * `lastCompletedOpSeq` speaks for an op the marker no longer names.
 */
export function decideActionEnded(
  attemptId: string,
  opSeq: number,
  reads: readonly MarkerRead[],
  sqlSessionIds: readonly number[] | null,
  nstSessions: readonly number[] | null,
): boolean {
  const markerDone = reads.some(
    ({ status: s }) =>
      s !== undefined &&
      ((s.completed && s.opAttemptId === attemptId && s.opSeq === opSeq) ||
        opSeq <= s.lastCompletedOpSeq),
  );
  if (!markerDone || sqlSessionIds === null || nstSessions === null) return false;
  const [sessionId] = sqlSessionIds;
  if (sqlSessionIds.length !== 1 || sessionId === undefined || sessionId <= 0) return false;
  return !nstSessions.includes(sessionId);
}

/** Parses the `R236-SQL:` and `R236-NST:` lines of the container script. `null` = not read. */
export function parseContainerEvidence(stdout: string): {
  sqlSessionIds: number[] | null;
  nstSessions: number[] | null;
} {
  const line = (prefix: string) =>
    stdout
      .split(/\r?\n/)
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length);
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null ? [] : [v]);
  let sqlSessionIds: number[] | null = null;
  let nstSessions: number[] | null = null;
  try {
    const sql = line("R236-SQL:");
    if (sql !== undefined) {
      const ids = asArray((JSON.parse(sql) as { ids?: unknown }).ids);
      if (ids.every((n) => typeof n === "number")) sqlSessionIds = ids as number[];
    }
  } catch {
    sqlSessionIds = null;
  }
  try {
    const nst = line("R236-NST:");
    if (nst !== undefined) {
      const ids = asArray(nst.trim() === "" ? null : JSON.parse(nst)).map(
        (s) => (s as { SessionID?: unknown }).SessionID,
      );
      if (ids.every((n) => typeof n === "number")) nstSessions = ids as number[];
    }
  } catch {
    nstSessions = null;
  }
  return { sqlSessionIds, nstSessions };
}

function containerScript(attemptId: string, opSeq: number, sinceIso: string): string {
  if (!/^[0-9A-Za-z-]{1,64}$/.test(attemptId) || !Number.isSafeInteger(opSeq)) {
    throw new Error(
      `refusing to build a SQL read for attemptId ${JSON.stringify(attemptId)} / opSeq ${opSeq}`,
    );
  }
  return `
Import-Module BcContainerHelper -DisableNameChecking
Invoke-ScriptInBcContainer -containerName ${CONTAINER} -argumentList @('${attemptId}', ${opSeq}, '${sinceIso}') -scriptblock { param($attemptId, $opSeq, $since)
  try {
    $cfg = Get-NAVServerConfiguration -ServerInstance BC -AsXml
    $get = { param($k) ($cfg.configuration.appSettings.add | Where-Object { $_.key -eq $k }).value }
    $srv = & $get 'DatabaseServer'; $inst = & $get 'DatabaseInstance'; $db = & $get 'DatabaseName'
    if ($inst) { $srv = "$srv\\$inst" }
    $sq = @{ ServerInstance = $srv; Database = $db }
    if ((Get-Command Invoke-Sqlcmd).Parameters.ContainsKey('TrustServerCertificate')) { $sq.TrustServerCertificate = $true }
    $tables = @(Invoke-Sqlcmd @sq -Query "SELECT name FROM sys.tables WHERE name LIKE '%LC Op Progress%'" | ForEach-Object { $_.name })
    if ($tables.Count -ne 1) { throw "expected one LC Op Progress table, found $($tables.Count): $($tables -join ', ')" }
    $ids = @(Invoke-Sqlcmd @sq -Query "SELECT [Session Id] AS sid FROM [dbo].[$($tables[0])] WHERE [Attempt Id] = N'$attemptId' AND [Op Seq] = $opSeq" | ForEach-Object { [int]$_.sid })
    'R236-SQL:' + (ConvertTo-Json -Compress -InputObject @{ table = $tables[0]; ids = $ids })
  } catch { 'R236-SQL-ERR:' + $_.Exception.Message }
  try {
    'R236-NST:' + (ConvertTo-Json -Compress -InputObject @(Get-NAVServerSession -ServerInstance BC | Select-Object SessionID,ClientType,UserID,LoginDatetime))
  } catch { 'R236-NST-ERR:' + $_.Exception.Message }
  '----'
  Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]$since} -ErrorAction SilentlyContinue |
    Where-Object ProviderName -like 'MicrosoftDynamicsNav*' |
    Select-Object TimeCreated,Id,LevelDisplayName,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(2000,$_.Message.Length))}} |
    Format-List | Out-String -Width 300
}`;
}

async function containerEvidence(attemptId: string, opSeq: number, sinceIso: string) {
  const proc = Bun.spawn(
    ["pwsh", "-NoProfile", "-Command", containerScript(attemptId, opSeq, sinceIso)],
    { env: { ...process.env, DOCKER_CONTEXT: "desktop-windows" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ...parseContainerEvidence(stdout),
    nstEvidence: `exit ${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
  };
}

function timedFetch(ms: number): FetchFn {
  const f = (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) =>
    bcFetch(input, { ...init, signal: AbortSignal.timeout(ms) });
  return Object.assign(f, { preconnect: bcFetch.preconnect });
}

interface Pending {
  readonly trace: CallTrace;
  readonly attemptId: string;
  readonly opSeq: number;
  readonly readMarker: () => Promise<MarkerRead>;
  readonly reads: MarkerRead[];
}

/** Hooks for one session: the fast broken-call read and the post-fence cost capture. */
function sessionHooks(
  odataCfg: ActivationConfig,
  pending: Pending[],
  postFence: PostFence[],
): TraceHooks {
  return {
    onBrokenCall: async (trace, body) => {
      if (!trace.action.startsWith("LethALControl_RunMutant")) return;
      const { attemptId, opSeq, leaseEpoch, leaseToken, serverGeneration } = body;
      if (typeof attemptId !== "string" || typeof opSeq !== "number") return;
      const brokeAt = trace.errorAt ?? Date.now();
      const status = new RunMutantTransport(
        odataCfg,
        String(body.targetAppId),
        String(body.artifactId),
        timedFetch(MARKER_READ_TIMEOUT_MS),
      );
      const lease = {
        epoch: Number(leaseEpoch),
        token: String(leaseToken),
        serverGeneration: String(serverGeneration),
        opSeq,
      };
      const readMarker = async (): Promise<MarkerRead> => {
        const at = Date.now();
        try {
          return {
            atMs: at - brokeAt,
            status: await status.getOperationStatus(lease, attemptId, opSeq),
          };
        } catch (err) {
          return { atMs: at - brokeAt, error: String(err) };
        }
      };
      const p: Pending = { trace, attemptId, opSeq, readMarker, reads: [] };
      pending.push(p);
      p.reads.push(await readMarker());
    },
    onBody: (trace, text) => {
      if (trace.action !== "LethALControl_RunMutantWithCoverage") return;
      const method = trace.testMethod ?? "?";
      try {
        const inner = JSON.parse(String((JSON.parse(text) as { value?: unknown }).value)) as Record<
          string,
          unknown
        >;
        const num = (k: string) =>
          typeof inner[k] === "number" ? { [k]: inner[k] as number } : {};
        postFence.push({
          method,
          ...num("coverageRunMs"),
          ...num("coverageSerializeMs"),
          ...num("coverageScannedRows"),
          ...num("coverageEmittedRows"),
        });
      } catch (err) {
        postFence.push({ method, parseError: String(err) });
      }
    },
  };
}

async function readOptionalLaunchConfig(): Promise<{
  environmentType?: BcDevConfig["environmentType"];
  environmentName?: string;
}> {
  let text: string;
  try {
    text = await readFile(LAUNCH_LOCAL_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(text) as {
    configurations: Array<{
      environmentType?: BcDevConfig["environmentType"];
      environmentName?: string;
    }>;
  };
  return parsed.configurations[0] ?? {};
}

class HarnessFault extends Error {}

async function main(): Promise<void> {
  if (process.env.LETHAL_R236_PROBE !== "1") {
    console.log("skipped");
    process.exit(0);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      arm: { type: "string" },
      sessions: { type: "string" },
      out: { type: "string" },
      segment: { type: "string", default: "1" },
      "control-app": { type: "string" },
      "no-trace": { type: "boolean", default: false },
    },
  });
  const arm = values.arm;
  const sessions = Number(values.sessions);
  const segment = Number(values.segment);
  if (arm === undefined || values.out === undefined)
    throw new HarnessFault("--arm and --out are required");
  if (!Number.isInteger(sessions) || sessions < 1)
    throw new HarnessFault(`--sessions must be a positive integer, got ${values.sessions}`);
  if (!Number.isInteger(segment) || segment < 1)
    throw new HarnessFault(`--segment must be a positive integer, got ${values.segment}`);
  const out = resolve(values.out);
  if (!existsSync(dirname(out)))
    throw new HarnessFault(`--out directory does not exist: ${dirname(out)}`);
  const controlApp = values["control-app"];
  if (controlApp !== undefined && !existsSync(controlApp))
    throw new HarnessFault(`--control-app not found: ${controlApp}`);
  const traced = !values["no-trace"];

  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir });
  const clientCommit = git.stdout.toString().trim();
  if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(clientCommit))
    throw new HarnessFault(`git rev-parse HEAD failed in ${import.meta.dir}`);

  const launchCfg = await readOptionalLaunchConfig();
  const configFile = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as LethalConfigFile;
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths)
    throw new HarnessFault(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension",
    );
  const odataCfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);

  let afterHit = false;
  for (let index = 1; index <= sessions; index++) {
    const controlVersion = await harnessVerifier.fetchControlVersion();
    const scratchDir = await mkdtemp(join(tmpdir(), `r236-${arm}-`));
    const outputDir = join(scratchDir, "publish");
    await mkdir(outputDir, { recursive: true });
    const calls: CallTrace[] = [];
    const pending: Pending[] = [];
    const postFence: PostFence[] = [];
    const events: RunEvent[] = [];
    const fetchFn = traced
      ? traceFetch(bcFetch, calls, sessionHooks(odataCfg, pending, postFence))
      : bcFetch;
    const backend = new BcDevMcpBackend(
      {
        mcpCommand: bcdev.mcpCommand,
        project: PROJECT_DIR,
        server: bcdev.server,
        serverInstance: bcdev.serverInstance,
        company: bcdev.company,
        packageCachePath: bcdev.packageCachePath,
        controlSymbolPath: controlApp ?? bcdev.controlSymbolPath,
        ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
        ...(launchCfg.environmentType !== undefined
          ? { environmentType: launchCfg.environmentType }
          : {}),
        ...(launchCfg.environmentName !== undefined
          ? { environmentName: launchCfg.environmentName }
          : {}),
        ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
        ...(bcdev.coverageMode !== undefined ? { coverageMode: bcdev.coverageMode } : {}),
      },
      undefined,
      {
        compiler: new ArtifactCompiler(
          { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
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
        new RunMutantTransport(odataCfg, targetAppId, artifactId, fetchFn),
    );
    const store = new ResultsStore(join(scratchDir, "lethal.sqlite"));
    const startedAt = new Date().toISOString();
    let quarantined: string | null = null;
    let thrown: string | null = null;
    let appVersion: string | null = null;
    let baseline: SessionRecord["baseline"] = [];
    try {
      const report = await runSession({
        backend,
        store,
        projectDir: PROJECT_DIR,
        testDir: TEST_DIR,
        instrumentedDir: join(scratchDir, "instrumented"),
        selectorIds: SELECTOR_IDS,
        only: ONLY,
        emit: [(e) => events.push(e)],
        lease: {
          client: new LeaseClient(odataCfg),
          serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
        },
        resourceServer: bcdev.server,
        resourceServerInstance: bcdev.serverInstance,
        quarantineDir: join(scratchDir, "quarantine"),
      });
      quarantined = report.quarantined?.reason ?? null;
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    } finally {
      try {
        const run = store.db
          .query("SELECT id, app_version FROM runs ORDER BY id DESC LIMIT 1")
          .get() as {
          id: number;
          app_version: string;
        } | null;
        if (run !== null) {
          appVersion = run.app_version;
          baseline = (
            store.db
              .query(
                "SELECT method, outcome, duration_ms, failure_message FROM test_results " +
                  "WHERE run_id = ? AND mutant_row_id IS NULL ORDER BY id",
              )
              .all(run.id) as Array<{
              method: string;
              outcome: string;
              duration_ms: number;
              failure_message: string | null;
            }>
          ).map((r) => ({
            method: r.method,
            outcome: r.outcome,
            durationMs: r.duration_ms,
            failureHead: r.failure_message === null ? null : r.failure_message.slice(0, 300),
          }));
        }
      } finally {
        store.close();
        await backend.close();
      }
    }

    // Slow path: second marker read, then the server's own record of the call's BC session.
    const broken: BrokenCall[] = [];
    for (const p of pending) {
      p.reads.push(await p.readMarker());
      const since = new Date(p.trace.dispatchedAt - 5_000).toISOString();
      const ev = await containerEvidence(p.attemptId, p.opSeq, since);
      const [only] = ev.sqlSessionIds ?? [];
      broken.push({
        attemptId: p.attemptId,
        opSeq: p.opSeq,
        reads: p.reads,
        sessionId: ev.sqlSessionIds?.length === 1 && only !== undefined ? only : null,
        nstSessions: ev.nstSessions,
        actionEnded: decideActionEnded(
          p.attemptId,
          p.opSeq,
          p.reads,
          ev.sqlSessionIds,
          ev.nstSessions,
        ),
        nstEvidence: ev.nstEvidence,
      });
    }

    let stopReason: string | null = null;
    let exitCode = 0;
    if (thrown !== null) {
      quarantined = `THREW: ${thrown}`;
      stopReason = "session threw; a thrown session is never an observation";
      exitCode = 4;
    } else if (broken.some((b) => !b.actionEnded)) {
      stopReason = "a broken RunMutant call's whole action could not be confirmed ended";
      exitCode = 3;
    } else if (quarantined !== null && broken.length === 0) {
      // Untraced, or a quarantine with no broken call on record: nothing proves the server is idle.
      stopReason = "quarantined with no broken RunMutant call on record to prove the action ended";
      exitCode = 3;
    }

    const record: SessionRecord = {
      arm,
      index,
      segment,
      startedAt,
      endedAt: new Date().toISOString(),
      traced,
      afterHit,
      controlVersion,
      clientCommit,
      appVersion,
      quarantined,
      hit: quarantined?.includes(HIT) ?? false,
      otherBaselineInFlight: quarantined !== null && OTHER_BASELINE_IN_FLIGHT.test(quarantined),
      baseline,
      calls,
      postFence,
      broken,
      warnings: events.flatMap((e) =>
        e.type === "warning" ? [{ code: e.code, message: e.message }] : [],
      ),
      stopReason,
      scratchDir,
    };
    appendFileSync(out, `${JSON.stringify(record)}\n`);
    console.log(
      `${arm} #${index}: ${record.hit ? "HIT" : "no hit"}, ${broken.length} broken call(s)${stopReason !== null ? `, STOP: ${stopReason}` : ""}`,
    );
    if (exitCode !== 0) process.exit(exitCode);
    afterHit = broken.length > 0;
  }
  process.exit(0);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(
      `harness fault: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(2);
  }
}
