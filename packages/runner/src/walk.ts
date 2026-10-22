/**
 * R631: the ONE recursive directory walk. Bun's `readdir(dir, { recursive: true })` FOLLOWS
 * directory links (Node's does not), so a link cycle hangs or throws ELOOP and a link out walks a
 * foreign tree as if it were inside. This walker lists each directory with a plain `readdir`, then
 * `lstat`s every entry: a real directory is descended, a real file is yielded, and a LINK (a
 * symlink, or on Windows a junction) is never descended. Only real directory edges are followed and
 * those form a tree, so the walk terminates by construction. The one exception is a package-cache
 * folder that is itself a link (below), which is entered once and never re-entered.
 *
 * ponytail: a bind mount of an ancestor can still loop; add a dev:ino set if one is ever seen.
 *
 * The root itself is opened normally, so a configured path that is itself a link still works.
 *
 * What happens to a link is the caller's `LinkPolicy`:
 * - `"refuse"`: user target and test roots. alc, the .NET al-runner and al-runner v3 all FOLLOW a
 *   linked folder and a linked `.al` file (measured, `/coord/handoff/R-631/tool-link-probe.md`), so
 *   a walk that skipped one would measure a different build from the one compiled. Any link, folder
 *   or file (a linked README too), throws `ProjectSymlinkRefusedError`, with two exceptions:
 *   - inside a `LINK_EXCUSED_DIRS` folder a link is listed in `skippedLinks` and never descended,
 *     UNLESS it reaches a `.al` file: alc compiles `.al` under `node_modules`, `.git` and `.vscode`
 *     (measured, same file), so such a link refuses. Real files there are yielded as anywhere else.
 *   - a PACKAGE-CACHE folder (`.alpackages` by name at any depth, or one `setPackageCacheDirs`
 *     registered) is walked under `"yield-files"`, and may itself be a link (a shared symbols
 *     folder). There too, a link that reaches a `.al` file refuses (review r2 N1/N2).
 *   Whether a link "reaches a .al" is `linkReachesAl`: a cut-off at `REACH_DEPTH_CAP` refuses.
 * - `"skip"`: LethAL-built and cache trees. Every link goes to `skippedLinks`; unexcused ones are
 *   announced to `onSkippedLinks` listeners (a session turns them into a caveat).
 * - `"yield-files"`: package caches. A linked FILE is yielded at its own path, its real path in
 *   `resolved`; a dangling link is skipped; a linked FOLDER refuses.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** Folders whose links are EXCUSED under `"refuse"` (compared case-insensitively). */
export const LINK_EXCUSED_DIRS: readonly string[] = ["node_modules", ".git", ".vscode"];

/** The default package-cache folder name, always treated as one inside a refused root. */
const DEFAULT_CACHE_NAME = ".alpackages";

export type LinkPolicy = "refuse" | "skip" | "yield-files";

export interface WalkOptions {
  readonly links: LinkPolicy;
}

export interface WalkResult {
  /** Root-relative paths with the OS separator (what a recursive `readdir` returned), sorted. */
  readonly files: string[];
  /** Every link not descended and not yielded, sorted. */
  readonly skippedLinks: string[];
  /** Each yielded linked file's real path, by its root-relative path (package caches). */
  readonly resolved: ReadonlyMap<string, string>;
}

