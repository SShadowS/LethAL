/**
 * R434 probe: can a BC server's full installed-app list be read safely and cheaply, from AL
 * (`NAV App Installed App`), without the automation `extensions` list R433 forbids? Pre-commitment:
 * docs/superpowers/specs/2026-10-23-r434-installed-apps-probe-precommitment.md.
 *
 *   bun scripts/r434-installed-probe/drive.ts --server bc1|bc2|bc3
 *
 * Run from the worktree root under `kraken coord lease <server> bugs` (`run-probe.sh` holds and
 * heartbeats it). REFUSES (exit 2) unless `kraken coord holder <server>` names lane bugs. The login
 * is read in-process from the secret file and never printed. The probe app is read by id only.
 *
 * Steps: publish the probe app (read absent first, read installed after); call
 * `R434ProbeInstalled_ListInstalled` three times, timing each HTTP call and reading the AL-side
 * row count and milliseconds; fingerprint the rows (sha256 of the sorted `id version` lines);
 * uninstall and unpublish the probe. Every app is recorded by id, publisher, name and version.
 *
 * STOP rule (pre-committed): a call that does not answer within 60 s, or a server that stops
 * answering HarnessInfo afterwards. Then: no removal, exit 5, and the wrapper keeps the lease.
 *
 * Writes docs/measurements/r434/<server>.json and logs to /coord/handoff/R-434/probe/drive.log.
 * Exit: 0 ran and removed; 1 a step failed (app removed); 2 the guard refused; 5 the STOP rule.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bcFetch } from "../../packages/runner/src/bc-fetch";
import { HarnessVerifier } from "../../packages/runner/src/harness";
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
const EVIDENCE = "/coord/handoff/R-434/probe";
const LOG = join(EVIDENCE, "drive.log");
const OUT_DIR = join(REPO, "docs", "measurements", "r434");
const PROBE = {
  id: "4c1e8a37-9d52-4f0b-b6e3-2a7d58c19f64",
  name: "LethAL R434 Installed Apps Probe",
};
const BUILD = join(import.meta.dir, "build", "probe.app");
const CALL_MS = 60_000;
const CALLS = 3;

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

class StopRule extends Error {}

/** One installed row as the probe writes it: `id|publisher|name|version`. */
interface Row {
  readonly id: string;
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
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
  if (git(["status", "--porcelain", "--", "scripts/r434-installed-probe"]) !== "")
    throw new Error("the probe sources are not committed; commit them first");
  const probeSourceSha = git(["rev-parse", "HEAD:scripts/r434-installed-probe"]);
  const appSha = new Bun.CryptoHasher("sha256").update(readFileSync(BUILD)).digest("hex");
  log(`${server}: harness ${harnessCommit}, probe tree ${probeSourceSha}, probe.app ${appSha}`);
  const doc: Record<string, unknown> = {
    server,
    date: new Date().toISOString().slice(0, 10),
    harness: `scripts/r434-installed-probe/drive.ts@${harnessCommit}`,
    probeSourceSha,
    appSha256: appSha,
    lease: { holder: JSON.parse(holder), releasedAt: null },
  };
  const harness = new HarnessVerifier(odata);
  const ext = await extensionsApi(c);
  const describe = async () => {
    const rs = await rows(c, ext, PROBE.id);
    return rs.length === 0
      ? "absent (0 rows)"
      : rs.map((r) => `${rowVersion(r)} isInstalled=${r.isInstalled}`).join("; ");
  };
  const list = async (): Promise<{ httpMs: number; alMs: number; rows: Row[] }> => {
    const url = `${odata.baseUrl}/ODataV4/R434ProbeInstalled_ListInstalled?company=${encodeURIComponent(COMPANY)}&tenant=default`;
    const t0 = Date.now();
    let res: Response;
    try {
      res = await bcFetch(url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(CALL_MS),
      });
    } catch (err) {
      throw new StopRule(`ListInstalled did not answer within ${CALL_MS} ms: ${errText(err)}`);
    }
    const text = await res.text();
    const httpMs = Date.now() - t0;
    if (!res.ok) throw new Error(`ListInstalled HTTP ${res.status}: ${text.slice(0, 500)}`);
    const value = String((JSON.parse(text) as { value?: unknown }).value ?? "");
    const head = /^rows=(\d+) ms=(\d+) /.exec(value);
    if (head === null) throw new Error(`ListInstalled answered no header: ${value.slice(0, 200)}`);
    const out: Row[] = [];
    for (const r of value.slice(head[0].length).split(";")) {
      if (r === "") continue;
      const [id = "", publisher = "", name = "", version = ""] = r.split("|");
      out.push({ id: id.replace(/[{}]/g, "").toLowerCase(), publisher, name, version });
    }
    if (out.length !== Number(head[1]))
      throw new Error(`ListInstalled said ${head[1]} rows but sent ${out.length}`);
    return { httpMs, alMs: Number(head[2]), rows: out };
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

    const calls: { httpMs: number; alMs: number; rows: number; fingerprint: string }[] = [];
    let last: Row[] = [];
    for (let i = 0; i < CALLS; i++) {
      const r = await list();
      const lines = r.rows.map((x) => `${x.id} ${x.version}`).sort();
      const fingerprint = new Bun.CryptoHasher("sha256").update(lines.join("\n")).digest("hex");
      calls.push({ httpMs: r.httpMs, alMs: r.alMs, rows: r.rows.length, fingerprint });
      log(
        `call ${i + 1}: ${r.rows.length} rows, AL ${r.alMs} ms, HTTP ${r.httpMs} ms, fingerprint ${fingerprint.slice(0, 16)}`,
      );
      last = r.rows;
    }
    doc.calls = calls;
    doc.installed = [...last].sort((a, b) =>
      (a.publisher + a.name).localeCompare(b.publisher + b.name),
    );
    const byPublisher: Record<string, number> = {};
    for (const r of last) byPublisher[r.publisher] = (byPublisher[r.publisher] ?? 0) + 1;
    doc.byPublisher = byPublisher;
    log(`by publisher: ${JSON.stringify(byPublisher)}`);
    // The server still answers after the reads.
    try {
      await harness.verify();
      log("harness verify after the reads: ok");
    } catch (err) {
      throw new StopRule(
        `the server stopped answering HarnessInfo after the reads: ${errText(err)}`,
      );
    }
  } catch (err) {
    if (err instanceof StopRule) {
      code = 5;
      doc.stop = err.message;
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
      writeFileSync(join(OUT_DIR, `${server}.json`), `${JSON.stringify(doc, null, 2)}\n`);
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
