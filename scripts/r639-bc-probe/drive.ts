/**
 * R639 bc1 probe (plan r3 §r3.2): BC's own outcome and raw error text, under LethAL's real BC test
 * runner (the LethAL Control app's RunMutant, as a baseline: mutantId ""), for six codeunits.
 *
 *   bun scripts/r639-bc-probe/drive.ts
 *
 * Run from the worktree root, AFTER `kraken coord lease bc1 bugs` (the caller holds the lease and
 * heartbeats it); this script REFUSES (exit 2) unless `kraken coord holder bc1` names lane bugs.
 * The login is read in-process from the secret file and never printed. Apps are read by id only
 * (R433). The probe apps are ALWAYS removed (tests app, then target): uninstall if installed, then
 * the bound Microsoft.NAV.unpublish, then a read-back that must show 0 rows.
 *
 * It writes docs/measurements/r639/bc1-probe.json (with `lease.releasedAt` null: the caller fills
 * it after releasing) and logs every step to /coord/handoff/R-639/probe/drive.log.
 *
 * Exit: 0 ran and removed; 1 a step failed or a STOP (see the log); 2 the lease guard refused.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { type Lease, LeaseClient } from "../../packages/runner/src/lease";
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
import { errText, readSecretFile } from "../bc-linux-setup.ts";

const REPO = join(import.meta.dir, "..", "..");
const BUILD = join(import.meta.dir, "build");
const EVIDENCE = "/coord/handoff/R-639/probe";
const LOG = join(EVIDENCE, "drive.log");
const OUT = join(REPO, "docs", "measurements", "r639", "bc1-probe.json");

const TARGET = {
  id: "d371a89d-d1c8-4c83-aca5-49261b816c3b",
  name: "LethAL R639 BC Probe",
  file: "target.app",
};
const TESTS = {
  id: "a9639c9f-d2c6-4b66-add7-d54a552cbfd2",
  name: "LethAL R639 BC Probe Tests",
  file: "tests.app",
};
/** Registered by the target's Install codeunit 92901. */
const ARTIFACT_ID = "d1618dd6c92c4a3982febac2e5339f21";
const BASE_APP = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const SYSTEM_APP = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const CALL_TIMEOUT_MS = 120_000;

/** One control-app call per codeunit. 92912 has two tests, so its one call is RunMutantMany. */
const CASES: { codeunit: number; methods: string[]; measured: boolean }[] = [
  { codeunit: 92910, methods: ["HttpGet"], measured: false },
  { codeunit: 92911, methods: ["HttpGetRaw"], measured: true },
  { codeunit: 92912, methods: ["DuplicateNamedKey", "AfterDupSentinel"], measured: false },
  { codeunit: 92913, methods: ["DuplicateNamedKey"], measured: false },
  { codeunit: 92914, methods: ["DuplicateNamedKeyThenRead"], measured: false },
  { codeunit: 92915, methods: ["DuplicateNamedKeyThenReadRaw"], measured: true },
];

mkdirSync(EVIDENCE, { recursive: true });
const log = (s: string) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

/** M-b: `raw`/`rawCode` from the FULL failure text, anchored at `MEASURED [` and the LAST `] [`. */
export function parseMeasured(text: string): { raw: string; rawCode: string } {
  const s = text.indexOf("MEASURED [");
  if (s < 0 || text.indexOf("MEASURED [", s + 1) >= 0)
    throw new Error("parseMeasured: need exactly one `MEASURED [`");
  const e = text.lastIndexOf("] [");
  if (e < s) throw new Error("parseMeasured: no `] [` after `MEASURED [`");
  const z = text.indexOf("]", e + 3);
  if (z < 0) throw new Error("parseMeasured: no closing `]`");
  if (z + 1 < text.length && text[z + 1] !== "\n")
    throw new Error("parseMeasured: the closing `]` is not followed by a newline or the end");
  return { raw: text.slice(s + 10, e), rawCode: text.slice(e + 3, z) };
}

async function holderIsBugs(): Promise<string> {
  const p = Bun.spawnSync(["kraken", "coord", "holder", "bc1"]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder bc1 exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== "bugs") throw new Error(`bc1 is not held by lane bugs: ${out}`);
  return out;
}

function git(args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: REPO });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return p.stdout.toString().trim();
}

interface TestLine {
  method?: unknown;
  result?: unknown;
  message?: unknown;
  stackTrace?: unknown;
}

