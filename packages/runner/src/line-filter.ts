import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SpawnFn } from "./publisher";

/**
 * Issue #19: a line-scoped mutant filter for PR runs (`--lines`, `--changed-since`).
 *
 * `--only` selects whole files, so a PR run spent most of its time on lines the PR never touched
 * (measured on a Document Output PR: 137 of 527 mutants on unchanged lines cost ~833 s of the first
 * 935 s). This keeps a mutant when its span shares at least one line with a range. Applied after
 * per-file dedup, like `--operator`, so the result is a strict subset of an unfiltered run and
 * cannot change a verdict.
 *
 * A mutant spanning both changed and unchanged lines is KEPT, deliberately: an `empty-block` over a
 * whole body with one changed line mutates behaviour the PR changed.
 */
export interface LineRange {
  /** Project-relative, forward slashes. */
  readonly file: string;
  /** 1-based, inclusive. */
  readonly start: number;
  readonly end: number;
}

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** `<file>:<start>-<end>` or `<file>:<line>`. The LAST colon splits, so a Windows drive letter in
 *  a path is not mistaken for the separator (though the path must be project-relative). */
export function parseLineArg(arg: string): LineRange {
  const at = arg.lastIndexOf(":");
  const file = at > 0 ? arg.slice(0, at) : "";
  const m = /^(\d+)(?:-(\d+))?$/.exec(at > 0 ? arg.slice(at + 1) : "");
  if (file === "" || m === null) {
    throw new Error(
      `--lines ${JSON.stringify(arg)}: expected <file>:<start>-<end> or <file>:<line>`,
    );
  }
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1 || end < start) {
    throw new Error(
      `--lines ${JSON.stringify(arg)}: lines are 1-based and <start> must not exceed <end>`,
    );
  }
  return { file: normalizeRelPath(file), start, end };
}

/**
 * The ADDED/modified line ranges of a `git diff -U0` (new-file side). A pure deletion (`+c,0`)
 * adds no line and yields no range: nothing is left at that spot to mutate. Deleted files and
 * `/dev/null` targets yield nothing either.
 *
 * GH-25: a binary `.al` (git prints no `+++` line for it) and a `.al` path git QUOTED both throw,
 * because either would otherwise contribute nothing and its changes would silently get no mutants.
 */
