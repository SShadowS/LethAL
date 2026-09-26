/**
 * R236 calibration (ruling q-160433): READ-ONLY. No lease, no RunMutant, no runSession. Answers,
 * before any probe session, whether the session check can mean anything:
 *
 *   (a) POOLING: is the session id of a recently FINISHED op (an `LC Op Progress` row in state
 *       done) still listed by `Get-NAVServerSession`? If yes, a listed session proves nothing.
 *   (b) Is a tenant-scoped `[Active Session]` read a sound "is this session still alive" control?
 *       Three criteria, each judged per round and then over all rounds:
 *       - finishedDisappears: a known finished op's session is ABSENT from a NON-EMPTY scoped table
 *         (present as the same session = not sound; an empty table proves nothing).
 *       - liveStays: while a burst of read-only `HarnessInfo` calls runs, the scoped table holds a
 *         row of OUR user that logged in during the burst. Only "sound" or "not determinable": a
 *         per-request session can end between two reads, so absence is never proof of unsoundness.
 *       - idsMatch: the latest `Session Event` Logon for a finished op's session id, at or before
 *         the op started, is OUR user (the control app's `SessionId()` and the server's session
 *         records share one id space). A different user = not sound.
 *       The control is sound only if all three are sound over the rounds.
 *
 * "Same session" = same id AND a login time at or before the op started (plus a tolerance); a
 * listed id that logged in later is a reused id, and a listed id with no login time is ambiguous.
 *
 * LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/calibrate.ts --out <file.ndjson>
 *   [--rounds <n>=5] [--interval-ms <ms>=10000] [--recent-minutes <m>=10]
 *
 * One NDJSON line per round (raw rows plus that round's verdicts), then one `summary` line.
 * Exit: 0 done (whatever the verdicts); 2 harness fault. Table and column names are UNVERIFIED
 * against a live container: the script dumps each table's real column list (`R236-COLS`), and a
 * failed read makes the dependent criteria "not determinable", never a guess.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ActivationConfig } from "../../packages/runner/src/activation";
import type { LethalConfigFile } from "../../packages/runner/src/cli";
import { odataBaseUrl, validateBcDevConfig } from "../../packages/runner/src/cli";
import { HarnessVerifier } from "../../packages/runner/src/harness";
// With the extension: R186's importer check matches by basename (see probe.test.ts).
import { CONFIG_PATH, CONTAINER, runPwsh } from "./probe.ts";

export type Verdict = "sound" | "not sound" | "not determinable";
export type Pooling = "pooled" | "not pooled" | "not determinable";

export interface Listed {
  readonly id: number;
  readonly user: string | null;
  /** ms since epoch, UTC; null when the server gave none. */
  readonly login: number | null;
}
export interface FinishedOp {
  readonly sessionId: number;
  readonly attemptId: string;
  readonly opSeq: number;
  readonly startedAt: number;
}
export interface SessionEvent {
  readonly sessionId: number;
  /** `Session Event."Event Type"`: 0 = Logon (unverified option order: Logon, Logoff, Start, Stop, Close). */
  readonly type: number;
  readonly at: number;
  readonly user: string | null;
}
export interface RoundData {
  readonly at: number;
  readonly user: string;
  readonly burst: { start: number; end: number; calls: number; errors: number };
  readonly nst: Listed[] | null;
  readonly active: Listed[] | null;
  readonly finished: FinishedOp[] | null;
  readonly events: SessionEvent[] | null;
}
export interface RoundVerdicts {
  readonly pooling: Pooling;
  readonly finishedDisappears: Verdict;
  readonly liveStays: Verdict;
  readonly idsMatch: Verdict;
}

const norm = (u: string | null) => (u ?? "").toLowerCase().replace(/^.*\\/, "");

type Match = "same" | "absent" | "ambiguous";
function matchOp(list: readonly Listed[], op: FinishedOp, tolMs: number): Match {
  const row = list.find((l) => l.id === op.sessionId);
  if (row === undefined) return "absent";
  if (row.login === null) return "ambiguous";
  return row.login <= op.startedAt + tolMs ? "same" : "absent"; // later login = a reused id
}