function lineOf(codeunitResults: unknown): TestLine {
  const parsed = (
    typeof codeunitResults === "string" ? JSON.parse(codeunitResults) : codeunitResults
  ) as {
    testResults?: unknown;
    error?: unknown;
  };
  const lines = Array.isArray(parsed.testResults) ? (parsed.testResults as TestLine[]) : [];
  const [only] = lines;
  if (lines.length !== 1 || only === undefined)
    throw new Error(`expected one test line, got ${lines.length}: ${JSON.stringify(parsed)}`);
  return only;
}

function record(line: TestLine, measured: boolean): Record<string, unknown> {
  const outcome =
    line.result === 2
      ? "pass"
      : line.result === 1
        ? "fail"
        : `unknown(${JSON.stringify(line.result)})`;
  const message = typeof line.message === "string" ? line.message : "";
  const stackTrace = typeof line.stackTrace === "string" ? line.stackTrace : "";
  // The same join `RunMutantTransport.failureTextOf` makes: what LethAL stores as the failure.
  const fullFailureText = [message, stackTrace].filter((x) => x.length > 0).join("\n");
  const nl = fullFailureText.indexOf("\n");
  const out: Record<string, unknown> = {
    method: line.method,
    outcome,
    resultEnum: line.result,
    fullFailureText,
    runnerMessageFirstLine: nl < 0 ? fullFailureText : fullFailureText.slice(0, nl),
    firstFrame: stackTrace === "" ? null : (stackTrace.split(";")[0] ?? null),
    message,
    stackTrace,
  };
  if (measured) {
    try {
      Object.assign(out, parseMeasured(fullFailureText));
    } catch (err) {
      out.rawParseError = errText(err);
    }
  }
  return out;
}

