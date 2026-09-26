/**
 * R236 probe: runs narrowed sandbox-data sessions (compile, publish, the 22-test baseline, no
 * mutant) and records, per BC call, the HTTP timeline from `traceFetch`. When a RunMutant call
 * breaks it reads the control app's op marker at once (fast path); after the session it reads the
 * marker again and asks the BC server itself whether the BC session that ran the call has ended
 * (slow path). Only both together count as "the whole action ended" (`actionEnd: "proven"`).
 * Ruling q-160433: anything less is `actionEnd: "unproven"`, a COUNTED hit with no retry, and the arm
 * continues; the next session starts only if doctor is clean and the harness check passes (no
 * force-reset), and its record carries `afterUnprovenHit`.
 *
 * LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm <label> --sessions <n>
 *   --out <file.ndjson> [--segment <n>] [--control-app <path.app>] [--no-trace]
 *
 * Exit codes: 0 all sessions ran; 2 harness fault; 3 run the recovery procedure (the gate after an
 * unproven hit failed, or a record could not be written to --out); 4 a session threw (for example
 * the lease acquire refused), also recovery.
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
export const CONFIG_PATH = `${PROJECT_DIR}/lethal.config.local.json`;
const LAUNCH_LOCAL_PATH = `${PROJECT_DIR}/.vscode/launch.local.json`;
const SELECTOR_IDS = { selectorId: 79399, controlId: 79398, tableId: 79397 };
/** The fixture's one `return-value` mutant, covered only by the TestPage test: no mutant runs. */
const ONLY = ["src/DataValueSource.Codeunit.al"];
export const CONTAINER = "Cronus28";
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
  readonly testMethod: string | null;
  readonly reads: readonly MarkerRead[];
  readonly sessionId: number | null;
  readonly nstSessions: number[] | null;
  readonly actionEnded: boolean;
  readonly nstEvidence: string;
  readonly evidenceError?: string;
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
  /** Ruling q-160433: the previous session's action end was unproven (reported apart and in the total). */
  readonly afterUnprovenHit: boolean;
  /** The first session of a resumed segment (`--segment` > 1), i.e. right after a recovery. */
  readonly postRecovery: boolean;
  /** "proven" / "unproven" for a session with a quarantine or a broken call; null otherwise. */
  readonly actionEnd: "proven" | "unproven" | null;
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
  /** Review r1: the session-list positive control, read every session (see `SessionControl`). */
  readonly sessionControl: SessionControl;
  readonly storeReadError: string | null;
  readonly warnings: ReadonlyArray<{ code: string; message: string }>;
  readonly stopReason: string | null;
  /** Not in the plan's shape: where the session's instrumented tree and scratch store live. */
  readonly scratchDir: string;
}

/**
 * Review r1: the positive control for the session check. An id missing from the server's session
 * list means "ended" only if that list is non-empty and is proven to use the SAME id space as the
 * control app's `SessionId()` (wrong tenant or wrong instance would list other ids, or none). Proof
 * is a known session id appearing in the list: the latest FINISHED op of this session (from
 * `LC Op Progress`) or the `sessionId` a successful `ran` answer carried. `activeTableOverlap` is
 * DIAGNOSTIC ONLY (review r2): the `Active Session` read has no tenant or instance filter, so a
 * wrong-tenant list could overlap it. `finishedOpListed: true` also says pooled sessions outlive
 * their op, in which case the session check cannot separate H2-fence from H2-action.
 */
export interface SessionControl {
  readonly finishedOpSessionId: number | null;
  readonly finishedOpListed: boolean | null;
  readonly ranAnswerSessionId: number | null;
  readonly ranAnswerListed: boolean | null;
  readonly activeTableOverlap: number[] | null;
  readonly idSpaceMatched: boolean;
  readonly error?: string;
}

