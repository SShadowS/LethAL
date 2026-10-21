/**
 * R593: is a parallel `bun test` the SAME suite as a serial one? Proven per test name, not by counts.
 *
 *   bun scripts/verify-equivalence.ts --serial <k> --parallel <n> --p <P> --out <dir>
 *
 * Typechecks and cleans `packages/*\/dist` once, then runs the full suite k times serially and n times
 * with `--parallel=<P>`, each as `CI=true bun test [--parallel=P] --reporter=junit`. Each run's junit is
 * read into a multiset of (file, classname, name, status) and diffed against serial run 1. Writes
 * `<dir>/<run>.xml`, `<dir>/<run>.log` and `<dir>/summary.md` (per run: counts, files, seconds, the
 * names that differ by file, and what else was running). Exit 0 only if every run equals serial run 1.
 *
 * Before EACH run it waits while a local heavy job runs (`--wait` regex over `ps -eo pid,args`; by
 * default al-runner, itest:alrunner, itest:hang, a corpus root under /work/src, corpus-snapshot), and
 * records `uptime` plus every other `bun`/`itest`/`al-runner` process in the summary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as parseCli } from "node:util";
import { type JunitCase, cleanDist, parseJunit, parseTestSummary } from "./verify.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export const DEFAULT_WAIT =
  "al-runner|itest:alrunner|itest:hang|hang\\.itest\\.ts|/work/src/|corpus-snapshot\\.ts";

/** One key per test: file, describe path, name and status, tab-separated. */
export function caseKey(c: JunitCase): string {
  return [c.file, c.classname, c.name, c.status].join("\t");
}

export function multiset(cases: readonly JunitCase[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cases) m.set(caseKey(c), (m.get(caseKey(c)) ?? 0) + 1);
  return m;
}

/**
 * The differences of run `b` against reference `a`, grouped by file: `- <key>` is in `a` only (or
 * more times), `+ <key>` in `b` only. A status change is a `-` and a `+` on the same name.
 */
