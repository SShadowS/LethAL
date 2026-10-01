/**
 * The build/test loop from CLAUDE.md, in the order that matters, as one command.
 *
 *   bun scripts/verify.ts              # typecheck, clean dist, full `bun test`
 *   bun scripts/verify.ts runner engine  # ... then `bun test packages/runner packages/engine`
 *
 * Steps: `bun run typecheck`; delete every `packages/*\/dist` IN-PROCESS (so no shell `rm -rf`
 * hook can block it, and stale compiled `*.test.js` cannot cause phantom failures); `bun test`
 * from the repo root (so `bunfig.toml`'s preload applies). Prints one line per step, the
 * pass/skip/fail counts, and the names of failing tests. The full output of a failing step goes to
 * a log file whose path is printed. Exits non-zero on any failure, or when the test summary cannot
 * be read: an unreadable summary is never reported as a pass.
 *
 * R393 (snapshot late write). A test that times out keeps running, and its late `toMatchSnapshot()`
 * is filed under the NEXT test's name, silently adding a wrong entry to a tracked `.snap`. Two guards,
 * both for verify.ts users ONLY (a plain `bun test` is not protected by either):
 *   1. The `bun test` child runs with `CI=true` in its env, set before bun starts (bun reads CI once at
 *      launch; a preload that sets it is too late). Then a snapshot that does not exist yet is REFUSED
 *      instead of written. Set LETHAL_TEST_ALLOW_SNAPSHOT_CREATE=1 to drop it (the output says so).
 *      To add a snapshot on purpose, run `bun test --update-snapshots <file>` yourself.
 *   2. The belt: `git status --porcelain -- '*.snap'` (staged, unstaged and untracked) plus a hash of
 *      each listed file, taken before and after the test step. Any `.snap` that changed DURING the run
 *      fails verify.ts and is named. A `.snap` that was already dirty before is not blamed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

export class VerifyArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyArgsError";
  }
}

/** Package names to `bun test` paths. No args means the whole suite (`[]`). */
export function parseArgs(argv: readonly string[], known: readonly string[]): string[] {
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-"))
      throw new VerifyArgsError(`unknown flag '${arg}' (usage: verify.ts [pkg...])`);
    const name = arg.replace(/^packages\//, "").replace(/\/$/, "");
    if (!known.includes(name)) {
      throw new VerifyArgsError(`no package '${arg}' under packages/ (have: ${known.join(", ")})`);
    }
    paths.push(`packages/${name}`);
  }
  return paths;
}

export interface TestSummary {
  readonly pass: number;
  readonly skip: number;
  readonly fail: number;
  readonly todo: number;
  readonly failing: string[];
}

/**
 * Reads `bun test`'s closing counts (` 25 pass`, ` 0 fail`, ...) and its `(fail) <name>` lines.
 * Returns null when no `pass` and no `fail` count is present: the caller treats that as a failure.
 */
export function parseTestSummary(output: string): TestSummary | null {
  const counts = new Map<string, number>();
  const failing: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const count = /^\s*(\d+) (pass|skip|fail|todo)$/.exec(line);
    if (count !== null) {
      const [, n, kind] = count;
      if (n !== undefined && kind !== undefined) counts.set(kind, Number(n));
      continue;
    }
    const failed = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (failed?.[1] !== undefined && !failing.includes(failed[1])) failing.push(failed[1]);
  }
  if (!counts.has("pass") && !counts.has("fail")) return null;
  return {
    pass: counts.get("pass") ?? 0,
    skip: counts.get("skip") ?? 0,
    fail: counts.get("fail") ?? 0,
    todo: counts.get("todo") ?? 0,
    failing,
  };
}

export const ALLOW_SNAPSHOT_CREATE = "LETHAL_TEST_ALLOW_SNAPSHOT_CREATE";

/**
 * The env for the `bun test` child: `CI=true` unless the opt-out is set. The opt-out also REMOVES
 * an inherited `CI`, so "guard off" really means bun may create a snapshot.
 */
export function testChildEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (base[ALLOW_SNAPSHOT_CREATE] === "1") {
    const { CI: _ci, ...rest } = base;
    return rest;
  }
  return { ...base, CI: "true" };
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

export interface TestStepIo {
  exec(cmd: string[], env: Record<string, string | undefined>): { code: number; output: string };
  snapState(): SnapState;
  env: Record<string, string | undefined>;
  log(output: string): string;
}

/** The `bun test` step with both R393 guards. Returns the lines to print and the exit code. */
export function testStep(
  paths: readonly string[],
  io: TestStepIo,
): { code: number; lines: string[] } {
  const lines: string[] = [];
  const optOut = io.env[ALLOW_SNAPSHOT_CREATE] === "1";
  lines.push(
    optOut
      ? `snapshot guard: OFF (${ALLOW_SNAPSHOT_CREATE}=1), a missing snapshot will be written`
      : "snapshot guard: CI=true for the test child, a missing snapshot is refused",
  );
  const before = io.snapState();
  const t = io.exec(["bun", "test", ...paths], testChildEnv(io.env));
  const after = io.snapState();
  const summary = parseTestSummary(t.output);
  const scope = paths.length === 0 ? "all" : paths.join(" ");
  let code = 0;
  if (summary === null) {
    lines.push(
      `test (${scope}): FAIL, no pass/fail summary in output (exit ${t.code}), log ${io.log(t.output)}`,
    );
    code = 1;
  } else {
    const ok = t.code === 0 && summary.fail === 0;
    const counts = `${summary.pass} pass / ${summary.skip} skip / ${summary.fail} fail${summary.todo > 0 ? ` / ${summary.todo} todo` : ""}`;
    lines.push(
      `test (${scope}): ${ok ? "ok" : "FAIL"} ${counts}${ok ? "" : ` (exit ${t.code}), log ${io.log(t.output)}`}`,
    );
    for (const name of summary.failing) lines.push(`  (fail) ${name}`);
    if (!ok) code = 1;
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
  return { code, lines };
}

function run(cmd: string[]): { code: number; output: string } {
  const r = Bun.spawnSync(cmd, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, output: `${r.stdout.toString()}${r.stderr.toString()}` };
}

function saveLog(step: string, output: string): string {
  const path = join(tmpdir(), `lethal-verify-${step}-${Date.now()}.log`);
  writeFileSync(path, output);
  return path;
}

function main(argv: readonly string[]): number {
  const packages = readdirSync(join(REPO_ROOT, "packages"));
  const paths = parseArgs(argv, packages);

  const tc = run(["bun", "run", "typecheck"]);
  if (tc.code !== 0) {
    console.log(`typecheck: FAIL (exit ${tc.code}), log ${saveLog("typecheck", tc.output)}`);
    console.log(
      tc.output
        .split(/\r?\n/)
        .filter((l) => /error TS\d+/.test(l))
        .slice(0, 30)
        .join("\n"),
    );
    return 1;
  }
  console.log("typecheck: ok");

  const removed: string[] = [];
  for (const pkg of packages) {
    const dist = join(REPO_ROOT, "packages", pkg, "dist");
    if (!existsSync(dist)) continue;
    rmSync(dist, { recursive: true, force: true });
    removed.push(pkg);
  }
  console.log(`clean dist: removed ${removed.length} (${removed.join(", ") || "none present"})`);

  const step = testStep(paths, {
    exec: (cmd, env) => {
      const r = Bun.spawnSync(cmd, { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode ?? 1, output: `${r.stdout.toString()}${r.stderr.toString()}` };
    },
    snapState: readSnapState,
    env: process.env,
    log: (o) => saveLog("test", o),
  });
  for (const l of step.lines) console.log(l);
  return step.code;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
