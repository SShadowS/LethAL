/**
 * R658 probe: for a BASELINE op (`RunMutant`, `mutantId ""`), does LethAL Control's existing
 * `StopHungRun` end the running test session when the client budget runs out, and leave the server
 * clean? Copied from scripts/r649-bc-probe/drive.ts. Pre-commitment: /coord/handoff/R-658/
 * precommitment-draft.md (until committed to master).
 *
 *   bun scripts/r658-bc-probe/drive.ts --server bc3
 *
 * Run from the worktree root, AFTER `kraken coord lease bc3 bugs` (the caller holds the lease and
 * heartbeats it; `/coord/handoff/R-658/run-probe.sh` does both). This script REFUSES (exit 2)
 * unless `--server bc3` and `kraken coord holder bc3` names lane bugs. The login is read
 * in-process from the secret file and never printed. Apps are read by id only (R433).
 *
 * Cases C, L, S: one `RunMutantTransport.run` each, `mutantId ""`, a 20 s budget, the stop hook
 * wired exactly as `BcDevMcpBackend.runViaTransport` wires it for a mutant (`onBudgetExceeded` ->
 * `stopHungRun` with the request's own `attemptId`, lease and `opSeq`; no `stopGraceMs`, so the
 * transport's 30 s default, equal to `STOP_GRACE_MS`). The transport is the real one. The only
 * addition is an observation tap on its fetch (`tapFetch`): it keeps the RunMutant HTTP request
 * open up to `OBSERVE_CAP_MS` after dispatch, records what BC finally sends on it and when, and
 * hands the transport that same answer, or the transport's own abort at the transport's own time.
 * After a stop, the driver waits to dispatch + 70 s (or the tap's answer, if later) and reads the op
 * progress row, which the stop leaves in place, before the release and the next acquire.
 *
 * Case D, last: `Sleep(30000)`, a 10 s budget, NO stop hook, and a pass-through tap, so LethAL's
 * real abort reaches the connection. Status and progress are read at dispatch + 45 s and + 60 s,
 * then our own `StopHungRun` cleans up under the still-held lease.
 *
 * Status, progress and the D cleanup reads go through a SECOND transport (`reader`), so they never
 * enter the R499 drain of the transport that runs the case.
 *
 * STOP rule (pre-committed, owner-approved): BC sent nothing on the held request by the cap; or a
 * refused or thrown stop whose op does not complete within 5 minutes; or a case that throws without
 * BC's answer on the held request; or D's cleanup stop finds the marker stranded; or a later
 * acquire is refused. Then: no further case, no control-app release, no reset, no unpublish; write
 * the evidence and exit 5. The wrapper then KEEPS the coord lease. After `stopped: true` the op is
 * tombstoned, so the control-app lease and `lethal doctor` read bc3 clean: that is not evidence.
 *
 * `--remove-only` runs no case: only the removal and read-back. `--status-only <opAttemptId>` makes
 * one GetOperationStatus read and nothing else.
 *
 * Writes docs/measurements/r658/bc3-probe.json (`lease.releasedAt` null: the caller fills it in) and
 * logs every step to /coord/handoff/R-658/probe/drive.log.
 *
 * Exit: 0 ran and removed; 1 a step failed (apps removed); 2 the guard refused; 5 the STOP rule.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../packages/runner/src/activation";
import type { TestVerdict } from "../../packages/runner/src/backend";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import {
  type AcquireOutcome,
  type Lease,
  LeaseClient,
  type OperationStatus,
} from "../../packages/runner/src/lease";
import { requiresUnsafeLatch } from "../../packages/runner/src/operation-outcome";
import {
  RunMutantTransport,
  isAlStopResponse,
} from "../../packages/runner/src/run-mutant-transport";
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
const EVIDENCE = "/coord/handoff/R-658/probe";
const LOG = join(EVIDENCE, "drive.log");
const OUT_DIR = join(REPO, "docs", "measurements", "r658");

const TARGET = {
  id: "d1d2d26c-a3b4-4a26-804f-903c1f1497f8",
  name: "LethAL R658 BC Baseline Stop Probe",
  file: "target.app",
};
const TESTS = {
  id: "c189159c-3fa4-4909-9c63-b4b65bafc1cd",
  name: "LethAL R658 BC Baseline Stop Probe Tests",
  file: "tests.app",
};
/** Registered by the target's Install codeunit 92940. */
const ARTIFACT_ID = "46f0516107e9ecda24671e5c5ddbabd0";
const BASE_APP = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const SYSTEM_APP = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
/** The transport's default grace (runViaTransport passes none). */
const GRACE_MS = 30_000;
/** How long the tap keeps the held request open; under the ~362 s proxy ceiling (R44). */
const OBSERVE_CAP_MS = 240_000;
/** After a stop: read the progress row no earlier than dispatch + 70 s (the 60 s tests' end + 10 s). */
const SETTLE_MS = 70_000;
/** Case D's two reads, after dispatch. */
const D_READS_MS = [45_000, 60_000] as const;
/** The control-app lease: the 15 s maximum, renewed every 5 s (the orchestrator's ttl/3). */
const TTL_S = 15;
const BEAT_MS = 5_000;
/** Status polls every 5 s; a refused or thrown stop whose op is not completed in 5 min is a STOP. */
const POLL_MS = 5_000;
const STOP_RULE_MS = 300_000;
const READ_MS = 15_000;

