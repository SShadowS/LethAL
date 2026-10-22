/**
 * R631: the ONE recursive directory walk. Bun's `readdir(dir, { recursive: true })` FOLLOWS
 * directory links (Node's does not), so a link cycle hangs or throws ELOOP and a link out walks a
 * foreign tree as if it were inside. This walker lists each directory with a plain `readdir`, then
 * `lstat`s every entry: a real directory is descended, a real file is yielded, and a LINK (a
 * symlink, or on Windows a junction) is never descended. Only real directory edges are followed and
 * those form a tree, so the walk terminates by construction.
 *
 * ponytail: a bind mount of an ancestor can still loop; add a dev:ino set if one is ever seen.
 *
 * The root itself is opened normally, so a configured path that is itself a link still works.
 *
 * What happens to a link is the caller's `LinkPolicy`:
 * - `"refuse"`: user target and test roots. alc, the .NET al-runner and al-runner v3 all FOLLOW a
 *   linked folder and a linked `.al` file (measured, `/coord/handoff/R-631/tool-link-probe.md`), so
 *   a walk that skipped one would measure a different build from the one compiled. The first link
 *   throws `ProjectSymlinkRefusedError`, EXCEPT a link inside a `LINK_EXCUSED_DIRS` folder, which
 *   is listed in `skippedLinks` and never descended. Real files there are yielded as anywhere else.
 * - `"skip"`: LethAL-built and cache trees. Every link goes to `skippedLinks`; unexcused ones are
 *   announced to `onSkippedLinks` listeners (a session turns them into a caveat).
 * - `"yield-files"`: package caches. A linked FILE is yielded at its own path, its real path in
 *   `resolved`; a dangling link is skipped; a linked FOLDER refuses.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/** Folders whose links are EXCUSED under `"refuse"` (compared case-insensitively). */
export const LINK_EXCUSED_DIRS: readonly string[] = ["node_modules", ".git"];

export type LinkPolicy = "refuse" | "skip" | "yield-files";

export interface WalkOptions {
  readonly links: LinkPolicy;
}

export interface WalkResult {
  /** Root-relative paths with the OS separator (what a recursive `readdir` returned), sorted. */
  readonly files: string[];
  /** Every link not descended and not yielded, sorted. */
  readonly skippedLinks: string[];
  /** `"yield-files"`: each yielded linked file's real path, by its root-relative path. */
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
  stat(path: string): Promise<EntryKind>;
  realpath(path: string): Promise<string>;
}

export interface WalkFsSync {
  readdir(dir: string): string[];
  lstat(path: string): EntryKind;
  stat(path: string): EntryKind;
  realpath(path: string): string;
}

const nodeFs: WalkFs = {
  readdir: (d) => readdir(d),
  lstat: (p) => lstat(p),
  stat: (p) => stat(p),
  realpath: (p) => realpath(p),
};

const nodeFsSync: WalkFsSync = {
  readdir: (d) => readdirSync(d),
  lstat: (p) => lstatSync(p),
  stat: (p) => statSync(p),
  realpath: (p) => realpathSync(p),
};

export class ProjectSymlinkRefusedError extends Error {
  constructor(
    readonly linkPath: string,
    readonly root: string,
    what = "project folder",
  ) {
    super(
      `${linkPath} is a link (symlink or junction) inside the ${what} ${root}. alc and al-runner follow links, so LethAL cannot keep what it measures equal to what they compile, and refuses (R631). Replace the link with a real folder (or copy the file in).`,
    );
    this.name = "ProjectSymlinkRefusedError";
  }
}

