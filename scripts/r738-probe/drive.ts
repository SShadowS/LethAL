/**
 * R738 live probe (BUILT AND COMPILED OFFLINE ONLY; run on NO server). Invented AL, no tables.
 * What does a REAL `lethal run` do when the installed tests app is left stale by an altool
 * publish (R728: altool accepts a target upgrade that removes a member the tests app calls)?
 *
 *   bun scripts/r738-probe/drive.ts --build [--server bc2]       offline: compile every build
 *   bun scripts/r738-probe/drive.ts --server bc2 --lane <lane> --step 1|2|3|cleanup
 *   bun scripts/r738-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login
 * is read in this process (`readSecretFile()`) and never printed. Apps are read by id only (R433).
 * Every direct HTTP call is bounded by CALL_TIMEOUT_MS. Nothing is ever truncated: texts go whole
 * to files under .kraken-local/r738-probe/. See README.md.
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
const OUT = join(REPO, ".kraken-local", "r738-probe");
const CALL_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 900_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";

const mkApp = (id: string, name: string) => ({ id, publisher: "LethAL Probe", name });
// Run 2 (the live proof on the built head, addendum 1): the SECOND id set. bc2 keeps run 1's records
// (9ab6e9c7… at LethAL's minted version, e08e9874… at 1.0.0.1) until a restart (R605).
const P = mkApp("ed1d8576-28e2-4c30-bff1-827dd234b9b1", "R738 Probe Target");
const Q = mkApp("2dcfea83-366b-4775-9b7f-003247b39755", "R738 Probe Tests");
type App = typeof P;

/** Build -> source dir; `against` is the target build a dependent compiles against. */
const BUILDS = [
  { build: "T1", dir: "target-v1" },
  { build: "Q", dir: "tests", against: { build: "T1", name: P.name } },
  // The run's own SOURCE, compiled here only to prove it compiles; LethAL compiles it again.
  { build: "TS", dir: "target" },
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
    if ("against" in v) {
      cache = join(OUT, "work", `${v.build}-symbols`);
      mkdirSync(cache, { recursive: true });
      copyFileSync(join(sym, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
      copyFileSync(
        join(OUT, `${v.against.build}.app`),
        join(cache, `LethAL Probe_${v.against.name}.app`),
      );
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
    "scripts/r738-probe/target",
    "--tests",
    "scripts/r738-probe/tests",
    "--backend",
    "bcdev",
    "--config",
    config,
    "--selector-id",
    "93797",
    "--control-id",
    "93798",
    "--table-id",
    "93799",
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
      for (const a of [P, Q]) need(absent(await read(x, a)), `${a.name} must be absent`);
      const publishes = [];
      for (const b of ["T1", "Q"] as const) publishes.push(await publish(x, n, b));
      const rs = { P: await read(x, P), Q: await read(x, Q) };
      need(
        installedAt(rs.P, "1.0.0.1") && installedAt(rs.Q, "1.0.0.1"),
        `P, Q installed at 1.0.0.1 after publish: ${JSON.stringify({ publishes, ...rs })}`,
      );
      return { publishes, ...rs };
    }
    case "2": {
      for (const a of [P, Q])
        need(installedAt(await read(x, a), "1.0.0.1"), `${a.name} installed at 1.0.0.1`);
      return { run: await lethalRun(x.server) };
    }
    case "3":
      return { P: await read(x, P), Q: await read(x, Q) };
    case "cleanup": {
      const removed: Record<string, string[]> = {};
      for (const a of [Q, P]) removed[a.name] = await remove(x, a);
      const left: Record<string, Row[]> = {};
      for (const a of [Q, P]) left[a.name] = await read(x, a);
      return {
        removed,
        remained: Object.fromEntries(Object.entries(left).filter(([, r]) => r.length > 0)),
        allAbsent: Object.values(left).every(absent),
        note: "BC keeps installed-version records (P at the minted version, Q at 1.0.0.1) until a restart (R605)",
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