/**
 * Task 2 requirement 7c, tightened by review r1. True only when the marker says THIS op completed,
 * the control app's own progress row names exactly one BC session for it, the server's session list
 * was read, is non-empty and is proven to share the id space (`idSpaceMatched`), and that session is
 * not in it. A `completed: true` for a DIFFERENT op than ours does not count: only
 * `lastCompletedOpSeq` speaks for an op the marker no longer names.
 */
export function decideActionEnded(
  attemptId: string,
  opSeq: number,
  reads: readonly MarkerRead[],
  sqlSessionIds: readonly number[] | null,
  nstSessions: readonly number[] | null,
  idSpaceMatched: boolean,
): boolean {
  const markerDone = reads.some(
    ({ status: s }) =>
      s !== undefined &&
      ((s.completed && s.opAttemptId === attemptId && s.opSeq === opSeq) ||
        opSeq <= s.lastCompletedOpSeq),
  );
  if (!markerDone || sqlSessionIds === null || nstSessions === null) return false;
  if (nstSessions.length === 0 || !idSpaceMatched) return false;
  const [sessionId] = sqlSessionIds;
  if (sqlSessionIds.length !== 1 || sessionId === undefined || sessionId <= 0) return false;
  return !nstSessions.includes(sessionId);
}

export interface ContainerEvidence {
  /** `${attemptId}:${opSeq}` to the progress row's session ids; a missing key was not read. */
  readonly opSessionIds: Map<string, number[]>;
  readonly finishedOps: Array<{ sessionId: number; attemptId: string; opSeq: number }> | null;
  readonly activeSessionIds: number[] | null;
  readonly nstSessions: number[] | null;
}

/** Parses the tagged lines of the container script. `null` (or a missing key) = not read. */
export function parseContainerEvidence(stdout: string): ContainerEvidence {
  const lines = stdout.split(/\r?\n/);
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null ? [] : [v]);
  const tagged = (prefix: string) =>
    lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  const one = <T>(prefix: string, parse: (v: unknown[]) => T | null): T | null => {
    const [raw] = tagged(prefix);
    if (raw === undefined) return null;
    try {
      return parse(asArray(raw.trim() === "" ? null : JSON.parse(raw)));
    } catch {
      return null;
    }
  };
  const numbers = (v: unknown[]) =>
    v.every((n) => typeof n === "number") ? (v as number[]) : null;
  const opSessionIds = new Map<string, number[]>();
  for (const raw of tagged("R236-SQL-OP:")) {
    try {
      const o = JSON.parse(raw) as { attemptId?: unknown; opSeq?: unknown; ids?: unknown };
      const ids = numbers(asArray(o.ids ?? null));
      if (typeof o.attemptId === "string" && typeof o.opSeq === "number" && ids !== null) {
        opSessionIds.set(`${o.attemptId}:${o.opSeq}`, ids);
      }
    } catch {
      // unread
    }
  }
  const finishedOps = one("R236-SQL-FIN:", (v) => {
    const rows = v.map((r) => r as { sid?: unknown; attemptId?: unknown; opSeq?: unknown });
    if (
      !rows.every(
        (r) =>
          typeof r.sid === "number" &&
          typeof r.attemptId === "string" &&
          typeof r.opSeq === "number",
      )
    ) {
      return null;
    }
    return rows.map((r) => ({
      sessionId: r.sid as number,
      attemptId: r.attemptId as string,
      opSeq: r.opSeq as number,
    }));
  });
  return {
    opSessionIds,
    finishedOps,
    activeSessionIds: one("R236-ACTIVE:", numbers),
    nstSessions: one("R236-NST:", (v) =>
      numbers(v.map((s) => (s as { SessionID?: unknown }).SessionID)),
    ),
  };
}

