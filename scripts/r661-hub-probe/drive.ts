/**
 * R661 probe: a hub-mode BASELINE run (`BcDevMcpBackend.run`, coverage `line` then `procedure`,
 * which goes to bc-dev-mcp's TestRunnerHub, not to LethAL Control) whose test outlives its budget.
 * Does BC's test session outlive LethAL giving up, and outlive the hub connection's close? Does it
 * touch LethAL Control's op marker? Pre-commitment:
 * docs/superpowers/specs/2026-10-23-r661-hub-baseline-overrun-probe-precommitment.md.
 *
 *   bun scripts/r661-hub-probe/drive.ts --server bc3
 *
 * Run from the worktree root under `kraken coord lease bc3 bugs` (`run-probe.sh` holds and
 * heartbeats it). REFUSES (exit 2) unless `--server bc3` and `kraken coord holder bc3` names lane
 * bugs. The login is read in-process from the secret file and never printed. Apps are read by id
 * only (R433).
 *
 * The test is the hang fixture's `Hang Z Baseline Tests.SleepsPastTheBaselineBudget` (79451,
 * `Sleep(25000)`), already published on bc3 by `itest:hang`. Case C runs its empty sibling
 * `ZPassesAfterTheStoppedTest` as the control. Session liveness is read from BC's `Active Session`
 * through the probe app's one web service, by difference from the read before dispatch.
 *
 * STOP rule (pre-committed): a session that appeared with a case is still listed at dispatch +
 * 35 s (10 s after its own Sleep ended); or the final control-app acquire is refused; or the op
 * marker moved. Then: no removal, exit 5, and the wrapper keeps the coord lease.
 *
 * Writes docs/measurements/r661/bc3-probe.json and logs to /coord/handoff/R-661/probe/drive.log.
 * Exit: 0 ran and removed; 1 a step failed (app removed); 2 the guard refused; 5 the STOP rule.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestMethodRef, TestVerdict } from "../../packages/runner/src/backend";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { BcDevMcpBackend } from "../../packages/runner/src/bcdev-backend";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { LeaseClient } from "../../packages/runner/src/lease";
import { requiresUnsafeLatch } from "../../packages/runner/src/operation-outcome";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import {
  COMPANY,
  type Conn,
  HOST,
  SERVERS,
  type ServerName,
  apiJson,
  extensionsApi,
  publishBytes,
  rowVersion,
  rows,
} from "../bc-app-content.ts";
import { bcDevMcpCommand, errText, readSecretFile } from "../bc-linux-setup.ts";

const REPO = join(import.meta.dir, "..", "..");
const EVIDENCE = "/coord/handoff/R-661/probe";
const LOG = join(EVIDENCE, "drive.log");
const OUT_DIR = join(REPO, "docs", "measurements", "r661");
const PROBE = { id: "b6f3e0a2-5c41-4e7d-9a18-61c2d7f4e905", name: "LethAL R661 Hub Session Probe" };
const BUILD = join(import.meta.dir, "build", "bc3", "probe.app");
const PROJECT = join(REPO, "fixtures", "sandbox-hang");
const CODEUNIT = { id: 79451, name: "Hang Z Baseline Tests" };
const BUDGET_MS = 10_000;
/** Reads after dispatch; the hub is closed at CLOSE_MS. The test's Sleep ends at 25 s. */
const READ_AT_MS = [5_000, 12_000, 16_000, 21_000, 35_000] as const;
const CLOSE_MS = 13_000;
const STOP_READ_MS = 35_000;
const CASES = [
  { role: "C", method: "ZPassesAfterTheStoppedTest", coverage: "procedure" },
  { role: "H-line", method: "SleepsPastTheBaselineBudget", coverage: "line" },
  { role: "H-procedure", method: "SleepsPastTheBaselineBudget", coverage: "procedure" },
] as const;

function log(line: string): void {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(s);
  try {
    mkdirSync(EVIDENCE, { recursive: true });
    appendFileSync(LOG, `${s}\n`);
  } catch {}
}

function serverArg(): ServerName {
  const i = process.argv.indexOf("--server");
  const s = i < 0 ? undefined : process.argv[i + 1];
  if (s !== "bc3") throw new Error(`--server bc3 is required (got ${String(s)})`);
  return s;
}

function holderIsBugs(server: ServerName): string {
  const p = Bun.spawnSync(["kraken", "coord", "holder", server]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder ${server} exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== "bugs")
    throw new Error(`${server} is not held by lane bugs: ${out}`);
  return out;
}

function git(args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: REPO });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return p.stdout.toString().trim();
}

const sleepUntil = (t0: number, ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, t0 + ms - Date.now())));

/** What the orchestrator's baseline loop does with this verdict today (`runBaselineTest`). */
function baselineReading(v: TestVerdict): string {
  if (v.operation !== undefined && requiresUnsafeLatch(v.operation))
    return `quarantine (${v.operation}): tier quarantined, session stops`;
  if (v.outcome === "pass") return "green";
  return `not green (${v.outcome})`;
}

class StopRule extends Error {}

