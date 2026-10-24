/**
 * R740 live probe (BUILT AND COMPILED OFFLINE ONLY; run on NO server). Invented AL, no tables.
 * What does a REAL `lethal run` do when the stale member belongs to a DEPENDENCY the installed tests
 * app calls (library L upgraded through LethAL's own deployer under a tests app Q not recompiled)?
 *
 *   bun scripts/r740-probe/drive.ts --build [--server bc2]       offline: compile every build
 *   bun scripts/r740-probe/drive.ts --server bc2 --lane <lane> --step 1|2|3|4|cleanup
 *   bun scripts/r740-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login
 * is read in this process (`readSecretFile()`; step 2's deployer and step 3's run via the repo's own
 * fixture-config reader) and never printed. Apps are read by id only (R433). Every direct HTTP call
 * is bounded by CALL_TIMEOUT_MS. Nothing is ever truncated: texts go whole to files under
 * .kraken-local/r740-probe/. See README.md.
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
import { itestConfigPath, readFixtureConfig } from "../../packages/runner/itest/config-path.ts";
import { bcFetch } from "../../packages/runner/src/bc-fetch.ts";
import {
  deployerFor,
  resolveAlToolPaths,
  validateBcDevConfig,
} from "../../packages/runner/src/cli.ts";
import { readAppIdentity } from "../../packages/runner/src/published-test-app.ts";
import { defaultAlToolPaths } from "../../packages/runner/src/publisher.ts";
import {
  type Conn,
  HOST,
  SERVERS,
  type ServerName,
  apiJson,
  extensionsApi,
  portsOf,
  residentPackage,
  rowVersion,
  rows,
  sha256Of,
} from "../bc-app-content.ts";
import { alcCompile, errText, readSecretFile } from "../bc-linux-setup.ts";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const OUT = join(REPO, ".kraken-local", "r740-probe");
const CALL_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 900_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";
const FIXTURE_DIR = join(REPO, "fixtures", "sandbox-app");

const mkApp = (id: string, name: string) => ({ id, publisher: "LethAL Probe", name });
// Set 1. Set 2 (NOT built; replace the ids in the app.json files and here, and the tests' dependency
// block): L edbf191d-45cd-45dd-bd38-f9910c0d60a7, P ef6468b3-8053-4383-a69a-8114dd06fd12,
// Q a3014e4e-2f3e-4185-8fce-0519bd133e3a.
const L = mkApp("916727ff-fac6-40f5-bc66-38800422d6d6", "R740 Probe Lib");
const P = mkApp("157d4738-4e4d-410b-b1be-743a3ba29106", "R740 Probe Target");
const Q = mkApp("a2a9b0bb-7274-42ae-8eee-89f12b23a6f2", "R740 Probe Tests");
type App = typeof P;

/** Build -> source dir; `against` lists the builds (and their names) a dependent compiles against. */
const BUILDS = [
  { build: "L1", dir: "lib-v1" },
  { build: "L2", dir: "lib-v2" },
  // The run's own SOURCE, compiled here only to prove it compiles; LethAL compiles it again.
  { build: "P", dir: "target" },
  {
    build: "Q",
    dir: "tests",
    against: [
      { build: "L1", name: L.name },
      { build: "P", name: P.name },
    ],
  },
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
/** Exactly one row is installed and it is at `v` (an upgrade may leave an old, uninstalled row). */
const installedNow = (r: Row[], v: string): boolean => {
  const on = r.filter((x) => x.isInstalled);
  return on.length === 1 && on[0]?.version === v;
};

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
 * Publish L2 through the SAME deployer a real run builds (as r728-probe's step 3): the server's
 * lethal config is read by the repo's own fixture reader and validated by `validateBcDevConfig`,
 * the altool path follows cli.ts's precedence, and `deployerFor` makes the `ContainerDeployer`.
 * A throw is a FACT: its full text goes to a file and the step goes on. Nothing is read or
 * printed from the config here.
 */
async function publishL2ViaDeployer(server: ServerName) {
  const cfgPath = itestConfigPath(FIXTURE_DIR, {
    ...process.env,
    LETHAL_ITEST_CONFIG: `lethal.config.${server}.json`,
  });
  const bcdev = validateBcDevConfig(readFixtureConfig(cfgPath).bcdev);
  const discovered = await defaultAlToolPaths();
  const { altoolPath } = resolveAlToolPaths(bcdev, discovered ?? undefined);
  if (altoolPath === undefined) throw new Error("could not locate altool (bcdev.altoolPath unset)");
  const deployer = deployerFor(bcdev, altoolPath);
  const appPath = builtPath("L2");
  const sha256 = sha256Of(readFileSync(appPath));
  try {
    await deployer.publish({ appPath, sha256 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      threw: true,
      errorName: err instanceof Error ? err.name : typeof err,
      error: saveText("error-2.txt", msg),
    };
  }
  return { threw: false };
}

/** Which version `dev/packages` serves for L (publisher + name, no listing of extensions). */
async function servedVersionOfL(x: Ctx) {
  try {
    const pkg = await residentPackage(x.c, L.publisher, L.name);
    if (pkg === null) return { served: null };
    const id = readAppIdentity(pkg);
    return { served: { name: id.name, version: id.version, sha256: sha256Of(pkg) } };
  } catch (err) {
    return { servedError: saveText("error-2-package.txt", errText(err)) };
  }
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
    "scripts/r740-probe/target",
    "--tests",
    "scripts/r740-probe/tests",
    "--backend",
    "bcdev",
    "--config",
    config,
    "--selector-id",
    "93837",
    "--control-id",
    "93838",
    "--table-id",
    "93839",
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

const readAll = async (x: Ctx) => ({
  L: await read(x, L),
  P: await read(x, P),
  Q: await read(x, Q),
});

async function step(x: Ctx, n: string): Promise<Facts> {
  switch (n) {
    case "1": {
      for (const a of [L, P, Q]) need(absent(await read(x, a)), `${a.name} must be absent`);
      const publishes = [];
      for (const b of ["L1", "P", "Q"] as const) publishes.push(await publish(x, n, b));
      const rs = await readAll(x);
      need(
        installedAt(rs.L, "1.0.0.1") &&
          installedAt(rs.P, "1.0.0.1") &&
          installedAt(rs.Q, "1.0.0.1"),
        `L, P, Q installed at 1.0.0.1 after publish: ${JSON.stringify({ publishes, ...rs })}`,
      );
      return { publishes, ...rs };
    }
    case "2": {
      const rs = await readAll(x);
      need(
        installedAt(rs.L, "1.0.0.1") &&
          installedAt(rs.P, "1.0.0.1") &&
          installedAt(rs.Q, "1.0.0.1"),
        "L, P, Q installed at 1.0.0.1",
      );
      const deployer = await publishL2ViaDeployer(x.server);
      return { deployer, ...(await readAll(x)), ...(await servedVersionOfL(x)) };
    }
    case "3": {
      const rs = await readAll(x);
      need(installedNow(rs.L, "1.0.0.2"), `L installed at 1.0.0.2: ${JSON.stringify(rs.L)}`);
      need(installedAt(rs.Q, "1.0.0.1"), `Q installed at 1.0.0.1: ${JSON.stringify(rs.Q)}`);
      return { run: await lethalRun(x.server) };
    }
    case "4":
      return await readAll(x);
    case "cleanup": {
      const removed: Record<string, string[]> = {};
      for (const a of [Q, P, L]) removed[a.name] = await remove(x, a);
      const left: Record<string, Row[]> = {};
      for (const a of [Q, P, L]) left[a.name] = await read(x, a);
      return {
        removed,
        remained: Object.fromEntries(Object.entries(left).filter(([, r]) => r.length > 0)),
        allAbsent: Object.values(left).every(absent),
        note: "BC keeps installed-version records (L at 1.0.0.2, P at the minted version, Q at 1.0.0.1) until a restart (R605)",
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
  const want = all ? ["1", "2", "3", "4"] : [arg("--step")];
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
