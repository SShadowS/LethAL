/**
 * The build/test loop from CLAUDE.md, in the order that matters, as one command.
 *
 *   bun scripts/verify.ts                   # FULL: typecheck, clean dist, every test file (parallel)
 *   bun scripts/verify.ts --changed[=<ref>] # PARTIAL: ... only the test files bun's import graph
 *                                           #   links to the diff since <ref> (default: merge-base
 *                                           #   with origin/master)
 *   bun scripts/verify.ts runner engine     # PARTIAL: ... `bun test packages/runner packages/engine`
 *
 * Steps: `bun run typecheck`; delete every `packages/*\/dist` IN-PROCESS (so no shell `rm -rf`
 * hook can block it, and stale compiled `*.test.js` cannot cause phantom failures); `bun test`
 * from the repo root (so `bunfig.toml`'s preload applies). Prints one line per step, the
 * pass/skip/fail counts, and the names of failing tests. The full output of a failing step goes to
 * a log file whose path is printed. Exits non-zero on any failure, or when the test summary cannot
 * be read: an unreadable summary is never reported as a pass.
 *
 * R593 (parallel and partial). The test step runs `bun test --parallel=<P>`:
 *   P = LETHAL_VERIFY_PARALLEL if set, else 1 (serial) under CI or GITHUB_ACTIONS, else
 *   min(8, floor(cores / 4)). Under `--parallel` the preload runs once per FILE and `CI=true`
 *   reaches every worker (both measured, and pinned by spawn tests in verify.test.ts).
 * The first line names the mode and the last line is the receipt. Only a run with NO arguments is
 * FULL, prints `test (all)` and `VERIFY FULL`; a partial run says PARTIAL on both lines and is
 * refused under CI. Exit codes: 0 only for a FULL pass, 4 for a PARTIAL pass (so `verify && git push`
 * cannot push on a subset), 1 for any failure, 2 for refused arguments. A full run also checks that bun ran every test file bun's own discovery rule
 * finds (`discoverTestFiles`), so a worker that silently drops a file cannot pass as full.
 *
 * R393 (snapshot late write). A test that times out keeps running, and its late `toMatchSnapshot()`
 * is filed under the NEXT test's name, silently adding a wrong entry to a tracked `.snap`. Two guards,
 * both for verify.ts users ONLY (a plain `bun test` is not protected by either):
 *   1. The `bun test` child runs with `CI=true` in its env, set before bun starts (bun reads CI once at
 *      launch; a preload that sets it is too late). Then a snapshot that does not exist yet is REFUSED
 *      instead of written. Set LETHAL_TEST_ALLOW_SNAPSHOT_CREATE=1 to drop it (the output says so;
 *      refused under CI). To add a snapshot on purpose, run `bun test --update-snapshots <file>`.
 *   2. The belt: `git status --porcelain -- '*.snap'` (staged, unstaged and untracked) plus a hash of
 *      each listed file, taken before and after the test step. Any `.snap` that changed DURING the run
 *      fails verify.ts and is named. A `.snap` that was already dirty before is not blamed.
 *
 * R622 (a stuck file). A test file that runs over FILE_LIMIT_S (180 s) of wall clock is killed and
 * fails the run on a `watchdog: FAIL, <file> ran over 180 s ...` line, so a worker spinning without
 * yielding costs 3 minutes instead of a silent hang. See `Heartbeat`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

export class VerifyArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyArgsError";
  }
}

export type Env = Record<string, string | undefined>;

export type VerifyMode =
  | { readonly kind: "full" }
  | { readonly kind: "changed"; readonly ref: string | undefined }
  | { readonly kind: "packages"; readonly paths: readonly string[] };

const USAGE = "usage: verify.ts [--changed[=<ref>] | pkg...]";

export const ALLOW_SNAPSHOT_CREATE = "LETHAL_TEST_ALLOW_SNAPSHOT_CREATE";

function ciVariable(env: Env): string | undefined {
  if (env.CI !== undefined && env.CI !== "") return "CI";
  if (env.GITHUB_ACTIONS !== undefined && env.GITHUB_ACTIONS !== "") return "GITHUB_ACTIONS";
  return undefined;
}

/**
 * The mode. Only an EMPTY argv is full. A partial mode (`--changed`, package names) and the snapshot
 * opt-out are refused when `CI` or `GITHUB_ACTIONS` is set in verify's OWN env, so a CI job edited to
 * pass one fails instead of going green on a subset.
 */
