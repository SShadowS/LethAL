/**
 * R706 bc1 probe: the text of an unhandled HttpClient failure on the web-service path (LethAL Control
 * RunMutant, runner 130450) next to the hub path (bc-dev-mcp `bcdev_test_run`, called directly with
 * coverage "none"). Pre-commitment (read it first, the constants and the outcome table are in it):
 * docs/superpowers/specs/2026-10-24-r706-client-path-probe-precommitment.md.
 *
 *   bun scripts/r706-client-probe/drive.ts
 *
 * Run from the worktree root under `kraken coord lease bc1 bugs` (`run-probe.sh` holds and heartbeats
 * it). Publishes r639's exact .app bytes (hash-checked, never recompiled), runs 92911 and 92910 on both
 * paths twice (run 2 in the other order), removes both apps, classifies (classify.ts), writes
 * readings.json. The login is read in-process and never printed. Apps are read by id only (R433).
 *
 * Exit: 0 ran and removed; 1 a step failed (apps removed); 2 a guard refused; 3 STOP before publish
 * (build or hash differs, an app already there); 5 HOLD (removal not read absent, or a hub overrun
 * whose session is not shown gone).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { type Lease, LeaseClient } from "../../packages/runner/src/lease";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import {
  COMPANY,
  type Conn,
  HOST,
  SERVERS,
  apiJson,
  extensionsApi,
  publishBytes,
  rowVersion,
  rows,
} from "../bc-app-content.ts";
import { bcDevMcpCommand, errText, readSecretFile } from "../bc-linux-setup.ts";
import {
  NONE,
  type PathClass,
  type Reading,
  type RunClasses,
  contradictsR639,
  outcomeOf,
  pathClass,
  readingOf,
} from "./classify.ts";

const REPO = join(import.meta.dir, "..", "..");
const EVIDENCE = "/coord/handoff/R-705/probe";
const LOG = join(EVIDENCE, "drive.log");
const R639_BUILD = "/work/lethal-wt/r639/scripts/r639-bc-probe/build";
const OUT_OF_USE = "/coord/machine/out-of-use/bc1.md";
const PROJECT = join(REPO, "fixtures", "sandbox-hang");
const MCP_COMMIT = "8371d0b";
const WANT_BUILD = "28.4.53241.56590";
const PLATFORM_APP = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const BASE_APP = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const SYSTEM_APP = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const ARTIFACT_ID = "d1618dd6c92c4a3982febac2e5339f21";
const TARGET = {
  id: "d371a89d-d1c8-4c83-aca5-49261b816c3b",
  name: "LethAL R639 BC Probe",
  file: "target.app",
  sha256: "7c46f5f75efa2bab59a557394f39008ebe9549b1625a03b4976fccaa0e4d0060",
};
const TESTS = {
  id: "a9639c9f-d2c6-4b66-add7-d54a552cbfd2",
  name: "LethAL R639 BC Probe Tests",
  file: "tests.app",
  sha256: "2b1138ace6bd2e7aa903fc3bd8cba2ed9a57e1ed6bd5e2f3c15222203595cd5a",
};
/** §5: 92911 first, then 92910, on every path in every run. */
const CASES = [
  { codeunit: 92911, method: "HttpGetRaw" },
  { codeunit: 92910, method: "HttpGet" },
] as const;
const CALL_MS = 120_000;
const HUB_BUDGET_MS = 60_000;
/** §5: run 1 web-service then hub; run 2 hub then web-service. */
const ORDER = [
  ["ws", "hub"],
  ["hub", "ws"],
] as const;

const log = (s: string) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  try {
    mkdirSync(EVIDENCE, { recursive: true });
    appendFileSync(LOG, `${line}\n`);
  } catch {}
};

/** Set just before the first publish; after it, a crash may leave apps on bc1. */
let published = false;