interface Case {
  readonly role: "C" | "L" | "S" | "D";
  readonly codeunit: number;
  readonly name: string;
  readonly method: string;
  readonly budgetMs: number;
  /** false only for D: no stop hook, and the tap passes the transport's abort through. */
  readonly stopHook: boolean;
}
const CASES: readonly Case[] = [
  {
    role: "C",
    codeunit: 92950,
    name: "R658 Control Sleep 100",
    method: "Sleep100",
    budgetMs: 20_000,
    stopHook: true,
  },
  {
    role: "L",
    codeunit: 92952,
    name: "R658 Busy Loop 60s",
    method: "BusyLoop60s",
    budgetMs: 20_000,
    stopHook: true,
  },
  {
    role: "S",
    codeunit: 92951,
    name: "R658 Sleep 60000",
    method: "Sleep60000",
    budgetMs: 20_000,
    stopHook: true,
  },
  {
    role: "D",
    codeunit: 92953,
    name: "R658 Sleep 30000 Abandoned",
    method: "Sleep30000",
    budgetMs: 10_000,
    stopHook: false,
  },
];

mkdirSync(EVIDENCE, { recursive: true });
const log = (s: string) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

class RemoveOnly extends Error {}
/** The pre-committed STOP rule: the session may still be live, so nothing more is done on bc3. */
class StopRule extends Error {}

/** Set just before the first RunMutant: from then on a crash may leave a live session (exit 5). */
let mayBeLive = false;
/** Set the moment any StopRule is seen; removal checks it as well as the exit code. */
let stopSeen = false;

/** C2: BC answered the held request only with a 200 or its AL-stop 408; a gateway 5xx or a bare 408 is not an answer. */
function bcAnswered(t: Tap | undefined): boolean {
  return t?.status !== undefined && (t.status === 200 || isAlStopResponse(t.status, t.body ?? ""));
}

const STOP_BANNER =
  "STOP RULE. No further case, no control-app release, no reset, no unpublish. If StopHungRun answered stopped:true, " +
  "the op is tombstoned: the control-app lease and `lethal doctor` will read bc3 CLEAN, and that must NOT be trusted " +
  "(the session may still run). KEEP the coord lease on bc3 (the wrapper holds it) until the owner's restart and a clean re-setup; " +
  "tell the orchestrator, which marks bc3 out of use.";

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

/** What BC sent on the held RunMutant request, as the tap saw it. */
interface Tap {
  sentAt: number;
  passThrough: boolean;
  status?: number;
  body?: string;
  error?: string;
  atMs?: number;
  done?: Promise<void>;
}

