#!/usr/bin/env bun
/**
 * R171 spike: is `lethal.negate-guard` worth building?
 *
 * Runs the candidate operator over a corpus WITHOUT registering it, the same way the R159 spike ran
 * `swap-additive` before it shipped: registering would move every frozen gate figure, and a spike
 * has to be answerable before that cost is paid.
 *
 * Measures four things the site count alone does not answer:
 *   1. sites CLAIMED after the cessions (comparison / logical / not, and every loop condition)
 *   2. how many of those are MARGINAL — no operator claims anything inside the condition today
 *   3. the equivalence hazard: a guard whose flip cannot change observable behaviour
 *   4. the non-termination hazard: a guard that controls a loop's exit, which R164 costs
 *
 *   bun scripts/r171-guard-spike.ts <project-dir> [<project-dir> ...]
 *
 * Point it at real AL, which must never be committed here.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { negateGuard } from "../packages/builtin-tier1/src/negate-guard";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun scripts/r171-guard-spike.ts <project-dir> [...]");
  process.exit(2);
}
/** Everything SHIPPED. `negateGuard` is deliberately not in here. */
const shipped = [...tier1Operators, ...tier2Operators];

function walk(n: ALSyntaxNode, v: (x: ALSyntaxNode) => void): void {
  v(n);
  for (const c of n.namedChildren) walk(c, v);
}
function inBody(n: ALSyntaxNode): boolean {
  for (let p = n.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}
/** Nearest enclosing loop, if any — the non-termination question. */
function enclosingLoop(n: ALSyntaxNode): ALSyntaxNode | null {
  for (let p = n.parent; p !== null; p = p.parent) {
    if (
      p.rawKind === "repeat_statement" ||
      p.rawKind === "while_statement" ||
      p.rawKind === "for_statement" ||
      p.rawKind === "foreach_statement"
    ) {
      return p;
    }
  }
  return null;
}

await initParser();

const files: SourceFile[] = [];
for (const dir of dirs) {
  for (const rel of (await readdir(dir, { recursive: true })).filter((f) =>
    f.toLowerCase().endsWith(".al"),
  )) {
    files.push({
      path: join(dir, rel),
      root: wrapRoot(parseAL(await readFile(join(dir, rel), "utf8"))),
    });
  }
}
const ctx = buildSemanticContext(files);

let ifGuards = 0;
let claimed = 0;
let marginal = 0;
const byKind = new Map<string, { claimed: number; marginal: number }>();

// Hazards
let emptyThen = 0;
let symmetricElse = 0;
let loopExitGuard = 0;
let mutatedTextEmpty = 0;

for (const file of files) {
  walk(file.root, (n) => {
    if (n.rawKind !== "if_statement" || !inBody(n)) return;
    ifGuards++;
    if (!negateGuard.targets(n, ctx)) return;
    const specs = negateGuard.generate(n, ctx);
    if (specs.length === 0) return;
    claimed++;

    const spec = specs[0];
    if (spec === undefined) return;
    const cond = spec.before;

    // A mutation whose replacement text is empty or unchanged would be a silent no-op mutant.
    if (spec.after.text.trim() === "" || spec.after.text === cond.text) mutatedTextEmpty++;

    // MARGINAL: nothing shipped claims a site inside this condition today.
    let anyShipped = false;
    walk(cond, (inner) => {
      if (anyShipped) return;
      for (const op of shipped) {
        try {
          if (op.targets(inner, ctx) && op.generate(inner, ctx).length > 0) {
            anyShipped = true;
            return;
          }
        } catch {
          /* an operator that throws on a shape is R120's business, not this spike's */
        }
      }
    });
    if (!anyShipped) marginal++;

    const b = byKind.get(cond.rawKind) ?? { claimed: 0, marginal: 0 };
    b.claimed++;
    if (!anyShipped) b.marginal++;
    byKind.set(cond.rawKind, b);

    // --- hazards ---
    const thenB = n.childForFieldName("then_branch");
    const elseB = n.childForFieldName("else_branch");
    // An empty `then` makes the flip observationally identical in the common case.
    if (thenB !== null && thenB.text.replace(/[\s;]/g, "") === "") emptyThen++;
    // Symmetric branches: identical text on both sides means flipping cannot be observed.
    if (thenB !== null && elseB !== null && thenB.text.trim() === elseB.text.trim())
      symmetricElse++;
    // A guard inside a loop whose body can exit/break: flipping may remove the only exit.
    const loop = enclosingLoop(n);
    if (loop !== null && thenB !== null && /\b(exit|break)\b/i.test(thenB.text)) loopExitGuard++;
  });
}

const rows = [...byKind].sort((a, b) => b[1].claimed - a[1].claimed);
console.log(`files: ${files.length}`);
console.log(`\`if\` guards in procedure/trigger bodies: ${ifGuards}\n`);
console.log(`${"condition kind".padEnd(28)} ${"claimed".padStart(8)} ${"marginal".padStart(9)}`);
for (const [k, b] of rows) {
  console.log(`${k.padEnd(28)} ${String(b.claimed).padStart(8)} ${String(b.marginal).padStart(9)}`);
}
console.log(`${"TOTAL".padEnd(28)} ${String(claimed).padStart(8)} ${String(marginal).padStart(9)}`);

console.log(`\nHAZARDS (subsets of the ${claimed} claimed):`);
console.log(`  empty \`then\` branch (equivalent by inspection):  ${emptyThen}`);
console.log(`  \`then\` identical to \`else\` (equivalent):          ${symmetricElse}`);
console.log(
  `  guard inside a loop whose branch exits/breaks:   ${loopExitGuard}  <- R164 non-termination risk`,
);
console.log(`  degenerate replacement text (must be 0):          ${mutatedTextEmpty}`);

if (claimed === 0) throw new Error("r171-guard-spike: no sites claimed — refusing to report");