export function judgeRound(d: RoundData, o: { recentMs: number; tolMs: number }): RoundVerdicts {
  let pooling: Pooling = "not determinable";
  const recent = (d.finished ?? []).filter((op) => d.at - op.startedAt <= o.recentMs);
  if (d.nst !== null && recent.length > 0) {
    const m = recent.map((op) => matchOp(d.nst ?? [], op, o.tolMs));
    if (m.includes("same")) pooling = "pooled";
    else if (!m.includes("ambiguous")) pooling = "not pooled";
  }

  let finishedDisappears: Verdict = "not determinable";
  if (d.active !== null && d.active.length > 0 && d.finished !== null) {
    const m = d.finished.map((op) => matchOp(d.active ?? [], op, o.tolMs));
    if (m.includes("same")) finishedDisappears = "not sound";
    else if (m.includes("absent")) finishedDisappears = "sound";
  }

  const liveStays: Verdict =
    d.active?.some(
      (r) =>
        norm(r.user) === norm(d.user) &&
        r.login !== null &&
        r.login >= d.burst.start - o.tolMs &&
        r.login <= d.burst.end + o.tolMs,
    ) === true
      ? "sound"
      : "not determinable";

  let idsMatch: Verdict = "not determinable";
  if (d.events !== null && d.finished !== null) {
    let matched = false;
    for (const op of d.finished) {
      const logon = d.events
        .filter(
          (e) => e.sessionId === op.sessionId && e.type === 0 && e.at <= op.startedAt + o.tolMs,
        )
        .sort((a, b) => b.at - a.at)[0];
      if (logon === undefined) continue;
      if (norm(logon.user) !== norm(d.user)) {
        idsMatch = "not sound";
        break;
      }
      matched = true;
    }
    if (idsMatch !== "not sound" && matched) idsMatch = "sound";
  }
  return { pooling, finishedDisappears, liveStays, idsMatch };
}

function combine(vs: readonly Verdict[]): Verdict {
  if (vs.includes("not sound")) return "not sound";
  return vs.includes("sound") ? "sound" : "not determinable";
}

export function aggregate(rounds: readonly RoundVerdicts[]): RoundVerdicts & {
  activeSessionControl: Verdict;
} {
  const ps = rounds.map((r) => r.pooling);
  const pooling: Pooling = ps.includes("pooled")
    ? "pooled"
    : ps.includes("not pooled")
      ? "not pooled"
      : "not determinable";
  const finishedDisappears = combine(rounds.map((r) => r.finishedDisappears));
  const liveStays = combine(rounds.map((r) => r.liveStays));
  const idsMatch = combine(rounds.map((r) => r.idsMatch));
  const all = [finishedDisappears, liveStays, idsMatch];
  const activeSessionControl: Verdict = all.includes("not sound")
    ? "not sound"
    : all.every((v) => v === "sound")
      ? "sound"
      : "not determinable";
  return { pooling, finishedDisappears, liveStays, idsMatch, activeSessionControl };
}

/** SQL datetimes carry no zone and BC stores UTC; an explicit zone is kept. */
function utc(s: unknown): number | null {
  if (typeof s !== "string" || s === "") return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? null : t;
}

export function parseCalibration(
  stdout: string,
): Pick<RoundData, "nst" | "active" | "finished" | "events"> {
  const lines = stdout.split(/\r?\n/);
  const read = <T>(tag: string, map: (r: Record<string, unknown>) => T | null): T[] | null => {
    const raw = lines.find((l) => l.startsWith(`${tag}:`))?.slice(tag.length + 1);
    if (raw === undefined) return null;
    try {
      const v: unknown = raw.trim() === "" ? [] : JSON.parse(raw);
      const rows = (Array.isArray(v) ? v : [v]).map((r) => map(r as Record<string, unknown>));
      return rows.every((r) => r !== null) ? (rows as T[]) : null;
    } catch {
      return null;
    }
  };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    nst: read("R236-NST", (r) =>
      typeof r.SessionID === "number"
        ? { id: r.SessionID, user: str(r.UserID), login: utc(r.Login) }
        : null,
    ),
    active: read("R236-ACTIVE", (r) =>
      typeof r.sid === "number" ? { id: r.sid, user: str(r.user), login: utc(r.login) } : null,
    ),
    finished: read("R236-FIN", (r) => {
      const startedAt = utc(r.started);
      return typeof r.sid === "number" &&
        typeof r.aid === "string" &&
        typeof r.seq === "number" &&
        startedAt !== null
        ? { sessionId: r.sid, attemptId: r.aid, opSeq: r.seq, startedAt }
        : null;
    }),
    events: read("R236-EVT", (r) => {
      const at = utc(r.at);
      return typeof r.sid === "number" && typeof r.type === "number" && at !== null
        ? { sessionId: r.sid, type: r.type, at, user: str(r.user) }
        : null;
    }),
  };
}

