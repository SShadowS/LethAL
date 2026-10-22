/**
 * Walk a corpus directory for `.al` files and parse each one, in a DETERMINISTIC order.
 *
 * Shared by `census-hang-capable.ts` and `sample-declined-hang-capable.ts`, which each used to carry
 * their own copy of this exact shape (documented there as "copied, not imported", to avoid importing
 * `census-operator-sites.ts`, which runs an entire corpus census as an import-time side effect). This
 * module has no top-level body at all, so importing it runs nothing and R186's guard (which polices
 * scripts with a CLI body that get imported unguarded, `scripts/importable-scripts.test.ts`) has
 * nothing to flag here.
 *
 * **Why the sort is not cosmetic.** A recursive directory listing does not promise an order,
 * and measured on this machine it is NOT stable between invocations. Both callers walk `files` in
 * array order and then stride-sample a fixed-size slice of it (`sample-declined-hang-capable.ts`'s
 * 30-of-N sample); an unordered input feeds that sampling a different set of files each run, so the
 * SAME corpus produces a different sample every time the script is invoked, even with no code change
 * in between. Measured directly: four sample runs on `do-rel2/Cloud` before this fix gave overload
 * counts of 14, 15, 15, 15 for the identical corpus and identical script. Sorting here, once, is what
 * makes "run it again" mean anything.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAL } from "../../packages/engine/src/ast/parser";
import { wrapRoot } from "../../packages/engine/src/ast/syntax-node";
import type { SourceFile } from "../../packages/engine/src/semantic/symbol-table";
import { walkFiles } from "../../packages/runner/src/walk";

export async function collectAlFiles(dir: string): Promise<SourceFile[]> {
  // R631: links are never followed; any skipped is said, so a census never shrinks silently.
  const walk = await walkFiles(dir, { links: "skip" });
  if (walk.skippedLinks.length > 0)
    console.error(
      `collectAlFiles: ${walk.skippedLinks.length} link(s) under ${dir} not followed (R631): ${walk.skippedLinks.slice(0, 10).join(", ")}`,
    );
  const entries = walk.files
    .filter((f) => f.toLowerCase().endsWith(".al"))
    // Plain lexicographic sort on the relative path: readdir's own order is not stable across
    // invocations on this machine, and every consumer of `files` depends on that order being fixed.
    .sort();
  const files: SourceFile[] = [];
  for (const rel of entries) {
    const source = await readFile(join(dir, rel), "utf8");
    files.push({ path: rel, root: wrapRoot(parseAL(source)) });
  }
  return files;
}
