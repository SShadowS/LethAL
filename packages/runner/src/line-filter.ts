import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { readTargetSource } from "./baseline-snapshot";
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

/** R421: thrown when a discovered file name cannot be given one `/`-separated path. */
export class DiscoveredPathError extends Error {
  constructor(
    message: string,
    readonly paths: readonly string[],
  ) {
    super(message);
    this.name = "DiscoveredPathError";
  }
}

/**
 * R421: the ONE place a discovered file name becomes a project path. Each raw name (a readdir
 * entry, or a source snapshot's key, both `\`-separated on Windows) is paired with its
 * `normalizeRelPath` form, and the list is sorted by that form in plain code-unit order, the order
 * discovery has always used. So file order, mutant ids, batches and every `file` written are the
 * same on every platform. Callers keep `raw` to READ the file (a `\`-keyed snapshot is looked up by
 * its own key) and use `rel` everywhere else.
 *
 * Throws `DiscoveredPathError` when two raw names give one `rel`: reading one and dropping the other
 * would lose a file without a word. Also throws, off win32, on a raw name holding a literal `\`.
 *
 * `platform` is a parameter, defaulting to `process.platform`, so every branch is testable on any
 * host (the `defaultAlToolPaths` pattern in `publisher.ts`).
 */
export function discoveredRelPaths(
  raw: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Array<{ rel: string; raw: string }> {
  // Off win32 `\` is an ordinary file-name character, not a separator. Normalising it would record
  // a path that does not exist, and the batch copy (which takes the raw name's basename) would
  // then hold two copies of one object. Checked before the collision check, so a POSIX `src\A`
  // beside `src/A` is refused for the backslash.
  if (platform !== "win32") {
    for (const r of raw) {
      if (!r.includes("\\")) continue;
      throw new DiscoveredPathError(
        `cannot use the file "${r}": its name contains a backslash. On ${platform} a backslash is an ordinary file-name character, but LethAL writes every path with "/", so this file would be recorded as "${normalizeRelPath(r)}", which does not exist, and its batch would not compile. Rename the file.`,
        [r],
      );
    }
  }
  const out = raw.map((r) => ({ rel: normalizeRelPath(r), raw: r }));
  const byRel = new Map<string, string[]>();
  for (const d of out) {
    const same = byRel.get(d.rel);
    if (same === undefined) byRel.set(d.rel, [d.raw]);
    else same.push(d.raw);
  }
  for (const names of byRel.values()) {
    if (names.length < 2) continue;
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    throw new DiscoveredPathError(
      `two discovered files have the same path once "\\" is read as "/": ${sorted.map((n) => `"${n}"`).join(" and ")}. Refusing rather than reading one of them and dropping the other.`,
      sorted,
    );
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
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

/** GH-25: where `--changed-since` lines came from. Recorded in the report. */
export interface ChangedSinceSource {
  /** The ref as given. */
  readonly ref: string;
  /** Full sha of `git merge-base <ref> HEAD`; the diff runs from here to the source snapshot. */
  readonly mergeBase: string;
  /** Untracked, not-ignored `.al` files under the project (minus `Mutation*`, as enumeration skips them), project-relative, sorted. Every line
   *  of each absent at the base counts as changed; an empty one is listed and contributes no range. */
  readonly untrackedFiles: readonly string[];
}

const isAl = (p: string) => p.toLowerCase().endsWith(".al");

/** The files `generateMutationSet` parses: `.al`, minus its own emitted `Mutation*` artifacts.
 *  Shared with it, so "LethAL parses this" means one thing in both places.
 *  R421: the base name follows `platform`, not the host (node:path's `basename` does): only win32
 *  reads `\` as a separator, so off win32 `x\MutationFoo.al` is one ordinary name. */
export const isEnumeratedAl = (p: string, platform: NodeJS.Platform = process.platform) =>
  isAl(p) && !(platform === "win32" ? win32 : posix).basename(p).startsWith("Mutation");

/** R205: a byte scan of the whole file, not git's prefix heuristic: any NUL, or a UTF-16 BOM. */
const looksBinary = (b: Buffer) =>
  b.includes(0) ||
  (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)));

/**
 * R205: the blobs `oids` name, read as BYTES through ONE `git cat-file --batch` (`SpawnFn` decodes
 * to text, which would rewrite a BOM or an invalid UTF-8 byte). `oids` maps each id to the path
 * it is read for, which a refusal names. A `missing` reply, a non-blob, a short read or a failed
 * exit throws: an unreadable base is never taken as "no base".
 */
async function readBlobs(
  cwd: string,
  oids: ReadonlyMap<string, string>,
  ref: string,
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (oids.size === 0) return out;
  const proc = Bun.spawn(["git", "cat-file", "--batch"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Both pipes drain while stdin is written, so a large batch cannot stall on a full pipe.
  const stdout = new Response(proc.stdout).arrayBuffer();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(`${[...oids.keys()].join("\n")}\n`);
  await proc.stdin.end();
  const [bytes, err, code] = await Promise.all([stdout, stderr, proc.exited]);
  const buf = Buffer.from(bytes);
  let at = 0;
  for (const [oid, path] of oids) {
    const nl = buf.indexOf(10, at);
    const header = nl < 0 ? "" : buf.toString("utf8", at, nl);
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    const end = nl + 1 + Number(m?.[2] ?? 0);
    if (m === null || m[1] !== oid || end >= buf.length || buf[end] !== 10) {
      throw new Error(
        `--changed-since ${ref}: git cat-file could not read ${path} (object ${oid}) at the merge base: ${header !== "" ? header : `exit ${code}: ${err.trim()}`}`,
      );
    }
    out.set(oid, buf.subarray(nl + 1, end));
    at = end + 1;
  }
  if (code !== 0) {
    throw new Error(
      `--changed-since ${ref}: git cat-file --batch failed (exit ${code}): ${err.trim()}`,
    );
  }
  return out;
}

/**
 * GH-25: the lines changed between `git merge-base <ref> HEAD` and the SOURCE SNAPSHOT the session
 * builds (R205; `readTargetSource`, read here when the caller passes none). The snapshot is what
 * LethAL parses and deploys, so these line numbers match the files the mutants are generated
 * from, whatever the disk does afterwards; #19's `<ref>...HEAD` used HEAD's numbering and
 * misaligned on a dirty tree.
 *
 * One rule (R205): each snapshot `.al` is diffed against the SAME path's blob at the merge base,
 * under the project's own folder of the repository. A path absent at the base (a new, untracked,
 * ignored or renamed file) is selected whole; a deleted one adds nothing. The diff is
 * `git diff --no-index` of two scratch folders, outside any repository, so no attribute, filter,
 * index flag or user config can change it. Only `.al` ranges are returned.
 */
export async function changedLinesSince(
  projectDir: string,
  ref: string,
  spawn: SpawnFn,
  snapshot?: ReadonlyMap<string, Buffer>,
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

  // The base: every `.al` blob under the project's folder at the merge base, keyed by its path
  // inside the project and fetched by object id (`<sha>:<path>` would name a root-relative path).
  // `prefix` ends in "/" (or is ""), so matching on it respects path separators.
  const prefix = (await run(["rev-parse", "--show-prefix"])).replace(/\n$/, "");
  const baseIds = new Map<string, string>();
  const gitlinks: string[] = [];
  for (const entry of (await run(["ls-tree", "-r", "-z", "--full-tree", mergeBase])).split("\0")) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    if (tab < 0 || !path.startsWith(prefix)) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const key = path.slice(prefix.length);
    if (mode === "160000") gitlinks.push(key);
    else if (type === "blob" && oid !== undefined && isAl(key)) baseIds.set(key, oid);
  }
  for (const entry of (await run(["ls-files", "-s", "-z", "--", "."])).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab >= 0 && entry.split(" ")[0] === "160000") gitlinks.push(entry.slice(tab + 1));
  }
  const others = (await run(["ls-files", "-z", "--others", "--exclude-standard", "--", "."]))
    .split("\0")
    .filter((e) => e !== "");

  const snap = new Map<string, Buffer>();
  for (const [raw, bytes] of snapshot ?? (await readTargetSource(projectDir))) {
    if (isAl(raw)) snap.set(normalizeRelPath(raw), bytes);
  }

  // A submodule or nested repository holding a snapshot `.al`: this repository records no base
  // for the files inside it. No `--exclude` remedy: line resolution runs before exclusions.
  const blind = (path: string, what: string) =>
    new Error(
      `--changed-since ${ref}: ${path} is ${what} inside the project. LethAL parses its .al files, but their baseline lives in the inner repository, which this repository's diff cannot read, so their changes cannot be found. Move the project out of the ${what === "a git submodule" ? "submodule's" : "nested repository's"} parent.`,
    );
  const holdsSnapshotAl = (dir: string) => {
    const under = `${dir.replace(/\/$/, "")}/`;
    return [...snap.keys()].some((k) => k.startsWith(under) && isEnumeratedAl(k));
  };
  for (const path of gitlinks) if (holdsSnapshotAl(path)) throw blind(path, "a git submodule");
  for (const entry of others) {
    if (entry.endsWith("/") && holdsSnapshotAl(entry))
      throw blind(entry, "a nested git repository");
  }
  const untrackedFiles = others
    .filter((e) => !e.endsWith("/") && isEnumeratedAl(e) && snap.has(normalizeRelPath(e)))
    .map(normalizeRelPath)
    .sort();

  const baseIdPaths = new Map<string, string>();
  for (const [key, oid] of baseIds) if (!baseIdPaths.has(oid)) baseIdPaths.set(oid, key);
  const blobs = await readBlobs(projectDir, baseIdPaths, ref);
  const baseOf = (key: string) => {
    const oid = baseIds.get(key);
    return oid === undefined ? undefined : blobs.get(oid);
  };
  for (const [key, bytes] of snap) {
    const base = baseOf(key);
    if (base?.equals(bytes) === true) continue;
    if (looksBinary(bytes) || (base !== undefined && looksBinary(base))) {
      throw new Error(binaryAlMessage(key));
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), "lethal-changed-since-"));
  try {
    const put = async (dir: string, key: string, bytes: Buffer) => {
      const path = join(scratch, dir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    };
    await mkdir(join(scratch, "base"));
    await mkdir(join(scratch, "snap"));
    for (const key of baseIds.keys()) {
      const bytes = baseOf(key);
      if (bytes !== undefined) await put("base", key, bytes);
    }
    for (const [key, bytes] of snap) await put("snap", key, bytes);
    // No repository, so no attributes, filters, index or worktree; no user config either. Each
    // flag pins a behaviour config could otherwise change (quotePath, prefixes, renames, textconv,
    // inter-hunk context, diff algorithm, CRLF). Exit 1 means "differences", not failure.
    const nowhere = join(scratch, "no-gitconfig");
    const diff = await spawn(
      [
        "git",
        "-c",
        "core.quotePath=false",
        "-c",
        "core.autocrlf=false",
        "diff",
        "--no-index",
        "--no-renames",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--inter-hunk-context=0",
        "--diff-algorithm=myers",
        "--ignore-cr-at-eol",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "base",
        "snap",
      ],
      { cwd: scratch, env: { GIT_CONFIG_GLOBAL: nowhere, GIT_CONFIG_SYSTEM: nowhere } },
    );
    if (diff.exitCode !== 0 && diff.exitCode !== 1) {
      throw new Error(
        `--changed-since ${ref}: git diff --no-index failed (exit ${diff.exitCode}): ${diff.stderr.trim()}`,
      );
    }
    const ranges = parseUnifiedDiffAdded(diff.stdout)
      .map((r) => {
        if (!r.file.startsWith("snap/")) {
          throw new Error(
            `--changed-since ${ref}: git diff --no-index reported ${r.file}, which is not in the source snapshot`,
          );
        }
        return { ...r, file: r.file.slice("snap/".length) };
      })
      .filter((r) => isEnumeratedAl(r.file));
    return { ranges, source: { ref, mergeBase, untrackedFiles } };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