function calibrationScript(tenant: string): string {
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenant))
    throw new Error(`refusing tenant ${JSON.stringify(tenant)}`);
  return `
Import-Module BcContainerHelper -DisableNameChecking
Invoke-ScriptInBcContainer -containerName ${CONTAINER} -argumentList @('${tenant}') -scriptblock { param($tenant)
  $iso = { param($d) if ($d -is [datetime]) { $d.ToUniversalTime().ToString('o') } else { $null } }
  try {
    'R236-NST:' + (ConvertTo-Json -Compress -InputObject @(Get-NAVServerSession -ServerInstance BC -Tenant $tenant | ForEach-Object { @{ SessionID = [int]$_.SessionID; UserID = [string]$_.UserID; ClientType = [string]$_.ClientType; Login = (& $iso $_.LoginDatetime) } }))
  } catch { 'R236-NST-ERR:' + $_.Exception.Message }
  $cfg = Get-NAVServerConfiguration -ServerInstance BC -AsXml
  $get = { param($k) ($cfg.configuration.appSettings.add | Where-Object { $_.key -eq $k }).value }
  $srv = & $get 'DatabaseServer'; $inst = & $get 'DatabaseInstance'; $db = & $get 'DatabaseName'
  if ($inst) { $srv = "$srv\\$inst" }
  $sq = @{ ServerInstance = $srv; Database = $db }
  if ((Get-Command Invoke-Sqlcmd).Parameters.ContainsKey('TrustServerCertificate')) { $sq.TrustServerCertificate = $true }
  $cols = { param($t) @(Invoke-Sqlcmd @sq -Query "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(N'[dbo].[$t]')" | ForEach-Object { [string]$_.name }) }
  try {
    $ac = & $cols 'Active Session'
    'R236-COLS:Active Session:' + (ConvertTo-Json -Compress -InputObject $ac)
    $where = @("[Server Instance Name] = N'BC'")
    $tcol = @($ac | Where-Object { $_ -like '*Tenant*' })
    if ($tcol.Count -eq 1) { $where += "[$($tcol[0])] = N'$tenant'" }
    'R236-ACTIVE-SCOPE:' + ($where -join ' AND ') + " (database $db)"
    $rows = @(Invoke-Sqlcmd @sq -Query "SELECT [Session ID] AS sid, [User ID] AS usr, [Client Type] AS ct, CONVERT(varchar(23), [Login Datetime], 126) AS login FROM [dbo].[Active Session] WHERE $($where -join ' AND ')" | ForEach-Object { @{ sid = [int]$_.sid; user = [string]$_.usr; ct = [int]$_.ct; login = [string]$_.login } })
    'R236-ACTIVE:' + (ConvertTo-Json -Compress -InputObject $rows)
  } catch { 'R236-ACTIVE-ERR:' + $_.Exception.Message }
  $sids = @()
  try {
    $t = @(Invoke-Sqlcmd @sq -Query "SELECT name FROM sys.tables WHERE name LIKE '%LC Op Progress%'" | ForEach-Object { $_.name })
    if ($t.Count -ne 1) { throw "expected one LC Op Progress table, found $($t.Count)" }
    'R236-COLS:' + $t[0] + ':' + (ConvertTo-Json -Compress -InputObject (& $cols $t[0]))
    $fin = @(Invoke-Sqlcmd @sq -Query "SELECT TOP 50 [Session Id] AS sid, [Attempt Id] AS aid, [Op Seq] AS seq, CONVERT(varchar(23), [Started At], 126) AS started FROM [dbo].[$($t[0])] WHERE [State] = 2 AND [Session Id] > 0 ORDER BY [Started At] DESC" | ForEach-Object { @{ sid = [int]$_.sid; aid = [string]$_.aid; seq = [long]$_.seq; started = [string]$_.started } })
    $sids = @($fin | ForEach-Object { $_.sid } | Sort-Object -Unique)
    'R236-FIN:' + (ConvertTo-Json -Compress -InputObject $fin)
  } catch { 'R236-FIN-ERR:' + $_.Exception.Message }
  try {
    'R236-COLS:Session Event:' + (ConvertTo-Json -Compress -InputObject (& $cols 'Session Event'))
    if ($sids.Count -eq 0) { throw 'no finished-op session ids to look up' }
    $ev = @(Invoke-Sqlcmd @sq -Query "SELECT [Session ID] AS sid, [Event Type] AS typ, CONVERT(varchar(23), [Event Datetime], 126) AS at, [User ID] AS usr FROM [dbo].[Session Event] WHERE [Server Instance Name] = N'BC' AND [Session ID] IN ($($sids -join ','))" | ForEach-Object { @{ sid = [int]$_.sid; type = [int]$_.typ; at = [string]$_.at; user = [string]$_.usr } })
    'R236-EVT:' + (ConvertTo-Json -Compress -InputObject $ev)
  } catch { 'R236-EVT-ERR:' + $_.Exception.Message }
}`;
}

