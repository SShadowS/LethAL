/**
 * R623 + R605 live probe (NOT YET RUN on any server). Invented AL only: two apps, no tables.
 *
 *   bun scripts/r623-probe/drive.ts --build [--server bc2]       offline: compile every variant
 *   bun scripts/r623-probe/drive.ts --server bc2 --lane <lane> --step 1..6|cleanup
 *   bun scripts/r623-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login
 * is read in this process through `readSecretFile()` and never printed. Apps are read by id only
 * (R433). Every step reads the state back first and refuses when it is not the state the step
 * expects. Each step prints one JSON line of facts: no credential, no source. Every HTTP call is
 * bounded by CALL_TIMEOUT_MS. See README.md.
 *
 * Exit: 0 ok; 1 a step failed; 2 refused (guard or unexpected prior state).
 */
import {
  copyFileSync,
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
  SERVERS,
  type ServerName,
  apiJson,
  extensionsApi,
  publishBytes,
  residentPackage,
  rowVersion,
  rows,
  sha256Of,
} from "../bc-app-content.ts";
import { alcCompile, errText, readSecretFile } from "../bc-linux-setup.ts";

const HERE = import.meta.dir;
const OUT = join(HERE, "..", "..", ".kraken-local", "r623-probe");
const CALL_TIMEOUT_MS = 120_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";

const A = {
  id: "3543fecd-9a43-4256-a10d-8d6df316c223",
  publisher: "LethAL Probe",
  name: "R623 Probe Target",
};
const B = {
  id: "5ea135b0-2061-4c4c-9be0-d3c8a17a9182",
  publisher: "LethAL Probe",
  name: "R623 Probe Dependent",
};
type App = typeof A;

