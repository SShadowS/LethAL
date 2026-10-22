import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * R629 / R634: the directory above `projectDir` whose own `app.json` also compiles these files (a
 * nested module), or `undefined`. The search starts at `projectDir`'s parent and stops at the
 * first directory holding `.git` (a directory, or a worktree's `.git` file), at `stopAt` (searched,
 * then the last), or at the filesystem root. A project that is itself a repo root is not searched.
 */
export function enclosingAppDir(projectDir: string, stopAt?: string): string | undefined {
  let dir = resolve(projectDir);
  const stop = stopAt !== undefined ? resolve(stopAt) : undefined;
  if (existsSync(join(dir, ".git")) || dir === stop) return undefined;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (existsSync(join(dir, "app.json"))) return dir;
    if (existsSync(join(dir, ".git")) || dir === stop) return undefined;
  }
}

/** The session's one `nested-project` warning text, or `undefined` when the project is not nested. */
export function nestedProjectWarning(projectDir: string, stopAt?: string): string | undefined {
  const parent = enclosingAppDir(projectDir, stopAt);
  if (parent === undefined) return undefined;
  return `[lethal] ${resolve(projectDir)} is nested in ${parent}, whose app.json also compiles these files; hang refusals are decided over this project only, so a loop in ${parent} or in an installed app that depends on this one is not seen (R629, R634)`;
}
