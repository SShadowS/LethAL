/**
 * R826B probe (GitHub #49): on bc4 (BC 29), what does BC answer on the held RunMutant request when
 * LethAL Control's StopHungRun ends a hung baseline test? Shape copied from scripts/r658-bc-probe/drive.ts.
 *
 *   bun scripts/r826b-bc4-probe/drive.ts build            compile the two scratch apps (reads symbols from bc4)
 *   bun scripts/r826b-bc4-probe/drive.ts publish          publish target, then tests (dev endpoint)
 *   bun scripts/r826b-bc4-probe/drive.ts run N1,E1,B1...  run the named cases, merge into bc4-probe.json
 *   bun scripts/r826b-bc4-probe/drive.ts remove           unpublish tests first, then target
 *
 * Run from the worktree root while lane `code` holds the coord lease on bc4 (`kraken coord holder bc4`);
 * every mode REFUSES (exit 2) otherwise. The wrapper (lease.sh) holds and heartbeats that lease; this
 * script never sees the token. The login is read in-process and never printed. Apps are read by id only (R433).
 *
 * Cases: N1,N2 normal run (Sleep 100 ms). E1,E2 natural end: a 25 s busy loop, 90 s budget, no stop
 * fires. B1,B2 busy loop; S1,S2 Sleep in a loop; D1,D2 database reads and writes: each hangs 120 s on
 * BC's own clock, 20 s budget, then the stop. After a hang: status reads, release, acquire, a Reader test
 * (are the ticks still moving, does the session id still exist), release, acquire, a clean test, release.
 *
 * Exit: 0 ok; 1 a step failed before any RunMutant was sent; 2 guard refused; 5 anything went wrong after
 * a RunMutant was sent (the session may be live: keep the lease, report, change nothing).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../packages/runner/src/activation";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import {
  type AcquireOutcome,
  type Lease,
  LeaseClient,
  type OperationStatus,
} from "../../packages/runner/src/lease";
import { defaultAlToolPaths } from "../../packages/runner/src/publisher";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import {
  COMPANY,
  type Conn,
  HOST,
  SERVERS,
  apiJson,
  extensionsApi,
  publishBytes,
  residentPackage,
  rowVersion,
  rows,
} from "../bc-app-content.ts";
import {
  CONTROL_APP,
  alcCompile,
  errText,
  readSecretFile,
} from "../bc-linux-setup.ts";

const SERVER = "bc4" as const;
const LANE = "code";
const REPO = join(import.meta.dir, "..", "..");
const HERE = import.meta.dir;
const BUILD = join(HERE, "build");
const EVIDENCE = "/coord/handoff/R-826b/probe";
const LOG = join(EVIDENCE, "drive.log");
const OUT = join(EVIDENCE, "bc4-probe.json");

const TARGET = {
  id: "12b7a3d5-ccbf-4000-b053-c955967ca57d",
  name: "LethAL R826B BC4 Stop Probe",
  file: "target.app",
  dir: "target",
};
const TESTS = {
  id: "9f1de814-0b0b-4be0-a52c-bf3236255c89",
  name: "LethAL R826B BC4 Stop Probe Tests",
  file: "tests.app",
  dir: "tests",
};
const ARTIFACT_ID = "3e69467842d34de0a63e6514564ddc57";
const CLEAN = { codeunit: 91510, name: "R826B Control Sleep 100", method: "Sleep100" };
const READER = { codeunit: 91514, name: "R826B Reader" };

const OBSERVE_CAP_MS = 240_000;
const TTL_S = 15;
const BEAT_MS = 5_000;
const POLL_MS = 5_000;
const STOP_RULE_MS = 300_000;
const READ_MS = 15_000;
const GRACE_MS = 30_000;

interface Case {
  readonly label: string;
  readonly kind: "normal" | "natural" | "hang";
  readonly shape: string;
  readonly codeunit: number;
  readonly name: string;
  readonly method: string;
  readonly reader?: string;
  readonly budgetMs: number;
}
const CASES: readonly Case[] = [
  ...[1, 2].map((n) => ({
    label: `N${n}`,
    kind: "normal" as const,
    shape: "normal",
    ...CLEAN,
    budgetMs: 20_000,
  })),
  ...[1, 2].map((n) => ({
    label: `E${n}`,
    kind: "natural" as const,
    shape: "busy loop, ends by itself at 25 s, no stop",
    codeunit: 91515,
    name: "R826B Busy 25s",
    method: "Busy25s",
    budgetMs: 90_000,
  })),
  ...[1, 2].map((n) => ({
    label: `B${n}`,
    kind: "hang" as const,
    shape: "busy loop",
    codeunit: 91511,
    name: "R826B Busy Loop",
    method: "BusyLoop",
    reader: "ReadB",
    budgetMs: 20_000,
  })),
  ...[1, 2].map((n) => ({
    label: `S${n}`,
    kind: "hang" as const,
    shape: "Sleep in a loop",
    codeunit: 91512,
    name: "R826B Sleep Loop",
    method: "SleepLoop",
    reader: "ReadS",
    budgetMs: 20_000,
  })),
  ...[1, 2].map((n) => ({
    label: `D${n}`,
    kind: "hang" as const,
    shape: "database reads and writes in a loop",
    codeunit: 91513,
    name: "R826B DB Loop",
    method: "DbLoop",
    reader: "ReadD",
    budgetMs: 20_000,
  })),
];

mkdirSync(EVIDENCE, { recursive: true });
const log = (s: string) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

let mayBeLive = false;
class StopRule extends Error {}

function holderIsCode(): string {
  const p = Bun.spawnSync(["kraken", "coord", "holder", SERVER]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder ${SERVER} exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== LANE) throw new Error(`${SERVER} is not held by lane ${LANE}: ${out}`);
  return out;
}

interface Tap {
  sentAt: number;
  status?: number;
  body?: string;
  error?: string;
  atMs?: number;
  done?: Promise<void>;
}

/** Holds the RunMutant request open up to OBSERVE_CAP_MS and records what BC sends on it, and when. */
function tapFetch(sink: { tap?: Tap | undefined }): FetchFn {
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!String(url).includes("/LethALControl_RunMutant?")) return bcFetch(url, init);
    const t: Tap = { sentAt: Date.now() };
    sink.tap = t;
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