/** Build name -> what it is. X returns 1, Y returns 2 (same version as X on purpose). */
const VARIANTS = [
  { build: "tX1", dir: "target", version: "1.0.0.1", exit: 1 },
  { build: "tY1", dir: "target", version: "1.0.0.1", exit: 2 },
  { build: "t5", dir: "target", version: "1.0.0.5", exit: 1 },
  { build: "t2", dir: "target", version: "1.0.0.2", exit: 1 },
  { build: "t6", dir: "target", version: "1.0.0.6", exit: 1 },
  { build: "dep", dir: "dependent", version: "1.0.0.1", exit: 0 },
] as const;
type Build = (typeof VARIANTS)[number]["build"];

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
  // The target variants first: the dependent compiles against tX1.
  for (const v of [...VARIANTS].sort((a, b) =>
    a.dir === b.dir ? 0 : a.dir === "target" ? -1 : 1,
  )) {
    const work = join(OUT, "work", v.build);
    mkdirSync(join(work, "src"), { recursive: true });
    const srcName = v.dir === "target" ? "Target.Codeunit.al" : "Dependent.Codeunit.al";
    let al = readFileSync(join(HERE, v.dir, "src", srcName), "utf8");
    if (v.dir === "target") {
      if (!al.includes("exit(1);")) throw new Error("Target.Codeunit.al lost its exit(1) line");
      al = al.replace("exit(1);", `exit(${v.exit});`);
    }
    writeFileSync(join(work, "src", srcName), al);
    const app = JSON.parse(readFileSync(join(HERE, v.dir, "app.json"), "utf8")) as {
      version: string;
    };
    if (v.dir === "target") app.version = v.version;
    writeFileSync(join(work, "app.json"), JSON.stringify(app, null, 2));
    const cache = join(OUT, "work", `${v.build}-symbols`);
    mkdirSync(cache, { recursive: true });
    copyFileSync(join(sym, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
    if (v.dir === "dependent")
      copyFileSync(join(OUT, "tX1.app"), join(cache, "LethAL Probe_R623 Probe Target.app"));
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

function built(name: Build): Buffer {
  const p = join(OUT, `${name}.app`);
  if (!existsSync(p)) throw new Error(`${p} is missing: run --build first`);
  return readFileSync(p);
}

function label(bytes: Buffer): Build | null {
  const s = sha256Of(bytes);
  return VARIANTS.find((v) => sha256Of(built(v.build)) === s)?.build ?? null;
}

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

interface Seen {
  readonly rows: { version: string; isInstalled: boolean; packageId: string }[];
  readonly residentVersion: string | null;
  readonly residentIs: Build | null;
}

async function read(x: Ctx, app: App): Promise<Seen> {
  const rs = (await rows(x.c, x.ext, app.id)).map((r) => ({
    version: rowVersion(r),
    isInstalled: r.isInstalled,
    packageId: r.packageId,
  }));
  const pkg = await residentPackage(x.c, app.publisher, app.name);
  return {
    rows: rs,
    residentVersion: pkg === null ? null : readAppIdentity(pkg).version,
    residentIs: pkg === null ? null : label(pkg),
  };
}

const absent = (s: Seen): boolean => s.rows.length === 0 && s.residentVersion === null;
const installedAt = (s: Seen, v: string): boolean =>
  s.rows.length === 1 && s.rows[0]?.isInstalled === true && s.rows[0].version === v;

function need(ok: boolean, what: string): void {
  if (!ok) throw new Refused(`prior state is not as expected: ${what}`);
}

interface PubResult {
  accepted: boolean;
  status: number;
  body: string;
}

/** Setup's own publish path (`publishBytes`); a refusal arrives as its "(HTTP n): body" error. */
async function publish(x: Ctx, b: Build): Promise<PubResult> {
  const bytes = built(b);
  const id = readAppIdentity(bytes);
  try {
    await publishBytes(x.c, `${id.publisher}_${id.name}_${id.version}.app`, bytes);
    return { accepted: true, status: 200, body: "" };
  } catch (err) {
    const m = /\(HTTP (\d+)\): ([\s\S]*)$/.exec(errText(err));
    if (m === null) throw err;
    return { accepted: false, status: Number(m[1]), body: (m[2] ?? "").slice(0, 500) };
  }
}

async function remove(x: Ctx, app: App): Promise<string[]> {
  const steps: string[] = [];
  for (const r of await rows(x.c, x.ext, app.id)) {
    const key = `${x.ext}(${r.packageId})`;
    if (r.isInstalled) {
      const u = await apiJson(x.c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
      steps.push(`uninstall ${rowVersion(r)} HTTP ${u.status}`);
      if (u.status !== 204)
        throw new Error(`uninstall ${app.name}: HTTP ${u.status} ${u.text.slice(0, 500)}`);
    }
    const p = await apiJson(x.c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    steps.push(`unpublish ${rowVersion(r)} HTTP ${p.status}`);
    if (p.status !== 204)
      throw new Error(`unpublish ${app.name}: HTTP ${p.status} ${p.text.slice(0, 500)}`);
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// state kept between steps (only what a read-back cannot tell)

const stateFile = (s: ServerName): string => join(OUT, `${s}-state.json`);
function loadState(s: ServerName): { step3Accepted?: boolean } {
  return existsSync(stateFile(s))
    ? (JSON.parse(readFileSync(stateFile(s), "utf8")) as { step3Accepted?: boolean })
    : {};
}

// ---------------------------------------------------------------------------------------------
// the steps; each returns the facts to print

type Facts = Record<string, unknown>;

async function step(x: Ctx, n: string): Promise<Facts> {
  switch (n) {
    case "1": {
      need(absent(await read(x, A)) && absent(await read(x, B)), "A and B must both be absent");
      const pa = await publish(x, "tX1");
      const pb = await publish(x, "dep");
      return { publishA: pa, publishB: pb, A: await read(x, A), B: await read(x, B) };
    }
    case "2": {
      const a = await read(x, A);
      need(
        installedAt(a, "1.0.0.1") && a.residentIs === "tX1",
        "A installed at 1.0.0.1 with the X bytes",
      );
      need(installedAt(await read(x, B), "1.0.0.1"), "B installed at 1.0.0.1");
      const p = await publish(x, "tY1");
      return { publishAY: p, A: await read(x, A), B: await read(x, B) };
    }
    case "3": {
      need((await read(x, A)).rows.length === 1, "A present (one row)");
      need(installedAt(await read(x, B), "1.0.0.1"), "B installed at 1.0.0.1");
      const p = await publish(x, "t5");
      mkdirSync(OUT, { recursive: true });
      writeFileSync(stateFile(x.server), JSON.stringify({ step3Accepted: p.accepted }));
      return { publishA5: p, A: await read(x, A), B: await read(x, B) };
    }
    case "4": {
      need(
        (await read(x, A)).rows.length === 1 && (await read(x, B)).rows.length === 1,
        "A and B present",
      );
      const rb = await remove(x, B);
      const ra = await remove(x, A);
      return { removeB: rb, removeA: ra, A: await read(x, A), B: await read(x, B) };
    }
    case "5": {
      need(absent(await read(x, A)) && absent(await read(x, B)), "A and B must both be absent");
      need(
        loadState(x.server).step3Accepted === true,
        "step 3 must have been accepted (no 1.0.0.5 record otherwise)",
      );
      const p = await publish(x, "t2");
      return { publishA2: p, A: await read(x, A) };
    }
    case "6": {
      const a = await read(x, A);
      need(absent(a) || installedAt(a, "1.0.0.2"), "A absent or installed at 1.0.0.2");
      need(absent(await read(x, B)), "B absent");
      const p = await publish(x, "t6");
      return { publishA6: p, A: await read(x, A) };
    }
    case "cleanup": {
      const rb = await remove(x, B);
      const ra = await remove(x, A);
      const a = await read(x, A);
      const b = await read(x, B);
      return {
        removeB: rb,
        removeA: ra,
        A: a,
        B: b,
        bothAbsent: absent(a) && absent(b),
        note: "BC keeps its installed-version record (the highest version published here) until a restart",
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
  const want = process.argv.includes("--all")
    ? ["1", "2", "3", "4", "5", "6", "cleanup"]
    : [arg("--step")];
  const login = readSecretFile();
  const c: Conn = {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
    fetch: ((url, init) =>
      bcFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })) as typeof fetch,
  };
  const x: Ctx = { c, ext: await extensionsApi(c), server };
  for (const n of want) {
    if (n === undefined) throw new Refused("--step or --all is required");
    const facts = await step(x, n);
    console.log(JSON.stringify({ server, step: n, ...facts }));
  }
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