/** Whether a link at `rel` sits INSIDE a `LINK_EXCUSED_DIRS` folder, at any depth. */
export function isLinkExcused(rel: string): boolean {
  const parents = rel.split(/[\\/]/).slice(0, -1);
  return parents.some((p) => LINK_EXCUSED_DIRS.includes(p.toLowerCase()));
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

/** What a link becomes, before any stat: skipped, refused, or (yield-files) stat it. */
function linkAction(rel: string, links: LinkPolicy): "skip" | "refuse" | "stat" {
  if (links === "skip") return "skip";
  if (links === "refuse") return isLinkExcused(rel) ? "skip" : "refuse";
  return "stat";
}

function finish(
  root: string,
  links: LinkPolicy,
  files: string[],
  skippedLinks: string[],
  resolved: Map<string, string>,
): WalkResult {
  files.sort();
  skippedLinks.sort();
  if (links === "skip") {
    const unexcused = skippedLinks.filter((l) => !isLinkExcused(l));
    if (unexcused.length > 0) for (const l of skipListeners) l(root, unexcused);
  }
  return { files, skippedLinks, resolved };
}

/** An entry deleted between its parent's listing and its own read: it is simply not there now.
 *  The ROOT is never excused, so a missing root still throws. */
const isVanished = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const refusalWhat = (links: LinkPolicy) =>
  links === "yield-files" ? "package cache" : "project folder";

export async function walkFiles(
  root: string,
  opts: WalkOptions,
  fs: WalkFs = nodeFs,
): Promise<WalkResult> {
  const files: string[] = [];
  const skippedLinks: string[] = [];
  const resolved = new Map<string, string>();
  const visit = async (relDir: string): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(join(root, relDir));
    } catch (err) {
      if (relDir !== "" && isVanished(err)) return;
      throw err;
    }
    for (const name of names) {
      const rel = relDir === "" ? name : join(relDir, name);
      const full = join(root, rel);
      let st: EntryKind;
      try {
        st = await fs.lstat(full);
      } catch (err) {
        if (isVanished(err)) continue;
        throw err;
      }
      if (st.isSymbolicLink()) {
        const action = linkAction(rel, opts.links);
        if (action === "skip") skippedLinks.push(rel);
        else if (action === "refuse") throw new ProjectSymlinkRefusedError(full, root);
        else {
          const target = await fs.stat(full).catch(() => undefined);
          if (target?.isDirectory() === true)
            throw new ProjectSymlinkRefusedError(full, root, refusalWhat(opts.links));
          if (target?.isFile() === true) {
            files.push(rel);
            resolved.set(rel, await fs.realpath(full));
          } else skippedLinks.push(rel);
        }
      } else if (st.isDirectory()) await visit(rel);
      else if (st.isFile()) files.push(rel);
    }
  };
  await visit("");
  return finish(root, opts.links, files, skippedLinks, resolved);
}

export function walkFilesSync(
  root: string,
  opts: WalkOptions,
  fs: WalkFsSync = nodeFsSync,
): WalkResult {
  const files: string[] = [];
  const skippedLinks: string[] = [];
  const resolved = new Map<string, string>();
  const visit = (relDir: string): void => {
    let names: string[];
    try {
      names = fs.readdir(join(root, relDir));
    } catch (err) {
      if (relDir !== "" && isVanished(err)) return;
      throw err;
    }
    for (const name of names) {
      const rel = relDir === "" ? name : join(relDir, name);
      const full = join(root, rel);
      let st: EntryKind;
      try {
        st = fs.lstat(full);
      } catch (err) {
        if (isVanished(err)) continue;
        throw err;
      }
      if (st.isSymbolicLink()) {
        const action = linkAction(rel, opts.links);
        if (action === "skip") skippedLinks.push(rel);
        else if (action === "refuse") throw new ProjectSymlinkRefusedError(full, root);
        else {
          let target: EntryKind | undefined;
          try {
            target = fs.stat(full);
          } catch {
            target = undefined;
          }
          if (target?.isDirectory() === true)
            throw new ProjectSymlinkRefusedError(full, root, refusalWhat(opts.links));
          if (target?.isFile() === true) {
            files.push(rel);
            resolved.set(rel, fs.realpath(full));
          } else skippedLinks.push(rel);
        }
      } else if (st.isDirectory()) visit(rel);
      else if (st.isFile()) files.push(rel);
    }
  };
  visit("");
  return finish(root, opts.links, files, skippedLinks, resolved);
}

/** Throws `ProjectSymlinkRefusedError` on the first unexcused link in `skippedLinks`. */
export function assertNoUnexcusedLinks(root: string, skippedLinks: readonly string[]): void {
  const first = skippedLinks.find((l) => !isLinkExcused(l));
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
