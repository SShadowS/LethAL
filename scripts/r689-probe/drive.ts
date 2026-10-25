/**
 * R689 live probe (copied from R738's). Invented AL, no tables, no loops (R164). Measurement only.
 * What does BC record for a test codeunit whose OnRun raises during suite discovery
 * (`SelectTestMethodsByRange`), where, and can LethAL read it without changing LethAL Control?
 *
 *   bun scripts/r689-probe/drive.ts --build [--server bc2]       offline: compile every build
 *   bun scripts/r689-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login
 * is read in this process (`readSecretFile()`) and never printed. Apps are read by id only (R433).
 * Every direct HTTP call is bounded by CALL_TIMEOUT_MS. Nothing is ever truncated: texts go whole
 * to files under .kraken-local/r689-probe/. See README.md.
 *
 * Exit: 0 ok; 1 a step failed; 2 refused (guard or unexpected prior state).
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bcFetch } from "../../packages/runner/src/bc-fetch.ts";
import { readAppIdentity } from "../../packages/runner/src/published-test-app.ts";
import {
  type Conn,
  HOST,
  SERVERS,
  type ServerName,
  apiJson,
  extensionsApi,
  portsOf,
  rowVersion,
  rows,
  sha256Of,
} from "../bc-app-content.ts";
import { alcCompile, errText, readSecretFile } from "../bc-linux-setup.ts";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const OUT = join(REPO, ".kraken-local", "r689-probe");
const CALL_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 900_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";
const COMPANY = "CRONUS International Ltd.";
// The Test Runner's symbols for compiling the reader (the shared cache holds System only).
const TEST_RUNNER_SYMBOLS = "fixtures/sandbox-coverage-probe/.alpackages";
const THROWING = 93890;
const PLAIN = 93891;

const mkApp = (id: string, name: string) => ({ id, publisher: "LethAL Probe", name });
// Set 1. A re-run needs set 2 (README), since bc2 keeps set 1's records until a restart (R605).
const P = mkApp("b3bda25b-cff0-435a-b6b3-1331dd8f7862", "R689 Probe Target");
const Q = mkApp("09518c22-cda3-4945-9d08-1d6c6ce4bc65", "R689 Probe Tests");
const R = mkApp("2565f0ea-4068-4c22-8ddf-a3e6fb3cdfe0", "R689 Probe Reader");
type App = typeof P;

/** Build -> source dir; `against` are the probe builds a dependent compiles against. */
const BUILDS = [
  { build: "P", dir: "target", against: [], testRunner: false },
  { build: "Q", dir: "tests", against: [{ build: "P", name: P.name }], testRunner: false },
  { build: "R", dir: "reader", against: [], testRunner: true },
] as const;
type Build = (typeof BUILDS)[number]["build"];

// ---------------------------------------------------------------------------------------------
// offline build

function symbolDir(server: ServerName): string {
  const root = join(SYMBOL_ROOT, server);
  const dir = readdirSync(root).sort().at(-1);
  if (dir === undefined) throw new Error(`no symbol cache under ${root}; run bc-linux-setup first`);
  return join(root, dir);
}

async function build(server: ServerName): Promise<void> {
  const alcDir = process.env.LETHAL_ALC_DIR;
  if (alcDir === undefined) throw new Error("LETHAL_ALC_DIR is not set");
  const alc = join(alcDir, "alc");
  const sym = symbolDir(server);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const shas: Record<string, string> = {};
  for (const v of BUILDS) {
    const work = join(OUT, "work", v.build);
    cpSync(join(HERE, v.dir), work, { recursive: true });
    let cache = sym; // the shared, read-only cache, as a run uses it
    if (v.against.length > 0 || v.testRunner) {
      cache = join(OUT, "work", `${v.build}-symbols`);
      mkdirSync(cache, { recursive: true });
      copyFileSync(join(sym, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
      for (const a of v.against)
        copyFileSync(join(OUT, `${a.build}.app`), join(cache, `LethAL Probe_${a.name}.app`));
      if (v.testRunner) {
        const dir = join(REPO, TEST_RUNNER_SYMBOLS);
        if (!existsSync(dir))
          throw new Error(`${dir} is missing: the reader needs Test Runner's symbols`);
        for (const f of readdirSync(dir).filter((n) => n.endsWith(".app")))
          if (f !== "Microsoft_System.app") copyFileSync(join(dir, f), join(cache, f));
      }
    }
    const out = join(OUT, `${v.build}.app`);
    await alcCompile(alc, work, cache, out);
    const bytes = readFileSync(out);
    const id = readAppIdentity(bytes);
    shas[v.build] = sha256Of(bytes);
    console.log(
      JSON.stringify({ built: v.build, name: id.name, version: id.version, sha256: shas[v.build] }),
    );
  }
  writeFileSync(join(OUT, "shas.json"), JSON.stringify(shas, null, 2));
}

function builtPath(name: Build): string {
  const p = join(OUT, `${name}.app`);
  if (!existsSync(p)) throw new Error(`${p} is missing: run --build first`);
  return p;
}

const built = (name: Build): Buffer => readFileSync(builtPath(name));

// ---------------------------------------------------------------------------------------------
// server helpers

class Refused extends Error {}

function holderIs(server: ServerName, lane: string): void {
  const p = Bun.spawnSync(["kraken", "coord", "holder", server]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder ${server} exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== lane)
    throw new Refused(`${server} is not held by lane ${lane}: ${out}`);
}

interface Ctx {
  readonly c: Conn;
  readonly ext: string;
  readonly server: ServerName;
}

type Row = { version: string; isInstalled: boolean };

async function read(x: Ctx, app: App): Promise<Row[]> {
  return (await rows(x.c, x.ext, app.id)).map((r) => ({
    version: rowVersion(r),
    isInstalled: r.isInstalled,
  }));
}

const absent = (r: Row[]): boolean => r.length === 0;
const installedAt = (r: Row[], v: string): boolean =>
  r.length === 1 && r[0]?.isInstalled === true && r[0].version === v;

function need(ok: boolean, what: string): void {
  if (!ok) throw new Refused(`prior state is not as expected: ${what}`);
}

/** A text is never cut: it goes whole to a file; the facts carry its hash and length. */
function saveText(fileName: string, text: string) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, fileName);
  writeFileSync(file, text);
  return {
    file,
    sha256: sha256Of(Buffer.from(text, "utf8")),
    length: text.length,
  };
}