/**
 * The transport's fetch, with one observation added for RunMutant only. Normally the real request
 * runs on the tap's own signal (aborted at `OBSERVE_CAP_MS`), and the transport gets either BC's
 * answer or a rejection at the moment ITS signal aborts. With `sink.passThrough` (case D) the
 * transport's own signal reaches the connection, and the tap only records the status or the error.
 * Every other action passes straight through.
 * ponytail: the body is read in full before the transport sees the headers; BC's OData action sends
 * headers and body together, so the transport's after-headers abort path (R191) is not exercised.
 */
export function tapFetch(sink: { tap?: Tap | undefined; passThrough?: boolean }): FetchFn {
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!String(url).includes("/LethALControl_RunMutant?")) return bcFetch(url, init);
    const t: Tap = { sentAt: Date.now(), passThrough: sink.passThrough === true };
    sink.tap = t;
    if (t.passThrough) {
      const p = bcFetch(url, init).then(
        (res) => {
          Object.assign(t, { status: res.status, atMs: Date.now() - t.sentAt });
          return res;
        },
        (err: unknown) => {
          Object.assign(t, { error: errText(err), atMs: Date.now() - t.sentAt });
          throw err;
        },
      );
      t.done = p.then(
        () => {},
        () => {},
      );
      return p;
    }
    const own = new AbortController();
    const cap = setTimeout(() => own.abort(), OBSERVE_CAP_MS);
    const raw = (async () => {
      try {
        const res = await bcFetch(url, { ...init, signal: own.signal });
        const body = await res.text();
        Object.assign(t, { status: res.status, body, atMs: Date.now() - t.sentAt });
        return new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } catch (err) {
        Object.assign(t, { error: errText(err), atMs: Date.now() - t.sentAt });
        throw err;
      } finally {
        clearTimeout(cap);
      }
    })();
    t.done = raw.then(
      () => {},
      () => {},
    );
    const signal = init?.signal;
    if (signal === undefined || signal === null) return raw;
    const aborted = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    return Promise.race([raw, aborted]);
  };
  return Object.assign(f, { preconnect: bcFetch.preconnect }) as FetchFn;
}

/** One status read, with the progress row's state flattened out (the decision table reads it). */
async function readStatus(
  reader: RunMutantTransport,
  lease: Lease,
  attemptId: string,
  opSeq: number,
  sinceMs: number,
): Promise<Record<string, unknown>> {
  try {
    const st = await reader.getOperationStatus(lease, attemptId, opSeq, READ_MS);
    return {
      atMs: Date.now() - sinceMs,
      opKind: st.opKind,
      opAttemptId: st.opAttemptId,
      completed: st.completed,
      progressState: st.opProgress?.state ?? null,
      lastCompletedIndex: st.opProgress?.lastCompletedIndex ?? null,
      status: st,
    };
  } catch (err) {
    return { atMs: Date.now() - sinceMs, statusError: errText(err) };
  }
}

/** Polls GetOperationStatus every 5 s from `from` until `completed` or 5 minutes. */
async function pollStatus(
  reader: RunMutantTransport,
  lease: Lease,
  attemptId: string,
  opSeq: number,
  from: number,
): Promise<{ completed: boolean; completedAfterMs?: number; snapshots: unknown[] }> {
  const snapshots: unknown[] = [];
  let last = "";
  while (Date.now() - from < STOP_RULE_MS) {
    await Bun.sleep(POLL_MS);
    const atMs = Date.now() - from;
    let st: OperationStatus;
    try {
      st = await reader.getOperationStatus(lease, attemptId, opSeq, READ_MS);
    } catch (err) {
      snapshots.push({ atMs, statusError: errText(err) });
      continue;
    }
    const { serverNow: _now, ...key } = st;
    if (JSON.stringify(key) !== last) {
      last = JSON.stringify(key);
      snapshots.push({ atMs, ...st });
      log(`    +${atMs} ms after the stop/call: status ${JSON.stringify(st)}`);
    }
    if (st.completed) return { completed: true, completedAfterMs: atMs, snapshots };
  }
  return { completed: false, snapshots };
}