export function parseArgs(
  argv: readonly string[],
  known: readonly string[],
  env: Env = {},
): VerifyMode {
  const ci = ciVariable(env);
  if (ci !== undefined && env[ALLOW_SNAPSHOT_CREATE] === "1") {
    throw new VerifyArgsError(`${ALLOW_SNAPSHOT_CREATE}=1 is refused under ${ci}`);
  }
  if (argv.length === 0) return { kind: "full" };
  let changed: VerifyMode | undefined;
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg === "--changed" || arg.startsWith("--changed=")) {
      if (changed !== undefined) throw new VerifyArgsError(`'--changed' given twice (${USAGE})`);
      const ref = arg === "--changed" ? undefined : arg.slice("--changed=".length);
      if (ref === "") throw new VerifyArgsError(`'--changed=' needs a ref (${USAGE})`);
      changed = { kind: "changed", ref };
      continue;
    }
    if (arg.startsWith("-")) throw new VerifyArgsError(`unknown flag '${arg}' (${USAGE})`);
    const name = arg.replace(/^packages\//, "").replace(/\/$/, "");
    if (!known.includes(name)) {
      throw new VerifyArgsError(`no package '${arg}' under packages/ (have: ${known.join(", ")})`);
    }
    paths.push(`packages/${name}`);
  }
  if (changed !== undefined && paths.length > 0) {
    throw new VerifyArgsError(`'--changed' and package names cannot be combined (${USAGE})`);
  }
  if (ci !== undefined) {
    throw new VerifyArgsError(
      `a partial verify (${argv.join(" ")}) is refused under ${ci}: CI runs the full suite`,
    );
  }
  return changed ?? { kind: "packages", paths };
}

/**
 * P, by precedence: an explicit LETHAL_VERIFY_PARALLEL (under CI or not), else 1 under CI, else
 * min(8, floor(cores / 4)) and at least 1. 8 was the measured knee on a 32-core machine.
 */
export function parallelism(env: Env, cores: number): { p: number; why: string } {
  const explicit = env.LETHAL_VERIFY_PARALLEL;
  if (explicit !== undefined && explicit !== "") {
    const p = Number(explicit);
    if (!Number.isInteger(p) || p < 1) {
      throw new VerifyArgsError(
        `LETHAL_VERIFY_PARALLEL must be a whole number >= 1, got '${explicit}'`,
      );
    }
    return { p, why: "LETHAL_VERIFY_PARALLEL" };
  }
  const ci = ciVariable(env);
  if (ci !== undefined) return { p: 1, why: `${ci} is set: serial` };
  return { p: Math.max(1, Math.min(8, Math.floor(cores / 4))), why: `min(8, ${cores} cores / 4)` };
}

/** The `bun test` argv. P=1 is a plain serial run (no `--parallel`). */
export function testCommand(
  mode: VerifyMode,
  p: number,
  changedSha: string | undefined,
  junitPath: string,
): string[] {
  // R622 review I3: the running bun itself. A `bun` found on PATH may be a shim (Windows), whose
  // pid is not the test process's, and then the watchdog would never match a heartbeat to it.
  return [
    process.execPath,
    "test",
    ...(p > 1 ? [`--parallel=${p}`] : []),
    ...(mode.kind === "changed" ? [`--changed=${changedSha}`] : []),
    ...(mode.kind === "packages" ? mode.paths : []),
    "--reporter=junit",
    `--reporter-outfile=${junitPath}`,
  ];
}

export interface TestSummary {
  readonly pass: number;
  readonly skip: number;
  readonly fail: number;
  readonly todo: number;
  readonly failing: string[];
  /** M of bun's `Ran N tests across M files`, when printed. */
  readonly files: number | undefined;
}

/**
 * Reads `bun test`'s closing counts (` 25 pass`, ` 0 fail`, ...), its `(fail) <name>` lines and,
 * under `--parallel`, its `✗ <file> (worker crashed: <why>)` lines (a crashed worker's earlier
 * passes are LOST from the pass count, so the crash must be named). Returns null when no `pass` and
 * no `fail` count is present: the caller treats that as a failure.
 */
