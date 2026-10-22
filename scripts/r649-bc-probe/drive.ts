/**
 * R649 probe: how long BC's own `Sleep` waits, under LethAL's real baseline call, and what LethAL
 * records when it outlasts the baseline budget. Copied from scripts/r639-bc-probe/drive.ts.
 *
 *   bun scripts/r649-bc-probe/drive.ts --server bc1|bc2|bc3
 *
 * Run from the worktree root, AFTER `kraken coord lease <server> bugs` (the caller holds the lease
 * and heartbeats it); this script REFUSES (exit 2) unless `kraken coord holder <server>` names lane
 * bugs. The login is read in-process from the secret file and never printed. Apps are read by id
 * only (R433). The probe apps are ALWAYS removed (tests app, then target): uninstall if installed,
 * then the bound Microsoft.NAV.unpublish, then a read-back that must show 0 rows.
 *
 * Each case is one `RunMutantTransport.run` (the `LethALControl_RunMutant` call bcdev makes for a
 * baseline test, `mutantId ""`), with `timeoutMs` = `BASELINE_TIMEOUT_DEFAULT`, and no stop hook
 * (bcdev wires R53's stop only for a mutant run). When that call ends without the server's answer
 * (`in-flight-unknown`), the driver keeps polling GetOperationStatus and GetOpAnswer on the same
 * lease until BC's own answer lands or `FOLLOW_CAP_MS` passes, so one run records both LethAL's
 * row and what BC itself did. The long cases run last; each may hold the lease ~10 minutes.
 *
 * `R649_CASES=92930,92931` runs only those codeunits (still in the order below).
 *
 * It writes docs/measurements/r649/<server>-probe.json (`lease.releasedAt` null: the caller fills
 * it after releasing) and logs every step to /coord/handoff/R-649/probe/drive.log.
 *
 * Exit: 0 ran and removed; 1 a step failed or a STOP (see the log); 2 the guard refused.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { type Lease, LeaseClient, type OperationStatus } from "../../packages/runner/src/lease";
import { BASELINE_TIMEOUT_DEFAULT } from "../../packages/runner/src/orchestrator";
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
import { errText, readSecretFile } from "../bc-linux-setup.ts";

const REPO = join(import.meta.dir, "..", "..");
const EVIDENCE = "/coord/handoff/R-649/probe";
const LOG = join(EVIDENCE, "drive.log");

const TARGET = {
  id: "7937c2a9-5c42-4e98-bd9b-9de8151b55fe",
  name: "LethAL R649 BC Sleep Probe",
  file: "target.app",
};
const TESTS = {
  id: "44c7bc28-455d-4ac9-bb27-3c20754c9c23",
  name: "LethAL R649 BC Sleep Probe Tests",
  file: "tests.app",
};
/** Registered by the target's Install codeunit 92920. */
const ARTIFACT_ID = "588155e99f794541ac96f1d42821b803";
const BASE_APP = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const SYSTEM_APP = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
/** The control-app lease: the 15 s maximum, renewed every 5 s (the orchestrator's ttl/3). */
const TTL_S = 15;
const BEAT_MS = 5_000;
/** After a call ends unanswered: poll every 10 s, until 720 s after dispatch (600 s + 2 min). */
const POLL_MS = 10_000;
const FOLLOW_CAP_MS = 720_000;
const READ_MS = 15_000;

/** Short first, long last (the long ones may hold the lease ~10 minutes each). */
const ALL_CASES = [
  { codeunit: 92930, name: "R649 Sleep 100", method: "Sleep100" },
  { codeunit: 92931, name: "R649 Sleep 5000", method: "Sleep5000" },
  { codeunit: 92932, name: "R649 Sleep 600000", method: "LongSleepThenAssert" },
  { codeunit: 92933, name: "R649 Sleeper Doubles", method: "SleeperDoubles" },
];
const only = process.env.R649_CASES;
const CASES =
  only === undefined || only === ""
    ? ALL_CASES
    : ALL_CASES.filter((k) => only.split(",").includes(String(k.codeunit)));

mkdirSync(EVIDENCE, { recursive: true });
const log = (s: string) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

