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
 *
 * R622 (the ledger). Every verify appends a START and an END line to one shared file,
 * /coord/locks/verify-ledger.tsv, or the file LETHAL_VERIFY_LEDGER names (tests use a temp file),
 * and prints how many OTHER verifies overlapped it. See `ledgerLine` for the columns.
 *
 * R616b (one verify at a time, and a longer timeout under io stall).
 *   1. The slot lock. The test step runs only while this process holds `verify-slot.lock`, in the
 *      same folder as the ledger (so LETHAL_VERIFY_LEDGER moves both; tests give a temp folder). It
 *      is made with an exclusive create and holds `pid, worktree, start`. Another live holder: wait,
 *      polling every 2 s, up to 10 min, then fail by name (verify never runs anyway). A holder whose
 *      PID IS DEAD is stale and is taken over (named in the receipt); age alone never makes a lock
 *      stale. Released on every exit path: a `finally`, and SIGINT/SIGTERM/SIGHUP handlers (remove
 *      the lock only if it still holds our pid, exit 130/143/129). SIGKILL or a crash cannot run a
 *      handler: the dead pid is what the next verify recovers from. Typecheck stays parallel. Skipped
 *      under CI. Receipt line: `verify slot: took | waited N s | took a stale lock from pid P |
 *      skipped (CI)`. See `acquireSlot` for the known ceilings (pid reuse).
 *      Known limit: a SIGTERM or SIGHUP sent to verify alone releases the lock, but the orphaned
 *      `bun test` child may keep running (Ctrl-C reaches the whole group and is fine).
 *   2. If io pressure `full` avg10 is >= 5.0 when read just before the test step (after the slot
 *      wait), the test child gets `--timeout=15000` (bun's default is 5000). Unreadable pressure
 *      (Windows) keeps the default. Receipt line: `per-test timeout: ...`. See `testTimeout`.
 *   3. A whole-run wall limit of 900 s on every child that verify runs (typecheck, `bun test`; `RUN_LIMIT_S`),
 *      besides the per-file one.
 *
 * R616 (test DBs and stall figures). The preload puts each test process's scratch SQLite DBs on a
 * tmpfs when it can (see packages/runner/tests/helpers/test-db.ts), and each process reports where
 * they went: the `test DBs:` line counts them per worker. `pressure at start:` and `pressure at
 * end:` give Linux's io and cpu stall figures (PSI), also kept in the ledger, so a timeout can be
 * read against the disk's state at the time.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

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
  timeoutMs?: number,
): string[] {
  // R622 review I3: the running bun itself. A `bun` found on PATH may be a shim (Windows), whose
  // pid is not the test process's, and then the watchdog would never match a heartbeat to it.
  return [
    process.execPath,
    "test",
    ...(p > 1 ? [`--parallel=${p}`] : []),
    ...(mode.kind === "changed" ? [`--changed=${changedSha}`] : []),
    ...(mode.kind === "packages" ? mode.paths : []),
    ...(timeoutMs !== undefined ? [`--timeout=${timeoutMs}`] : []),
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

/**
 * R724: the error text of each failing test, so a CI console shows the cause, not only the log
 * artifact. A test is reported once, at its first `(fail)` line (bun repeats the names in its
 * closing summary, with no text before them). At most `maxLines` lines per test, each cut to 300
 * characters.
 */
export interface FailureScan {
  /** Error text per failing test name. */
  readonly details: Map<string, string[]>;
  /** The test file each failing test ran in, when bun's output names it. */
  readonly fileOf: Map<string, string>;
  /** Per file: its passing tests that took 1 s or more (`name [ms]`), the stall's neighbours. */
  readonly slow: Map<string, string[]>;
}

/**
 * Bun's real shape: an assertion error prints BEFORE its `(fail)` line, but a timeout prints
 * `  ^ this test timed out after Nms.` AFTER it (seen in CI run 40105067954). `::` lines (CI
 * group/error annotations), `file.test.ts:` headers and the banner are not error text; a header
 * (or `::group::<file>:`) says which file the following tests belong to.
 */
export function scanFailures(output: string, maxLines = 12): FailureScan {
  const details = new Map<string, string[]>();
  const fileOf = new Map<string, string>();
  const slow = new Map<string, string[]>();
  let buf: string[] = [];
  let lastFail: string | undefined;
  let file = "";
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // The closing recap repeats every (fail) line and its timeout line: stop, the first pass has them.
    if (/^\d+ tests? failed:$/.test(line)) break;
    const header = /^(?:::group::)?(\S+\.test\.[cm]?[jt]sx?):$/.exec(line)?.[1];
    if (header !== undefined) {
      file = header.replaceAll("\\", "/");
      buf = [];
      lastFail = undefined;
      continue;
    }
    if (line === "" || line.startsWith("::") || line.startsWith("bun test v")) continue;
    const failed = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (failed?.[1] !== undefined) {
      if (!details.has(failed[1])) {
        details.set(failed[1], buf.slice(-maxLines));
        if (file !== "") fileOf.set(failed[1], file);
      }
      buf = [];
      lastFail = failed[1];
      continue;
    }
    const pass = /^\(pass\) (.+?) \[([\d.]+)ms\]$/.exec(line);
    if (pass !== null || /^\((skip|todo)\) /.test(line)) {
      buf = [];
      lastFail = undefined;
      if (pass?.[1] !== undefined && Number(pass[2]) >= 1000) {
        const l = slow.get(file) ?? [];
        if (l.length < 10) l.push(`${pass[1]} [${pass[2]}ms]`);
        slow.set(file, l);
      }
      continue;
    }
    if (/^\s*\^ this test timed out after /.test(line)) {
      const d = lastFail === undefined ? undefined : details.get(lastFail);
      if (d !== undefined) d.push(line.trim());
      continue;
    }
    lastFail = undefined;
    buf.push(line.length > 300 ? `${line.slice(0, 300)}...` : line);
  }
  return { details, fileOf, slow };
}

/** Failing tests whose detail verify prints to the console; the log file has the rest. */
const DETAIL_CAP = 20;

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
 * before it. A hang in bun's coordinator itself, after the files ran, is caught only by the
 * whole-run limit (`RUN_LIMIT_S`, R616b), not by a heartbeat.
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
 * Whether `pid` is alive now with `parent` as its parent, asked of the OS just before a signal, so
 * on Linux a pid reused by another process is never hit (the check and the kill are microseconds
 * apart, and pids are handed out in sequence). Windows asks CIM through PowerShell, about a second
 * before the kill, and reuses pids quickly, so there the window is small but not zero. Any other OS,
 * or any failure to ask, answers false, and `execWatched` then uses its backstop.
 */
export function isChildOf(pid: number, parent: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid ...`; comm may hold spaces and parentheses, so split after the LAST ")".
      const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return state !== "Z" && Number(ppid) === parent; // a zombie has already ended
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
  /** Set by `execWatched`: where each of this run's test processes put its DBs (R616). */
  readonly testDbs?: readonly TestDbReport[];
}

/**
 * R616: the variable that tells the preload where to report where its test DBs went. Each test
 * process writes `<dir>/<pid>` = `<parent pid>\t<where>`, where `<where>` is `<root> (tmpfs)` or
 * `on disk (<the fallback's reason>)`.
 */
export const TEST_DB_REPORT_DIR = "LETHAL_VERIFY_TEST_DB_REPORT_DIR";

export interface TestDbReport {
  readonly pid: number;
  readonly where: string;
}

/**
 * The reports of this run's test processes, by the watchdog's rule (`stuckWorkers`): a worker of
 * the bun test child, or the child itself with verify as its parent. A nested `bun test` started
 * by a test inherits the variable and writes here too; it is dropped. A half-written file is too.
 */
export function readTestDbReports(dir: string, childPid: number, selfPid: number): TestDbReport[] {
  const out: TestDbReport[] = [];
  for (const name of readdirSync(dir)) {
    const [ppidText, where] = readFileSync(join(dir, name), "utf8").split("\t");
    const pid = Number(name);
    const ppid = Number(ppidText);
    if (where === undefined || where === "") continue;
    if (ppid === childPid || (pid === childPid && ppid === selfPid)) out.push({ pid, where });
  }
  return out;
}

/** The receipt line: where the test DBs went, counted per worker. */
export function testDbsLine(reports: readonly TestDbReport[]): string {
  if (reports.length === 0) return "test DBs: no worker reported where its DBs went";
  const n = reports.length;
  const byWhere = new Map<string, number>();
  for (const r of reports) byWhere.set(r.where, (byWhere.get(r.where) ?? 0) + 1);
  const [only] = byWhere.keys();
  if (byWhere.size === 1 && only !== undefined) {
    return `test DBs: ${only} in all ${n} ${n === 1 ? "worker" : "workers"}`;
  }
  return `test DBs: ${[...byWhere].map(([w, k]) => `${w} in ${k} of ${n} workers`).join("; ")}`;
}

/**
 * R616 review I3: the machine's stall figures, so the next unexplained timeout can be read against
 * them. Linux PSI (`/proc/pressure/io` and `/cpu`): the share of time tasks waited on that
 * resource, as avg10/avg60/avg300 (per cent over the last 10 s, 60 s, 300 s), for `some` task and
 * (where present) for `full` (all tasks). A file that cannot be read (Windows, macOS, an old
 * kernel) is skipped and named. The text holds no tab, so it fits one ledger column.
 */
export function pressureText(read: (path: string) => string): string {
  const one = (kind: "io" | "cpu"): string => {
    const path = `/proc/pressure/${kind}`;
    let text: string;
    try {
      text = read(path);
    } catch (e) {
      return `${kind} skipped (cannot read ${path}: ${e instanceof Error ? e.message : String(e)})`;
    }
    const parts: string[] = [];
    for (const line of text.split("\n")) {
      const m = /^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(line);
      if (m !== null) parts.push(`${m[1]} ${m[2]}/${m[3]}/${m[4]}`);
    }
    return parts.length === 0
      ? `${kind} skipped (no avg10 line in ${path})`
      : `${kind} ${parts.join(" ")}`;
  };
  return `${one("io")}; ${one("cpu")}`.replace(/[\t\r\n]/g, " ");
}

/**
 * Runs `cmd` (a `bun` first argument means the running bun, review I3) with the R622 watchdog. Its
 * stdout and stderr are read WHILE it runs (review I1): with a plain OS pipe, read only after exit,
 * a big run fills the pipe, the writer blocks, and the watchdog would kill an innocent file. Bun
 * 1.4.2 buffers an unread pipe itself (measured: 500 MB, read after exit, no block; probe in
 * `/coord/handoff/R-622/redcheck/pipe-probe/`), so reading while it runs is the safe order should
 * that ever change.
 *
 * Review I-A: the watchdog must never itself hang silently. Each line is printed the moment it
 * happens, not only in the receipt. A confirmed worker gets SIGTERM; one still ours `graceMs` later
 * gets SIGKILL; one still ours `graceMs` after that, or one that cannot be confirmed as ours at all,
 * triggers the backstop: SIGKILL to verify's own `bun test` child through the handle verify holds
 * (a pid that cannot be reused while the handle is held). The run then ends, failed and named.
 */
export interface WatchOptions {
  /** Prints a watchdog line the moment it happens. Default: `console.log`. */
  readonly print?: (line: string) => void;
  /** The descendant check. Default: `isChildOf`; a test injects a refusal. */
  readonly isChild?: (pid: number, parent: number) => boolean;
  /** How long a signal gets before the next step. Default: 3000 ms. */
  readonly graceMs?: number;
  /** R616b C: the whole-run limit in seconds. Default: `RUN_LIMIT_S`. */
  readonly runLimitS?: number;
}

/**
 * R616b C (R622's remaining gap): a whole-run wall limit. A full verify takes 30 to 45 s; the
 * slowest ever seen was 631 s, in R622's own hang. If a child that verify runs (the typecheck or
 * `bun test`) is still running after 900 s, verify kills it through its handle and fails by name. This catches a hang in bun's own
 * coordinator after every file ran, which no per-file heartbeat sees.
 */
export const RUN_LIMIT_S = 900;

export async function execWatched(
  cmd: readonly string[],
  env: Env,
  cwd: string,
  limitS: number,
  opts: WatchOptions = {},
): Promise<ExecResult> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const isChild = opts.isChild ?? isChildOf;
  const graceMs = opts.graceMs ?? 3000;
  const beats = mkdtempSync(join(tmpdir(), "verify-heartbeat-"));
  const dbReports = mkdtempSync(join(tmpdir(), "verify-testdbs-"));
  const argv = cmd[0] === "bun" ? [process.execPath, ...cmd.slice(1)] : [...cmd];
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...env, [HEARTBEAT_DIR]: beats, [TEST_DB_REPORT_DIR]: dbReports },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  const drain = async (s: ReadableStream<Uint8Array>, add: (t: string) => void): Promise<void> => {
    const d = new TextDecoder();
    for await (const chunk of s) add(d.decode(chunk, { stream: true }));
    add(d.decode());
  };
  const drained = Promise.all([
    drain(proc.stdout, (t) => {
      out += t;
    }),
    drain(proc.stderr, (t) => {
      err += t;
    }),
  ]);
  const fails: string[] = [];
  const say = (line: string): void => {
    fails.push(line);
    print(line);
  };
  let backstopped = false;
  const backstop = (why: string): void => {
    if (backstopped) return;
    backstopped = true;
    proc.kill("SIGKILL");
    say(
      `watchdog: backstop, ${why}; sent SIGKILL to this run's bun test process ${proc.pid} through its handle, which stopped the whole run. R622.`,
    );
  };
  const signal = (pid: number, sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(pid, sig);
    } catch {
      // it ended between the check and the signal; the next check sees that
    }
  };
  const sent: Array<{ pid: number; ppid: number; who: string; step: "TERM" | "KILL"; at: number }> =
    [];
  const runLimitMs = (opts.runLimitS ?? RUN_LIMIT_S) * 1000;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (!backstopped && now - startedAt > runLimitMs) {
      backstopped = true;
      proc.kill("SIGKILL");
      say(
        `watchdog: FAIL, this run went over ${runLimitMs / 1000} s${fails.length === 0 ? " (no file was over its limit)" : ""}; sent SIGKILL to process ${proc.pid} through its handle. R622.`,
      );
    }
    for (const b of stuckWorkers(
      readHeartbeats(beats),
      now,
      limitS * 1000,
      proc.pid,
      process.pid,
    )) {
      rmSync(join(beats, String(b.pid)), { force: true }); // report each file once
      const rel = relative(cwd, b.file);
      const file = (rel.startsWith("..") ? b.file : rel).replaceAll("\\", "/");
      const serial = b.pid === proc.pid;
      const who = serial ? `the bun test process ${b.pid} (serial)` : `worker ${b.pid}`;
      say(
        `watchdog: FAIL, ${file} ran over ${limitS} s in ${who}${serial ? " (a file stuck before its first test is named as the file before it)" : ""}. R622.`,
      );
      if (!isChild(b.pid, b.ppid)) {
        backstop(`${who} could not be confirmed as a child of this run, so it was not signalled`);
        continue;
      }
      signal(b.pid, "SIGTERM");
      say(`watchdog: sent SIGTERM to ${who}`);
      sent.push({ pid: b.pid, ppid: b.ppid, who, step: "TERM", at: now });
    }
    for (const w of sent) {
      if (now - w.at < graceMs || !isChild(w.pid, w.ppid)) continue; // waiting, or it ended
      if (w.step === "TERM") {
        signal(w.pid, "SIGKILL");
        say(`watchdog: ${w.who} outlived SIGTERM by ${graceMs} ms; sent SIGKILL`);
        w.step = "KILL";
        w.at = now;
      } else {
        backstop(`${w.who} outlived SIGKILL by ${graceMs} ms`);
      }
    }
  }, 1000);
  try {
    const code = await proc.exited;
    // After the backstop a worker that was never signalled may live on holding the pipes open, so
    // take what has arrived instead of waiting for the end of the stream.
    await (backstopped ? Promise.race([drained.catch(() => {}), Bun.sleep(graceMs)]) : drained);
    return {
      code,
      output: `${out}${err}`,
      watchdog: { limitS, fails },
      testDbs: readTestDbReports(dbReports, proc.pid, process.pid),
    };
  } finally {
    clearInterval(timer);
    for (const d of [beats, dbReports]) {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

/** The shared ledger, unless LETHAL_VERIFY_LEDGER names another file. */
export const LEDGER_PATH = "/coord/locks/verify-ledger.tsv";
export const LEDGER_ENV = "LETHAL_VERIFY_LEDGER";

/** A line's byte limit: well under PIPE_BUF (4096), the size a single O_APPEND write keeps whole. */
export const LEDGER_LINE_MAX = 1024;
/** The worktree column keeps at most this many characters (its tail): 4 bytes each at most. */
const LEDGER_WORKTREE_MAX = 200;
/** The pressure column's limit: a full reading is about 110 ASCII characters; an error text may be longer. */
const PRESSURE_MAX = 300;

/**
 * An open START older than this is not running, even if its pid is alive: that pid was reused. 15
 * minutes is about 36 times the slowest full verify seen on Linux (24.9 s at P=8, load 49,
 * `/coord/handoff/R-622/repro.md`), and a run the watchdog stops ends long before it.
 */
export const LEDGER_STALE_MS = 15 * 60 * 1000;

export interface LedgerSelf {
  readonly pid: number;
  readonly start: number;
  readonly p: number;
  readonly scope: VerifyMode["kind"];
  readonly worktree: string;
}

/**
 * R622 the verify ledger. Why: a full verify at 05:33Z on 2026-10-22 failed with 9 SQLite timeouts
 * at load 6, and whether other full verifies ran at the same time could not be checked (R616).
 *
 * One line per event, tab-separated, in this fixed order:
 *   event   START or END
 *   start   the run's start, UTC ISO (on both lines: pid + start is the run's key)
 *   end     the run's end, UTC ISO; `-` on START
 *   pid     verify's pid
 *   p       the P it ran with
 *   result  pass or fail; `-` on START
 *   failed  the failed-test count, `?` when no summary was read; `-` on START
 *   scope   full, changed or packages
 *   worktree the repo root; tabs and newlines become spaces, and a long one keeps only its tail
 *   pressure `pressureText` read at that event (R616), `-` when none was read; cut to its first
 *            PRESSURE_MAX characters
 * A run that died leaves a START with no END, and any line that does not parse is skipped. A line
 * written before R616 has 9 columns (no pressure) and still parses; a verify from before R616
 * reads only 9-column lines, so it skips the new ones until its branch merges master.
 */
export function ledgerLine(
  event: "START" | "END",
  self: LedgerSelf,
  finish?: { readonly end: number; readonly ok: boolean; readonly failed: number | undefined },
  pressure = "-",
): string {
  const clean = self.worktree.replace(/[\t\r\n]/g, " ");
  const worktree =
    clean.length > LEDGER_WORKTREE_MAX ? `...${clean.slice(-LEDGER_WORKTREE_MAX)}` : clean;
  const stall = pressure.replace(/[\t\r\n]/g, " ").slice(0, PRESSURE_MAX);
  const iso = (ms: number): string => new Date(ms).toISOString();
  return `${[
    event,
    iso(self.start),
    finish === undefined ? "-" : iso(finish.end),
    self.pid,
    self.p,
    finish === undefined ? "-" : finish.ok ? "pass" : "fail",
    finish === undefined ? "-" : (finish.failed ?? "?"),
    self.scope,
    worktree,
    stall,
  ].join("\t")}\n`;
}

export interface LedgerRun {
  readonly pid: number;
  readonly start: number;
  /** Undefined while only its START is in the ledger. */
  readonly end: number | undefined;
}

/** Every run in the ledger's text, keyed by pid + start. A line that does not parse is skipped. */
export function parseLedger(text: string): LedgerRun[] {
  const runs = new Map<string, LedgerRun>();
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f.length !== 9 && f.length !== 10) continue; // 9: written before R616's pressure column
    const [event, startText, endText, pidText] = f;
    const pid = Number(pidText);
    const start = Date.parse(startText ?? "");
    if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(start)) continue;
    const key = `${pid}\t${start}`;
    if (event === "START") {
      if (!runs.has(key)) runs.set(key, { pid, start, end: undefined });
    } else if (event === "END") {
      const end = Date.parse(endText ?? "");
      if (!Number.isNaN(end)) runs.set(key, { pid, start, end });
    }
  }
  return [...runs.values()];
}

