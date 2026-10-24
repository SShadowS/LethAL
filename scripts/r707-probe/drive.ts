/**
 * R707 live probe (NOT YET RUN on any server). Invented AL only: two apps, no tables.
 * What does BC do with an installed dependent B when its target A is republished with a changed
 * signature (A1s, same version), with Answer removed (A2r, an upgrade), and with Answer restored (A3)?
 *
 *   bun scripts/r707-probe/drive.ts --build [--server bc2]       offline: compile every variant
 *   bun scripts/r707-probe/drive.ts --server bc2 --lane <lane> --step 1..5|cleanup
 *   bun scripts/r707-probe/drive.ts --server bc2 --lane <lane> --all
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
  COMPANY,
  type Conn,
  HOST,
  SERVERS,
  type ServerName,
  apiJson,
  extensionsApi,
  portsOf,
  publishBytes,
  residentPackage,
  rowVersion,
  rows,
  sha256Of,
} from "../bc-app-content.ts";
import { alcCompile, errText, readSecretFile } from "../bc-linux-setup.ts";

const HERE = import.meta.dir;
const OUT = join(HERE, "..", "..", ".kraken-local", "r707-probe");
const CALL_TIMEOUT_MS = 120_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";

const A = {
  id: "e390149d-8472-4ab1-b1ea-3e10a42156bb",
  publisher: "LethAL Probe",
  name: "R707 Probe Target",
};
const B = {
  id: "76068df3-2038-49cd-b992-51ea13158bda",
  publisher: "LethAL Probe",
  name: "R707 Probe Dependent",
};
type App = typeof A;

/** Build name -> what it is. A1s has the SAME version as A1 on purpose. */
const VARIANTS = [
  { build: "A1", dir: "target", version: "1.0.0.1" },
  { build: "A1s", dir: "target", version: "1.0.0.1" },
  { build: "A2r", dir: "target", version: "1.0.0.2" },
  { build: "A3", dir: "target", version: "1.0.0.3" },
  { build: "B", dir: "dependent", version: "1.0.0.1" },
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
  // The target variants first: B compiles against A1.
  for (const v of VARIANTS) {
    const work = join(OUT, "work", v.build);
    mkdirSync(join(work, "src"), { recursive: true });
    if (v.dir === "target") {
      copyFileSync(
        join(HERE, "target", "variants", `${v.build}.al`),
        join(work, "src", "Target.al"),
      );
    } else {
      for (const f of readdirSync(join(HERE, "dependent", "src")))
        copyFileSync(join(HERE, "dependent", "src", f), join(work, "src", f));
    }
    const app = JSON.parse(readFileSync(join(HERE, v.dir, "app.json"), "utf8")) as {
      version: string;
    };
    if (v.dir === "target") app.version = v.version;
    writeFileSync(join(work, "app.json"), JSON.stringify(app, null, 2));
    const cache = join(OUT, "work", `${v.build}-symbols`);
    mkdirSync(cache, { recursive: true });
    copyFileSync(join(sym, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
    if (v.dir === "dependent")
      copyFileSync(join(OUT, "A1.app"), join(cache, "LethAL Probe_R707 Probe Target.app"));
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

interface CallResult {
  status: number;
  /** The "value" of a 2xx answer, else null. */
  result: unknown;
  /** The first 500 chars of a non-2xx body. */
  error: string;
}

/** POST B's web service `R707Dep_Call` over OData V4 (unbound action on the codeunit). */
async function callB(x: Ctx): Promise<CallResult> {
  const params = new URLSearchParams({ company: COMPANY, tenant: "default" });
  const url = `${HOST}:${portsOf(x.server).odata}/BC/ODataV4/R707Dep_Call?${params.toString()}`;
  const res = await (x.c.fetch ?? bcFetch)(url, {
    method: "POST",
    headers: {
      authorization: x.c.authorization,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, result: null, error: text.slice(0, 500) };
  try {
    return {
      status: res.status,
      result: (JSON.parse(text) as { value?: unknown }).value,
      error: "",
    };
  } catch {
    return { status: res.status, result: null, error: `unparsable body: ${text.slice(0, 500)}` };
  }
}

// ---------------------------------------------------------------------------------------------
// the steps; each returns the facts to print

type Facts = Record<string, unknown>;

/** Steps 3-5: publish a build of A under B, then read both back and call B again. */
async function republishA(x: Ctx, b: Build, key: string): Promise<Facts> {
  need((await read(x, A)).rows.length === 1, "A present (one row)");
  need((await read(x, B)).rows.length === 1, "B present (one row)");
  const p = await publish(x, b);
  return { [key]: p, A: await read(x, A), B: await read(x, B), callB: await callB(x) };
}

async function step(x: Ctx, n: string): Promise<Facts> {
  switch (n) {
    case "1": {
      need(absent(await read(x, A)) && absent(await read(x, B)), "A and B must both be absent");
      const pa = await publish(x, "A1");
      const pb = await publish(x, "B");
      return { publishA1: pa, publishB: pb, A: await read(x, A), B: await read(x, B) };
    }
    case "2": {
      need(
        installedAt(await read(x, A), "1.0.0.1") && (await read(x, A)).residentIs === "A1",
        "A installed at 1.0.0.1 with the A1 bytes",
      );
      need(installedAt(await read(x, B), "1.0.0.1"), "B installed at 1.0.0.1");
      const call = await callB(x);
      // A 404 means the web service is not registered: the probe is wrong, not a measurement.
      need(call.status !== 404, `R707Dep_Call answered 404 (probe error): ${call.error}`);
      return { callB: call, expected: 1 };
    }
    case "3":
      need(installedAt(await read(x, A), "1.0.0.1"), "A installed at 1.0.0.1");
      need(installedAt(await read(x, B), "1.0.0.1"), "B installed at 1.0.0.1");
      return republishA(x, "A1s", "publishA1s");
    case "4":
      return republishA(x, "A2r", "publishA2r");
    case "5":
      return republishA(x, "A3", "publishA3");
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
    ? ["1", "2", "3", "4", "5", "cleanup"]
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
