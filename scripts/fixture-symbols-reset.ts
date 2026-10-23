/**
 * R670: reset ONE worktree's fixture `.alpackages` after a symbol-tar re-pin, by hand.
 *
 *   bun scripts/fixture-symbols-reset.ts [--dry-run] <worktree>
 *
 * A re-pin makes every worktree whose folders came from the old tar refuse
 * (`al-runner-v3-gate-symbols-unverified`: its `.fixture-symbols.sha256` names the old pin). R614
 * never deletes automatically, so each lane runs this on each of its worktrees. It is never called
 * by a gate or by setup.
 *
 * - The marker names another sha than the current pin: removes the gate's two folders and the
 *   marker, printing each path (`--dry-run` only lists them). The next `itest:alrunner-v3` or gate
 *   run then extracts them from the pinned tar.
 * - Refused, nothing removed: the marker equals the pin (nothing to do); no marker but both folders
 *   there (placed by hand or before R614: the R614 fix is printed instead); one folder only with no
 *   marker, or with a marker equal to the pin (the gate's own by-hand fix is printed); no marker
 *   and no folders; a folder or the marker whose parent resolves outside the worktree (a symlinked
 *   `fixtures/`); a path that is not a LethAL checkout; a path under `/coord` or outside
 *   `/work/lethal*`.
 * - R670's swap window: the marker names master's OLD pin while the folders already hold the new
 *   tar's files (kraken-setup wrote them). Run from r670's code that is the ordinary "marker is not
 *   the current pin" case, so the folders and the marker are removed.
 */
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  FIXTURE_SYMBOLS_TAR_SHA256,
  GATE_ALPACKAGES,
  SYMBOLS_MARKER,
} from "../packages/runner/itest/fixture-symbols.ts";

export class ResetRefusedError extends Error {
  override readonly name = "ResetRefusedError";
}

/** `/work/lethal` itself or anything beginning `/work/lethal` (`/work/lethal-wt/x`), never `/coord`. */
export function allowedWorktree(
  path: string,
  roots: readonly string[] = ["/work/lethal"],
): boolean {
  if (path === "/coord" || path.startsWith("/coord/")) return false;
  return roots.some((r) => path === r || path.startsWith(r));
}

/** The paths to remove, or a refusal. Reads only; `roots` is a seam for temp-dir tests. */
export function resetPlan(s: {
  readonly worktree: string;
  readonly pin?: string;
  readonly roots?: readonly string[];
}): string[] {
  const pin = s.pin ?? FIXTURE_SYMBOLS_TAR_SHA256;
  const abs = resolve(s.worktree);
  if (!allowedWorktree(abs, s.roots))
    throw new ResetRefusedError(`${abs}: not under /work/lethal* (or under /coord); refused`);
  const wt = existsSync(abs) ? realpathSync(abs) : abs;
  if (!allowedWorktree(wt, s.roots))
    throw new ResetRefusedError(`${abs} resolves to ${wt}, not under /work/lethal*; refused`);
  if (!existsSync(join(wt, ".git")) || !existsSync(join(wt, "packages", "runner", "package.json")))
    throw new ResetRefusedError(
      `${wt}: not a LethAL checkout (no .git or packages/runner); refused`,
    );
  const marker = join(wt, SYMBOLS_MARKER);
  const all = GATE_ALPACKAGES.map((f) => join(wt, f));
  const folders = all.filter((f) => existsSync(f));
  // Each path is removed through its parent folder: a symlinked `fixtures/` (or worktree root)
  // would aim the removal outside the worktree.
  for (const p of [...folders, marker]) {
    const parent = realpathSync(dirname(p));
    if (parent !== wt && !parent.startsWith(`${wt}${sep}`))
      throw new ResetRefusedError(
        `${p}: its folder resolves to ${parent}, outside the worktree ${wt}; refused`,
      );
  }
  // the same one-time fix the gate's own refusal names (`al-runner-v3-gate-symbols-unverified`)
  const manual = `the one-time fix, by hand: remove ${[...folders, marker].join(" and ")}, then run again to extract them from the pinned tar`;
  const partial = folders.length > 0 && folders.length < all.length;
  if (!existsSync(marker)) {
    if (partial)
      throw new ResetRefusedError(
        `${wt}: no ${SYMBOLS_MARKER} and only ${folders.join(", ")} of the two folders; nothing removed. ${manual}`,
      );
    if (folders.length > 0)
      throw new ResetRefusedError(
        `${wt}: no ${SYMBOLS_MARKER} but ${folders.join(" and ")} exist, so where they came from is unknown; nothing removed. The R614 fix: run itest:alrunner-v3 or the gate once, which compares them with the pinned tar and writes the marker if they are equal; or, after checking them yourself, remove the folders by hand and run again to extract them`,
      );
    throw new ResetRefusedError(
      `${wt}: no ${SYMBOLS_MARKER} and no fixture folders; nothing to reset`,
    );
  }
  const found = readFileSync(marker, "utf8").trim();
  if (found === pin && partial)
    throw new ResetRefusedError(
      `${wt}: ${SYMBOLS_MARKER} names the pin but only ${folders.join(", ")} of the two folders exist; nothing removed. ${manual}`,
    );
  if (found === pin)
    throw new ResetRefusedError(
      `${wt}: ${SYMBOLS_MARKER} already names the pin ${pin}; nothing to do`,
    );
  return [...folders, marker];
}

/** `roots` is the same test seam as `resetPlan`'s. */
export function main(argv: readonly string[], roots?: readonly string[]): number {
  const dry = argv.includes("--dry-run");
  const rest = argv.filter((a) => a !== "--dry-run");
  const [worktree] = rest;
  if (worktree === undefined || rest.length !== 1) {
    console.error("usage: bun scripts/fixture-symbols-reset.ts [--dry-run] <worktree>");
    return 2;
  }
  let plan: string[];
  try {
    plan = resetPlan({ worktree, ...(roots !== undefined ? { roots } : {}) });
  } catch (e) {
    if (!(e instanceof ResetRefusedError)) throw e;
    console.error(`fixture-symbols-reset: ${e.message}`);
    return 1;
  }
  for (const p of plan) {
    if (!dry) rmSync(p, { recursive: true, force: true });
    console.log(`${dry ? "would remove" : "removed"} ${p}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