export function parseTestSummary(output: string): TestSummary | null {
  const counts = new Map<string, number>();
  const failing: string[] = [];
  let files: number | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const count = /^\s*(\d+) (pass|skip|fail|todo)$/.exec(line);
    if (count !== null) {
      const [, n, kind] = count;
      if (n !== undefined && kind !== undefined) counts.set(kind, Number(n));
      continue;
    }
    const ran = /^Ran \d+ tests? across (\d+) files?\./.exec(line);
    if (ran?.[1] !== undefined) files = Number(ran[1]);
    const failed = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (failed?.[1] !== undefined && !failing.includes(failed[1])) failing.push(failed[1]);
    const crashed = /^✗ (.+ \(worker crashed: .*\))$/.exec(line);
    if (crashed?.[1] !== undefined && !failing.includes(crashed[1])) failing.push(crashed[1]);
  }
  if (!counts.has("pass") && !counts.has("fail")) return null;
  return {
    pass: counts.get("pass") ?? 0,
    skip: counts.get("skip") ?? 0,
    fail: counts.get("fail") ?? 0,
    todo: counts.get("todo") ?? 0,
    failing,
    files,
  };
}

export interface JunitCase {
  readonly file: string;
  readonly classname: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "skip" | "todo";
}

function unescapeXml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");
}

/** Every `<testcase>` of a bun junit report, with its status. A file with zero tests has none. */
export function parseJunit(xml: string): JunitCase[] {
  const out: JunitCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1] ?? "";
    const body = m[3] ?? "";
    const attr = (k: string): string =>
      unescapeXml(new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1] ?? "");
    const status = /<(failure|error)\b/.test(body)
      ? "fail"
      : /<skipped message="TODO"/.test(body)
        ? "todo"
        : /<skipped\b/.test(body)
          ? "skip"
          : "pass";
    out.push({ file: attr("file"), classname: attr("classname"), name: attr("name"), status });
  }
  return out;
}

const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/**
 * The test files bun discovers under `root`, by bun's measured rule: every directory is walked
 * except `node_modules` and dot-directories (gitignored non-dot directories ARE walked), and a file
 * matches `*.test.*`, `*_test.*`, `*.spec.*` or `*_spec.*`. Paths relative to `root`, `/`-separated,
 * sorted.
 */
export function discoverTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(path);
      } else if (e.isFile() && TEST_FILE.test(e.name)) {
        found.push(path);
      }
    }
  };
  walk("");
  return found.sort();
}

/**
 * The full-run completeness check: bun's `across M files` must equal the discovered count. On a
 * mismatch, the paths each way (junit `file=` attributes vs the discovered set, up to 20 each).
 * A zero-test file is counted by bun but has no junit entry, so it can appear in the first list.
 */
export function completeness(
  expected: readonly string[],
  ranFiles: number | undefined,
  junitFiles: readonly string[],
): string[] {
  if (ranFiles === expected.length) return [];
  const ran = new Set(junitFiles.map((f) => f.replaceAll("\\", "/")));
  const exp = new Set(expected);
  const notRun = expected.filter((f) => !ran.has(f));
  const notExpected = [...ran].filter((f) => !exp.has(f)).sort();
  return [
    `file-set check: FAIL, bun ran ${ranFiles ?? "an unknown number of"} files, discovery finds ${expected.length}`,
    `  discovered but no junit entry (${notRun.length}; a zero-test file has none):`,
    ...notRun.slice(0, 20).map((f) => `    ${f}`),
    `  in junit but not discovered (${notExpected.length}):`,
    ...notExpected.slice(0, 20).map((f) => `    ${f}`),
  ];
}

/**
 * The env for the `bun test` child: `CI=true` unless the opt-out is set. The opt-out also REMOVES
 * an inherited `CI`, so "guard off" really means bun may create a snapshot.
 */
export function testChildEnv(base: Env): Env {
  if (base[ALLOW_SNAPSHOT_CREATE] === "1") {
    const { CI: _ci, ...rest } = base;
    return rest;
  }
  return { ...base, CI: "true" };
}

/**
 * The env A7 (verify.test.ts) gives a child `bun test`: `base` minus every `LETHAL_TEST_*`
 * variable, with HOME/USERPROFILE at the sentinel `home` and TMPDIR/TEMP/TMP at the sentinel `tmp`.
 * Then only the child's OWN preload can move them, and an inherited fake can never pass for it.
 */
