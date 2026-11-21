#!/usr/bin/env bun
/**
 * PR-301 (GitHub #52): the sites `stepStalls` adds to R1061's rule B, for `lethal.remove-assignment`.
 * For every `assignment_statement` in a project it asks `openItemHangRefuses` three times: the new check
 * off, on, and on without its other-writes condition (`pr301Seam`). Prints one line per site the
 * check adds, as `file:line  added|added-loose`, then the counts.
 *
 *   bun scripts/census-pr301-step-amount.ts <project-dir> [<project-dir> ...]
 *
 * Counts, paths and line numbers only, never AL source text: the intended input includes customer AL.
 */
import { openItemHangRefuses, pr301Seam } from "../packages/builtin-tier1/src/loop-hazard";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser } from "../packages/engine/src/ast/parser";
import type { ALSyntaxNode } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { collectAlFiles } from "./lib/collect-al-files";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun scripts/census-pr301-step-amount.ts <project-dir> [...]");
  process.exit(2);
}
await initParser();
const OP = "lethal.remove-assignment";

function refused(
  n: ALSyntaxNode,
  ctx: ReturnType<typeof buildSemanticContext>,
  on: boolean,
  loose: boolean,
) {
  pr301Seam.on = on;
  pr301Seam.anyOtherWrite = loose;
  try {
    return openItemHangRefuses(n, ctx, OP);
  } finally {
    pr301Seam.on = true;
    pr301Seam.anyOtherWrite = false;
  }
}

for (const dir of dirs) {
  const files = await collectAlFiles(dir);
  const ctx = buildSemanticContext(files);
  let sites = 0;
  let added = 0;
  let loose = 0;
  for (const f of files) {
    const walk = (n: ALSyntaxNode): void => {
      if (n.kind === ALNodeKind.assignment_statement) {
        sites++;
        if (!refused(n, ctx, false, false)) {
          const strict = refused(n, ctx, true, false);
          const wide = strict || refused(n, ctx, true, true);
          if (strict) added++;
          if (wide) loose++;
          if (wide)
            console.log(
              `  ${f.path}:${n.startPosition.row + 1}  ${strict ? "added" : "added-loose"}`,
            );
        }
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(f.root);
  }
  console.log(
    `== ${dir}: assignments ${sites}, added ${added}, added with any other write ${loose}`,
  );
}