/** Direct dev-endpoint publish (same wire shape as setup's; the error body is kept whole). */
async function publish(x: Ctx, step: string, b: Build) {
  const bytes = built(b);
  const id = readAppIdentity(bytes);
  const fileName = `${id.publisher}_${id.name}_${id.version}.app`;
  const params = new URLSearchParams({
    tenant: "default",
    SchemaUpdateMode: "forcesync",
    DependencyPublishingOption: "default",
  });
  const form = new FormData();
  form.append(fileName, new Blob([bytes]), fileName);
  const res = await (x.c.fetch ?? bcFetch)(
    `${HOST}:${portsOf(x.server).dev}/BC/dev/apps?${params}`,
    {
      method: "POST",
      headers: { authorization: x.c.authorization },
      body: form,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    },
  );
  const text = await res.text();
  return {
    build: b,
    accepted: res.ok,
    status: res.status,
    ...(res.ok ? {} : { body: text, ...saveText(`body-${step}-${b}.txt`, text) }),
  };
}

/**
 * One call of the reader's OData action `R689Reader_<proc>`. The answer (OData's scalar `value`,
 * a JSON text) goes whole to a file; the facts carry the parsed value too.
 */
async function reader(x: Ctx, step: string, proc: string, body: Record<string, unknown>) {
  const params = new URLSearchParams({ company: COMPANY, tenant: "default" });
  const res = await (x.c.fetch ?? bcFetch)(
    `${HOST}:${portsOf(x.server).odata}/BC/ODataV4/R689Reader_${proc}?${params}`,
    {
      method: "POST",
      headers: { authorization: x.c.authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    },
  );
  const text = await res.text();
  const saved = saveText(`reader-${step}-${proc}.json`, text);
  let value: unknown = null;
  if (res.ok) {
    const v = (JSON.parse(text) as { value?: unknown }).value;
    value = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  }
  return { proc, body, status: res.status, ...saved, value };
}

async function remove(x: Ctx, app: App): Promise<string[]> {
  const steps: string[] = [];
  for (const r of await rows(x.c, x.ext, app.id)) {
    const key = `${x.ext}(${r.packageId})`;
    if (r.isInstalled) {
      const u = await apiJson(x.c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
      steps.push(`uninstall ${rowVersion(r)} HTTP ${u.status}`);
      if (u.status !== 204) throw new Error(`uninstall ${app.name}: HTTP ${u.status} ${u.text}`);
    }
    const p = await apiJson(x.c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    steps.push(`unpublish ${rowVersion(r)} HTTP ${p.status}`);
    if (p.status !== 204) throw new Error(`unpublish ${app.name}: HTTP ${p.status} ${p.text}`);
  }
  return steps;
}

/**
 * Runs LethAL itself as a child process from the worktree root. Stdout and stderr go whole to
 * files; the exit code (null on a timeout kill) is in the facts.
 */
async function lethalRun(server: ServerName) {
  const config = `fixtures/sandbox-app/lethal.config.${server}.json`;
  if (!existsSync(join(REPO, config)))
    throw new Refused(`${config} is missing: run bc-linux-setup`);
  mkdirSync(OUT, { recursive: true });
  const db = join(OUT, `run-${Date.now()}.sqlite`);
  const argv = [
    "bun",
    "packages/runner/src/cli.ts",
    "run",
    "--project",
    "scripts/r689-probe/target",
    "--tests",
    "scripts/r689-probe/tests",
    "--backend",
    "bcdev",
    "--config",
    config,
    "--selector-id",
    "93887",
    "--control-id",
    "93888",
    "--table-id",
    "93889",
    "--db",
    db,
    "--out",
    join(OUT, "report.json"),
    "--progress-out",
    join(OUT, "events.ndjson"),
  ];
  const p = Bun.spawn(argv, {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return {
    argv,
    exitCode,
    signalCode: p.signalCode,
    stdout: saveText("run-stdout.txt", stdout),
    stderr: saveText("run-stderr.txt", stderr),
    report: join(OUT, "report.json"),
    events: join(OUT, "events.ndjson"),
    db,
  };
}

// ---------------------------------------------------------------------------------------------
// the steps; each returns the facts to print

type Facts = Record<string, unknown>;

async function step(x: Ctx, n: string): Promise<Facts> {
  switch (n) {
    case "1": {
      for (const a of [P, Q, R]) need(absent(await read(x, a)), `${a.name} must be absent`);
      const publishes = [];
      for (const b of ["P", "Q", "R"] as const) publishes.push(await publish(x, n, b));
      const refused = publishes.filter((p) => !p.accepted);
      // A refused publish is a failed step (exit 1), not an unexpected prior state.
      if (refused.length > 0) throw new Error(`publish refused: ${JSON.stringify(refused)}`);
      const rs = { P: await read(x, P), Q: await read(x, Q), R: await read(x, R) };
      need(
        [rs.P, rs.Q, rs.R].every((r) => installedAt(r, "1.0.0.1")),
        `P, Q, R installed at 1.0.0.1 after publish: ${JSON.stringify({ publishes, ...rs })}`,
      );
      return { publishes, ...rs };
    }
    case "2": {
      // Discovery through the reader, in its own suite: the plain codeunit FIRST (it proves the
      // service answers), then the throwing one.
      const plain = await reader(x, n, "Discover", { codeunitId: PLAIN });
      if (plain.status !== 200) throw new Error(`the reader did not answer: HTTP ${plain.status}`);
      return { plain, throwing: await reader(x, n, "Discover", { codeunitId: THROWING }) };
    }
    case "3": {
      for (const a of [P, Q])
        need(installedAt(await read(x, a), "1.0.0.1"), `${a.name} installed at 1.0.0.1`);
      return { run: await lethalRun(x.server) };
    }
    case "4":
      // What LethAL Control's own discovery left in its suites (LC*), for both codeunits.
      return {
        throwing: await reader(x, n, "ControlSuites", { codeunitId: THROWING }),
        plain: await reader(x, n, "ControlSuites", { codeunitId: PLAIN }),
      };
    case "5":
      return { webServices: await reader(x, n, "WebServices", {}) };
    case "6":
      return { P: await read(x, P), Q: await read(x, Q), R: await read(x, R) };
    case "cleanup": {
      const own = await reader(x, n, "DeleteOwn", {}).catch((e: unknown) => ({
        error: errText(e),
      }));
      const removed: Record<string, string[]> = {};
      for (const a of [R, Q, P]) removed[a.name] = await remove(x, a);
      const left: Record<string, Row[]> = {};
      for (const a of [R, Q, P]) left[a.name] = await read(x, a);
      return {
        own,
        removed,
        remained: Object.fromEntries(Object.entries(left).filter(([, r]) => r.length > 0)),
        allAbsent: Object.values(left).every(absent),
        note: "BC keeps installed-version records (Q, R at 1.0.0.1, P at the minted version) and LethAL Control's LC* suites until a restart (R605)",
      };
    }
    default:
      throw new Refused(`unknown step ${n}`);
  }
}

// ---------------------------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const server = (arg("--server") ?? "bc2") as ServerName;
  if (!(server in SERVERS)) throw new Refused(`unknown server ${server}`);
  if (process.argv.includes("--build")) {
    await build(server);
    return 0;
  }
  const lane = arg("--lane");
  if (lane === undefined) throw new Refused("--lane is required");
  holderIs(server, lane);
  const all = process.argv.includes("--all");
  const want = all ? ["1", "2", "3", "4", "5", "6"] : [arg("--step")];
  const login = readSecretFile();
  const c: Conn = {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
    fetch: ((url, init) =>
      bcFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })) as typeof fetch,
  };
  const x: Ctx = { c, ext: await extensionsApi(c), server };
  const run = async (n: string): Promise<void> => {
    console.log(JSON.stringify({ server, step: n, ...(await step(x, n)) }));
  };
  try {
    for (const n of want) {
      if (n === undefined) throw new Refused("--step or --all is required");
      await run(n);
    }
  } catch (err) {
    // --all stops at the first failure but still cleans up; the original error is printed first,
    // so a cleanup that throws cannot hide it.
    console.error(`${err instanceof Refused ? "REFUSED" : "FAILED"}: ${errText(err)}`);
    if (all) await run("cleanup");
    throw err;
  }
  if (all) await run("cleanup");
  return 0;
}

if (import.meta.main) {
  process.exit(
    await main().catch((err: unknown) => {
      console.error(`${err instanceof Refused ? "REFUSED" : "FAILED"}: ${errText(err)}`);
      return err instanceof Refused ? 2 : 1;
    }),
  );
}
