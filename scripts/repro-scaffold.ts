/**
 * R934: an invented-app repro for al-runner v3 in one command, plus the AL that matters.
 *
 *   bun scripts/repro-scaffold.ts new <dir> [--target <file.al>]... [--test <file.al>]... [--symbols <dir>]
 *   bash <dir>/run.sh                  (both transports through heavy-slot.sh --wait, then the compare)
 *   bun scripts/repro-scaffold.ts compare <dir>
 *
 * `new` writes <dir>/app (fixtures/sandbox-app plus each --target file), <dir>/app-test (a test app that depends on the
 * sandbox app, each --test file, and the fixture symbols in .alpackages), two configs (the DEFAULT transport and
 * one-shot, the gate's offline settings: no demo data, no .NET sidecar) and run.sh. The symbols come from --symbols, else
 * from this checkout's fixtures/sandbox-tests/.alpackages, extracted from the pinned tar first (as the gate does).
 * `compare` joins the two runs' reports per mutant (file, start, end, operator) and prints every verdict or killing-test
 * difference; it exits 1 when there is one. Write AL with one object per file (a multi-object file is fine since R918,
 * but one per file keeps the repro plain). Never put a real app's source in a repro that goes upstream.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SANDBOX_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

export interface NewOptions {
  readonly dir: string;
  readonly targets?: readonly string[];
  readonly tests?: readonly string[];
  /** A folder holding the sandbox app's and Microsoft's symbol packages; default: the checkout's fixture symbols. */
  readonly symbols?: string;
  /** The al-runner binary the configs name (default: the pinned `current`). */
  readonly alRunner?: string;
  readonly alc?: string;
}

function testAppJson(): string {
  return `${JSON.stringify(
    {
      id: "3c0a7f52-9d14-4b8e-a2c6-934000000001",
      name: "LethAL Repro Tests",
      publisher: "LethAL",
      version: "1.0.0.0",
      brief: "An invented-app repro (scripts/repro-scaffold.ts).",
      description: "Scratch repro. Not committed.",
      dependencies: [
        { id: SANDBOX_APP_ID, name: "LethAL Sandbox App", publisher: "LethAL", version: "1.0.0.1" },
      ],
      idRanges: [{ from: 79000, to: 79199 }],
      resourceExposurePolicy: {
        allowDebugging: true,
        allowDownloadingSource: true,
        includeSourceInSymbolFile: true,
      },
      runtime: "17.0",
      features: [],
    },
    null,
    2,
  )}\n`;
}

function config(dir: string, o: NewOptions, oneShot: boolean): string {
  return `${JSON.stringify(
    {
      alRunnerV3: {
        path: o.alRunner ?? "/work/tools/al-runner-v3/current/al-runner",
        packagesDir: join(dir, "app-test", ".alpackages"),
        bcVersion: "28.0.46665.47126",
        alcPath: o.alc ?? join(process.env.LETHAL_ALC_DIR ?? "", "alc"),
        cacheDir: join(dir, "cache"),
        downloadDemoData: false,
        dotnetSidecar: false,
        ...(oneShot ? { transport: "one-shot" } : {}),
      },
      selectorIds: IDS,
    },
    null,
    2,
  )}\n`;
}

function runScript(dir: string): string {
  return `#!/bin/bash
# repro-scaffold.ts: the repro on the DEFAULT transport and on one-shot, then the per-mutant compare.
cd ${JSON.stringify(REPO)} || exit 9
D=${JSON.stringify(dir)}
for name in default oneshot; do
  rm -f "$D/$name.sqlite"*
  bash scripts/heavy-slot.sh --wait other timeout 3600 bun packages/runner/src/cli.ts run --project "$D/app" --tests "$D/app-test" \\
    --backend al-runner-v3 --config "$D/v3.$name.json" --db "$D/$name.sqlite" \\
    --out "$D/$name.report.json" --progress-out "$D/$name.events.ndjson" > "$D/$name.stdout.txt" 2> "$D/$name.stderr.txt"
  echo "$name rc=$?"
done
grep -h "serve-default-fallback" "$D/default.stderr.txt" | cut -c1-300
bun scripts/repro-scaffold.ts compare "$D"
`;
}

/** The checkout's sandbox-tests symbols, extracted from the pinned tar when missing (the gate's own step). */
async function fixtureSymbols(): Promise<string> {
  const { prepareFixtureSymbols } = await import("../packages/runner/itest/fixture-symbols");
  await prepareFixtureSymbols({ worktree: REPO });
  return join(REPO, "fixtures", "sandbox-tests", ".alpackages");
}