/** A stop before anything was published. */
class StopBeforePublish extends Error {}
/** A hub call outlived its budget: the session cannot be shown gone. */
class HubOverrun extends Error {}

function holderIsBugs(): string {
  const p = Bun.spawnSync(["kraken", "coord", "holder", "bc1"]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder bc1 exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== "bugs") throw new Error(`bc1 is not held by lane bugs: ${out}`);
  return out;
}

function git(args: string[], cwd = REPO): string {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return p.stdout.toString().trim();
}

/** bc-dev-mcp must be commit 8371d0b with a dist/ built after that commit and no newer source. */
function mcpBuildFacts(): Record<string, unknown> {
  const dir = bcDevMcpCommand()[1]?.replace(/\/dist\/index\.js$/, "");
  if (dir === undefined) throw new StopBeforePublish("cannot find bc-dev-mcp's directory");
  const head = git(["rev-parse", "HEAD"], dir);
  const committedAt = Number(git(["log", "-1", "--format=%ct"], dir)) * 1000;
  const distAt = statSync(join(dir, "dist", "index.js")).mtimeMs;
  const newer = Bun.spawnSync(["find", "src", "-name", "*.ts", "-newer", "dist/index.js"], {
    cwd: dir,
  })
    .stdout.toString()
    .trim();
  const facts = { dir, head, distBuiltAfterCommit: distAt >= committedAt, newerSources: newer };
  if (!head.startsWith(MCP_COMMIT) || distAt < committedAt || newer !== "")
    throw new StopBeforePublish(`bc-dev-mcp is not ${MCP_COMMIT} built: ${JSON.stringify(facts)}`);
  return facts;
}

const frameOf = (text: string): string | null =>
  /Test Runner - [A-Za-z. ]*\(Codeunit \d+\)|Test Runner - [A-Za-z. ]*/.exec(text)?.[0] ?? null;

interface Call {
  codeunit: number;
  method: string;
  reading: Reading;
  runner: string | null;
  isError?: boolean;
  note?: string;
}