async function main(): Promise<number> {
  let holder: string;
  try {
    holder = await holderIsBugs();
  } catch (err) {
    console.error(`REFUSED: ${errText(err)}`);
    return 2;
  }
  log(`lease guard: ${holder}`);
  const harnessCommit = git(["rev-parse", "HEAD"]);
  if (
    git([
      "status",
      "--porcelain",
      "--",
      "scripts/r639-bc-probe/target",
      "scripts/r639-bc-probe/tests",
      "scripts/r639-bc-probe/drive.ts",
    ]) !== ""
  )
    throw new Error("the probe sources are not committed; commit them first");
  const probeSourceSha = git(["rev-parse", "HEAD:scripts/r639-bc-probe"]);
  const appSha: Record<string, string> = {};
  for (const a of [TARGET, TESTS])
    appSha[a.file] = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(BUILD, a.file)))
      .digest("hex");
  log(
    `harness ${harnessCommit}, probe source tree ${probeSourceSha}, apps ${JSON.stringify(appSha)}`,
  );

  const login = readSecretFile();
  const c: Conn = {
    server: "bc1",
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  };
  const odata = {
    baseUrl: `${HOST}:${SERVERS.bc1.odata}/BC`,
    apiBaseUrl: `${HOST}:${SERVERS.bc1.api}/BC`,
    company: COMPANY,
    username: login.user,
    password: login.password,
    tenant: "default",
  };
  const doc: Record<string, unknown> = {
    server: "bc1",
    date: new Date().toISOString().slice(0, 10),
    harness: `scripts/r639-bc-probe/drive.ts@${harnessCommit}`,
    probeSourceSha,
    appSha256: appSha,
    testHttpRequestPolicy: "absent",
    runnerPath:
      'LethAL Control RunMutant (one method per call, mutantId ""); 92912 through RunMutantMany (both methods, one call, stopAtFirstFailure false)',
    lease: { holder: JSON.parse(holder), releasedAt: null },
    apps: { target: TARGET, tests: TESTS, artifactId: ARTIFACT_ID },
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
    // Step 3: the build and the control version.
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

    // Step 4: both probe ids must be ABSENT.
    for (const a of [TARGET, TESTS]) {
      const rs = await rows(c, ext, a.id);
      log(`before: ${await describe(a)}`);
      if (rs.length > 0) {
        doc.stop = `${a.name} already on bc1 before the probe; nothing removed (not ours)`;
        throw new Error(`STOP: ${doc.stop}`);
      }
    }
    doc.absentBefore = true;

    // Step 5: publish target, then tests; read each back installed.
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
    const reg = await postAction(odata, "LethALControl_RegisteredArtifact", {
      targetAppId: TARGET.id,
    });
    log(`RegisteredArtifact(${TARGET.id}) = ${reg}`);
    doc.registeredArtifact = reg;

    // Step 6: one control-app call per codeunit, under a control-app lease.
    const leases = new LeaseClient(odata);
    const got = await leases.acquire(
      "r639-bc-probe (lane bugs)",
      15,
      crypto.randomUUID(),
      info.serverGeneration,
    );
    if (!got.granted) throw new Error(`control-app lease refused: ${JSON.stringify(got)}`);
    const lease: Lease = got.lease;
    log(`control-app lease epoch ${lease.epoch}, lastCompletedOpSeq ${lease.lastCompletedOpSeq}`);
    let opSeq = lease.lastCompletedOpSeq;
    const results: Record<string, unknown>[] = [];
    try {
      for (const k of CASES) {
        const r = await leases.renew(lease, 15);
        if (!r.renewed) throw new Error("control-app lease renew refused");
        opSeq += 1;
        const attemptId = `r639-${k.codeunit}-${opSeq}`;
        const fence = {
          leaseEpoch: lease.epoch,
          leaseToken: lease.token,
          serverGeneration: lease.serverGeneration,
          opSeq,
        };
        const base = { targetAppId: TARGET.id, artifactId: ARTIFACT_ID, attemptId, mutantId: "" };
        const [first] = k.methods;
        if (first === undefined) throw new Error("unreachable: a case with no method");
        const answerText =
          k.methods.length === 1
            ? await postAction(odata, "LethALControl_RunMutant", {
                ...base,
                testCodeunitId: k.codeunit,
                testMethod: first,
                ...fence,
              })
            : await postAction(odata, "LethALControl_RunMutantMany", {
                ...base,
                testMethods: JSON.stringify(
                  k.methods.map((m, i) => ({
                    index: i + 1,
                    codeunitId: k.codeunit,
                    method: m,
                    budgetMs: 60_000,
                  })),
                ),
                stopAtFirstFailure: false,
                requestCeilingMs: 300_000,
                stopGraceMs: 30_000,
                ...fence,
              });
        log(`codeunit ${k.codeunit}: answer ${answerText}`);
        const answer = JSON.parse(answerText) as Record<string, unknown>;
        if (answer.status !== "ran")
          throw new Error(`codeunit ${k.codeunit}: status ${String(answer.status)}`);
        const tests: Record<string, unknown>[] = [];
        // A line that cannot be read is recorded, never thrown: the next codeunit still runs.
        const one = (method: string, cr: unknown): Record<string, unknown> => {
          try {
            return record(lineOf(cr), k.measured);
          } catch (err) {
            return { method, outcome: "unreadable", lineError: errText(err) };
          }
        };
        if (k.methods.length === 1) tests.push(one(first, answer.codeunitResults));
        else if (!Array.isArray(answer.methods))
          tests.push({
            method: first,
            outcome: "unreadable",
            lineError: `no methods array; runError ${String(answer.runError)}`,
          });
        else
          for (const m of answer.methods as {
            method: string;
            codeunitResults: unknown;
            sessionId?: unknown;
          }[])
            tests.push({ ...one(m.method, m.codeunitResults), sessionId: m.sessionId });
        for (const t of tests)
          log(
            `  ${k.codeunit} ${String(t.method)}: ${String(t.outcome)} | ${String(t.runnerMessageFirstLine)}`,
          );
        results.push({ codeunit: k.codeunit, attemptId, opSeq, answer, tests });
      }
    } finally {
      const rel = await leases.release(lease);
      log(`control-app lease release: ${JSON.stringify(rel)}`);
    }
    doc.results = results;
    const frame = results
      .flatMap((r) => r.tests as Record<string, unknown>[])
      .map((t) => (typeof t.stackTrace === "string" ? t.stackTrace : ""))
      .find((s) => s !== "");
    // The runner is the callstack frame that names the Test Runner; null when none does.
    doc.runnerCodeunit = frame?.split(";").find((f) => f.includes("Test Runner")) ?? null;
    doc.callstackSample = frame ?? null;
  } catch (err) {
    log(`FAILED: ${errText(err)}`);
    doc.error = errText(err);
    code = 1;
  } finally {
    // Step 7: ALWAYS remove, tests first, then the target (only once we may have published).
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
    mkdirSync(join(REPO, "docs", "measurements", "r639"), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
    log(`wrote ${OUT}`);
  }
  return code;
}

/** E3: uninstall if installed, then the bound unpublish (each HTTP 204), then 0 rows by id. */
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

async function postAction(
  cfg: { baseUrl: string; company: string; username: string; password: string; tenant: string },
  action: string,
  body: Record<string, unknown>,
): Promise<string> {
  const params = new URLSearchParams({ company: cfg.company, tenant: cfg.tenant });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await bcFetch(`${cfg.baseUrl}/ODataV4/${action}?${params}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${action}: HTTP ${res.status}: ${text.slice(0, 2000)}`);
    const value = (JSON.parse(text) as { value?: unknown }).value;
    if (typeof value !== "string")
      throw new Error(`${action}: no string value: ${text.slice(0, 2000)}`);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) process.exit(await main());