/** What the orchestrator's baseline loop does with this verdict today (R658 code map, steps 1-4). */
function baselineReading(v: TestVerdict): string {
  if (v.operation !== undefined && requiresUnsafeLatch(v.operation))
    return `quarantine: baseline test ${v.operation}, durable tier quarantine, baseline stops`;
  if (v.outcome === "pass") return "green";
  if (v.outcome === "fail" || v.outcome === "error")
    return `not green: did not pass at baseline (${v.outcome})`;
  return `not green: ${v.outcome}, not a quarantine and not a did-not-pass-at-baseline outcome`;
}

function acquireReading(got: AcquireOutcome): Record<string, unknown> {
  return got.granted
    ? { granted: true, epoch: got.lease.epoch, lastCompletedOpSeq: got.lease.lastCompletedOpSeq }
    : { ...got };
}

/** M3: a release that throws is retried once after the TTL has run out; never a STOP by itself. */
async function releaseOnce(leases: LeaseClient, lease: Lease): Promise<unknown> {
  try {
    return await leases.release(lease);
  } catch (err) {
    const firstError = errText(err);
    log(`  release threw (${firstError}); waiting out the ${TTL_S} s TTL, then one retry`);
    await Bun.sleep(TTL_S * 1000 + 2000);
    try {
      return { firstError, retry: await leases.release(lease) };
    } catch (e2) {
      return { firstError, retryError: errText(e2) };
    }
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
  const login = readSecretFile();
  const odata = {
    baseUrl: `${HOST}:${SERVERS[server].odata}/BC`,
    apiBaseUrl: `${HOST}:${SERVERS[server].api}/BC`,
    company: COMPANY,
    username: login.user,
    password: login.password,
    tenant: "default",
  };
  // --status-only <opAttemptId>: ONE GetOperationStatus read (the op seq is the id's last "-" part).
  // No run, release, stop, publish, unpublish or reset. The read does not gate on the lease.
  const so = process.argv.indexOf("--status-only");
  if (so >= 0) {
    const attemptId = process.argv[so + 1] ?? "";
    if (!/^r658-\d+-\d+$/.test(attemptId)) {
      console.error(`REFUSED: --status-only needs an id like r658-92951-1234 (got ${attemptId})`);
      return 2;
    }
    const opSeq = Number(attemptId.split("-").pop());
    const info = await new HarnessVerifier(odata).verify();
    const st = await new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID).getOperationStatus(
      { epoch: 0, token: "", serverGeneration: info.serverGeneration },
      attemptId,
      opSeq,
      READ_MS,
    );
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        serverGeneration: info.serverGeneration,
        status: st,
      }),
    );
    return 0;
  }
  const BUILD = join(import.meta.dir, "build", server);
  const removeOnly = process.argv.includes("--remove-only");
  const OUT = removeOnly
    ? join(EVIDENCE, `${server}-remove-only-${Date.now()}.json`)
    : join(OUT_DIR, `${server}-probe.json`);
  log(`lease guard: ${holder}`);
  const harnessCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain", "--", "scripts/r658-bc-probe"]) !== "")
    throw new Error("the probe sources are not committed; commit them first");
  const probeSourceSha = git(["rev-parse", "HEAD:scripts/r658-bc-probe"]);
  const appSha: Record<string, string> = {};
  for (const a of [TARGET, TESTS])
    appSha[a.file] = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(BUILD, a.file)))
      .digest("hex");
  log(`harness ${harnessCommit}, probe tree ${probeSourceSha}, apps ${JSON.stringify(appSha)}`);

  const c: Conn = {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  };
  const doc: Record<string, unknown> = {
    server,
    date: new Date().toISOString().slice(0, 10),
    harness: `scripts/r658-bc-probe/drive.ts@${harnessCommit}`,
    probeSourceSha,
    appSha256: appSha,
    runnerPath: `LethAL Control RunMutant through RunMutantTransport.run (mutantId ""). C, L, S: timeoutMs 20000, onBudgetExceeded -> stopHungRun as runViaTransport builds it, stopGraceMs unset = ${GRACE_MS}, fetch tapped to hold the RunMutant request to ${OBSERVE_CAP_MS} ms, progress read at dispatch + ${SETTLE_MS} ms after a stop. D: timeoutMs 10000, no stop hook, pass-through tap, reads at + ${D_READS_MS.join(" and + ")} ms, then a cleanup StopHungRun. Status reads on a second transport, polled every ${POLL_MS} ms`,
    lease: { holder: JSON.parse(holder), releasedAt: null },
    apps: { target: TARGET, tests: TESTS, artifactId: ARTIFACT_ID },
    cases: CASES.map((k) => `${k.role} ${k.codeunit}`),
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
    if (removeOnly) {
      published = true;
      throw new RemoveOnly();
    }
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
    const sink: { tap?: Tap | undefined; passThrough?: boolean } = {};
    // Read through a function: the fetch tap sets `sink.tap` in a callback TS cannot follow.
    const tapNow = (): Tap | undefined => sink.tap;
    const transport = new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID, tapFetch(sink));
    // M4: every status read goes through this second transport, outside the run transport's drain.
    const reader = new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID);
    const results: Record<string, unknown>[] = [];
    doc.results = results;
    let prev: Record<string, unknown> | undefined;
    const acquire = async (owner: string) => {
      const got = await leases.acquire(owner, TTL_S, crypto.randomUUID(), info.serverGeneration);
      log(`acquire (${owner}): ${JSON.stringify(acquireReading(got))}`);
      if (prev !== undefined) prev.nextAcquire = acquireReading(got);
      if (!got.granted) {
        const why = `control-app lease refused after ${prev === undefined ? "no case" : String(prev.role)}: ${JSON.stringify(got)}`;
        doc.stop = why;
        // Before any case ran, a refusal is a plain failure; after one, the op may be live.
        throw prev === undefined ? new Error(why) : new StopRule(why);
      }
      return got.lease;
    };

    for (const k of CASES) {
      const lease = await acquire(`r658-bc-probe ${k.role} (lane bugs)`);
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
      const opSeq = lease.lastCompletedOpSeq + 1;
      const attemptId = `r658-${k.codeunit}-${opSeq}`;
      const fence = {
        epoch: lease.epoch,
        token: lease.token,
        serverGeneration: lease.serverGeneration,
        opSeq,
      };
      const row: Record<string, unknown> = {
        role: k.role,
        codeunit: k.codeunit,
        method: k.method,
        attemptId,
        opSeq,
        budgetMs: k.budgetMs,
        heartbeatProblems: beats,
      };
      results.push(row);
      prev = row;
      const stop: Record<string, unknown> = { fired: false, wired: k.stopHook };
      row.stop = stop;
      let poll: ReturnType<typeof pollStatus> | undefined;
      let stopRule = false;
      const dispatchedAt = Date.now();
      try {
        log(`${k.role} ${k.codeunit} ${k.method}: dispatch ${attemptId}`);
        row.dispatchedAt = new Date(dispatchedAt).toISOString();
        let v: TestVerdict;
        sink.tap = undefined;
        sink.passThrough = !k.stopHook;
        mayBeLive = true;
        try {
          v = await transport.run({
            ref: { codeunitId: k.codeunit, codeunitName: k.name, method: k.method },
            mutantId: "",
            attemptId,
            timeoutMs: k.budgetMs,
            lease: fence,
            // As runViaTransport builds it for a mutant run. D has none, as a baseline has today.
            ...(k.stopHook
              ? {
                  onBudgetExceeded: async (boundMs: number) => {
                    const at = Date.now();
                    Object.assign(stop, { fired: true, firedAtMs: at - dispatchedAt, boundMs });
                    poll = pollStatus(reader, lease, attemptId, opSeq, at);
                    log(
                      `  ${k.role}: budget exceeded at +${at - dispatchedAt} ms, StopHungRun sent`,
                    );
                    try {
                      const a = await transport.stopHungRun({
                        attemptId,
                        lease: fence,
                        timeoutMs: boundMs,
                      });
                      Object.assign(stop, { result: a, answeredAtMs: Date.now() - dispatchedAt });
                      log(`  ${k.role}: StopHungRun ${JSON.stringify(a)}`);
                      return a;
                    } catch (err) {
                      Object.assign(stop, {
                        error: errText(err),
                        answeredAtMs: Date.now() - dispatchedAt,
                      });
                      log(`  ${k.role}: StopHungRun threw ${errText(err)}`);
                      throw err;
                    }
                  },
                }
              : {}),
          });
        } finally {
          await tapNow()?.done;
        }
        const wallMs = Date.now() - dispatchedAt;
        const { ref: _ref, coverage: _cov, ...verdict } = v;
        row.lethal = { wallMs, verdict, baselineReading: baselineReading(v) };
        log(
          `  ${k.role}: LethAL ${v.outcome} after ${wallMs} ms (${v.operation ?? "terminal"}) -> ${baselineReading(v)}`,
        );
        const t = tapNow();
        row.held =
          t === undefined
            ? "no RunMutant request seen"
            : {
                passThrough: t.passThrough,
                status: t.status ?? null,
                atMs: t.atMs ?? null,
                withinBudgetPlusGrace: t.atMs !== undefined && t.atMs <= k.budgetMs + GRACE_MS,
                alStop408: t.status !== undefined && isAlStopResponse(t.status, t.body ?? ""),
                body: (t.body ?? "").slice(0, 2000),
                ...(t.error !== undefined ? { error: t.error } : {}),
              };
        log(`  ${k.role}: held request ${JSON.stringify(row.held).slice(0, 600)}`);

        if (k.role === "D") {
          // D: LethAL abandoned the request at its budget. Is the op still running?
          const reads: Record<string, unknown>[] = [];
          for (const ms of D_READS_MS) {
            await Bun.sleep(Math.max(0, dispatchedAt + ms - Date.now()));
            const r = await readStatus(reader, lease, attemptId, opSeq, dispatchedAt);
            reads.push(r);
            log(`  D: +${ms} ms ${JSON.stringify(r).slice(0, 600)}`);
          }
          row.dReads = reads;
          const cleanup: Record<string, unknown> = { sentAtMs: Date.now() - dispatchedAt };
          try {
            cleanup.result = await transport.stopHungRun({
              attemptId,
              lease: fence,
              timeoutMs: GRACE_MS,
            });
          } catch (err) {
            cleanup.error = errText(err);
          }
          row.cleanupStop = cleanup;
          log(`  D: cleanup StopHungRun ${JSON.stringify(cleanup)}`);
          row.statusAfterCleanup = await readStatus(reader, lease, attemptId, opSeq, dispatchedAt);
          const stopped = (cleanup.result as { stopped?: boolean } | undefined)?.stopped === true;
          const last = reads.at(-1);
          if (stopped || last?.completed !== true) {
            stopRule = true;
            throw new StopRule(
              `D: op ${attemptId} ${stopped ? "was still marked running: the cleanup stop tombstoned a stranded marker" : "not completed at + 60 s"}; the session may still run`,
            );
          }
          row.status = { completed: true, from: "D's own phase 3 (completed at + 60 s, no stop)" };
        } else {
          const confirmed = (stop.result as { stopped?: boolean } | undefined)?.stopped === true;
          if (stop.fired) {
            // I1: the stop leaves the progress row; read it once the 60 s tests would have ended.
            await Bun.sleep(Math.max(0, dispatchedAt + SETTLE_MS - Date.now()));
            row.progressAfterSettle = await readStatus(
              reader,
              lease,
              attemptId,
              opSeq,
              dispatchedAt,
            );
            log(
              `  ${k.role}: settle read ${JSON.stringify(row.progressAfterSettle).slice(0, 600)}`,
            );
            if (!confirmed) row.void = "the stop was refused or threw: this case is void (row 0)";
          }
          // After a confirmed stop the op is tombstoned, so this poll cannot be a STOP trigger; it
          // still is one for no stop (C) and for a refused or thrown stop.
          const st = await (poll ?? pollStatus(reader, lease, attemptId, opSeq, Date.now()));
          row.status = st;
          if (!st.completed) {
            stopRule = true;
            throw new StopRule(
              `${k.role}: op ${attemptId} not completed ${STOP_RULE_MS} ms after the ${stop.fired ? "refused or thrown stop" : "call"}`,
            );
          }
          // THE live trigger after a confirmed stop: nothing proves the session ended without BC's answer.
          if (!bcAnswered(t)) {
            stopRule = true;
            throw new StopRule(
              `${k.role}: BC did not answer the held request with a 200 or its AL-stop 408 by ${OBSERVE_CAP_MS} ms (status ${String(t?.status ?? "none")}); the session may still run`,
            );
          }
        }
      } catch (err) {
        // C2: never release, unpublish or run on unless BC answered the held request (D: unless its
        // own phase 3 completed), and the op reads completed.
        if (!(err instanceof StopRule)) {
          const settled =
            k.role === "D"
              ? (row.status as { completed?: boolean } | undefined)?.completed === true
              : bcAnswered(tapNow()) &&
                (row.status as { completed?: boolean } | undefined)?.completed === true;
          if (!settled) {
            stopRule = true;
            throw new StopRule(
              `${k.role}: ${errText(err)}; and BC's answer on the held request or the op's completion is not in hand`,
            );
          }
        }
        if (err instanceof StopRule) {
          stopRule = true;
          stopSeen = true;
        }
        throw err;
      } finally {
        beating = false;
        await beat;
        if (!stopRule) {
          row.release = await releaseOnce(leases, lease);
          row.statusAfterRelease = await readStatus(reader, lease, attemptId, opSeq, dispatchedAt);
          log(
            `  ${k.role}: release ${JSON.stringify(row.release)}, then ${JSON.stringify(row.statusAfterRelease).slice(0, 400)}`,
          );
        }
      }
      if (k.role === "C" && (row.lethal as { verdict: TestVerdict }).verdict.outcome !== "pass") {
        doc.stop = "the control case C did not pass; L, S and D not run";
        throw new Error(`STOP: ${doc.stop}`);
      }
    }
    // The read after the last case: does a fresh acquire see a clean lease?
    const read = await acquire("r658-bc-probe read (lane bugs)");
    doc.finalRelease = await releaseOnce(leases, read);
  } catch (err) {
    if (err instanceof RemoveOnly) {
      log("remove-only: no case run");
      doc.removeOnly = true;
    } else if (err instanceof StopRule) {
      code = 5;
      stopSeen = true;
      doc.stopRule = err.message;
      log(`${STOP_BANNER} Trigger: ${err.message}`);
    } else {
      log(`FAILED: ${errText(err)}`);
      doc.error = errText(err);
      code = 1;
    }
  } finally {
    // Remove, tests first, then the target, once we may have published; never after the STOP rule.
    if (code === 5 || stopSeen) {
      code = 5;
      removal.note = "STOP rule fired: nothing removed, the session may still be live";
    } else if (published) {
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
    // A failed evidence write must not change the exit code or the removal decision above.
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
      log(`wrote ${OUT}`);
    } catch (err) {
      console.error(`evidence write FAILED: ${errText(err)}`);
    }
    if (code === 5) console.error(STOP_BANNER);
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

if (import.meta.main) {
  // A crash once a RunMutant was sent may leave a live session: exit 5, so the wrapper holds bc3.
  const crash = (err: unknown) => {
    console.error(`driver crashed: ${errText(err)}${mayBeLive ? `. ${STOP_BANNER}` : ""}`);
    process.exit(mayBeLive ? 5 : 1);
  };
  process.on("unhandledRejection", crash);
  process.on("uncaughtException", crash);
  process.exit(
    await main().catch((err: unknown) => {
      console.error(`driver failed: ${errText(err)}`);
      return mayBeLive ? 5 : 1;
    }),
  );
}