async function main(): Promise<number> {
  let holder: string;
  try {
    if (existsSync(OUT_OF_USE)) throw new Error(`${OUT_OF_USE} exists`);
    holder = holderIsBugs();
  } catch (err) {
    console.error(`REFUSED: ${errText(err)}`);
    return 2;
  }
  const login = readSecretFile();
  const ports = SERVERS.bc1;
  const timed: NonNullable<Conn["fetch"]> = (url, init) =>
    bcFetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) });
  const authorization = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`;
  const c: Conn = { server: "bc1", authorization, fetch: timed };
  const odata = {
    baseUrl: `${HOST}:${ports.odata}/BC`,
    apiBaseUrl: `${HOST}:${ports.api}/BC`,
    company: COMPANY,
    username: login.user,
    password: login.password,
    tenant: "default",
  };
  log(`lease guard: ${holder}`);
  const harnessCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain", "--", "scripts/r706-client-probe"]) !== "") {
    console.error("REFUSED: the probe sources are not committed");
    return 2;
  }
  const doc: Record<string, unknown> = {
    server: "bc1",
    date: new Date().toISOString().slice(0, 10),
    harness: `scripts/r706-client-probe/drive.ts@${harnessCommit}`,
    probeSourceSha: git(["rev-parse", "HEAD:scripts/r706-client-probe"]),
    lease: { holder: JSON.parse(holder), releasedAt: null },
    coverageMode: "none",
    testHttpRequestPolicy: "absent",
  };
  const ext = await extensionsApi(c);
  const describe = async (a: { id: string; name: string }) => {
    const rs = await rows(c, ext, a.id);
    return rs.length === 0
      ? `${a.name} (${a.id}): absent (0 rows)`
      : `${a.name} (${a.id}): ${rs.map((r) => `${rowVersion(r)} isInstalled=${r.isInstalled}`).join("; ")}`;
  };
  let hold: string | undefined;
  let code = 0;
  const runs: RunClasses[] = [];
  doc.runs = [];
  try {
    // Hashes first: the pre-committed bytes, copied into the evidence folder, or nothing.
    mkdirSync(join(EVIDENCE, "apps"), { recursive: true });
    const sha: Record<string, string> = {};
    const bytes: Record<string, Buffer> = {};
    for (const a of [TARGET, TESTS]) {
      const b = readFileSync(join(R639_BUILD, a.file));
      sha[a.file] = new Bun.CryptoHasher("sha256").update(b).digest("hex");
      if (sha[a.file] !== a.sha256)
        throw new StopBeforePublish(`${a.file} sha256 ${sha[a.file]} is not ${a.sha256}`);
      writeFileSync(join(EVIDENCE, "apps", a.file), b);
      bytes[a.file] = b;
    }
    doc.appSha256 = sha;
    doc.bcDevMcp = mcpBuildFacts();

    // The build, by id: Base, System Application and the platform.
    const build: Record<string, string> = {};
    for (const [n, id] of [
      ["Base Application", BASE_APP],
      ["System Application", SYSTEM_APP],
      ["Platform (System)", PLATFORM_APP],
    ] as const) {
      const rs = await rows(c, ext, id);
      build[n] = rs.map((r) => rowVersion(r)).join("; ") || "absent";
      log(`server build: ${n} ${build[n]}`);
    }
    doc.bcBuild = build;
    for (const [n, v] of Object.entries(build))
      if (v !== WANT_BUILD) throw new StopBeforePublish(`${n} reads ${v}, not ${WANT_BUILD}`);
    const harness = new HarnessVerifier(odata);
    doc.lethalControl = await harness.fetchControlVersion();
    const info = await harness.verify();
    log(`LethAL Control ${doc.lethalControl}; serverGeneration ${info.serverGeneration}`);

    for (const a of [TARGET, TESTS]) {
      log(`before: ${await describe(a)}`);
      if ((await rows(c, ext, a.id)).length > 0)
        throw new StopBeforePublish(`${a.name} already on bc1 (not ours); nothing removed`);
    }

    published = true;
    for (const a of [TARGET, TESTS]) {
      await publishBytes(c, `LethAL_${a.name}_1.0.0.0.app`, bytes[a.file] ?? new Uint8Array());
      const rs = await rows(c, ext, a.id);
      log(`published: ${await describe(a)}`);
      if (rs.length !== 1 || rs[0]?.isInstalled !== true)
        throw new Error(`${a.name} not read back installed`);
    }

    const reader = new RunMutantTransport(odata, TARGET.id, ARTIFACT_ID);
    const opStatus = async () => {
      try {
        const st = await reader.getOperationStatus(
          { epoch: 0, token: "", serverGeneration: info.serverGeneration },
          "r706-read",
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
    doc.opMarkerBefore = await opStatus();
    log(`op marker before: ${JSON.stringify(doc.opMarkerBefore)}`);

    const leases = new LeaseClient(odata);
    let opSeq = 0;
    /** The web-service path: RunMutant baseline, one method per call, under a control-app lease. */
    const wsPass = async (): Promise<{ calls: Call[]; raw: unknown[] }> => {
      const got = await leases.acquire(
        "r706-client-probe (lane bugs)",
        120,
        crypto.randomUUID(),
        info.serverGeneration,
      );
      if (!got.granted) throw new Error(`control-app lease refused: ${JSON.stringify(got)}`);
      const lease: Lease = got.lease;
      opSeq = Math.max(opSeq, lease.lastCompletedOpSeq);
      const calls: Call[] = [];
      const raw: unknown[] = [];
      try {
        for (const k of CASES) {
          const r = await leases.renew(lease, 120);
          if (!r.renewed) throw new Error("control-app lease renew refused");
          opSeq += 1;
          const answerText = await postAction(odata, "LethALControl_RunMutant", {
            targetAppId: TARGET.id,
            artifactId: ARTIFACT_ID,
            attemptId: `r706-${k.codeunit}-${opSeq}`,
            mutantId: "",
            testCodeunitId: k.codeunit,
            testMethod: k.method,
            leaseEpoch: lease.epoch,
            leaseToken: lease.token,
            serverGeneration: lease.serverGeneration,
            opSeq,
          });
          const answer = JSON.parse(answerText) as Record<string, unknown>;
          raw.push({ codeunit: k.codeunit, answerText });
          if (answer.status !== "ran")
            throw new Error(`ws ${k.codeunit}: status ${String(answer.status)}`);
          calls.push(wsCall(k.codeunit, answer.codeunitResults));
        }
      } finally {
        log(`control-app lease release: ${JSON.stringify(await leases.release(lease))}`);
      }
      return { calls, raw };
    };
    /** The hub path: bcdev_test_run directly, one child process per call, closed in `finally`. */
    const hubPass = async (): Promise<{ calls: Call[]; raw: unknown[] }> => {
      const calls: Call[] = [];
      const raw: unknown[] = [];
      for (const k of CASES) {
        const one = await hubCall(k.codeunit, k.method, login, ports);
        raw.push(one.raw);
        calls.push(one.call);
        if (one.overrun) throw new HubOverrun(`hub ${k.codeunit} outlived ${HUB_BUDGET_MS} ms`);
      }
      return { calls, raw };
    };

    for (const [i, order] of ORDER.entries()) {
      const n = i + 1;
      const byPath: Record<string, { calls: Call[]; raw: unknown[] }> = {};
      for (const p of order) {
        log(`run ${n}: ${p}`);
        byPath[p] = await (p === "ws" ? wsPass() : hubPass());
        writeFileSync(
          join(EVIDENCE, `${p}-run${n}.json`),
          `${JSON.stringify({ order: order.join(","), calls: byPath[p]?.raw }, null, 2)}\n`,
        );
        for (const cl of byPath[p]?.calls ?? [])
          log(`  ${p} ${cl.codeunit}: ${cl.reading.cls} | ${cl.reading.raw}`);
      }
      const cls = (p: "ws" | "hub"): PathClass => {
        const [a, b] = (byPath[p]?.calls ?? []).map((x) => x.reading);
        return pathClass(a ?? NONE, b ?? NONE);
      };
      runs.push({ ws: cls("ws"), hub: cls("hub") });
      (doc.runs as unknown[]).push({
        run: n,
        order,
        ws: { class: cls("ws"), calls: byPath.ws?.calls },
        hub: { class: cls("hub"), calls: byPath.hub?.calls },
      });
    }
    doc.opMarkerAfter = await opStatus();
    log(`op marker after: ${JSON.stringify(doc.opMarkerAfter)}`);
  } catch (err) {
    if (err instanceof HubOverrun) {
      // §8: the session must be shown gone from Active Session before any other call to bc1. The
      // probe apps hold no Active Session reader (r639's bytes are fixed), so it cannot be shown.
      hold = `${errText(err)}; Active Session cannot be read by this probe, so the hub session is not shown gone`;
      code = 5;
    } else if (err instanceof StopBeforePublish) {
      doc.stop = errText(err);
      code = 3;
      log(`STOP: ${errText(err)}`);
    } else {
      doc.error = errText(err);
      code = 1;
      log(`FAILED: ${errText(err)}`);
    }
  } finally {
    const removal: Record<string, unknown> = {};
    if (hold !== undefined) {
      doc.hold = hold;
      removal.note = "HOLD: no removal, no other call to bc1";
      log(`HOLD: ${hold}`);
    } else if (published) {
      for (const a of [TESTS, TARGET]) {
        const steps: string[] = [];
        try {
          await removeApp(c, ext, a, steps);
          steps.push(`read-back ${await describe(a)}`);
          removal[a.name] = { ok: true, steps };
        } catch (err) {
          steps.push(`FAILED: ${errText(err)}`);
          removal[a.name] = { ok: false, steps };
          code = 5;
          hold = `removal of ${a.name} not read back absent`;
          doc.hold = hold;
        }
        log(`removal ${a.name}: ${steps.join(" | ")}`);
      }
    } else removal.note = "nothing published; nothing removed";
    doc.removal = removal;
    if (runs.length === ORDER.length) {
      try {
        const o = outcomeOf(runs);
        doc.outcomeRow = o.row;
        doc.outcome = o.outcome;
        if (contradictsR639(o.row, runs)) doc.contradictsR639 = true;
        log(`outcome: row ${o.row} ${o.outcome}`);
      } catch (err) {
        doc.outcomeError = errText(err);
        log(`outcome FAILED: ${errText(err)}`);
      }
    }
    try {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, "readings.json"), `${JSON.stringify(doc, null, 2)}\n`);
      writeFileSync(join(EVIDENCE, "README.md"), readme(doc));
    } catch (err) {
      console.error(`evidence write FAILED: ${errText(err)}`);
    }
  }
  return code;
}

function readme(doc: Record<string, unknown>): string {
  return [
    "# R706 probe evidence",
    "",
    `- server: ${String(doc.server)}, date ${String(doc.date)}, build ${JSON.stringify(doc.bcBuild)}`,
    `- LethAL Control: ${String(doc.lethalControl)}`,
    `- harness: ${String(doc.harness)}`,
    "- web-service runner: Test Runner - Isol. Codeunit (130450) when the callstacks say so; see readings.json",
    `- outcome: row ${String(doc.outcomeRow)} ${String(doc.outcome)}`,
    `- stop/hold/error: ${String(doc.stop ?? doc.hold ?? doc.error ?? "none")}`,
    "",
  ].join("\n");
}

interface TestLine {
  method?: unknown;
  result?: unknown;
  message?: unknown;
  stackTrace?: unknown;
}

/** One web-service answer: the whole failure text is the message and the callstack. */
function wsCall(codeunit: number, codeunitResults: unknown): Call {
  const parsed = (
    typeof codeunitResults === "string" ? JSON.parse(codeunitResults) : codeunitResults
  ) as { testResults?: TestLine[] };
  const lines = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  const [only] = lines;
  const method = CASES.find((k) => k.codeunit === codeunit)?.method ?? "";
  if (lines.length !== 1 || only === undefined)
    return { codeunit, method, reading: NONE, runner: null, note: `${lines.length} test lines` };
  const message = typeof only.message === "string" ? only.message : "";
  const stack = typeof only.stackTrace === "string" ? only.stackTrace : "";
  const text = [message, stack].filter((x) => x.length > 0).join("\n");
  const runner = stack.split(";").find((f) => f.includes("Test Runner - ")) ?? null;
  return {
    codeunit,
    method,
    reading: only.result === 1 ? readingOf(codeunit === 92911 ? 92911 : 92910, text) : NONE,
    runner,
    ...(only.result === 1 ? {} : { note: `result ${JSON.stringify(only.result)}` }),
  };
}

interface HubResult {
  call: Call;
  raw: unknown;
  overrun: boolean;
}

async function hubCall(
  codeunit: number,
  method: string,
  login: { user: string; password: string },
  ports: { dev: number; api: number },
): Promise<HubResult> {
  const cmd = bcDevMcpCommand();
  const env = {
    ...getDefaultEnvironment(),
    BC_DEV_USER: login.user,
    BC_DEV_PASSWORD: login.password,
    BC_DEV_API_PORT: String(ports.api),
  };
  const client = new Client({ name: "lethal-r706", version: "0.0.0" });
  const args = {
    codeunits: [{ id: codeunit, methods: [method] }],
    coverage: "none",
    project: PROJECT,
    server: `${HOST}:${ports.dev}`,
    serverInstance: "BC",
    tenant: "default",
    port: ports.dev,
    company: COMPANY,
  };
  const none = (note: string, raw: unknown, overrun = false): HubResult => ({
    call: { codeunit, method, reading: NONE, runner: null, note },
    raw: { args, note, response: raw },
    overrun,
  });
  // Once callTool has been sent, any failure may leave a running session: an overrun (HOLD).
  let sent = false;
  try {
    try {
      await client.connect(
        new StdioClientTransport({ command: cmd[0] ?? "", args: cmd.slice(1), env }),
      );
    } catch (err) {
      return none(`connect failed: ${errText(err)}`, null);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    sent = true;
    const call = client.callTool({ name: "bcdev_test_run", arguments: args }, undefined, {
      timeout: HUB_BUDGET_MS,
    });
    call.catch(() => {});
    const res = await Promise.race([
      call,
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), HUB_BUDGET_MS + 5_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (res === "timeout") return none("hub call outlived its budget", null, true);
    const content = (res as { content?: { type: string; text?: string }[] }).content ?? [];
    const text = content.find((x) => x.type === "text")?.text;
    const isError = (res as { isError?: boolean }).isError === true;
    if (isError || text === undefined) {
      const n = none("isError or no text", res);
      return { ...n, call: { ...n.call, isError } };
    }
    let payload: {
      results?: { codeunitId: number; method: string; status: string; output: string }[];
    };
    try {
      payload = JSON.parse(text);
    } catch {
      return none("payload is not JSON", res);
    }
    const found = payload.results?.find((x) => x.codeunitId === codeunit && x.method === method);
    if (found === undefined) return none("no result for the method", res);
    const out = typeof found.output === "string" ? found.output : "";
    if (found.status !== "failed") return none(`status ${found.status}`, res);
    return {
      call: {
        codeunit,
        method,
        reading: readingOf(codeunit === 92911 ? 92911 : 92910, out),
        runner: frameOf(out),
        isError,
      },
      raw: { args, response: res },
      overrun: false,
    };
  } catch (err) {
    return none(`call threw: ${errText(err)}`, null, sent);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Uninstall if installed, then the bound unpublish (each HTTP 204), then 0 rows by id. */
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
      steps.push(`uninstall HTTP ${u.status}`);
      if (u.status !== 204) throw new Error(`uninstall ${a.name}: HTTP ${u.status}`);
    }
    const p = await apiJson(c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    steps.push(`unpublish HTTP ${p.status}`);
    if (p.status !== 204) throw new Error(`unpublish ${a.name}: HTTP ${p.status}`);
  }
  if ((await rows(c, ext, a.id)).length > 0)
    throw new Error(`${a.name} still present after removal`);
}

async function postAction(
  cfg: { baseUrl: string; company: string; username: string; password: string; tenant: string },
  action: string,
  body: Record<string, unknown>,
): Promise<string> {
  const params = new URLSearchParams({ company: cfg.company, tenant: cfg.tenant });
  const res = await bcFetch(`${cfg.baseUrl}/ODataV4/${action}?${params}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${action}: HTTP ${res.status}: ${text.slice(0, 2000)}`);
  const value = (JSON.parse(text) as { value?: unknown }).value;
  if (typeof value !== "string")
    throw new Error(`${action}: no string value: ${text.slice(0, 2000)}`);
  return value;
}

if (import.meta.main) {
  // A crash after a publish leaves apps on bc1: exit 1 there would let the wrapper release the lease.
  const crash = (err: unknown) => {
    console.error(`driver crashed: ${errText(err)}`);
    process.exit(published ? 5 : 1);
  };
  process.on("unhandledRejection", crash);
  process.on("uncaughtException", crash);
  process.exit(
    await main().catch((err: unknown) => {
      console.error(`driver failed: ${errText(err)}`);
      return published ? 5 : 1;
    }),
  );
}