export function diffCases(a: readonly JunitCase[], b: readonly JunitCase[]): Map<string, string[]> {
  const ma = multiset(a);
  const mb = multiset(b);
  const byFile = new Map<string, string[]>();
  const add = (key: string, sign: string, n: number): void => {
    const [file = "", classname = "", name = "", status = ""] = key.split("\t");
    const list = byFile.get(file) ?? [];
    const label = `${sign} ${classname === "" ? "" : `${classname} > `}${name} [${status}]`;
    list.push(n > 1 ? `${label} x${n}` : label);
    byFile.set(file, list);
  };
  for (const [k, n] of ma) if (n > (mb.get(k) ?? 0)) add(k, "-", n - (mb.get(k) ?? 0));
  for (const [k, n] of mb) if (n > (ma.get(k) ?? 0)) add(k, "+", n - (ma.get(k) ?? 0));
  return new Map([...byFile].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

/** Lines of `ps -eo pid,args` (header dropped) whose args match `re`, minus `exclude` pids. */
export function matchingProcesses(ps: string, re: RegExp, exclude: ReadonlySet<number>): string[] {
  return ps
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => {
      const m = /^(\d+)\s+(.*)$/.exec(l);
      return (
        m?.[1] !== undefined &&
        m[2] !== undefined &&
        !exclude.has(Number(m[1])) &&
        !WATCHER.test(m[2]) &&
        re.test(m[2])
      );
    });
}

/** A shell, log watcher or search that merely MENTIONS a job is not the job (its child is). */
const WATCHER = /^(\S*\/)?(bash|sh|tail|grep|ugrep|rg|ps|less|cat)\b/;

function sh(cmd: string[]): string {
  return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

interface RunResult {
  name: string;
  seconds: number;
  pass: number;
  fail: number;
  skip: number;
  files: number | undefined;
  cases: JunitCase[];
  load: string;
  others: string[];
}

async function main(): Promise<number> {
  const { values } = parseCli({
    args: process.argv.slice(2),
    options: {
      serial: { type: "string" },
      parallel: { type: "string" },
      p: { type: "string" },
      out: { type: "string" },
      wait: { type: "string", default: DEFAULT_WAIT },
    },
    strict: true,
  });
  const k = Number(values.serial);
  const n = Number(values.parallel);
  const p = Number(values.p);
  if (!(k >= 1) || !(n >= 0) || !(p >= 2) || values.out === undefined) {
    throw new Error(
      "usage: verify-equivalence.ts --serial <k >= 1> --parallel <n> --p <P >= 2> --out <dir>",
    );
  }
  const out = values.out;
  mkdirSync(out, { recursive: true });
  const wait = new RegExp(values.wait ?? DEFAULT_WAIT);
  const tc = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tc.exitCode !== 0) throw new Error(`typecheck failed:\n${tc.stdout}${tc.stderr}`);
  console.log(`typecheck ok; clean dist: ${cleanDist(REPO_ROOT).join(", ") || "none present"}`);

  const runs: RunResult[] = [];
  const names = [
    ...Array.from({ length: k }, (_, i) => `serial-${i + 1}`),
    ...Array.from({ length: n }, (_, i) => `parallel-${i + 1}`),
  ];
  for (const name of names) {
    for (;;) {
      const heavy = matchingProcesses(sh(["ps", "-eo", "pid,args"]), wait, new Set([process.pid]));
      if (heavy.length === 0) break;
      console.log(
        `${new Date().toISOString()} ${name}: waiting, heavy job running:\n  ${heavy.map((l) => l.slice(0, 120)).join("\n  ")}`,
      );
      await Bun.sleep(30_000);
    }
    const load = sh(["uptime"]).trim();
    const others = matchingProcesses(
      sh(["ps", "-eo", "pid,args"]),
      /\bbun\b|itest|al-runner/,
      new Set([process.pid]),
    ).filter((l) => !l.includes("pi-server.ts") && !l.includes("kraken"));
    const xml = join(out, `${name}.xml`);
    const args = name.startsWith("parallel") ? [`--parallel=${p}`] : [];
    const t0 = Date.now();
    const r = Bun.spawnSync(
      ["bun", "test", ...args, "--reporter=junit", `--reporter-outfile=${xml}`],
      { cwd: REPO_ROOT, env: { ...process.env, CI: "true" }, stdout: "pipe", stderr: "pipe" },
    );
    const seconds = (Date.now() - t0) / 1000;
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    writeFileSync(join(out, `${name}.log`), output);
    const s = parseTestSummary(output);
    const cases = parseJunit(readFileSync(xml, "utf8"));
    runs.push({
      name,
      seconds,
      pass: s?.pass ?? -1,
      fail: s?.fail ?? -1,
      skip: s?.skip ?? -1,
      files: s?.files,
      cases,
      load,
      others,
    });
    console.log(
      `${name}: ${s?.pass} pass / ${s?.skip} skip / ${s?.fail} fail, ${s?.files} files, ${cases.length} junit cases, ${seconds.toFixed(1)} s`,
    );
  }

  const ref = runs[0];
  if (ref === undefined) throw new Error("no runs");
  const lines = [
    `# verify-equivalence: ${k} serial + ${n} parallel (--parallel=${p})`,
    "",
    `Tree: ${sh(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"]).trim()}, bun ${Bun.version}. Reference: ${ref.name}.`,
    "",
    "| run | pass | skip | fail | files | junit cases | seconds | same names as reference |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const details: string[] = [];
  let allSame = true;
  let flaky = 0;
  for (const run of runs) {
    const d = diffCases(ref.cases, run.cases);
    if (d.size > 0) allSame = false;
    if (run.name.startsWith("parallel") && (d.size > 0 || run.fail !== 0)) flaky++;
    lines.push(
      `| ${run.name} | ${run.pass} | ${run.skip} | ${run.fail} | ${run.files} | ${run.cases.length} | ${run.seconds.toFixed(1)} | ${d.size === 0 ? "yes" : `NO (${d.size} files)`} |`,
    );
    details.push(`## ${run.name}`, "", `- load: ${run.load}`, "- also running:");
    for (const o of run.others) details.push(`  - \`${o.slice(0, 200)}\``);
    if (run.others.length === 0) details.push("  - (no other bun/itest/al-runner process)");
    for (const [file, diffs] of d) {
      details.push(`- ${file}:`);
      for (const x of diffs) details.push(`  - ${x}`);
    }
    details.push("");
  }
  lines.push(
    "",
    `Parallel runs differing from the reference or with a failure: ${flaky} of ${n}.`,
    `Result: ${allSame ? "IDENTICAL per test name in every run" : "DIFFERENT (see below)"}.`,
    "",
    ...details,
  );
  writeFileSync(join(out, "summary.md"), `${lines.join("\n")}\n`);
  console.log(`summary: ${join(out, "summary.md")}; ${allSame ? "identical" : "DIFFERENT"}`);
  return allSame ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