/**
 * How many runs of OTHER pids overlap ours, `self.start` to `until` (our start for the START count,
 * now for the END count). A run with no END is taken as running now only while its pid is alive
 * AND its start is under LEDGER_STALE_MS old: a dead pid crashed, and an old live one was reused.
 */
export function countOverlaps(
  runs: readonly LedgerRun[],
  self: { readonly pid: number; readonly start: number },
  until: number,
  now: number,
  alive: (pid: number) => boolean,
): number {
  return runs.filter((r) => {
    if (r.pid === self.pid) return false;
    const end = r.end ?? (now - r.start < LEDGER_STALE_MS && alive(r.pid) ? now : undefined);
    return end !== undefined && r.start <= until && end >= self.start;
  }).length;
}

/** Whether a process with this pid exists (EPERM: it does, owned by another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ONE write() of the whole line on an O_APPEND descriptor, so concurrent lines never interleave. */
export function ledgerAppend(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    const n = writeSync(fd, line);
    if (n !== Buffer.byteLength(line)) throw new Error(`short write (${n} bytes)`);
  } finally {
    closeSync(fd);
  }
}

export interface LedgerIo {
  readonly path: string;
  readonly worktree: string;
  readonly pid: number;
  readonly alive: (pid: number) => boolean;
}

/** Appends `line`, then counts the overlaps up to `until`. Never throws: an error is returned. */
function ledgerEvent(
  l: LedgerIo,
  line: string,
  self: LedgerSelf,
  until: number,
  now: number,
): { count: number } | { error: string } {
  try {
    ledgerAppend(l.path, line);
    const runs = parseLedger(readFileSync(l.path, "utf8"));
    return { count: countOverlaps(runs, self, until, now, l.alive) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const others = (n: number): string => `${n} other ${n === 1 ? "verify" : "verifies"}`;

/** R616b: bun's default per-test timeout, the raised one, and the io stall that raises it. */
export const DEFAULT_TIMEOUT_MS = 5000;
export const RAISED_TIMEOUT_MS = 15000;
export const IO_FULL_RAISE = 5.0;

/**
 * R616b B. When the disk is stalled just before the test step (io `full` avg10 >= 5.0: all tasks
 * waited on io for 5% of the last 10 s; read after the slot wait, so it describes the disk the
 * tests will meet), the test child gets `--timeout=15000`. Otherwise bun's 5000 ms stays. Pressure
 * that cannot be read (Windows, no /proc) keeps the default and says so. A test that hangs still
 * fails, only 10 s later. bun's own timeout is not re-tested here.
 */
export function testTimeout(pressure: string | undefined): { ms: number; line: string } {
  const m = /io some [\d.]+\/[\d.]+\/[\d.]+ full ([\d.]+)\//.exec(pressure ?? "");
  if (m?.[1] === undefined) {
    return {
      ms: DEFAULT_TIMEOUT_MS,
      line: `per-test timeout: ${DEFAULT_TIMEOUT_MS} ms (default; io pressure unreadable)`,
    };
  }
  if (Number(m[1]) >= IO_FULL_RAISE) {
    return {
      ms: RAISED_TIMEOUT_MS,
      line: `per-test timeout: ${RAISED_TIMEOUT_MS} ms (io full avg10 ${m[1]} >= ${IO_FULL_RAISE})`,
    };
  }
  return { ms: DEFAULT_TIMEOUT_MS, line: `per-test timeout: ${DEFAULT_TIMEOUT_MS} ms (default)` };
}

/** R616b A: the slot lock's name (beside the ledger), the wait limit and the poll interval. */
export const SLOT_NAME = "verify-slot.lock";
export const SLOT_WAIT_LIMIT_S = 600;
export const SLOT_POLL_MS = 2000;

export function slotPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), SLOT_NAME);
}