export function sentinelEnv(base: Env, home: string, tmp: string): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("LETHAL_TEST_")) env[k] = v;
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
}

/** path -> `<porcelain status>:<content hash>` for every staged, unstaged or untracked `.snap`. */
export type SnapState = Map<string, string>;

export function parseSnapState(porcelain: string, read: (path: string) => string): SnapState {
  const state: SnapState = new Map();
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const path = line.slice(3).replace(/^"|"$/g, "");
    state.set(path, `${line.slice(0, 2)}:${read(path)}`);
  }
  return state;
}

/** The `.snap` files whose state differs between the two snapshots (changed, added or cleaned). */
export function snapChanges(before: SnapState, after: SnapState): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

function readSnapState(): SnapState {
  const r = Bun.spawnSync(["git", "status", "--porcelain", "--", "*.snap"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((r.exitCode ?? 1) !== 0) {
    throw new Error(`git status failed (exit ${r.exitCode}): ${r.stderr.toString()}`);
  }
  return parseSnapState(r.stdout.toString(), (p) => {
    const full = join(REPO_ROOT, p);
    return existsSync(full)
      ? createHash("sha1").update(readFileSync(full)).digest("hex")
      : "deleted";
  });
}

/** The R622 per-file limit for a full verify, in seconds. Why 180: see the watchdog section. */
export const FILE_LIMIT_S = 180;

/** The variable that tells the preload where to write its heartbeat. */
export const HEARTBEAT_DIR = "LETHAL_VERIFY_HEARTBEAT_DIR";

/**
 * R622 watchdog. One test file once ran for 10 minutes at 100% CPU and never failed: bun's
 * per-test timeout cannot fire in code that does not yield. So the preload writes a heartbeat,
 * `<dir>/<pid>` holding `<start ms>\t<parent pid>\t<test file>`, when each file starts, and
 * removes it when the file ends. verify reads them every second. A heartbeat older than the limit
 * is a file that ran over it, and verify kills that one process and fails the run, naming the file.
 *
 * The limit is 180 s per file. The slowest file on the Windows CI job (serial) took 20 to 29 s in
 * three green master runs, and the slowest on Linux at P=8 under load 44 took 17.6 s, so 180 s is
 * at least 6 times the slowest seen (`/coord/handoff/R-622/windows-times.md`). It is a wall-clock
 * limit on a whole file; no test timeout changes.
 *
 * Serial runs load the preload once, so a file stuck before its first test is named as the file
 * before it. A hang in bun's coordinator itself, after the files ran, is not covered.
 */
export interface Heartbeat {
  readonly pid: number;
  readonly start: number;
  readonly ppid: number;
  readonly file: string;
}

/** Every complete heartbeat in `dir`. A file caught half-written is skipped: it is read again in 1 s. */
export function readHeartbeats(dir: string): Heartbeat[] {
  const out: Heartbeat[] = [];
  for (const name of readdirSync(dir)) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // removed between the listing and the read: the file ended
    }
    const [start, ppid, file] = text.split("\t");
    if (start === undefined || ppid === undefined || file === undefined || file === "") continue;
    out.push({ pid: Number(name), start: Number(start), ppid: Number(ppid), file });
  }
  return out;
}

/**
 * The heartbeats over the limit that belong to this run: a worker of the `bun test` child
 * (`--parallel`), or the child itself with verify as its parent (serial).
 */
export function stuckWorkers(
  beats: readonly Heartbeat[],
  now: number,
  limitMs: number,
  childPid: number,
  selfPid: number,
): Heartbeat[] {
  return beats.filter(
    (b) =>
      now - b.start > limitMs &&
      (b.ppid === childPid || (b.pid === childPid && b.ppid === selfPid)),
  );
}

/**
 * Whether `pid` is alive now with `parent` as its parent, asked of the OS just before a kill, so a
 * pid reused by another process is never hit. Linux reads `/proc`; Windows asks CIM through
 * PowerShell (about a second, and only when a file ran over the limit). Any other OS, or any
 * failure to ask, answers false: the run still fails, but nothing is killed.
 */
