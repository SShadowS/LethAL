/**
 * R709 live probe (NOT YET RUN on any server). Invented AL only: seven builds, no tables.
 * What is BC's FULL 422 body when an UPGRADE of a target breaks installed dependents and BC "could
 * not restore"? Needed: the exact format of its list of removed extensions, for ONE and for TWO
 * dependents. R707's probe cut bodies at 500 chars and lost it, so this one NEVER truncates a body:
 * every refusal body is written whole to .kraken-local/r709-probe/body-<step>.txt, and its sha256
 * and length go into the step's JSON line (with the full text).
 *
 *   bun scripts/r709-probe/drive.ts --build [--server bc2]       offline: compile every build
 *   bun scripts/r709-probe/drive.ts --server bc2 --lane <lane> --step 1..5|cleanup
 *   bun scripts/r709-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login
 * is read in this process through `readSecretFile()` and never printed. Apps are read by id only
 * (R433). Every step reads the state back first and refuses when it is not the state the step
 * expects. Each step prints one JSON line of facts. Every HTTP call is bounded by CALL_TIMEOUT_MS.
 * See README.md.
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
  COMPANY,
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
const OUT = join(HERE, "..", "..", ".kraken-local", "r709-probe");
const CALL_TIMEOUT_MS = 120_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";

const mkApp = (id: string, name: string) => ({ id, publisher: "LethAL Probe", name });
const T = mkApp("9ff560dd-bcde-4128-8f36-d9eaf8110c4c", "R709 Probe Target");
const D1 = mkApp("6a564aa8-4536-4653-98d2-2a9d762df994", "R709 Probe Dep One");
const D2 = mkApp("e1042b90-751b-4790-b064-1731c55bb830", "R709 Probe Dep Two");
const U = mkApp("4ccbac7b-5f98-4140-8575-8110a8ddac49", "R709 Probe Target Solo");
const E = mkApp("d296a165-7cc2-482b-b43a-3836b2f160f8", "R709 Probe Dep Solo");
type App = typeof T;

/** Build -> source dir; `against` is the target build a dependent compiles against. */
const BUILDS = [
  { build: "T1", dir: "t1" },
  { build: "T2", dir: "t2" },
  { build: "U1", dir: "u1" },
  { build: "U2", dir: "u2" },
  { build: "D1", dir: "d1", against: { build: "T1", name: T.name } },
  { build: "D2", dir: "d2", against: { build: "T1", name: T.name } },
  { build: "E", dir: "e", against: { build: "U1", name: U.name } },
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
  // Targets come first in BUILDS: a dependent compiles against T1 or U1.
  for (const v of BUILDS) {
    const work = join(OUT, "work", v.build);
    cpSync(join(HERE, v.dir), work, { recursive: true });
    const cache = join(OUT, "work", `${v.build}-symbols`);
    mkdirSync(cache, { recursive: true });
    copyFileSync(join(sym, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
    if ("against" in v)
      copyFileSync(
        join(OUT, `${v.against.build}.app`),
        join(cache, `LethAL Probe_${v.against.name}.app`),
      );
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

/** A body is never cut: it goes whole to a file; the facts carry its hash, length and text. */
function saveBody(step: string, text: string) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `body-${step}.txt`);
  writeFileSync(file, text);
  return {
    bodyFile: file,
    bodySha256: sha256Of(Buffer.from(text, "utf8")),
    bodyLength: text.length,
    body: text,
  };
}

/**
 * Our own publish (setup's `publishBytes` cuts the error body at 2000 chars). Same wire shape:
 * one multipart part named after the file.
 */
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
    ...(res.ok ? {} : saveBody(step === "3" || step === "5" ? step : `${step}-${b}`, text)),
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

/** POST `<service>_Call` over OData V4 (unbound action on the codeunit). Bodies are kept whole. */
async function call(x: Ctx, service: string) {
  const params = new URLSearchParams({ company: COMPANY, tenant: "default" });
  const url = `${HOST}:${portsOf(x.server).odata}/BC/ODataV4/${service}_Call?${params.toString()}`;
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
  if (!res.ok) return { service, status: res.status, result: null, error: text };
  try {
    return {
      service,
      status: res.status,
      result: (JSON.parse(text) as { value?: unknown }).value,
      error: "",
    };
  } catch {
    return { service, status: res.status, result: null, error: `unparsable body: ${text}` };
  }
}

// ---------------------------------------------------------------------------------------------
// the steps; each returns the facts to print

type Facts = Record<string, unknown>;

async function callsAre1(x: Ctx, services: string[]): Promise<Facts> {
  const calls = [];
  for (const s of services) calls.push(await call(x, s));
  for (const c of calls)
    need(
      c.status === 200 && c.result === 1,
      `${c.service}_Call must answer 200/1: ${JSON.stringify(c)}`,
    );
  return { calls, expected: 1 };
}

async function step(x: Ctx, n: string): Promise<Facts> {
  switch (n) {
    case "1": {
      for (const a of [T, D1, D2]) need(absent(await read(x, a)), `${a.name} must be absent`);
      const publishes = [];
      for (const b of ["T1", "D1", "D2"] as const) publishes.push(await publish(x, n, b));
      return { publishes, T: await read(x, T), D1: await read(x, D1), D2: await read(x, D2) };
    }
    case "2":
      for (const a of [T, D1, D2])
        need(installedAt(await read(x, a), "1.0.0.1"), `${a.name} installed at 1.0.0.1`);
      return callsAre1(x, ["R709DepOne", "R709DepTwo"]);
    case "3": {
      for (const a of [T, D1, D2])
        need(installedAt(await read(x, a), "1.0.0.1"), `${a.name} installed at 1.0.0.1`);
      const p = await publish(x, n, "T2");
      return {
        publishT2: p,
        T: await read(x, T),
        D1: await read(x, D1),
        D2: await read(x, D2),
        calls: [await call(x, "R709DepOne"), await call(x, "R709DepTwo")],
      };
    }
    case "4": {
      for (const a of [U, E]) need(absent(await read(x, a)), `${a.name} must be absent`);
      const publishes = [await publish(x, n, "U1")];
      publishes.push(await publish(x, n, "E"));
      const rs = { U: await read(x, U), E: await read(x, E) };
      need(installedAt(rs.U, "1.0.0.1") && installedAt(rs.E, "1.0.0.1"), "U and E installed");
      return { publishes, ...rs, ...(await callsAre1(x, ["R709DepSolo"])) };
    }
    case "5": {
      for (const a of [U, E])
        need(installedAt(await read(x, a), "1.0.0.1"), `${a.name} installed at 1.0.0.1`);
      const p = await publish(x, n, "U2");
      return {
        publishU2: p,
        U: await read(x, U),
        E: await read(x, E),
        calls: [await call(x, "R709DepSolo")],
      };
    }
    case "cleanup": {
      const removed: Record<string, string[]> = {};
      for (const a of [D1, D2, T, E, U]) removed[a.name] = await remove(x, a);
      const left: Record<string, Row[]> = {};
      for (const a of [D1, D2, T, E, U]) left[a.name] = await read(x, a);
      return {
        removed,
        remained: Object.fromEntries(Object.entries(left).filter(([, r]) => r.length > 0)),
        allAbsent: Object.values(left).every(absent),
        note: "BC keeps its installed-version record (1.0.0.2 for T and U) until a restart",
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
  const want = all ? ["1", "2", "3", "4", "5"] : [arg("--step")];
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
    // --all stops at the first refusal-to-proceed but still cleans up.
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
