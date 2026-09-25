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
 */
export function parseUnifiedDiffAdded(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  let file: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
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

/** Runs `git diff -U0 --relative <ref>...HEAD` inside the project, so paths come out
 *  project-relative even when the project is a subdirectory of the repository. */
export async function changedLinesSince(
  projectDir: string,
  ref: string,
  spawn: SpawnFn,
): Promise<LineRange[]> {
  const out = await spawn(
    ["git", "diff", "-U0", "--no-color", "--no-ext-diff", "--relative", `${ref}...HEAD`, "--", "."],
    { cwd: projectDir },
  );
  if (out.exitCode !== 0) {
    throw new Error(
      `--changed-since ${ref}: git diff failed in ${projectDir} (exit ${out.exitCode}): ${out.stderr.trim()}`,
    );
  }
  return parseUnifiedDiffAdded(out.stdout);
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