interface EntryKind {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Injectable only so the tests can count calls. */
export interface WalkFs {
  readdir(dir: string): Promise<string[]>;
  lstat(path: string): Promise<EntryKind>;
}

export interface WalkFsSync {
  readdir(dir: string): string[];
  lstat(path: string): EntryKind;
}

const nodeFs: WalkFs = { readdir: (d) => readdir(d), lstat: (p) => lstat(p) };
const nodeFsSync: WalkFsSync = { readdir: (d) => readdirSync(d), lstat: (p) => lstatSync(p) };

export class ProjectSymlinkRefusedError extends Error {
  constructor(
    readonly linkPath: string,
    readonly root: string,
    what = "project folder",
    why = "",
  ) {
    super(
      `${linkPath} is a link (symlink or junction) inside the ${what} ${root}${why}. alc and al-runner follow links, so LethAL cannot keep what it measures equal to what they compile, and refuses (R631). Replace the link with a real folder (or copy the file in).`,
    );
    this.name = "ProjectSymlinkRefusedError";
  }
}

/** Whether a link at `rel` sits INSIDE a `LINK_EXCUSED_DIRS` folder, at any depth. */
export function isLinkExcused(rel: string): boolean {
  const parents = rel.split(/[\\/]/).slice(0, -1);
  return parents.some((p) => LINK_EXCUSED_DIRS.includes(p.toLowerCase()));
}

const registeredCaches = new Set<string>();

/**
 * The configured package-cache folders (`bcdev.packageCachePath`, `alRunner.packagesDir`, ...),
 * walked under the cache policy when they sit inside a refused root. `.alpackages` always is.
 * ponytail: process-wide, set once by the CLI from its config; a per-call option if one process
 * ever serves two configs.
 */
export function setPackageCacheDirs(paths: readonly string[]): void {
  registeredCaches.clear();
  for (const p of paths) registeredCaches.add(resolve(p));
}

function isCacheDir(full: string): boolean {
  return basename(full).toLowerCase() === DEFAULT_CACHE_NAME || registeredCaches.has(resolve(full));
}

/**
 * Whether a skipped link at `rel` is none of a refused root's business: inside an excused folder,
 * or a package-cache folder or anything in one (the cache policy governs those).
 */
export function isLinkIgnored(root: string, rel: string): boolean {
  if (isLinkExcused(rel)) return true;
  const parts = rel.split(/[\\/]/);
  for (let i = 1; i <= parts.length; i++)
    if (isCacheDir(join(root, ...parts.slice(0, i)))) return true;
  return false;
}

/** `stat`, or `undefined` for a dangling link. */
function statOrUndefined(full: string): EntryKind | undefined {
  try {
    return statSync(full);
  } catch {
    return undefined;
  }
}

/** How many folders below a link `linkReachesAl` looks before it gives up, and refuses. */
export const REACH_DEPTH_CAP = 32;

/** Exported only so the tests can count the folders `linkReachesAl` reads (review r2 N3). */
export const reachStats = { foldersScanned: 0 };

const REACHES_AL = ", and it reaches a .al file, which alc compiles even there";
const TOO_DEEP = `, and LethAL could not prove it reaches no .al file (more than ${REACH_DEPTH_CAP} folders deep)`;

/**
 * M1 (and review r2 N1/N2 for cache links): why a link (by its own path) must refuse: it is a `.al`
 * file, or a folder that holds one at any depth, through further links too, or a folder tree deeper
 * than `REACH_DEPTH_CAP` (a cut-off refuses, never admits). `undefined`: it reaches no `.al`.
 * `seen` is the walk's (review r2 N3): a real folder scanned once found no `.al` (a find throws the
 * walk), so no later link in the same walk re-scans it.
 * ponytail: unreadable folders count as "no .al" (alc cannot read them either).
 */
function linkReachesAl(full: string, seen: Set<string>): string | undefined {
  const target = statOrUndefined(full);
  if (target?.isFile() === true) return full.toLowerCase().endsWith(".al") ? REACHES_AL : undefined;
  if (target?.isDirectory() !== true) return undefined;
  const dirs: Array<readonly [string, number]> = [[full, 0]];
  for (let next = dirs.pop(); next !== undefined; next = dirs.pop()) {
    const [d, depth] = next;
    let real: string;
    try {
      real = realpathSync(d);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    if (depth > REACH_DEPTH_CAP) return TOO_DEEP;
    seen.add(real);
    reachStats.foldersScanned++;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(d, name);
      const st = statOrUndefined(p); // follows links on purpose: alc does
      if (st?.isDirectory() === true) dirs.push([p, depth + 1]);
      else if (st?.isFile() === true && name.toLowerCase().endsWith(".al")) return REACHES_AL;
    }
  }
  return undefined;
}

type SkipListener = (root: string, links: readonly string[]) => void;
const skipListeners = new Set<SkipListener>();

/**
 * Be told of every unexcused link a `"skip"` walk passed over. Returns the unsubscribe.
 * ponytail: process-wide; two sessions in one process each hear the other's links (over-reporting,
 * the safe side). Pass a per-session sink through the walks if that ever matters.
 */
export function onSkippedLinks(listener: SkipListener): () => void {
  skipListeners.add(listener);
  return () => skipListeners.delete(listener);
}

/**
 * The policies a walk descends under. `"project-cache"` is a package-cache folder INSIDE a refused
 * root: `"yield-files"`, except that a link reaching a `.al` refuses (review r2 N1/N2: alc compiles
 * it, and a cache link must not readmit a foreign `.al` tree).
 */
type Policy = LinkPolicy | "project-cache";

/** What one link becomes. Throws a refusal; otherwise skip it, yield it, or descend it. */
type LinkOutcome =
  | { readonly kind: "skip" }
  | { readonly kind: "file"; readonly real: string }
  | { readonly kind: "descend"; readonly policy: Policy };

function onLink(
  root: string,
  rel: string,
  full: string,
  policy: Policy,
  seen: Set<string>,
): LinkOutcome {
  if (policy === "skip") return { kind: "skip" };
  const refuseIfReachesAl = (what: string): void => {
    const why = linkReachesAl(full, seen);
    if (why !== undefined) throw new ProjectSymlinkRefusedError(full, root, what, why);
  };
  if (policy === "refuse") {
    if (isCacheDir(full)) {
      // A shared symbols folder: entered once under the cache policy, unless it reaches a `.al`.
      refuseIfReachesAl("project folder");
      return statOrUndefined(full)?.isDirectory() === true
        ? { kind: "descend", policy: "project-cache" }
        : { kind: "skip" };
    }
    if (!isLinkExcused(rel)) throw new ProjectSymlinkRefusedError(full, root);
    refuseIfReachesAl("project folder");
    return { kind: "skip" };
  }
  const target = statOrUndefined(full);
  if (target?.isDirectory() === true)
    throw new ProjectSymlinkRefusedError(full, root, "package cache");
  if (target?.isFile() === true) {
    if (policy === "project-cache") refuseIfReachesAl("package cache");
    return { kind: "file", real: realpathSync(full) };
  }
  return { kind: "skip" };
}

/** The policy a real directory's children are walked under. */
const childPolicy = (full: string, policy: Policy): Policy =>
  policy === "refuse" && isCacheDir(full) ? "project-cache" : policy;

/** An entry deleted between its parent's listing and its own read: it is simply not there now.
 *  The ROOT is never excused, so a missing root still throws. */
const isVanished = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

class Collector {
  readonly files: string[] = [];
  readonly skippedLinks: string[] = [];
  readonly resolved = new Map<string, string>();
  /** Real folders `linkReachesAl` already scanned in this walk (review r2 N3). */
  private readonly reachSeen = new Set<string>();