function connFor(): { c: Conn; odata: ConstructorParameters<typeof HarnessVerifier>[0] } {
  const login = readSecretFile();
  return {
    c: {
      server: SERVER,
      authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
    },
    odata: {
      baseUrl: `${HOST}:${SERVERS[SERVER].odata}/BC`,
      apiBaseUrl: `${HOST}:${SERVERS[SERVER].api}/BC`,
      company: COMPANY,
      username: login.user,
      password: login.password,
      tenant: "default",
    },
  };
}

async function describe(c: Conn, ext: string, a: { id: string; name: string }): Promise<string> {
  const rs = await rows(c, ext, a.id);
  return rs.length === 0
    ? `${a.name} (${a.id}): absent`
    : `${a.name} (${a.id}): ${rs.map((r) => `${rowVersion(r)} isInstalled=${r.isInstalled}`).join("; ")}`;
}

// ---------------------------------------------------------------------------------------------
async function build(): Promise<number> {
  const { c } = connFor();
  const tools = await defaultAlToolPaths();
  if (tools === undefined) throw new Error("no alc found");
  const sym = join(BUILD, "symbols");
  mkdirSync(sym, { recursive: true });
  for (const name of ["System", "Base Application", "System Application", "Business Foundation"]) {
    const pkg = await residentPackage(c, "Microsoft", name);
    log(`symbols: Microsoft ${name}: ${pkg === null ? "not on bc4" : `${pkg.length} bytes`}`);
    if (pkg !== null) writeFileSync(join(sym, `Microsoft_${name}.app`), pkg);
  }
  writeFileSync(join(sym, "LethAL_LethAL Control.app"), readFileSync(CONTROL_APP));
  await alcCompile(tools.alcPath, join(HERE, TARGET.dir), sym, join(BUILD, TARGET.file));
  writeFileSync(join(sym, "LethAL_LethAL R826B BC4 Stop Probe.app"), readFileSync(join(BUILD, TARGET.file)));
  await alcCompile(tools.alcPath, join(HERE, TESTS.dir), sym, join(BUILD, TESTS.file));
  for (const a of [TARGET, TESTS]) {
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(join(BUILD, a.file))).digest("hex");
    log(`built ${a.file} sha256 ${sha}`);
  }
  return 0;
}

async function publish(): Promise<number> {
  const { c, odata } = connFor();
  const ext = await extensionsApi(c);
  for (const a of [TARGET, TESTS]) {
    log(`before: ${await describe(c, ext, a)}`);
    if ((await rows(c, ext, a.id)).length > 0) throw new Error(`${a.name} already on bc4`);
  }
  const harness = new HarnessVerifier(odata);
  log(`LethAL Control ${await harness.fetchControlVersion()}`);
  for (const a of [TARGET, TESTS]) {
    await publishBytes(c, `LethAL_${a.name}_1.0.0.0.app`, readFileSync(join(BUILD, a.file)));
    const rs = await rows(c, ext, a.id);
    log(`published: ${await describe(c, ext, a)}`);
    if (rs.length !== 1 || rs[0]?.isInstalled !== true) throw new Error(`${a.name} not installed`);
  }
  return 0;
}