export function sessionControl(
  ev: ContainerEvidence,
  brokenAttemptIds: readonly string[],
  ranAnswerSessionId: number | null,
): SessionControl {
  const nst = ev.nstSessions;
  const listed = (id: number | null) => (id === null || nst === null ? null : nst.includes(id));
  // finishedOps come newest first; a broken op is never its own control (that would be circular).
  const finished = ev.finishedOps?.find((o) => !brokenAttemptIds.includes(o.attemptId));
  const finishedOpSessionId =
    finished !== undefined && finished.sessionId > 0 ? finished.sessionId : null;
  const activeTableOverlap =
    nst === null || ev.activeSessionIds === null
      ? null
      : ev.activeSessionIds.filter((id) => id > 0 && nst.includes(id));
  const finishedOpListed = listed(finishedOpSessionId);
  const ranAnswerListed = listed(ranAnswerSessionId);
  return {
    finishedOpSessionId,
    finishedOpListed,
    ranAnswerSessionId,
    ranAnswerListed,
    activeTableOverlap,
    idSpaceMatched:
      nst !== null && nst.length > 0 && (finishedOpListed === true || ranAnswerListed === true),
  };
}

interface EvidenceOp {
  readonly attemptId: string;
  readonly opSeq: number;
}

function containerScript(
  tenant: string,
  ops: readonly EvidenceOp[],
  sessionSinceSql: string,
  eventsSinceIso: string | null,
): string {
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenant))
    throw new Error(`refusing tenant ${JSON.stringify(tenant)}`);
  for (const { attemptId, opSeq } of ops) {
    if (!/^[0-9A-Za-z-]{1,64}$/.test(attemptId) || !Number.isSafeInteger(opSeq)) {
      throw new Error(
        `refusing to build a SQL read for attemptId ${JSON.stringify(attemptId)} / opSeq ${opSeq}`,
      );
    }
  }
  const opsJson = JSON.stringify(ops.map((o) => ({ a: o.attemptId, s: o.opSeq })));
  return `
Import-Module BcContainerHelper -DisableNameChecking
Invoke-ScriptInBcContainer -containerName ${CONTAINER} -argumentList @('${tenant}', '${opsJson}', '${sessionSinceSql}', '${eventsSinceIso ?? ""}') -scriptblock { param($tenant, $opsJson, $sessionSince, $since)
  try {
    $cfg = Get-NAVServerConfiguration -ServerInstance BC -AsXml
    $get = { param($k) ($cfg.configuration.appSettings.add | Where-Object { $_.key -eq $k }).value }
    $srv = & $get 'DatabaseServer'; $inst = & $get 'DatabaseInstance'; $db = & $get 'DatabaseName'
    if ($inst) { $srv = "$srv\\$inst" }
    $sq = @{ ServerInstance = $srv; Database = $db }
    if ((Get-Command Invoke-Sqlcmd).Parameters.ContainsKey('TrustServerCertificate')) { $sq.TrustServerCertificate = $true }
    $tables = @(Invoke-Sqlcmd @sq -Query "SELECT name FROM sys.tables WHERE name LIKE '%LC Op Progress%'" | ForEach-Object { $_.name })
    if ($tables.Count -ne 1) { throw "expected one LC Op Progress table, found $($tables.Count): $($tables -join ', ')" }
    $t = $tables[0]
    'R236-SQL-TABLE:' + $t
    foreach ($o in @(ConvertFrom-Json $opsJson)) {
      $ids = @(Invoke-Sqlcmd @sq -Query "SELECT [Session Id] AS sid FROM [dbo].[$t] WHERE [Attempt Id] = N'$($o.a)' AND [Op Seq] = $($o.s)" | ForEach-Object { [int]$_.sid })
      'R236-SQL-OP:' + (ConvertTo-Json -Compress -InputObject @{ attemptId = [string]$o.a; opSeq = [long]$o.s; ids = $ids })
    }
    # State 2 = done (OptionMembers running,between,done). Newest first.
    $fin = @(Invoke-Sqlcmd @sq -Query "SELECT [Session Id] AS sid, [Attempt Id] AS aid, [Op Seq] AS seq FROM [dbo].[$t] WHERE [State] = 2 AND [Started At] >= '$sessionSince' ORDER BY [Started At] DESC" | ForEach-Object { @{ sid = [int]$_.sid; attemptId = [string]$_.aid; opSeq = [long]$_.seq } })
    'R236-SQL-FIN:' + (ConvertTo-Json -Compress -InputObject $fin)
  } catch { 'R236-SQL-ERR:' + $_.Exception.Message }
  try {
    $act = @(Invoke-Sqlcmd @sq -Query "SELECT [Session ID] AS sid FROM [dbo].[Active Session]" | ForEach-Object { [int]$_.sid })
    'R236-ACTIVE:' + (ConvertTo-Json -Compress -InputObject $act)
  } catch { 'R236-ACTIVE-ERR:' + $_.Exception.Message }
  try {
    'R236-NST:' + (ConvertTo-Json -Compress -InputObject @(Get-NAVServerSession -ServerInstance BC -Tenant $tenant | Select-Object SessionID,ClientType,UserID,LoginDatetime))
  } catch { 'R236-NST-ERR:' + $_.Exception.Message }
  if ($since) {
    '----'
    Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]$since} -ErrorAction SilentlyContinue |
      Where-Object ProviderName -like 'MicrosoftDynamicsNav*' |
      Select-Object TimeCreated,Id,LevelDisplayName,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(2000,$_.Message.Length))}} |
      Format-List | Out-String -Width 300
  }
}`;
}

