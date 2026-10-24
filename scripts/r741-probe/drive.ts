/**
 * R741 live probe (copied from R738's). Invented AL, one table, no loops (R164).
 * When the run's target removes a member it added through a tableextension or a pageextension,
 * which object id does BC name in "The object with ID <id> does not have a member with that ID":
 * the extension's own, or the BASE object's (another app's)?
 *
 *   bun scripts/r741-probe/drive.ts --build [--server bc2]       offline: compile every build
 *   bun scripts/r741-probe/drive.ts --server bc2 --lane <lane> --step 1|2|3|cleanup
 *   bun scripts/r741-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login
 * is read in this process (`readSecretFile()`) and never printed. Apps are read by id only (R433).
 * Every direct HTTP call is bounded by CALL_TIMEOUT_MS. Nothing is ever truncated: texts go whole
 * to files under .kraken-local/r741-probe/. See README.md.
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
const OUT = join(REPO, ".kraken-local", "r741-probe");
const CALL_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 900_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";

const mkApp = (id: string, name: string) => ({ id, publisher: "LethAL Probe", name });
// Run 2 (the live proof of R749 on the built head): the SECOND id set. bc2 keeps run 1's records
// (set 1: 35e61124…, 7eafd7d0…, ef054a8e…) until a restart (R605).
const B = mkApp("28c577b9-5e6a-4735-add0-bd6c3f451ea6", "R741 Probe Base");
const P = mkApp("15fda437-a323-4426-8a43-1e24acfb18b2", "R741 Probe Target");
const Q = mkApp("87ce8474-9f15-4641-bbed-b8d6ae3c0103", "R741 Probe Tests");
type App = typeof P;

/** Build -> source dir; `against` are the builds a dependent compiles against. */
const BUILDS = [
  { build: "B", dir: "base", against: [] },
  { build: "T1", dir: "target-v1", against: [{ build: "B", name: B.name }] },
  {
    build: "Q",
    dir: "tests",
    against: [
      { build: "B", name: B.name },
      { build: "T1", name: P.name },
    ],
  },
  // The run's own SOURCE, compiled here only to prove it compiles; LethAL compiles it again.
  { build: "TS", dir: "target", against: [{ build: "B", name: B.name }] },
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
    if (v.against.length > 0) {
      cache = join(OUT, "work", `${v.build}-symbols`);
      mkdirSync(cache, { recursive: true });
      copyFileSync(join(sym, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
      for (const a of v.against)
        copyFileSync(join(OUT, `${a.build}.app`), join(cache, `LethAL Probe_${a.name}.app`));
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

function holderIs(server: ServerName, lane: string): void {
  const p = Bun.spawnSync(["kraken", "coord", "holder", server]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder ${server} exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== lane)
    throw new Error(`${server} is not held by lane ${lane}: ${out}`);
}

class Refused extends Error {}

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
  const base = `fixtures/sandbox-app/lethal.config.${server}.json`;
  if (!existsSync(join(REPO, base))) throw new Refused(`${base} is missing: run bc-linux-setup`);
  mkdirSync(OUT, { recursive: true });
  // The target depends on B, whose symbols the shared cache (Microsoft only) lacks: the run gets a
  // probe-local cache (the shared cache's .app files copied, plus B) through a gitignored copy of
  // the config with only bcdev.packageCachePath changed. The copy holds the login: never printed,
  // removed by cleanup.
  const cfg = JSON.parse(readFileSync(join(REPO, base), "utf8")) as {
    bcdev: { packageCachePath: string };
  };
  const cache = join(OUT, "pkgcache");
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const shared = cfg.bcdev.packageCachePath;
  const linked = readdirSync(shared).filter((f) => f.toLowerCase().endsWith(".app"));
  for (const f of linked) copyFileSync(join(shared, f), join(cache, f));
  copyFileSync(builtPath("B"), join(cache, `LethAL Probe_${B.name}.app`));
  cfg.bcdev.packageCachePath = cache;
  const config = join(OUT, "run.config.json");
  writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  const db = join(OUT, `run-${Date.now()}.sqlite`);
  const argv = [
    "bun",
    "packages/runner/src/cli.ts",
    "run",
    "--project",
    "scripts/r741-probe/target",
    "--tests",
    "scripts/r741-probe/tests",
    "--backend",
    "bcdev",
    "--config",
    config,
    "--selector-id",
    "93867",
    "--control-id",
    "93868",
    "--table-id",
    "93869",
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
    cache: { dir: cache, shared, copied: linked, added: `LethAL Probe_${B.name}.app` },
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
      for (const a of [B, P, Q]) need(absent(await read(x, a)), `${a.name} must be absent`);
      const publishes = [];
      for (const b of ["B", "T1", "Q"] as const) publishes.push(await publish(x, n, b));
      const rs = { B: await read(x, B), P: await read(x, P), Q: await read(x, Q) };
      need(
        [rs.B, rs.P, rs.Q].every((r) => installedAt(r, "1.0.0.1")),
        `B, P, Q installed at 1.0.0.1 after publish: ${JSON.stringify({ publishes, ...rs })}`,
      );
      return { publishes, ...rs };
    }
    case "2": {
      for (const a of [B, P, Q])
        need(installedAt(await read(x, a), "1.0.0.1"), `${a.name} installed at 1.0.0.1`);
      return { run: await lethalRun(x.server) };
    }
    case "3":
      return { B: await read(x, B), P: await read(x, P), Q: await read(x, Q) };
    case "cleanup": {
      const removed: Record<string, string[]> = {};
      for (const a of [Q, P, B]) removed[a.name] = await remove(x, a);
      const left: Record<string, Row[]> = {};
      for (const a of [Q, P, B]) left[a.name] = await read(x, a);
      rmSync(join(OUT, "run.config.json"), { force: true });
      return {
        removed,
        remained: Object.fromEntries(Object.entries(left).filter(([, r]) => r.length > 0)),
        allAbsent: Object.values(left).every(absent),
        note: "BC keeps installed-version records (B and Q at 1.0.0.1, P at the minted version) until a restart (R605)",
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
  const want = all ? ["1", "2", "3"] : [arg("--step")];
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
    // --all stops at the first failure but still cleans up.
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
