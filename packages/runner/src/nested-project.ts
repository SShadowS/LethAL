import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The real path (Bun reads a symlinked project through its link, R631), else the resolved one. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * R629 / R634: the directory above `projectDir` whose own `app.json` FILE also compiles these files
 * (a nested module), or `undefined`. The search runs over `projectDir`'s REAL path, starts at its
 * parent, and stops at the first directory holding `.git` (a directory, or a worktree's or a
 * submodule's `.git` file), at `stopAt` (searched, then the last), or at the filesystem or drive
 * root. A project that is itself a repo root is not searched. Two limits follow from the `.git`
 * stop: a git submodule between the module and the outer `app.json` ends the search there, so that
 * case gets no warning although alc ignores git boundaries; and with no `.git` above (a temp copy),
 * the search runs to the filesystem or drive root, where a stray `app.json` would make it warn.
 */
export function enclosingAppDir(projectDir: string, stopAt?: string): string | undefined {
  let dir = realOf(projectDir);
  const stop = stopAt !== undefined ? realOf(stopAt) : undefined;
  if (existsSync(join(dir, ".git")) || dir === stop) return undefined;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (isFile(join(dir, "app.json"))) return dir;
    if (existsSync(join(dir, ".git")) || dir === stop) return undefined;
  }
}

/** The session's one `nested-project` warning text, or `undefined` when the project is not nested. */
export function nestedProjectWarning(projectDir: string, stopAt?: string): string | undefined {
  const parent = enclosingAppDir(projectDir, stopAt);
  if (parent === undefined) return undefined;
  return `[lethal] ${realOf(projectDir)} is nested in ${parent}, whose app.json also compiles these files; hang refusals are decided over this project only, so a loop in ${parent} or in an installed app that depends on this one is not seen (R629, R634)`;
}