export async function scaffold(o: NewOptions): Promise<void> {
  const dir = resolve(o.dir);
  // A test app with no test codeunit only fails ("no tests discovered"), so refuse it here rather than after a slot wait.
  if ((o.tests ?? []).length === 0)
    throw new Error("repro-scaffold: give at least one --test <file.al>");
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new Error(`repro-scaffold: ${dir} exists and is not empty`);
  const symbols = o.symbols ?? (await fixtureSymbols());
  if (!readdirSync(symbols).some((f) => f.startsWith("LethAL_LethAL Sandbox App_")))
    throw new Error(`repro-scaffold: ${symbols} holds no LethAL Sandbox App symbol package`);
  const app = join(dir, "app");
  const test = join(dir, "app-test");
  cpSync(join(REPO, "fixtures", "sandbox-app"), app, { recursive: true });
  mkdirSync(join(test, "src"), { recursive: true });
  cpSync(symbols, join(test, ".alpackages"), { recursive: true });
  writeFileSync(join(test, "app.json"), testAppJson());
  for (const f of o.targets ?? []) cpSync(f, join(app, "src", basename(f)));
  for (const f of o.tests ?? []) cpSync(f, join(test, "src", basename(f)));
  writeFileSync(join(dir, "v3.default.json"), config(dir, o, false));
  writeFileSync(join(dir, "v3.oneshot.json"), config(dir, o, true));
  writeFileSync(join(dir, "run.sh"), runScript(dir), { mode: 0o755 });
}

type Row = {
  file: string;
  startIndex: number;
  endIndex: number;
  operatorName: string;
  verdict: string;
  killingTest?: string;
};

/** The per-mutant differences between two reports' mutant lists (empty when they agree). */
export function compareReports(a: readonly Row[], b: readonly Row[]): string[] {
  const key = (m: Row) => `${m.file}|${m.startIndex}|${m.endIndex}|${m.operatorName}`;
  const bm = new Map(b.map((m) => [key(m), m]));
  const out: string[] = [];
  for (const m of a) {
    const o = bm.get(key(m));
    if (o === undefined) out.push(`${key(m)}: only in default`);
    else if (o.verdict !== m.verdict)
      out.push(`${key(m)}: default ${m.verdict}, one-shot ${o.verdict}`);
    else if ((o.killingTest ?? "") !== (m.killingTest ?? ""))
      out.push(
        `${key(m)}: killed by ${m.killingTest ?? "-"} on default, ${o.killingTest ?? "-"} on one-shot`,
      );
    bm.delete(key(m));
  }
  for (const k of bm.keys()) out.push(`${k}: only in one-shot`);
  return out;
}

export function compare(dir: string): number {
  const read = (n: string) => {
    const f = join(dir, `${n}.report.json`);
    if (!existsSync(f))
      throw new Error(`repro-scaffold compare: the ${n} run wrote no report; see ${n}.stderr.txt`);
    return (JSON.parse(readFileSync(f, "utf8")) as { mutants: Row[] }).mutants;
  };
  const a = read("default");
  const diffs = compareReports(a, read("oneshot"));
  console.log(`repro-scaffold compare: ${a.length} mutants, ${diffs.length} difference(s)`);
  for (const d of diffs) console.log(`  ${d}`);
  return diffs.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  if (dir === undefined || (cmd !== "new" && cmd !== "compare")) {
    console.error(
      "usage: repro-scaffold.ts new <dir> [--target f.al]... [--test f.al]... [--symbols dir] | compare <dir>",
    );
    process.exit(2);
  }
  if (cmd === "compare") process.exit(compare(resolve(dir)));
  const targets: string[] = [];
  const tests: string[] = [];
  let symbols: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`repro-scaffold: ${flag} needs a value`);
    if (flag === "--target") targets.push(value);
    else if (flag === "--test") tests.push(value);
    else if (flag === "--symbols") symbols = value;
    else throw new Error(`repro-scaffold: unknown flag ${flag}`);
  }
  await scaffold({ dir, targets, tests, ...(symbols !== undefined ? { symbols } : {}) });
  console.log(`repro-scaffold: ${resolve(dir)} ready; run: bash ${join(resolve(dir), "run.sh")}`);
}