async function main(): Promise<number> {
  let server: ServerName;
  let holder: string;
  try {
    server = serverArg();
    holder = holderIsBugs(server);
  } catch (err) {
    console.error(`REFUSED: ${errText(err)}`);
    return 2;
  }
  const login = readSecretFile();
  const ports = SERVERS[server];
  const odata = {
    baseUrl: `${HOST}:${ports.odata}/BC`,
    apiBaseUrl: `${HOST}:${ports.api}/BC`,
    company: COMPANY,
    username: login.user,
    password: login.password,
    tenant: "default",
  };
  const authorization = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`;
  const c: Conn = { server, authorization };
  log(`lease guard: ${holder}`);
  const harnessCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain", "--", "scripts/r661-hub-probe"]) !== "")
    throw new Error("the probe sources are not committed; commit them first");
  const probeSourceSha = git(["rev-parse", "HEAD:scripts/r661-hub-probe"]);
  const appSha = new Bun.CryptoHasher("sha256").update(readFileSync(BUILD)).digest("hex");
  log(`harness ${harnessCommit}, probe tree ${probeSourceSha}, probe.app ${appSha}`);
  const doc: Record<string, unknown> = {
    server,
    date: new Date().toISOString().slice(0, 10),
    harness: `scripts/r661-hub-probe/drive.ts@${harnessCommit}`,
    probeSourceSha,
    appSha256: appSha,
    lease: { holder: JSON.parse(holder), releasedAt: null },
    budgetMs: BUDGET_MS,
    readAtMs: READ_AT_MS,
    closeAtMs: CLOSE_MS,
  };

  const listSessions = async (): Promise<Map<string, string>> => {
    const url = `${odata.baseUrl}/ODataV4/R661ProbeSessions_ListSessions?company=${encodeURIComponent(COMPANY)}&tenant=default`;
    const res = await bcFetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ListSessions HTTP ${res.status}: ${text.slice(0, 500)}`);
    const value = String((JSON.parse(text) as { value?: unknown }).value ?? "");
    const out = new Map<string, string>();
    for (const row of value.split(";")) {
      const id = row.split("/")[0];
      if (id !== undefined && id !== "") out.set(id, row);
    }
    return out;
  };

  const harness = new HarnessVerifier(odata);
  const reader = new RunMutantTransport(odata, PROBE.id, "0".repeat(32));
  const opStatus = async (serverGeneration: string) => {
    try {
      const st = await reader.getOperationStatus(
        { epoch: 0, token: "", serverGeneration },
        "r661-read",
        0,
        15_000,
      );
      return {
        opKind: st.opKind,
        opAttemptId: st.opAttemptId,
        opSeq: st.opSeq,
        lastCompletedOpSeq: st.lastCompletedOpSeq,
      };
    } catch (err) {
      return { error: errText(err) };
    }
  };

  const ext = await extensionsApi(c);
  const describe = async () => {
    const rs = await rows(c, ext, PROBE.id);
    return rs.length === 0
      ? "absent (0 rows)"
      : rs.map((r) => `${rowVersion(r)} isInstalled=${r.isInstalled}`).join("; ");
  };
  let published = false;
  let code = 0;
  try {
    doc.lethalControl = await harness.fetchControlVersion();
    const info = await harness.verify();
    log(`LethAL Control ${doc.lethalControl}; serverGeneration ${info.serverGeneration}`);
    if ((await rows(c, ext, PROBE.id)).length > 0)
      throw new Error(`${PROBE.name} already on ${server} before the probe (not ours)`);
    published = true;
    await publishBytes(c, `LethAL_${PROBE.name}_1.0.0.0.app`, readFileSync(BUILD));
    const after = await rows(c, ext, PROBE.id);
    log(`published: ${await describe()}`);
    if (after.length !== 1 || after[0]?.isInstalled !== true)
      throw new Error("probe app not read back installed");

    const markerBefore = await opStatus(info.serverGeneration);
    doc.opMarkerBefore = markerBefore;
    log(`op marker before: ${JSON.stringify(markerBefore)}`);

    const results: Record<string, unknown>[] = [];
    doc.results = results;
    for (const k of CASES) {
      const backend = new BcDevMcpBackend({
        mcpCommand: bcDevMcpCommand(),
        project: PROJECT,
        server: `${HOST}:${ports.dev}`,
        serverInstance: "BC",
        tenant: "default",
        port: ports.dev,
        company: COMPANY,
        packageCachePath: join(PROJECT, ".alpackages"),
        controlSymbolPath: join(PROJECT, ".alpackages", "lethal-control.app"),
        env: {
          BC_DEV_USER: login.user,
          BC_DEV_PASSWORD: login.password,
          BC_DEV_API_PORT: String(ports.api),
        },
      });
      const r: Record<string, unknown> = { role: k.role, method: k.method, coverage: k.coverage };
      results.push(r);
      const before = await listSessions();
      r.sessionsBefore = [...before.values()];
      const ref: TestMethodRef = {
        codeunitId: CODEUNIT.id,
        codeunitName: CODEUNIT.name,
        method: k.method,
      };
      const t0 = Date.now();
      log(`${k.role}: dispatch ${k.method} coverage ${k.coverage} budget ${BUDGET_MS}`);
      const run = backend.run(ref, { coverage: k.coverage, timeoutMs: BUDGET_MS }).then(
        (v) => {
          r.verdict = {
            outcome: v.outcome,
            operation: v.operation ?? null,
            durationMs: v.durationMs,
            failureMessage: v.failureMessage?.slice(0, 1000) ?? null,
            atMs: Date.now() - t0,
          };
          r.baselineReading = baselineReading(v);
          log(`${k.role}: verdict ${JSON.stringify(r.verdict)} -> ${r.baselineReading}`);
        },
        (err: unknown) => {
          r.verdict = { threw: errText(err), atMs: Date.now() - t0 };
          log(`${k.role}: run threw ${errText(err)}`);
        },
      );
      if (k.role === "C") {
        await run;
        await backend.close();
        r.closedAtMs = Date.now() - t0;
        continue;
      }
      const appeared = new Set<string>();
      const reads: Record<string, unknown>[] = [];
      r.reads = reads;
      let closed = false;
      for (const at of READ_AT_MS) {
        if (!closed && at > CLOSE_MS) {
          await sleepUntil(t0, CLOSE_MS);
          await backend.close();
          closed = true;
          r.closedAtMs = Date.now() - t0;
          log(`${k.role}: backend closed (bc-dev-mcp child ended) at +${r.closedAtMs} ms`);
        }
        await sleepUntil(t0, at);
        const now = await listSessions();
        if (at === READ_AT_MS[0])
          for (const id of now.keys()) if (!before.has(id)) appeared.add(id);
        const live = [...appeared].filter((id) => now.has(id));
        reads.push({ atMs: Date.now() - t0, appearedStillListed: live, rows: [...now.values()] });
        log(
          `${k.role}: +${at} appeared [${[...appeared].join(",")}] still listed [${live.join(",")}]`,
        );
      }
      await run;
      r.appeared = [...appeared];
      const last = reads.at(-1) as { appearedStillListed: string[] } | undefined;
      if (last !== undefined && last.appearedStillListed.length > 0) {
        doc.stop = `${k.role}: session(s) ${last.appearedStillListed.join(",")} still listed at +${STOP_READ_MS} ms`;
        throw new StopRule(doc.stop as string);
      }
    }

    const markerAfter = await opStatus(info.serverGeneration);
    doc.opMarkerAfter = markerAfter;
    log(`op marker after: ${JSON.stringify(markerAfter)}`);
    if (JSON.stringify(markerAfter) !== JSON.stringify(markerBefore)) {
      doc.stop = "the op marker moved during hub-only runs";
      throw new StopRule(doc.stop as string);
    }
    const leases = new LeaseClient(odata);
    const got = await leases.acquire(
      "r661-hub-probe (lane bugs)",
      15,
      crypto.randomUUID(),
      info.serverGeneration,
    );
    doc.finalAcquire = got.granted ? { granted: true } : { granted: false, reason: got.reason };
    log(`final acquire: ${JSON.stringify(doc.finalAcquire)}`);
    if (!got.granted) {
      doc.stop = "the final control-app acquire was refused";
      throw new StopRule(doc.stop as string);
    }
    doc.finalRelease = await leases.release(got.lease);
    log(`final release: ${JSON.stringify(doc.finalRelease)}`);
  } catch (err) {
    if (err instanceof StopRule) {
      code = 5;
      log(`STOP RULE: ${err.message}. No removal; keep the coord lease.`);
    } else {
      code = 1;
      doc.error = errText(err);
      log(`FAILED: ${errText(err)}`);
    }
  } finally {
    if (code !== 5 && published) {
      const steps: string[] = [];
      try {
        await removeProbe(c, ext, steps);
        steps.push(`read-back ${await describe()}`);
      } catch (err) {
        steps.push(`FAILED: ${errText(err)}`);
        code = 1;
      }
      doc.removal = steps;
      log(`removal: ${steps.join(" | ")}`);
    }
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, `${server}-probe.json`), `${JSON.stringify(doc, null, 2)}\n`);
    } catch (err) {
      console.error(`evidence write FAILED: ${errText(err)}`);
    }
  }
  return code;
}

/** R639's E3: uninstall if installed, then the bound unpublish (each HTTP 204). */
async function removeProbe(c: Conn, ext: string, steps: string[]): Promise<void> {
  for (const r of await rows(c, ext, PROBE.id)) {
    const key = `${ext}(${r.packageId})`;
    if (r.isInstalled) {
      const u = await apiJson(c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
      steps.push(`uninstall HTTP ${u.status}`);
      if (u.status !== 204) throw new Error(`uninstall HTTP ${u.status} ${u.text.slice(0, 500)}`);
    }
    const p = await apiJson(c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    steps.push(`unpublish HTTP ${p.status}`);
    if (p.status !== 204) throw new Error(`unpublish HTTP ${p.status} ${p.text.slice(0, 500)}`);
  }
}

if (import.meta.main) {
  process.exit(
    await main().catch((err: unknown) => {
      console.error(`driver failed: ${errText(err)}`);
      return 1;
    }),
  );
}