function serverArg(): ServerName {
  const i = process.argv.indexOf("--server");
  const s = i < 0 ? undefined : process.argv[i + 1];
  if (s !== "bc1" && s !== "bc2" && s !== "bc3")
    throw new Error(`--server bc1|bc2|bc3 is required (got ${String(s)})`);
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

/** The failure text LethAL stores, split as R639 records it: first line, then the callstack. */
function split(text: string | undefined): Record<string, unknown> {
  const t = text ?? "";
  const nl = t.indexOf("\n");
  return {
    fullFailureText: t,
    firstLine: nl < 0 ? t : t.slice(0, nl),
    callstack: nl < 0 ? null : t.slice(nl + 1),
  };
}

/** BC's own answer (the RunMutant `value` JSON) for one test, read raw, never thrown. */
function bcLine(answer: string): Record<string, unknown> {
  try {
    const a = JSON.parse(answer) as { status?: unknown; codeunitResults?: unknown };
    const cr = (
      typeof a.codeunitResults === "string" ? JSON.parse(a.codeunitResults) : a.codeunitResults
    ) as { testResults?: unknown } | undefined;
    const lines = Array.isArray(cr?.testResults)
      ? (cr.testResults as Record<string, unknown>[])
      : [];
    const [l] = lines;
    if (lines.length !== 1 || l === undefined)
      return { status: a.status, lineError: `expected one test line, got ${lines.length}` };
    const message = typeof l.message === "string" ? l.message : "";
    const stackTrace = typeof l.stackTrace === "string" ? l.stackTrace : "";
    return {
      status: a.status,
      method: l.method,
      outcome: l.result === 2 ? "pass" : l.result === 1 ? "fail" : `unknown(${String(l.result)})`,
      resultEnum: l.result,
      ...split([message, stackTrace].filter((x) => x.length > 0).join("\n")),
      message,
      stackTrace,
    };
  } catch (err) {
    return { lineError: errText(err) };
  }
}

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
  const BUILD = join(import.meta.dir, "build", server);
  const OUT = join(REPO, "docs", "measurements", "r649", `${server}-probe.json`);
  log(`lease guard: ${holder}`);
  const harnessCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain", "--", "scripts/r649-bc-probe"]) !== "")
    throw new Error("the probe sources are not committed; commit them first");
  const probeSourceSha = git(["rev-parse", "HEAD:scripts/r649-bc-probe"]);
  const appSha: Record<string, string> = {};
  for (const a of [TARGET, TESTS])
    appSha[a.file] = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(BUILD, a.file)))
      .digest("hex");
  log(`harness ${harnessCommit}, probe tree ${probeSourceSha}, apps ${JSON.stringify(appSha)}`);

  const login = readSecretFile();
  const c: Conn = {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  };
  const odata = {
    baseUrl: `${HOST}:${SERVERS[server].odata}/BC`,
    apiBaseUrl: `${HOST}:${SERVERS[server].api}/BC`,
    company: COMPANY,
    username: login.user,
    password: login.password,
    tenant: "default",
  };
  const doc: Record<string, unknown> = {
    server,
    date: new Date().toISOString().slice(0, 10),
    harness: `scripts/r649-bc-probe/drive.ts@${harnessCommit}`,
    probeSourceSha,
    appSha256: appSha,
    runnerPath: `LethAL Control RunMutant through RunMutantTransport.run (mutantId "", timeoutMs ${BASELINE_TIMEOUT_DEFAULT}, no stop hook), one method per call; an unanswered call is followed by GetOperationStatus/GetOpAnswer polls every ${POLL_MS} ms until ${FOLLOW_CAP_MS} ms after dispatch`,
    lease: { holder: JSON.parse(holder), releasedAt: null },
    apps: { target: TARGET, tests: TESTS, artifactId: ARTIFACT_ID },
    cases: CASES.map((k) => k.codeunit),
  };
  const ext = await extensionsApi(c);
  const describe = async (a: { id: string; name: string }) => {
    const rs = await rows(c, ext, a.id);
    return rs.length === 0
      ? `${a.name} (${a.id}): absent (0 rows)`
      : `${a.name} (${a.id}): ${rs.map((r) => `${rowVersion(r)} isInstalled=${r.isInstalled}`).join("; ")}`;
  };
  const removal: Record<string, unknown> = {};
  let published = false;
  let code = 0;
  try {
    const build: Record<string, string> = {};
    for (const [n, id] of [
      ["Base Application", BASE_APP],
      ["System Application", SYSTEM_APP],
    ] as const) {
      const rs = await rows(c, ext, id);
      build[n] =
        rs.map((r) => `${rowVersion(r)} isInstalled=${r.isInstalled}`).join("; ") || "absent";
      log(`server build: ${n} ${build[n]}`);
    }
    doc.bcBuild = build;
    const harness = new HarnessVerifier(odata);
    doc.lethalControl = await harness.fetchControlVersion();
    log(`LethAL Control ${doc.lethalControl}`);
    const info = await harness.verify();
    log(`harness verify ok; serverGeneration ${info.serverGeneration}`);

    // Both probe ids must be ABSENT before anything is published.
    for (const a of [TARGET, TESTS]) {
      const rs = await rows(c, ext, a.id);
      log(`before: ${await describe(a)}`);
      if (rs.length > 0) {
        doc.stop = `${a.name} already on ${server} before the probe; nothing removed (not ours)`;
        throw new Error(`STOP: ${doc.stop}`);
      }
    }
    doc.absentBefore = true;

    published = true;
    for (const a of [TARGET, TESTS]) {
      try {
        await publishBytes(c, `LethAL_${a.name}_1.0.0.0.app`, readFileSync(join(BUILD, a.file)));
      } catch (err) {
        doc.stop = `publish ${a.name} refused: ${errText(err)}`;
        throw new Error(`STOP: ${doc.stop}`);
      }
      const rs = await rows(c, ext, a.id);
      log(`published: ${await describe(a)}`);
      if (rs.length !== 1 || rs[0]?.isInstalled !== true) {
        doc.stop = `${a.name} not read back installed`;
        throw new Error(`STOP: ${doc.stop}`);
      }
    }

    const leases = new LeaseClient(odata);
    const got = await leases.acquire(
      "r649-bc-probe (lane bugs)",
      TTL_S,
      crypto.randomUUID(),
      info.serverGeneration,
    );
    if (!got.granted) throw new Error(`control-app lease refused: ${JSON.stringify(got)}`);
    const lease: Lease = got.lease;
    log(`control-app lease epoch ${lease.epoch}, lastCompletedOpSeq ${lease.lastCompletedOpSeq}`);
    // The heartbeat runs for the whole lease, also while a call is open (as the orchestrator's does).
    const beats: string[] = [];
    let beating = true;
    const beat = (async () => {
      while (beating) {
        await Bun.sleep(BEAT_MS);
        if (!beating) break;
        try {
          const r = await leases.renew(lease, TTL_S);
          if (!r.renewed)
            beats.push(`${new Date().toISOString()} renew refused ${JSON.stringify(r)}`);
        } catch (err) {
          beats.push(`${new Date().toISOString()} renew threw ${errText(err)}`);
        }
      }
    })();
    const transport = new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID);
    let opSeq = lease.lastCompletedOpSeq;
    const results: Record<string, unknown>[] = [];
    try {
      for (const k of CASES) {
        opSeq += 1;
        const attemptId = `r649-${k.codeunit}-${opSeq}`;
        const fence = {
          epoch: lease.epoch,
          token: lease.token,
          serverGeneration: lease.serverGeneration,
          opSeq,
        };
        log(`codeunit ${k.codeunit} ${k.method}: dispatch ${attemptId}`);
        const dispatchedAt = Date.now();
        const v = await transport.run({
          ref: { codeunitId: k.codeunit, codeunitName: k.name, method: k.method },
          mutantId: "",
          attemptId,
          timeoutMs: BASELINE_TIMEOUT_DEFAULT,
          lease: fence,
        });
        const wallMs = Date.now() - dispatchedAt;
        const { ref: _ref, coverage: _cov, ...verdict } = v;
        log(
          `  ${k.codeunit}: LethAL ${v.outcome} after ${wallMs} ms (${v.operation ?? "terminal"}) | ${String(split(v.failureMessage).firstLine)}`,
        );
        const row: Record<string, unknown> = {
          codeunit: k.codeunit,
          method: k.method,
          attemptId,
          opSeq,
          dispatchedAt: new Date(dispatchedAt).toISOString(),
          lethal: { wallMs, verdict, ...split(v.failureMessage) },
        };
        results.push(row);
        if (v.operation !== "in-flight-unknown") continue;

        // The call ended without BC's answer: follow the op until BC answers or the cap passes.
        const snapshots: Record<string, unknown>[] = [];
        let last = "";
        let lastOpenAtMs: number | null = null;
        let bc: Record<string, unknown> | undefined;
        while (Date.now() - dispatchedAt < FOLLOW_CAP_MS) {
          await Bun.sleep(POLL_MS);
          const atMs = Date.now() - dispatchedAt;
          let st: OperationStatus;
          try {
            st = await transport.getOperationStatus(lease, attemptId, opSeq, READ_MS);
          } catch (err) {
            snapshots.push({ atMs, statusError: errText(err) });
            continue;
          }
          const { serverNow: _now, ...key } = st;
          if (JSON.stringify(key) !== last) {
            last = JSON.stringify(key);
            snapshots.push({ atMs, ...st });
            log(`  ${k.codeunit}: +${atMs} ms status ${JSON.stringify(st)}`);
          }
          if (!st.completed) {
            lastOpenAtMs = atMs;
            continue;
          }
          const kept = await transport.readKeptAnswer(lease, attemptId, opSeq, READ_MS);
          bc = kept.found
            ? {
                seenCompleteAtMs: atMs,
                lastSeenOpenAtMs: lastOpenAtMs,
                ...bcLine(kept.answer),
                answer: kept.answer,
              }
            : { seenCompleteAtMs: atMs, lastSeenOpenAtMs: lastOpenAtMs, kept };
          break;
        }
        row.followUp = { snapshots, bc: bc ?? `no answer by ${FOLLOW_CAP_MS} ms after dispatch` };
        log(`  ${k.codeunit}: BC ${JSON.stringify(bc ?? "no answer by the cap").slice(0, 600)}`);
        if (bc === undefined) {
          doc.stop = `codeunit ${k.codeunit}'s op had no answer ${FOLLOW_CAP_MS} ms after dispatch; later cases not run`;
          throw new Error(`STOP: ${doc.stop}`);
        }
      }
    } finally {
      beating = false;
      await beat;
      doc.results = results;
      doc.heartbeatProblems = beats;
      const rel = await leases.release(lease).catch((err: unknown) => errText(err));
      log(`control-app lease release: ${JSON.stringify(rel)}`);
    }
  } catch (err) {
    log(`FAILED: ${errText(err)}`);
    doc.error = errText(err);
    code = 1;
  } finally {
    // ALWAYS remove, tests first, then the target (once we may have published).
    if (published) {
      for (const a of [TESTS, TARGET]) {
        const steps: string[] = [];
        try {
          await removeApp(c, ext, a, steps);
          steps.push(`read-back ${await describe(a)}`);
          removal[a.name] = { ok: true, steps };
        } catch (err) {
          steps.push(`FAILED: ${errText(err)}`);
          steps.push(`read-back ${await describe(a).catch(errText)}`);
          removal[a.name] = { ok: false, steps };
          code = 1;
        }
        log(`removal ${a.name}: ${steps.join(" | ")}`);
      }
    } else {
      removal.note = "nothing published; nothing removed";
    }
    doc.removal = removal;
    mkdirSync(join(REPO, "docs", "measurements", "r649"), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    log(`wrote ${OUT}`);
  }
  return code;
}

/** R639's E3: uninstall if installed, then the bound unpublish (each HTTP 204), then 0 rows by id. */
async function removeApp(
  c: Conn,
  ext: string,
  a: { id: string; name: string },
  steps: string[],
): Promise<void> {
  for (const r of await rows(c, ext, a.id)) {
    const key = `${ext}(${r.packageId})`;
    if (r.isInstalled) {
      const u = await apiJson(c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
      steps.push(`uninstall HTTP ${u.status}${u.ok ? "" : ` ${u.text.slice(0, 1000)}`}`);
      if (u.status !== 204) throw new Error(`uninstall ${a.name}: HTTP ${u.status}`);
    }
    const p = await apiJson(c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    steps.push(`unpublish HTTP ${p.status}${p.ok ? "" : ` ${p.text.slice(0, 1000)}`}`);
    if (p.status !== 204) throw new Error(`unpublish ${a.name}: HTTP ${p.status}`);
  }
  if ((await rows(c, ext, a.id)).length > 0)
    throw new Error(`${a.name} still present after removal`);
}

if (import.meta.main) process.exit(await main());
