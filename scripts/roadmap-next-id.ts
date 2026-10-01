/**
 * Prints the next free roadmap id (`R<n>`) and its file name.
 *
 *   bun scripts/roadmap-next-id.ts     # stdout: R389 docs/roadmap/R389.md
 *
 * "Free" means unused ANYWHERE this clone can see: the working tree's `docs/roadmap/`, every local
 * and remote branch (`git for-each-ref` + `git ls-tree`), and every other worktree from
 * `git worktree list`. Other sessions file rows concurrently (R174 was overwritten that way), so
 * the working tree alone is not enough. `_template.md` and any non-`R<nnn>.md` name are ignored.
 * Run it immediately before writing the file; it cannot see a session that has not committed.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ROW_DIR, RoadmapFormatError, rowFileName } from "./roadmap-index.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const ROW_FILE_RE = /^R(\d{3,})\.md$/;

/** Numeric ids from file names or paths; anything that is not `R<nnn>.md` is skipped. */
export function idsFromNames(names: readonly string[]): number[] {
  const ids: number[] = [];
  for (const name of names) {
    const m = ROW_FILE_RE.exec(basename(name.trim()));
    if (m?.[1] !== undefined) ids.push(Number(m[1]));
  }
  return ids;
}

/** Max over every source, plus one. Throws when no source holds any id. */
export function nextId(sources: ReadonlyMap<string, readonly number[]>): {
  next: number;
  max: number;
  maxSeenIn: string[];
} {
  let max = -1;
  for (const ids of sources.values()) for (const id of ids) if (id > max) max = id;
  if (max < 0) {
    throw new RoadmapFormatError(`no R<nnn>.md ids found in ${sources.size} source(s)`);
  }
  const maxSeenIn = [...sources].filter(([, ids]) => ids.includes(max)).map(([s]) => s);
  return { next: max + 1, max, maxSeenIn };
}

function git(args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.toString().trim()}`,
    );
  }
  return r.stdout.toString();
}

/** Worktree paths from `git worktree list --porcelain`. */
export function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

function collect(): Map<string, number[]> {
  const sources = new Map<string, number[]>();
  sources.set("working tree", idsFromNames(readdirSync(join(REPO_ROOT, ROW_DIR))));
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
    .split(/\r?\n/)
    .filter((r) => r !== "" && !r.endsWith("/HEAD"));
  for (const ref of refs) {
    sources.set(ref, idsFromNames(git(["ls-tree", "--name-only", ref, `${ROW_DIR}/`]).split("\n")));
  }
  for (const wt of worktreePaths(git(["worktree", "list", "--porcelain"]))) {
    const dir = join(wt, ROW_DIR);
    // A pruned worktree's folder is gone; its commits are already covered by its branch ref.
    if (existsSync(dir)) sources.set(`worktree ${wt}`, idsFromNames(readdirSync(dir)));
  }
  return sources;
}

if (import.meta.main) {
  const sources = collect();
  const { next, max, maxSeenIn } = nextId(sources);
  console.error(
    `max R${max} across ${sources.size} sources (seen in ${maxSeenIn.slice(0, 3).join(", ")})`,
  );
  console.log(`R${next} ${ROW_DIR}/${rowFileName(next)}`);
}