async function removeApp(c: Conn, ext: string, a: { id: string; name: string }): Promise<void> {
  for (const r of await rows(c, ext, a.id)) {
    const key = `${ext}(${r.packageId})`;
    if (r.isInstalled) {
      const u = await apiJson(c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
      log(`uninstall ${a.name}: HTTP ${u.status}${u.ok ? "" : ` ${u.text.slice(0, 500)}`}`);
      if (u.status !== 204) throw new Error(`uninstall ${a.name}: HTTP ${u.status}`);
    }
    const p = await apiJson(c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    log(`unpublish ${a.name}: HTTP ${p.status}${p.ok ? "" : ` ${p.text.slice(0, 500)}`}`);
    if (p.status !== 204) throw new Error(`unpublish ${a.name}: HTTP ${p.status}`);
  }
  if ((await rows(c, ext, a.id)).length > 0) throw new Error(`${a.name} still present`);
}

async function remove(): Promise<number> {
  const { c } = connFor();
  const ext = await extensionsApi(c);
  for (const a of [TESTS, TARGET]) {
    await removeApp(c, ext, a);
    log(`read-back ${await describe(c, ext, a)}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
const acquireReading = (got: AcquireOutcome): Record<string, unknown> =>
  got.granted
    ? { granted: true, epoch: got.lease.epoch, lastCompletedOpSeq: got.lease.lastCompletedOpSeq }
    : { ...got };

/** Pulls the test's own "MEASURED ..." text out of a RunMutant answer body, whatever its escaping. */
const measuredText = (body: string | undefined): string | null =>
  body?.match(/MEASURED[^"\\]*/)?.[0] ?? null;

async function runCases(labels: string[]): Promise<number> {
  const { c, odata } = connFor();
  const ext = await extensionsApi(c);
  for (const a of [TARGET, TESTS]) {
    const d = await describe(c, ext, a);
    log(`before: ${d}`);
    if (d.endsWith("absent")) throw new Error(`${a.name} is not published`);
  }
  const harness = new HarnessVerifier(odata);
  const control = await harness.fetchControlVersion();
  const info = await harness.verify();
  log(`LethAL Control ${control}; harness verify ok; serverGeneration ${info.serverGeneration}`);

  const leases = new LeaseClient(odata);
  const sink: { tap?: Tap | undefined } = {};
  const tapNow = (): Tap | undefined => sink.tap;
  const transport = new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID, tapFetch(sink));
  const reader = new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID);

  const doc: { startedAt: string; control: string; rows: Record<string, Record<string, unknown>> } =
    existsSync(OUT)
      ? JSON.parse(readFileSync(OUT, "utf8"))
      : { startedAt: new Date().toISOString(), control, rows: {} };

  const readStatus = async (lease: Lease, attemptId: string, opSeq: number, since: number) => {
    try {
      const st = await reader.getOperationStatus(lease, attemptId, opSeq, READ_MS);
      return {
        sinceMs: Date.now() - since,
        completed: st.completed,
        opKind: st.opKind,
        progressState: st.opProgress?.state ?? null,
        lastCompletedIndex: st.opProgress?.lastCompletedIndex ?? null,
        startedAt: st.opProgress?.startedAt ?? null,
        serverNow: st.serverNow ?? null,
      };
    } catch (err) {
      return { sinceMs: Date.now() - since, statusError: errText(err) };
    }
  };

  const pollStatus = async (lease: Lease, attemptId: string, opSeq: number, from: number) => {
    const snaps: unknown[] = [];
    let last = "";
    while (Date.now() - from < STOP_RULE_MS) {
      await Bun.sleep(POLL_MS);
      let st: OperationStatus;
      try {
        st = await reader.getOperationStatus(lease, attemptId, opSeq, READ_MS);
      } catch (err) {
        snaps.push({ sinceStopMs: Date.now() - from, statusError: errText(err) });
        continue;
      }
      const flat = {
        sinceStopMs: Date.now() - from,
        completed: st.completed,
        progressState: st.opProgress?.state ?? null,
        lastCompletedIndex: st.opProgress?.lastCompletedIndex ?? null,
        startedAt: st.opProgress?.startedAt ?? null,
        serverNow: st.serverNow ?? null,
      };
      const key = JSON.stringify({ ...flat, sinceStopMs: 0, serverNow: 0 });
      if (key !== last) {
        last = key;
        snaps.push(flat);
        log(`    +${flat.sinceStopMs} ms after stop: ${JSON.stringify(flat)}`);
      }
      if (st.completed) return { completed: true, snaps };
    }
    return { completed: false, snaps };
  };

  /** One control-app lease: acquire, heartbeat, run fn, release. Records acquire and release readings. */
  const withLease = async <T>(
    owner: string,
    fn: (lease: Lease) => Promise<T>,
    rec: Record<string, unknown>,
    key: string,
  ): Promise<T> => {
    const got = await leases.acquire(owner, TTL_S, crypto.randomUUID(), info.serverGeneration);
    rec[`${key}Acquire`] = acquireReading(got);
    log(`acquire (${owner}): ${JSON.stringify(acquireReading(got))}`);
    if (!got.granted) throw new StopRule(`acquire refused for ${owner}: ${JSON.stringify(got)}`);
    const lease = got.lease;
    let beating = true;
    const beats: string[] = [];
    const beat = (async () => {
      while (beating) {
        await Bun.sleep(BEAT_MS);
        if (!beating) break;
        try {
          const r = await leases.renew(lease, TTL_S);
          if (!r.renewed) beats.push(`renew refused ${JSON.stringify(r)}`);
        } catch (err) {
          beats.push(`renew threw ${errText(err)}`);
        }
      }
    })();
    try {
      return await fn(lease);
    } finally {
      beating = false;
      await beat;
      if (beats.length > 0) rec[`${key}HeartbeatProblems`] = beats;
      try {
        const rel = await leases.release(lease);
        rec[`${key}Release`] = rel;
        log(`release (${owner}): ${JSON.stringify(rel)}`);
      } catch (err) {
        rec[`${key}Release`] = { threw: errText(err) };
        log(`release (${owner}) threw ${errText(err)}`);
      }
    }
  };

  const fenceOf = (lease: Lease) => {
    const opSeq = lease.lastCompletedOpSeq + 1;
    return {
      opSeq,
      fence: {
        epoch: lease.epoch,
        token: lease.token,
        serverGeneration: lease.serverGeneration,
        opSeq,
      },
    };
  };

  /** A plain run, no stop hook. Returns what BC answered on the held request and what LethAL scored. */
  const runPlain = async (
    lease: Lease,
    codeunit: number,
    name: string,
    method: string,
    budgetMs: number,
  ) => {
    const { opSeq, fence } = fenceOf(lease);
    const attemptId = `r826b-${codeunit}-${opSeq}`;
    const at = Date.now();
    sink.tap = undefined;
    mayBeLive = true;
    try {
      const v = await transport.run({
        ref: { codeunitId: codeunit, codeunitName: name, method },
        mutantId: "",
        attemptId,
        timeoutMs: budgetMs,
        lease: fence,
      });
      await tapNow()?.done;
      const t = tapNow();
      return {
        attemptId,
        wallMs: Date.now() - at,
        outcome: v.outcome,
        operation: v.operation ?? null,
        heldStatus: t?.status ?? null,
        heldAtMs: t?.atMs ?? null,
        measured: measuredText(t?.body),
        heldBodyHead: (t?.body ?? "").slice(0, 600),
      };
    } finally {
      await tapNow()?.done;
    }
  };

  for (const label of labels) {
    const k = CASES.find((x) => x.label === label);
    if (k === undefined) throw new Error(`unknown case ${label}`);
    log(`=== case ${label}: ${k.shape} ===`);
    const row: Record<string, unknown> = {
      label,
      shape: k.shape,
      codeunit: k.codeunit,
      method: k.method,
      budgetMs: k.budgetMs,
    };
    doc.rows[label] = row;
    try {
      await withLease(
        `r826b ${label} (lane ${LANE})`,
        async (lease) => {
          const { opSeq, fence } = fenceOf(lease);
          const attemptId = `r826b-${k.codeunit}-${opSeq}`;
          const stop: Record<string, unknown> = { fired: false };
          row.stop = stop;
          row.attemptId = attemptId;
          const dispatchedAt = Date.now();
          row.dispatchedAt = new Date(dispatchedAt).toISOString();
          let stopAt = 0;
          let poll: ReturnType<typeof pollStatus> | undefined;
          sink.tap = undefined;
          mayBeLive = true;
          log(`${label}: dispatch ${attemptId}`);
          let outcome: string | undefined;
          let operation: string | null = null;
          try {
            const v = await transport.run({
              ref: { codeunitId: k.codeunit, codeunitName: k.name, method: k.method },
              mutantId: "",
              attemptId,
              timeoutMs: k.budgetMs,
              lease: fence,
              onBudgetExceeded: async (boundMs: number) => {
                stopAt = Date.now();
                Object.assign(stop, { fired: true, firedAtMs: stopAt - dispatchedAt, boundMs });
                poll = pollStatus(lease, attemptId, opSeq, stopAt);
                log(`  ${label}: budget exceeded at +${stopAt - dispatchedAt} ms, StopHungRun sent`);
                try {
                  const a = await transport.stopHungRun({ attemptId, lease: fence, timeoutMs: boundMs });
                  Object.assign(stop, { result: a, answeredAtMs: Date.now() - dispatchedAt });
                  log(`  ${label}: StopHungRun ${JSON.stringify(a)}`);
                  return a;
                } catch (err) {
                  Object.assign(stop, { error: errText(err), answeredAtMs: Date.now() - dispatchedAt });
                  log(`  ${label}: StopHungRun threw ${errText(err)}`);
                  throw err;
                }
              },
            });
            outcome = v.outcome;
            operation = v.operation ?? null;
          } finally {
            await tapNow()?.done;
          }
          const t = tapNow();
          row.lethal = { wallMs: Date.now() - dispatchedAt, outcome, operation };
          row.held = {
            status: t?.status ?? null,
            atMsAfterDispatch: t?.atMs ?? null,
            msFromStopToAnswer:
              stopAt > 0 && t?.atMs !== undefined ? t.sentAt + t.atMs - stopAt : null,
            error: t?.error ?? null,
            body: (t?.body ?? "").slice(0, 4000),
          };
          log(`  ${label}: held ${JSON.stringify(row.held).slice(0, 700)}`);
          if (k.kind !== "hang") {
            row.status = await readStatus(lease, attemptId, opSeq, dispatchedAt);
            return;
          }
          if (t?.status === undefined) {
            throw new StopRule(`${label}: BC sent nothing on the held request (${t?.error ?? "no error"})`);
          }
          // Status right after, then the poll until completed.
          const st = await (poll ?? pollStatus(lease, attemptId, opSeq, Date.now()));
          row.statusPoll = st;
          if (!st.completed) throw new StopRule(`${label}: op not completed ${STOP_RULE_MS} ms after stop`);
          row.stoppedAtDispatchPlusMs = stopAt - dispatchedAt;
          // The hang would end by itself 120 s after it started. Does the progress row move at all
          // up to then and past it? Reads at +45 s and +135 s, still on this lease.
          const reads: unknown[] = [];
          for (const ms of [45_000, 135_000]) {
            await Bun.sleep(Math.max(0, dispatchedAt + ms - Date.now()));
            const r = await readStatus(lease, attemptId, opSeq, dispatchedAt);
            reads.push(r);
            log(`  ${label}: +${ms} ms ${JSON.stringify(r)}`);
          }
          row.progressReads = reads;
        },
        row,
        "hang",
      );
      // The next acquire (above) then a clean test on its own lease.
      await withLease(
        `r826b ${label} clean`,
        async (lease) => {
          row.clean = await runPlain(lease, CLEAN.codeunit, CLEAN.name, CLEAN.method, 20_000);
          log(`  ${label}: clean ${JSON.stringify(row.clean).slice(0, 400)}`);
        },
        row,
        "clean",
      );
    } finally {
      writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
      log(`wrote ${OUT}`);
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  let holder: string;
  try {
    holder = holderIsCode();
  } catch (err) {
    console.error(`REFUSED: ${errText(err)}`);
    return 2;
  }
  log(`lease guard: ${holder}; mode ${mode}; head ${Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO }).stdout.toString().trim()}`);
  switch (mode) {
    case "build":
      return build();
    case "publish":
      return publish();
    case "remove":
      return remove();
    case "run":
      return runCases((process.argv[3] ?? "").split(",").filter((s) => s !== ""));
    default:
      console.error("usage: drive.ts build|publish|remove|run <labels>");
      return 2;
  }
}

process.on("unhandledRejection", (err) => {
  console.error(`driver crashed: ${errText(err)}`);
  process.exit(mayBeLive ? 5 : 1);
});
process.exit(
  await main().catch((err: unknown) => {
    log(`driver failed: ${errText(err)}${mayBeLive ? " (a RunMutant was sent: keep the lease, change nothing)" : ""}`);
    return mayBeLive ? 5 : 1;
  }),
);