export function parseUnifiedDiffAdded(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  let file: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const binary = /^Binary files .* and b\/(.+) differ$/.exec(line)?.[1];
    if (binary?.toLowerCase().endsWith(".al")) {
      throw new Error(binaryAlMessage(normalizeRelPath(binary)));
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target.startsWith('"')) {
        if (target.toLowerCase().endsWith('.al"')) {
          throw new Error(
            `${target}: git quoted this path, which LethAL does not unquote, so its changes would silently get no mutants`,
          );
        }
        file = undefined;
        continue;
      }
      file = target === "/dev/null" ? undefined : normalizeRelPath(target.replace(/^b\//, ""));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.push({ file, start, end: start + count - 1 });
  }
  return ranges;
}

const binaryAlMessage = (path: string) =>
  `a binary .al file (${path}): git reports no lines for it, so its changes would silently get no mutants`;

/** Lines in a text as tree-sitter counts rows: split on "\n", a trailing newline ends the last
 *  line rather than starting a new one. "" is 0. CRLF counts the same as LF. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** GH-25: where `--changed-since` lines came from. Recorded in the report. */
export interface ChangedSinceSource {
  /** The ref as given. */
  readonly ref: string;
  /** Full sha of `git merge-base <ref> HEAD`; the diff runs from here to the working tree. */
  readonly mergeBase: string;
  /** Untracked, not-ignored `.al` files under the project (minus `Mutation*`, as enumeration skips them), project-relative, sorted. Every line
   *  of each counts as changed; an empty one is listed and contributes no range. */
  readonly untrackedFiles: readonly string[];
}

const isAl = (p: string) => p.toLowerCase().endsWith(".al");

/** The files `generateMutationSet` parses: `.al`, minus its own emitted `Mutation*` artifacts.
 *  Shared with it, so "LethAL parses this" means one thing in both places. */
export const isEnumeratedAl = (p: string) => isAl(p) && !basename(p).startsWith("Mutation");

/** "Holds a file LethAL would parse", walked the way `generateMutationSet` walks the project. */
async function holdsAlFile(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir, { recursive: true })).some(isEnumeratedAl);
  } catch (e) {
    // A submodule registered in the index but absent on disk: LethAL parses nothing there.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * GH-25: the lines changed between `git merge-base <ref> HEAD` and the WORKING TREE, plus every
 * line of each untracked, not-ignored `.al` file. The working tree is what LethAL parses and
 * deploys, so these line numbers match the files the mutants are generated from; #19's
 * `<ref>...HEAD` used HEAD's numbering and misaligned on a dirty tree. On a clean tree the two
 * are identical. Runs inside the project with `--relative` and `-- .`, so paths come out
 * project-relative even when the project is a subdirectory of the repository. Only `.al` ranges
 * are returned.
 */
// ponytail: reads the live tree at session start; an edit before generateMutationSet parses misaligns the lines. R205's snapshot closes this.
export async function changedLinesSince(
  projectDir: string,
  ref: string,
  spawn: SpawnFn,
): Promise<{ ranges: LineRange[]; source: ChangedSinceSource }> {
  const run = async (args: readonly string[]) => {
    const out = await spawn(["git", ...args], { cwd: projectDir });
    if (out.exitCode !== 0) {
      throw new Error(
        `--changed-since ${ref}: git ${args.join(" ")} failed in ${projectDir} (exit ${out.exitCode}): ${out.stderr.trim()}`,
      );
    }
    return out.stdout;
  };

  const mb = await spawn(["git", "merge-base", ref, "HEAD"], { cwd: projectDir });
  if (mb.exitCode === 1 && mb.stdout.trim() === "") {
    throw new Error(
      `--changed-since ${ref}: ${ref} and HEAD share no commit (an orphan branch or a shallow clone?) in ${projectDir}`,
    );
  }
  if (mb.exitCode !== 0) {
    throw new Error(
      `--changed-since ${ref}: git merge-base ${ref} HEAD failed in ${projectDir} (exit ${mb.exitCode}): ${mb.stderr.trim()}`,
    );
  }
  const mergeBase = mb.stdout.trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(mergeBase)) {
    throw new Error(
      `--changed-since ${ref}: git merge-base ${ref} HEAD printed ${JSON.stringify(mergeBase)}, not a commit sha`,
    );
  }

  // An index flag makes git diff treat a file as unchanged whatever is on disk, so its edits would
  // get no mutants. `ls-files -v` tags assume-unchanged with a lowercase letter, skip-worktree with S.
  for (const entry of (await run(["ls-files", "-v", "-z", "--", "."])).split("\0")) {
    const tag = entry.slice(0, 1);
    const path = entry.slice(2);
    if (!isEnumeratedAl(path)) continue;
    const flag =
      tag === "S" ? "skip-worktree" : /^[a-z]$/.test(tag) ? "assume-unchanged" : undefined;
    if (flag === undefined) continue;
    throw new Error(
      `--changed-since ${ref}: ${path} is marked ${flag}, so git diff reports it unchanged whatever its working-tree content, and its edits would get no mutants. Clear the flag in ${projectDir} with: git update-index --no-${flag} ${path}`,
    );
  }

  // No second tree: the diff runs to the working tree. Each flag pins a behaviour a user's config
  // could otherwise change (quotePath, prefixes, renames, textconv, inter-hunk context, diff
  // algorithm) or that CRLF would break.
  const diff = await run([
    "-c",
    "core.quotePath=false",
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--inter-hunk-context=0",
    "--diff-algorithm=myers",
    "--find-renames",
    "--ignore-cr-at-eol",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--relative",
    mergeBase,
    "--",
    ".",
  ]);
  const ranges = parseUnifiedDiffAdded(diff).filter((r) => isEnumeratedAl(r.file));

  // A submodule or nested repository is walked and parsed by LethAL, but this repository's diff
  // never sees edits inside it. No `--exclude` remedy: line resolution runs before exclusions.
  const blind = (path: string, what: string) =>
    new Error(
      `--changed-since ${ref}: ${path} is ${what} inside the project. LethAL parses its .al files, but this repository's diff cannot see edits inside it, so they would get no mutants. Move the project out of the ${what === "a git submodule" ? "submodule's" : "nested repository's"} parent.`,
    );
  for (const entry of (await run(["ls-files", "-s", "-z", "--", "."])).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0 || entry.split(" ")[0] !== "160000") continue;
    const path = entry.slice(tab + 1);
    if (await holdsAlFile(join(projectDir, path))) throw blind(path, "a git submodule");
  }

  const untrackedFiles: string[] = [];
  const others = (await run(["ls-files", "-z", "--others", "--exclude-standard", "--", "."]))
    .split("\0")
    .filter((e) => e !== "");
  for (const entry of others) {
    if (entry.endsWith("/")) {
      if (await holdsAlFile(join(projectDir, entry))) throw blind(entry, "a nested git repository");
      continue;
    }
    if (isEnumeratedAl(entry)) untrackedFiles.push(normalizeRelPath(entry));
  }
  untrackedFiles.sort();
  for (const file of untrackedFiles) {
    const bytes = await readFile(join(projectDir, file));
    if (bytes.includes(0)) throw new Error(binaryAlMessage(file));
    const n = lineCount(new TextDecoder().decode(bytes));
    if (n > 0) ranges.push({ file, start: 1, end: n });
  }
  return { ranges, source: { ref, mergeBase, untrackedFiles } };
}

/** Case-insensitive on the file, because the AL projects this runs on live on Windows. */
export function spanTouches(
  ranges: readonly LineRange[],
  file: string,
  firstLine: number,
  lastLine: number,
): boolean {
  const f = normalizeRelPath(file).toLowerCase();
  return ranges.some(
    (r) => r.file.toLowerCase() === f && r.start <= lastLine && firstLine <= r.end,
  );
}