/** The wait ran past its limit with a live holder. Verify fails by name; it never runs anyway. */
export class SlotTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotTimeoutError";
  }
}

export type SlotSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
const SLOT_SIGNAL_EXIT: Record<SlotSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export interface SlotIo {
  readonly path: string;
  readonly pid: number;
  readonly worktree: string;
  readonly alive: (pid: number) => boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
  readonly proc: {
    on(sig: SlotSignal, fn: () => void): void;
    off(sig: SlotSignal, fn: () => void): void;
    exit(code: number): void;
  };
  readonly waitLimitS?: number;
}

export interface Slot {
  /** For the receipt: `took`, `waited N s` or `took a stale lock from pid P`. */
  readonly line: string;
  release(): void;
}

/** The pid in the lock file; `null` when the file is gone, `undefined` when it holds no pid (yet). */
function slotHolder(path: string): { pid: number | undefined; worktree: string } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const [pidText, worktree] = text.split("\t");
  const pid = Number(pidText);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : undefined, worktree: worktree ?? "?" };
}

/**
 * R616b A. One full verify at a time: the test step runs only while this process holds
 * `<ledger dir>/verify-slot.lock` (`<pid>\t<worktree>\t<start ISO>`), created with an exclusive
 * create (`wx`). A live holder is waited for, polling every 2 s, up to 10 min (then
 * `SlotTimeoutError`). A holder is stale when its PID IS DEAD (never by age alone: a slow verify
 * is not a dead one), and then the lock is taken over. The lock is released on every exit path:
 * the caller's `finally`, and SIGINT, SIGTERM and SIGHUP (the handler removes the lock only if it
 * still holds our pid, then exits 128 + the signal number). SIGKILL or a crash cannot run a
 * handler; the next verify finds the dead pid and takes over.
 *
 * ponytail: the pid-reuse window. If a crashed holder's pid has been given to an unrelated live
 * process, its lock reads as live until that process ends or the 10 min limit fails the wait (then
 * delete the file by hand). Two verifies taking over the same stale lock at once can each delete
 * the other's fresh lock; the re-read before the delete makes that window microseconds. A lock
 * file with no readable pid (caught half-written, or a crash between create and write) is waited
 * for like a live one. Upgrade for any of these: a real flock, which bun cannot call.
 *
 * ponytail: a SIGTERM or SIGHUP sent to verify ALONE releases the lock, but the `bun test` child
 * is orphaned and may keep running, so the next verify can start beside it. Ctrl-C reaches the
 * whole process group and is fine. Upgrade: kill the child from the handler (needs its handle).
 */