export function isChildOf(pid: number, parent: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid ...`; comm may hold spaces and parentheses, so split after the LAST ")".
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === parent;
    }
    if (process.platform === "win32") {
      const r = Bun.spawnSync(
        [
          "powershell",
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = r.stdout.toString().trim();
      return r.exitCode === 0 && out !== "" && Number(out) === parent;
    }
  } catch {
    // no such process
  }
  return false;
}

export interface ExecResult {
  readonly code: number;
  readonly output: string;
  /** Set by `execWatched`: the limit it used, and one FAIL line per file that ran over it. */
  readonly watchdog?: { readonly limitS: number; readonly fails: readonly string[] };
}

/**
 * Runs `cmd` (a `bun` first argument means the running bun, review I3) with the R622 watchdog. Its
 * stdout and stderr are read WHILE it runs (review I1): with a plain OS pipe, read only after exit,
 * a big run fills the pipe, the writer blocks, and the watchdog would kill an innocent file. Bun
 * 1.4.2 buffers an unread pipe itself (measured: 500 MB, read after exit, no block; probe in
 * `/coord/handoff/R-622/redcheck/pipe-probe/`), so reading while it runs is the safe order should
 * that ever change.
 */
export async function execWatched(
  cmd: readonly string[],
  env: Env,
  cwd: string,
  limitS: number,
): Promise<ExecResult> {
  const beats = mkdtempSync(join(tmpdir(), "verify-heartbeat-"));
  const argv = cmd[0] === "bun" ? [process.execPath, ...cmd.slice(1)] : [...cmd];
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...env, [HEARTBEAT_DIR]: beats },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const fails: string[] = [];
  const timer = setInterval(() => {
    for (const b of stuckWorkers(
      readHeartbeats(beats),
      Date.now(),
      limitS * 1000,
      proc.pid,
      process.pid,
    )) {
      rmSync(join(beats, String(b.pid)), { force: true }); // report each file once
      const file = relative(cwd, b.file).replaceAll("\\", "/");
      const serial = b.pid === proc.pid;
      const who = serial ? `the bun test process ${b.pid} (serial)` : `worker ${b.pid}`;
      if (!isChildOf(b.pid, b.ppid)) {
        fails.push(
          `watchdog: FAIL, ${file} ran over ${limitS} s in ${who}, which is gone or no longer bun's, so nothing was killed. R622.`,
        );
        continue;
      }
      process.kill(b.pid, "SIGTERM");
      fails.push(
        `watchdog: FAIL, ${file} ran over ${limitS} s in ${who}; killed it${serial ? ", which stopped the whole run (a file stuck before its first test is named as the file before it)" : ""}. R622.`,
      );
    }
  }, 1000);
  try {
    const [code, out, err] = await Promise.all([proc.exited, stdout, stderr]);
    return { code, output: `${out}${err}`, watchdog: { limitS, fails } };
  } finally {
    clearInterval(timer);
    rmSync(beats, { recursive: true, force: true });
  }
}

export interface TestStepIo {
  exec(cmd: string[], env: Env): ExecResult | Promise<ExecResult>;
  snapState(): SnapState;
  env: Env;
  log(output: string): string;
  /** A fresh path for the junit report. */
  junitPath(): string;
  /** The junit report's text after the run ("" when none was written). */
  readJunit(path: string): string;
  /** The discovered test files (read in full mode only). */
  expectedTestFiles(): string[];
}

export interface TestStepPlan {
  readonly mode: VerifyMode;
  readonly p: number;
  /** The resolved sha for `--changed`. */
  readonly changedSha?: string;
}

/** The scope a line names. `all` is produced only for mode `full`. */
function scopeOf(plan: TestStepPlan): string {
  switch (plan.mode.kind) {
    case "full":
      return "all";
    case "changed":
      return `changed since ${plan.changedSha}`;
    case "packages":
      return `packages: ${plan.mode.paths.map((p) => p.replace(/^packages\//, "")).join(" ")}`;
  }
}