export type RunScript = (
  script: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export async function runPwsh(script: string) {
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-Command", script], {
    env: { ...process.env, DOCKER_CONTEXT: "desktop-windows" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

export interface PendingBroken {
  readonly trace: CallTrace;
  readonly attemptId: string;
  readonly opSeq: number;
  readonly readMarker: () => Promise<MarkerRead>;
  readonly reads: MarkerRead[];
}

/**
 * The slow path, once per session: the second marker read of every broken RunMutant call, then ONE
 * container call for the progress rows, the session-list control and the event log. Never throws:
 * any failure is recorded and leaves `actionEnded` false, so the caller still writes the record.
 */
export async function gatherEvidence(
  pending: readonly PendingBroken[],
  input: { tenant: string; sessionStartedAt: string; ranAnswerSessionId: number | null },
  run: RunScript = runPwsh,
): Promise<{ broken: BrokenCall[]; control: SessionControl; evidence: string }> {
  for (const p of pending) {
    try {
      p.reads.push(await p.readMarker());
    } catch (err) {
      p.reads.push({ atMs: -1, error: String(err) });
    }
  }
  let ev: ContainerEvidence = {
    opSessionIds: new Map(),
    finishedOps: null,
    activeSessionIds: null,
    nstSessions: null,
  };
  let evidence = "";
  let evidenceError: string | undefined;
  try {
    const firstDispatch = Math.min(...pending.map((p) => p.trace.dispatchedAt));
    const script = containerScript(
      input.tenant,
      pending,
      new Date(Date.parse(input.sessionStartedAt) - 5_000).toISOString().slice(0, 23),
      pending.length > 0 ? new Date(firstDispatch - 5_000).toISOString() : null,
    );
    const r = await run(script);
    ev = parseContainerEvidence(r.stdout);
    evidence = `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
  } catch (err) {
    evidenceError = String(err);
    evidence = `evidence step failed: ${evidenceError}`;
  }
  const control: SessionControl = {
    ...sessionControl(
      ev,
      pending.map((p) => p.attemptId),
      input.ranAnswerSessionId,
    ),
    ...(evidenceError !== undefined ? { error: evidenceError } : {}),
  };
  const broken = pending.map((p): BrokenCall => {
    const ids = ev.opSessionIds.get(`${p.attemptId}:${p.opSeq}`) ?? null;
    const [only] = ids ?? [];
    return {
      attemptId: p.attemptId,
      opSeq: p.opSeq,
      testMethod: p.trace.testMethod ?? null,
      reads: p.reads,
      sessionId: ids?.length === 1 && only !== undefined ? only : null,
      nstSessions: ev.nstSessions,
      actionEnded: decideActionEnded(
        p.attemptId,
        p.opSeq,
        p.reads,
        ids,
        ev.nstSessions,
        control.idSpaceMatched,
      ),
      nstEvidence: evidence,
      ...(evidenceError !== undefined ? { evidenceError } : {}),
    };
  });
  return { broken, control, evidence };
}

/**
 * Ruling q-160433. A thrown session stops for recovery (4). Otherwise the session is recorded and
 * the arm CONTINUES; the only question is whether its action end is proven. "proven" needs every
 * broken RunMutant call to be proven ended AND, for a quarantine, the quarantined test to be one of
 * those calls. Anything less is "unproven": a counted hit, no retry, and the NEXT session starts
 * only through `preflight`.
 */
export function decideExit(s: {
  thrown: string | null;
  quarantined: string | null;
  broken: ReadonlyArray<{ testMethod: string | null; actionEnded: boolean }>;
}): { exitCode: 0 | 4; actionEnd: "proven" | "unproven" | null; stopReason: string | null } {
  if (s.thrown !== null) {
    return {
      exitCode: 4,
      actionEnd: null,
      stopReason: "session threw; a thrown session is never an observation",
    };
  }
  if (s.quarantined === null && s.broken.length === 0) {
    return { exitCode: 0, actionEnd: null, stopReason: null };
  }
  const test =
    s.quarantined === null ? null : /in-flight-unknown running (\S+)/.exec(s.quarantined)?.[1];
  const proven =
    s.broken.every((b) => b.actionEnded) &&
    (s.quarantined === null || (test !== undefined && s.broken.some((b) => b.testMethod === test)));
  return { exitCode: 0, actionEnd: proven ? "proven" : "unproven", stopReason: null };
}

/**
 * The gate before a session that follows an unproven hit: doctor must exit 0 and the harness check
 * must pass. Nothing here force-resets anything; a failure means "run the recovery procedure".
 * The lease acquire itself happens inside `runSession`, whose failure throws and exits 4.
 */
export async function preflight(deps: {
  doctor: () => Promise<number>;
  harness: () => Promise<unknown>;
}): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const code = await deps.doctor();
    if (code !== 0) return { ok: false, reason: `doctor exited ${code}` };
    await deps.harness();
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/** Always leaves the record somewhere: the file, else stdout. Returns false if the file failed. */
export function writeRecord(out: string, record: unknown): boolean {
  let line = "";
  try {
    line = JSON.stringify(record);
    appendFileSync(out, `${line}\n`);
    return true;
  } catch (err) {
    console.error(`could not append to ${out}: ${String(err)}; the record follows on stdout`);
    console.log(`R236-RECORD:${line === "" ? String(record) : line}`);
    return false;
  }
}
function timedFetch(ms: number): FetchFn {
  const f = (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) =>
    bcFetch(input, { ...init, signal: AbortSignal.timeout(ms) });
  return Object.assign(f, { preconnect: bcFetch.preconnect });
}

/** Hooks for one session: the fast broken-call read and the post-fence cost capture. */
function sessionHooks(
  odataCfg: ActivationConfig,
  pending: PendingBroken[],
  postFence: PostFence[],
  ran: { sessionId: number | null },
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
      const p: PendingBroken = { trace, attemptId, opSeq, readMarker, reads: [] };
      pending.push(p);
      p.reads.push(await readMarker());
    },
    onBody: (trace, text) => {
      if (!trace.action.startsWith("LethALControl_RunMutant")) return;
      const method = trace.testMethod ?? "?";
      try {
        const inner = JSON.parse(String((JSON.parse(text) as { value?: unknown }).value)) as Record<
          string,
          unknown
        >;
        // Review r1: a `ran` answer's own session id (AddSessionKeys) is one positive control.
        if (inner.status === "ran" && typeof inner.sessionId === "number") {
          ran.sessionId = inner.sessionId;
        }
        if (trace.action !== "LethALControl_RunMutantWithCoverage") return;
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
  let afterUnprovenHit = false;
  for (let index = 1; index <= sessions; index++) {
    if (afterUnprovenHit) {
      // Ruling q-160433: after an unproven action end, the next session starts only if doctor is
      // clean and the harness check passes, with no force-reset. Otherwise: recovery (exit 3).
      const gate = await preflight({
        doctor: async () => {
          const repo = resolve(import.meta.dir, "..", "..");
          const proc = Bun.spawn(
            [
              "bun",
              join(repo, "packages/runner/src/cli.ts"),
              "doctor",
              "--config",
              CONFIG_PATH,
              "--project",
              PROJECT_DIR,
            ],
            { cwd: repo, stdout: "inherit", stderr: "inherit" },
          );
          return await proc.exited;
        },
        harness: () => harnessVerifier.verify(),
      });
      if (!gate.ok) {
        console.error(
          `${arm} #${index}: preflight after an unproven hit failed (${gate.reason}); run the recovery procedure, then resume with --segment ${segment + 1}`,
        );
        process.exit(3);
      }
    }
    const controlVersion = await harnessVerifier.fetchControlVersion();
    const scratchDir = await mkdtemp(join(tmpdir(), `r236-${arm}-`));
    const outputDir = join(scratchDir, "publish");
    await mkdir(outputDir, { recursive: true });
    const calls: CallTrace[] = [];
    const pending: PendingBroken[] = [];
    const postFence: PostFence[] = [];
    const ran: { sessionId: number | null } = { sessionId: null };
    const events: RunEvent[] = [];
    const fetchFn = traced
      ? traceFetch(bcFetch, calls, sessionHooks(odataCfg, pending, postFence, ran))
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
    let storeReadError: string | null = null;
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
      } catch (err) {
        storeReadError = String(err);
      } finally {
        // A failed close must not escape to exit 2 and lose this session's record.
        try {
          store.close();
          await backend.close();
        } catch (err) {
          storeReadError = `${storeReadError ?? ""} close failed: ${String(err)}`.trim();
        }
      }
    }

    // Slow path, never throws: second marker reads, then ONE container call for the progress rows,
    // the session-list positive control (recorded every session, hit or not) and the event log.
    const { broken, control } = await gatherEvidence(pending, {
      tenant: bcdev.tenant ?? "default",
      sessionStartedAt: startedAt,
      ranAnswerSessionId: ran.sessionId,
    });
    if (thrown !== null) quarantined = `THREW: ${thrown}`;
    const { exitCode, actionEnd, stopReason } = decideExit({ thrown, quarantined, broken });

    const record: SessionRecord = {
      arm,
      index,
      segment,
      startedAt,
      endedAt: new Date().toISOString(),
      traced,
      afterHit,
      afterUnprovenHit,
      postRecovery: segment > 1 && index === 1,
      actionEnd,
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
      sessionControl: control,
      storeReadError,
      warnings: events.flatMap((e) =>
        e.type === "warning" ? [{ code: e.code, message: e.message }] : [],
      ),
      stopReason,
      scratchDir,
    };
    const written = writeRecord(out, record);
    console.log(
      `${arm} #${index}: ${record.hit ? "HIT" : "no hit"}, ${broken.length} broken call(s)${stopReason !== null ? `, STOP: ${stopReason}` : ""}`,
    );
    if (exitCode !== 0) process.exit(exitCode);
    if (!written) process.exit(3); // the record reached stdout only: stop, never continue silently
    afterHit = broken.length > 0;
    afterUnprovenHit = actionEnd === "unproven";
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