export async function acquireSlot(s: SlotIo): Promise<Slot> {
  const limitMs = (s.waitLimitS ?? SLOT_WAIT_LIMIT_S) * 1000;
  const t0 = s.now();
  let announced = false;
  let stale: number | undefined;
  for (;;) {
    try {
      writeFileSync(s.path, `${s.pid}\t${s.worktree}\t${new Date(s.now()).toISOString()}`, {
        flag: "wx",
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = slotHolder(s.path);
    if (holder === null) continue; // it left between our create and our read
    // Our own pid in the file is a leftover of an earlier process that had this pid.
    if (holder.pid !== undefined && (holder.pid === s.pid || !s.alive(holder.pid))) {
      if (slotHolder(s.path)?.pid === holder.pid) {
        rmSync(s.path, { force: true });
        stale = holder.pid;
      }
      continue;
    }
    const who =
      holder.pid === undefined
        ? "a verify (the lock holds no pid)"
        : `pid ${holder.pid} (${holder.worktree})`;
    const waited = s.now() - t0;
    if (waited >= limitMs) {
      throw new SlotTimeoutError(
        `waited ${limitMs / 1000} s for ${who} to finish its tests; not running anyway. ` +
          `If that verify is gone, delete ${s.path}.`,
      );
    }
    if (!announced) {
      announced = true;
      s.print(`verify slot: waiting for ${who}`);
    }
    await s.sleep(SLOT_POLL_MS);
  }
  const handlers = new Map<SlotSignal, () => void>();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const [sig, fn] of handlers) s.proc.off(sig, fn);
    try {
      if (slotHolder(s.path)?.pid === s.pid) rmSync(s.path, { force: true });
    } catch {
      // nothing more to do; the next verify sees our dead pid
    }
  };
  for (const sig of Object.keys(SLOT_SIGNAL_EXIT) as SlotSignal[]) {
    const fn = (): void => {
      release();
      s.proc.exit(SLOT_SIGNAL_EXIT[sig]);
    };
    handlers.set(sig, fn);
    s.proc.on(sig, fn);
  }
  const line =
    stale !== undefined
      ? `took a stale lock from pid ${stale}`
      : announced
        ? `waited ${Math.round((s.now() - t0) / 1000)} s`
        : "took";
  return { line, release };
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
  /** R616b: bun's `--timeout`, only when raised (`testTimeout`); none keeps bun's 5000 ms. */
  readonly timeoutMs?: number;
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
    testCommand(plan.mode, plan.p, plan.changedSha, junit, plan.timeoutMs),
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
    const scan = scanFailures(t.output);
    const slowShown = new Set<string>();
    for (const [i, name] of summary.failing.entries()) {
      lines.push(`  (fail) ${name}`);
      if (i >= DETAIL_CAP) continue;
      for (const d of scan.details.get(name) ?? []) lines.push(`    | ${d}`);
      const f = scan.fileOf.get(name);
      if (f !== undefined && !slowShown.has(f)) {
        slowShown.add(f);
        for (const s of scan.slow.get(f) ?? []) lines.push(`    | slow pass in ${f}: ${s}`);
      }
    }
    if (summary.failing.length > DETAIL_CAP)
      lines.push(
        `  ... error text shown for the first ${DETAIL_CAP} of ${summary.failing.length} failing tests; the log has the rest`,
      );
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
  // R616 review minor 4: from each worker's own report, so a worker that fell back is named.
  if (t.testDbs !== undefined) lines.push(testDbsLine(t.testDbs));
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
  /** The R622 ledger; none, no ledger lines. */
  readonly ledger?: LedgerIo;
  /** R616: the stall figures now (`pressureText`); none, no pressure lines and `-` in the ledger. */
  readonly pressure?: () => string;
  /** R616b: the slot lock; none, no slot (the receipt says so). */
  readonly slot?: SlotIo;
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
  // R622: the ledger's START. A failure is warned about once, at the end, and never fails the run.
  const ledger = io.ledger;
  const self: LedgerSelf = {
    pid: ledger?.pid ?? 0,
    start: t0,
    p,
    scope: mode.kind,
    worktree: ledger?.worktree ?? "",
  };
  // R616: the stall figures at the start and the end, printed and kept in the ledger.
  const startPressure = io.pressure?.();
  if (startPressure !== undefined) say(`pressure at start: ${startPressure}`);
  const atStart =
    ledger === undefined
      ? undefined
      : ledgerEvent(ledger, ledgerLine("START", self, undefined, startPressure), self, t0, t0);
  if (ledger !== undefined && atStart !== undefined && "count" in atStart) {
    say(`ledger: ${others(atStart.count)} running at start (${ledger.path})`);
  }
  const ledgerEnd = (ok: boolean, summary: TestSummary | null): void => {
    const endPressure = io.pressure?.();
    if (endPressure !== undefined) say(`pressure at end: ${endPressure}`);
    if (ledger === undefined || atStart === undefined) return;
    const now = io.now();
    const atEnd =
      "count" in atStart
        ? ledgerEvent(
            ledger,
            ledgerLine("END", self, { end: now, ok, failed: summary?.fail }, endPressure),
            self,
            now,
            now,
          )
        : atStart;
    say(
      "count" in atStart && "count" in atEnd
        ? `ledger: ${others(atStart.count)} running at start, ${atEnd.count} overlapped by end (${ledger.path})`
        : `ledger: unavailable (${"error" in atEnd ? atEnd.error : ""}); overlap not recorded`,
    );
  };
  const done = (code: number, summary: TestSummary | null): { code: number; lines: string[] } => {
    ledgerEnd(code === 0, summary);
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
  // R616b: one verify at a time on the test step; typecheck above stays parallel.
  let slot: Slot | undefined;
  const ci = ciVariable(io.env);
  if (ci !== undefined) {
    say("verify slot: skipped (CI)");
  } else if (io.slot === undefined) {
    say("verify slot: skipped (no slot folder)");
  } else {
    try {
      slot = await acquireSlot({
        ...io.slot,
        print: (l) => {
          say(l);
        },
      });
      say(`verify slot: ${slot.line}`);
    } catch (e) {
      if (e instanceof SlotTimeoutError) {
        say(`verify slot: FAIL, ${e.message}`);
        return done(1, null);
      }
      say(
        `verify slot: unavailable (${e instanceof Error ? e.message : String(e)}); running without it`,
      );
    }
  }
  const timeout = testTimeout(io.pressure?.());
  say(timeout.line);
  let step: Awaited<ReturnType<typeof testStep>>;
  try {
    step = await testStep(
      { ...plan, ...(timeout.ms !== DEFAULT_TIMEOUT_MS ? { timeoutMs: timeout.ms } : {}) },
      io,
    );
  } finally {
    slot?.release();
  }
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
      ledger: {
        path: process.env[LEDGER_ENV] || LEDGER_PATH,
        worktree: REPO_ROOT,
        pid: process.pid,
        alive: pidAlive,
      },
      pressure: () => pressureText((p) => readFileSync(p, "utf8")),
      slot: {
        path: slotPath(process.env[LEDGER_ENV] || LEDGER_PATH),
        pid: process.pid,
        worktree: REPO_ROOT,
        alive: pidAlive,
        now: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
        print: (l) => console.log(l),
        proc: {
          on: (sig, fn) => void process.on(sig, fn),
          off: (sig, fn) => void process.off(sig, fn),
          exit: (code) => process.exit(code),
        },
      },
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