/** The `bun test` step with both R393 guards. Returns the lines to print and the exit code. */
export async function testStep(
  plan: TestStepPlan,
  io: TestStepIo,
): Promise<{ code: number; lines: string[]; summary: TestSummary | null }> {
  const lines: string[] = [];
  const optOut = io.env[ALLOW_SNAPSHOT_CREATE] === "1";
  lines.push(
    optOut
      ? `snapshot guard: OFF (${ALLOW_SNAPSHOT_CREATE}=1), a missing snapshot will be written`
      : "snapshot guard: CI=true for the test child, a missing snapshot is refused",
  );
  const junit = io.junitPath();
  const before = io.snapState();
  const t = await io.exec(
    testCommand(plan.mode, plan.p, plan.changedSha, junit),
    testChildEnv(io.env),
  );
  const after = io.snapState();
  const summary = parseTestSummary(t.output);
  const scope = scopeOf(plan);
  let code = 0;
  if (summary === null) {
    lines.push(
      `test (${scope}): FAIL, no pass/fail summary in output (exit ${t.code}), log ${io.log(t.output)}`,
    );
    code = 1;
  } else {
    const ok = t.code === 0 && summary.fail === 0 && summary.failing.length === 0;
    const counts = `${summary.pass} pass / ${summary.skip} skip / ${summary.fail} fail${summary.todo > 0 ? ` / ${summary.todo} todo` : ""}`;
    lines.push(
      `test (${scope}): ${ok ? "ok" : "FAIL"} ${counts}, ${summary.files ?? "?"} files${ok ? "" : ` (exit ${t.code}), log ${io.log(t.output)}`}`,
    );
    for (const name of summary.failing) lines.push(`  (fail) ${name}`);
    if (!ok) code = 1;
    if (plan.mode.kind === "full") {
      const junitFiles = [...new Set(parseJunit(io.readJunit(junit)).map((c) => c.file))];
      const gap = completeness(io.expectedTestFiles(), summary.files, junitFiles);
      if (gap.length > 0) {
        lines.push(...gap);
        code = 1;
      } else {
        lines.push(`file-set check: ok, bun ran all ${summary.files} discovered test files`);
      }
    } else {
      lines.push(
        `bun ran ${summary.files ?? "?"} test files (partial run: the file set is not checked)`,
      );
    }
  }
  if (t.watchdog !== undefined) {
    // R622: fails on its own line, even when bun's own `worker crashed` line is missing.
    if (t.watchdog.fails.length > 0) {
      lines.push(...t.watchdog.fails);
      code = 1;
    } else {
      lines.push(`watchdog: ok, no test file ran over ${t.watchdog.limitS} s`);
    }
  }
  const changed = snapChanges(before, after);
  if (changed.length > 0) {
    lines.push(`snapshot belt: FAIL, ${changed.length} .snap file(s) changed DURING the test run:`);
    for (const f of changed) lines.push(`  ${f}`);
    lines.push(
      "  A timed-out test can write its snapshot under the next test's name (R393). Review with `git diff`, revert it,",
      "  or add a snapshot on purpose with `bun test --update-snapshots <file>`.",
    );
    code = 1;
  }
  return { code, lines, summary };
}

/** The first line: what this run is. Only mode `full` says FULL. */
export function modeLine(plan: TestStepPlan, pWhy: string): string {
  const par = plan.p > 1 ? `--parallel=${plan.p}` : "serial";
  if (plan.mode.kind === "full")
    return `verify mode: FULL (all test files, ${par}; P from ${pWhy})`;
  return `verify mode: PARTIAL (${scopeOf(plan)}, ${par}) -- NOT a submit or merge verify`;
}

/** The last line. `VERIFY FULL` is produced only for mode `full`. */
export function receipt(
  mode: VerifyMode,
  ok: boolean,
  summary: TestSummary | null,
  guardOff: boolean,
  seconds: number,
): string {
  const counts =
    summary === null
      ? "no test summary"
      : `${summary.pass} pass / ${summary.skip} skip / ${summary.fail} fail`;
  const tail = `${guardOff ? " (snapshot guard OFF)" : ""} [${seconds.toFixed(1)} s]`;
  if (mode.kind === "full") return `VERIFY FULL: ${ok ? "PASS" : "FAIL"} (${counts})${tail}`;
  return `VERIFY PARTIAL: ${ok ? `PASS, exit ${PARTIAL_PASS_EXIT}` : "FAIL"} (${counts})${tail} -- run \`bun scripts/verify.ts\` with no arguments before submit`;
}