  /** Returns the policy to descend `rel` under, or `undefined` for no descent. */
  entry(root: string, rel: string, st: EntryKind, policy: Policy): Policy | undefined {
    const full = join(root, rel);
    if (st.isSymbolicLink()) {
      const out = onLink(root, rel, full, policy, this.reachSeen);
      if (out.kind === "descend") return out.policy;
      if (out.kind === "file") {
        this.files.push(rel);
        this.resolved.set(rel, out.real);
      } else this.skippedLinks.push(rel);
      return undefined;
    }
    if (st.isDirectory()) return childPolicy(full, policy);
    if (st.isFile()) this.files.push(rel);
    return undefined;
  }

  finish(root: string, opts: WalkOptions): WalkResult {
    this.files.sort();
    this.skippedLinks.sort();
    if (opts.links === "skip") {
      const unexcused = this.skippedLinks.filter((l) => !isLinkExcused(l));
      if (unexcused.length > 0) for (const l of skipListeners) l(root, unexcused);
    }
    return { files: this.files, skippedLinks: this.skippedLinks, resolved: this.resolved };
  }
}

export async function walkFiles(
  root: string,
  opts: WalkOptions,
  fs: WalkFs = nodeFs,
): Promise<WalkResult> {
  const c = new Collector();
  const visit = async (relDir: string, policy: Policy): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(join(root, relDir));
    } catch (err) {
      if (relDir !== "" && isVanished(err)) return;
      throw err;
    }
    for (const name of names) {
      const rel = relDir === "" ? name : join(relDir, name);
      let st: EntryKind;
      try {
        st = await fs.lstat(join(root, rel));
      } catch (err) {
        if (isVanished(err)) continue;
        throw err;
      }
      const next = c.entry(root, rel, st, policy);
      if (next !== undefined) await visit(rel, next);
    }
  };
  await visit("", opts.links);
  return c.finish(root, opts);
}

export function walkFilesSync(
  root: string,
  opts: WalkOptions,
  fs: WalkFsSync = nodeFsSync,
): WalkResult {
  const c = new Collector();
  const visit = (relDir: string, policy: Policy): void => {
    let names: string[];
    try {
      names = fs.readdir(join(root, relDir));
    } catch (err) {
      if (relDir !== "" && isVanished(err)) return;
      throw err;
    }
    for (const name of names) {
      const rel = relDir === "" ? name : join(relDir, name);
      let st: EntryKind;
      try {
        st = fs.lstat(join(root, rel));
      } catch (err) {
        if (isVanished(err)) continue;
        throw err;
      }
      const next = c.entry(root, rel, st, policy);
      if (next !== undefined) visit(rel, next);
    }
  };
  visit("", opts.links);
  return c.finish(root, opts);
}

/** Throws `ProjectSymlinkRefusedError` on the first link in `skippedLinks` that is not ignored
 *  (`isLinkIgnored`). */
export function assertNoUnexcusedLinks(root: string, skippedLinks: readonly string[]): void {
  const first = skippedLinks.find((l) => !isLinkIgnored(root, l));
  if (first !== undefined) throw new ProjectSymlinkRefusedError(join(root, first), root);
}

/**
 * R631: refuse a target or test root that holds an unexcused link, BEFORE any compile. `links` is
 * `"refuse"` in product code; whatever it is, a skipped unexcused link still refuses (defence in
 * depth: a later change to the policy cannot turn the refusal into a quiet skip).
 */
export async function refuseProjectLinks(
  roots: readonly string[],
  links: LinkPolicy = "refuse",
): Promise<void> {
  for (const root of roots)
    assertNoUnexcusedLinks(root, (await walkFiles(root, { links })).skippedLinks);
}
