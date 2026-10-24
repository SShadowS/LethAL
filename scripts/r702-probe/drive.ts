/**
 * R702 gap 2 live probe (NOT YET RUN on any server). Invented AL only: one app, one table.
 * Does Next see rows moved or inserted ahead of the cursor when the walked record is TEMPORARY?
 * Cells: legs T1c, T1v, T3o, T3c, L2, L2b x find FindSet, FindSetTrue, FindMinus x temp yes/no x N 3, 60, 1000.
 * Every walk is capped inside the AL (3N+10 visits, checked before every action). See README.md.
 *
 *   bun scripts/r702-probe/drive.ts --build [--server bc2]       offline: compile the app
 *   bun scripts/r702-probe/drive.ts --server bc2 --lane <lane> --step publish|run-perm|run-temp|cleanup
 *   bun scripts/r702-probe/drive.ts --server bc2 --lane <lane> --all
 *
 * A server step REFUSES (exit 2) unless `kraken coord holder <server>` names `--lane`. The login is read
 * in this process through `readSecretFile()` and never printed. The app is read by id only (R433). Each
 * HTTP call is bounded by CALL_TIMEOUT_MS. Results go to .kraken-local/r702-probe/results.tsv.
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
  rowVersion,
  rows,
  sha256Of,
} from "../bc-app-content.ts";
import { alcCompile, errText, readSecretFile } from "../bc-linux-setup.ts";

const HERE = import.meta.dir;
const OUT = join(HERE, "..", "..", ".kraken-local", "r702-probe");
const CALL_TIMEOUT_MS = 120_000;
const SYMBOL_ROOT = "/coord/cache/bc-symbols";

const APP = {
  id: "b0a9bc3f-6c05-4dc5-97ae-fcea6eb0d3e6",
  publisher: "LethAL Probe",
  name: "R702 Temp Walk Probe",
};
const LEGS = ["T1c", "T1v", "T3o", "T3c", "L2", "L2b"] as const;
const FINDS = ["FindSet", "FindSetTrue", "FindMinus"] as const;
const NS = [3, 60, 1000] as const;
const APP_FILE = join(OUT, "R702.app");

// ---------------------------------------------------------------------------------------------
// offline build

async function build(server: ServerName): Promise<void> {
  const alcDir = process.env.LETHAL_ALC_DIR;
  if (alcDir === undefined) throw new Error("LETHAL_ALC_DIR is not set");
  const root = join(SYMBOL_ROOT, server);
  const dir = readdirSync(root).sort().at(-1);
  if (dir === undefined) throw new Error(`no symbol cache under ${root}; run bc-linux-setup first`);
  rmSync(OUT, { recursive: true, force: true });
  const work = join(OUT, "work");
  const cache = join(OUT, "symbols");
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(cache, { recursive: true });
  copyFileSync(join(HERE, "app", "app.json"), join(work, "app.json"));
  for (const f of readdirSync(join(HERE, "app", "src")))
    copyFileSync(join(HERE, "app", "src", f), join(work, "src", f));
  copyFileSync(join(root, dir, "Microsoft_System.app"), join(cache, "Microsoft_System.app"));
  await alcCompile(join(alcDir, "alc"), work, cache, APP_FILE);
  const bytes = readFileSync(APP_FILE);
  const id = readAppIdentity(bytes);
  const shas = { R702: sha256Of(bytes) };
  writeFileSync(join(OUT, "shas.json"), JSON.stringify(shas, null, 2));
  console.log(
    JSON.stringify({ built: "R702", name: id.name, version: id.version, sha256: shas.R702 }),
  );
}

// ---------------------------------------------------------------------------------------------
// server helpers

class Refused extends Error {}

function holderIs(server: ServerName, lane: string): void {
  const p = Bun.spawnSync(["kraken", "coord", "holder", server]);
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`kraken coord holder ${server} exited ${p.exitCode}`);
  const h = JSON.parse(out) as { lane?: unknown } | null;
  if (h === null || h.lane !== lane)
    throw new Error(`${server} is not held by lane ${lane}: ${out}`);
}

interface Ctx {
  readonly c: Conn;
  readonly ext: string;
  readonly server: ServerName;
}

async function seen(x: Ctx): Promise<{ version: string; isInstalled: boolean }[]> {
  return (await rows(x.c, x.ext, APP.id)).map((r) => ({
    version: rowVersion(r),
    isInstalled: r.isInstalled,
  }));
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new Refused(`prior state is not as expected: ${what}`);
}

async function callLeg(
  x: Ctx,
  leg: string,
  find: string,
  n: number,
  temp: boolean,
): Promise<string> {
  const params = new URLSearchParams({ company: COMPANY, tenant: "default" });
  const url = `${HOST}:${portsOf(x.server).odata}/BC/ODataV4/R702Probe_RunLeg?${params.toString()}`;
  const res = await (x.c.fetch ?? bcFetch)(url, {
    method: "POST",
    headers: {
      authorization: x.c.authorization,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ leg, find, n, isTemp: temp }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 400).replace(/\s+/g, " ")}`);
  return (JSON.parse(text) as { value: string }).value;
}

// ---------------------------------------------------------------------------------------------
// the steps

type Facts = Record<string, unknown>;

async function runCells(x: Ctx, temp: boolean): Promise<Facts> {
  const tsv = join(OUT, "results.tsv");
  const head = "temp\tleg\tfind\tN\tvisits\tdistinct\tmaxPerId\tcapped\tfirst20\trows\tperm\traw";
  const lines = existsSync(tsv) ? readFileSync(tsv, "utf8").trimEnd().split("\n") : [head];
  let cells = 0;
  for (const n of NS)
    for (const leg of LEGS)
      for (const find of FINDS) {
        const raw = await callLeg(x, leg, find, n, temp);
        const f = (k: string) => new RegExp(`${k}=([^;|]*)`).exec(raw)?.[1] ?? "";
        const cols = [
          temp ? "temp" : "perm",
          leg,
          find,
          n,
          f("visits"),
          f("distinct"),
          f("maxPerId"),
          f("capped"),
          f("first20"),
          f("rows"),
          f("perm"),
          raw,
        ];
        lines.push(cols.join("\t"));
        writeFileSync(tsv, `${lines.join("\n")}\n`); // after every cell, so a stop keeps what ran
        console.log(
          JSON.stringify({ temp, leg, find, n, visits: f("visits"), capped: f("capped") }),
        );
        cells++;
      }
  return { cells, results: tsv };
}

async function step(x: Ctx, n: string): Promise<Facts> {
  switch (n) {
    case "publish": {
      need((await seen(x)).length === 0, "the probe app must be absent");
      const bytes = readFileSync(APP_FILE);
      const id = readAppIdentity(bytes);
      await publishBytes(x.c, `${id.publisher}_${id.name}_${id.version}.app`, bytes);
      return { sha256: sha256Of(bytes), rows: await seen(x) };
    }
    case "run-perm":
    case "run-temp": {
      const r = await seen(x);
      need(r.length === 1 && r[0]?.isInstalled === true, "the probe app is installed (one row)");
      return runCells(x, n === "run-temp");
    }
    case "cleanup": {
      const steps: string[] = [];
      for (const r of await rows(x.c, x.ext, APP.id)) {
        const key = `${x.ext}(${r.packageId})`;
        if (r.isInstalled) {
          const u = await apiJson(x.c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
          steps.push(`uninstall ${rowVersion(r)} HTTP ${u.status}`);
          if (u.status !== 204)
            throw new Error(`uninstall: HTTP ${u.status} ${u.text.slice(0, 500)}`);
        }
        const p = await apiJson(x.c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
        steps.push(`unpublish ${rowVersion(r)} HTTP ${p.status}`);
        if (p.status !== 204)
          throw new Error(`unpublish: HTTP ${p.status} ${p.text.slice(0, 500)}`);
      }
      const after = await seen(x);
      return { steps, after, absent: after.length === 0 };
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
  if (!existsSync(APP_FILE)) throw new Refused(`${APP_FILE} is missing: run --build first`);
  holderIs(server, lane);
  const all = process.argv.includes("--all");
  const want = all ? ["publish", "run-perm", "run-temp"] : [arg("--step")];
  const login = readSecretFile();
  const c: Conn = {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
    fetch: ((url, init) =>
      bcFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })) as typeof fetch,
  };
  const x: Ctx = { c, ext: await extensionsApi(c), server };
  let code = 0;
  try {
    for (const n of want) {
      if (n === undefined) throw new Refused("--step or --all is required");
      console.log(JSON.stringify({ server, step: n, ...(await step(x, n)) }));
    }
  } catch (err) {
    if (!all) throw err;
    code = err instanceof Refused ? 2 : 1;
    console.error(`${err instanceof Refused ? "REFUSED" : "FAILED"}: ${errText(err)}`);
  }
  if (all) console.log(JSON.stringify({ server, step: "cleanup", ...(await step(x, "cleanup")) }));
  return code;
}

if (import.meta.main) {
  process.exit(
    await main().catch((err: unknown) => {
      console.error(`${err instanceof Refused ? "REFUSED" : "FAILED"}: ${errText(err)}`);
      return err instanceof Refused ? 2 : 1;
    }),
  );
}