/**
 * Orchestrator amendment (2026-10-21): a PARTIAL run that passes exits 4, never 0, so a
 * `verify && git push` chain cannot push on a subset. A failure stays 1; only FULL exits 0. R-587's
 * partial gates exit 4 too.
 */
export const PARTIAL_PASS_EXIT = 4;

export function exitCode(mode: VerifyMode, code: number): number {
  return code === 0 && mode.kind !== "full" ? PARTIAL_PASS_EXIT : code;
}

export interface VerifyIo extends TestStepIo {
  packages: readonly string[];
  cores: number;
  /** A git command in the repo; throws on a non-zero exit. */
  git(args: string[]): string;
  cleanDist(): string[];
  now(): number;
  print(line: string): void;
}

/** The whole run. Prints each line as it goes and returns them all, plus the exit code. */
export async function runVerify(
  argv: readonly string[],
  io: VerifyIo,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const say = (l: string): void => {
    lines.push(l);
    io.print(l);
  };
  const t0 = io.now();
  const mode = parseArgs(argv, io.packages, io.env);
  const { p, why } = parallelism(io.env, io.cores);
  let changedSha: string | undefined;
  if (mode.kind === "changed") {
    const ref = mode.ref ?? io.git(["merge-base", "HEAD", "origin/master"]).trim();
    changedSha = io.git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  }
  const plan: TestStepPlan = { mode, p, ...(changedSha !== undefined ? { changedSha } : {}) };
  say(modeLine(plan, why));
  if (mode.kind === "changed") {
    say(
      "  blind spot: a test that reads a changed NON-import file (a fixture .al, a .json, a .snap) is not selected; run the full verify after touching those",
    );
  }
  const guardOff = io.env[ALLOW_SNAPSHOT_CREATE] === "1";
  const done = (code: number, summary: TestSummary | null): { code: number; lines: string[] } => {
    say(receipt(mode, code === 0, summary, guardOff, (io.now() - t0) / 1000));
    return { code: exitCode(mode, code), lines };
  };

  const tc = await io.exec(["bun", "run", "typecheck"], io.env);
  if (tc.code !== 0) {
    say(`typecheck: FAIL (exit ${tc.code}), log ${io.log(tc.output)}`);
    for (const l of tc.output
      .split(/\r?\n/)
      .filter((l) => /error TS\d+/.test(l))
      .slice(0, 30))
      say(l);
    return done(1, null);
  }
  say("typecheck: ok");
  const removed = io.cleanDist();
  say(`clean dist: removed ${removed.length} (${removed.join(", ") || "none present"})`);
  const step = await testStep(plan, io);
  for (const l of step.lines) say(l);
  return done(step.code, step.summary);
}

function saveLog(step: string, output: string): string {
  const path = join(tmpdir(), `lethal-verify-${step}-${Date.now()}.log`);
  writeFileSync(path, output);
  return path;
}

/** Deletes every `packages/<pkg>/dist`; returns the packages that had one. */
export function cleanDist(root: string): string[] {
  const removed: string[] = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const dist = join(root, "packages", pkg, "dist");
    if (!existsSync(dist)) continue;
    rmSync(dist, { recursive: true, force: true });
    removed.push(pkg);
  }
  return removed;
}

async function main(argv: readonly string[]): Promise<number> {
  const junitDir = mkdtempSync(join(tmpdir(), "verify-junit-"));
  let n = 0;
  try {
    const r = await runVerify(argv, {
      packages: readdirSync(join(REPO_ROOT, "packages")),
      cores: availableParallelism(),
      env: process.env,
      exec: (cmd, env) => execWatched(cmd, env, REPO_ROOT, FILE_LIMIT_S),
      git: (args) => {
        const r = Bun.spawnSync(["git", ...args], {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((r.exitCode ?? 1) !== 0) {
          throw new VerifyArgsError(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
        }
        return r.stdout.toString();
      },
      snapState: readSnapState,
      log: (o) => saveLog("test", o),
      junitPath: () => join(junitDir, `run-${n++}.xml`),
      readJunit: (p) => (existsSync(p) ? readFileSync(p, "utf8") : ""),
      expectedTestFiles: () => discoverTestFiles(REPO_ROOT),
      cleanDist: () => cleanDist(REPO_ROOT),
      now: () => Date.now(),
      print: (l) => console.log(l),
    });
    return r.code;
  } finally {
    rmSync(junitDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