async function main(): Promise<void> {
  if (process.env.LETHAL_R236_PROBE !== "1") {
    console.log("skipped");
    process.exit(0);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      out: { type: "string" },
      rounds: { type: "string", default: "5" },
      "interval-ms": { type: "string", default: "10000" },
      "recent-minutes": { type: "string", default: "10" },
    },
  });
  const rounds = Number(values.rounds);
  const intervalMs = Number(values["interval-ms"]);
  const recentMs = Number(values["recent-minutes"]) * 60_000;
  if (values.out === undefined) throw new Error("--out is required");
  if (![rounds, intervalMs, recentMs].every((n) => Number.isInteger(n) && n >= 0) || rounds < 1) {
    throw new Error(
      "--rounds, --interval-ms and --recent-minutes must be non-negative integers, rounds >= 1",
    );
  }
  const out = resolve(values.out);
  if (!existsSync(dirname(out))) throw new Error(`--out directory does not exist: ${dirname(out)}`);

  const bcdev = validateBcDevConfig(
    (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LethalConfigFile).bcdev,
  );
  const odataCfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harness = new HarnessVerifier(odataCfg);
  const tenant = bcdev.tenant ?? "default";
  const opts = { recentMs, tolMs: 5_000 };
  const judged: RoundVerdicts[] = [];
  for (let round = 1; round <= rounds; round++) {
    // The burst: sequential READ-ONLY HarnessInfo calls for as long as the container read runs, so
    // an OData session of our user is (almost always) live while the table is read.
    let stop = false;
    const burst = { start: Date.now(), end: 0, calls: 0, errors: 0 };
    const burstDone = (async () => {
      while (!stop) {
        try {
          await harness.fetchControlVersion();
        } catch {
          burst.errors++;
        }
        burst.calls++;
      }
      burst.end = Date.now();
    })();
    const r = await runPwsh(calibrationScript(tenant)).catch((err: unknown) => ({
      stdout: "",
      stderr: `spawn failed: ${String(err)}`,
      code: -1,
    }));
    stop = true;
    await burstDone;
    const data: RoundData = {
      at: Date.now(),
      user: bcdev.username,
      burst,
      ...parseCalibration(r.stdout),
    };
    const verdicts = judgeRound(data, opts);
    judged.push(verdicts);
    appendFileSync(
      out,
      `${JSON.stringify({ kind: "round", round, ...data, verdicts, raw: { code: r.code, stdout: r.stdout, stderr: r.stderr } })}\n`,
    );
    console.log(`round ${round}: ${JSON.stringify(verdicts)}`);
    if (round < rounds) await Bun.sleep(intervalMs);
  }
  const summary = aggregate(judged);
  appendFileSync(out, `${JSON.stringify({ kind: "summary", rounds, recentMs, ...summary })}\n`);
  console.log(`summary: ${JSON.stringify(summary)}`);
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
