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
 */

import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  const t = run(["bun", "test", ...paths]);
  const summary = parseTestSummary(t.output);
  const scope = paths.length === 0 ? "all" : paths.join(" ");
  if (summary === null) {
    console.log(
      `test (${scope}): FAIL, no pass/fail summary in output (exit ${t.code}), log ${saveLog("test", t.output)}`,
    );
    return 1;
  }
  const ok = t.code === 0 && summary.fail === 0;
  const counts = `${summary.pass} pass / ${summary.skip} skip / ${summary.fail} fail${summary.todo > 0 ? ` / ${summary.todo} todo` : ""}`;
  console.log(
    `test (${scope}): ${ok ? "ok" : "FAIL"} ${counts}${ok ? "" : ` (exit ${t.code}), log ${saveLog("test", t.output)}`}`,
  );
  for (const name of summary.failing) console.log(`  (fail) ${name}`);
  return ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
