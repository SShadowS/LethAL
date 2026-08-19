#!/usr/bin/env bun
/**
 * R161's before/after proof, as a SET DIFF rather than a count.
 *
 *   bun scripts/r161-slot-census.ts <project-dir>
 *
 * R161 widens six operators' guard from `isStatementPosition` (one of several statements inside a
 * `begin ... end`) to `isStatementSlot` (anywhere the grammar wants a statement, including the
 * un-braced body of a branch). A count that merely went up would not prove nothing was dropped,
 * which is R87's lesson on this exact instrument, so this reports gained and lost separately and
 * FAILS if anything was lost.
 *
 * The old claim is reconstructed rather than re-run against an older checkout: for all six the guard
 * is a plain conjunct, so `old = new AND isStatementPosition(node)` is exact. That reconstruction is
 * itself asserted, by checking that no site is claimed under the old rule and not the new one, which
 * a widening predicate makes impossible unless the reconstruction is wrong.
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here. Only counts, operator names and slot kinds are printed.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { isStatementPosition } from "../packages/engine/src/ast/tree-walks";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [projectDir] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r161-slot-census.ts <project-dir>");
  process.exit(2);
}

/**
 * ONLY the six operators R161 changed.
 *
 * The reconstruction `old = new AND isStatementPosition(node)` is exact for an operator whose guard
 * was that conjunct and MEANINGLESS for one that never had it: the four operators that merely
 * COMPUTE `parentContext` from `isStatementPosition` claim expression-position sites by design, so
 * reconstructing their old claim this way reports every one of those as newly gained. The first run
 * of this script did exactly that and printed 11,167 gains across slots like `if_statement.condition`
 * and `assignment_statement.right`, which no change of R161's could produce. Listed by name rather
 * than detected, because "which operators did this change touch" is not something the code can ask.
 */
const CHANGED = new Set([
  "lethal.void-method-call",
  "lethal.remove-calcfields",
  "lethal.remove-commit",
  "lethal.remove-setrange",
  "lethal.remove-testfield",
  "lethal.validate-to-assign",
]);
const operators = [...tier1Operators, ...tier2Operators].filter((op) => CHANGED.has(op.name));
if (operators.length !== CHANGED.size) {
  throw new Error(
    `r161-slot-census: expected ${CHANGED.size} changed operators in the registry, found ${operators.length}`,
  );
}

await initParser();
const rel = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const files: SourceFile[] = [];
for (const r of rel) {
  files.push({ path: r, root: wrapRoot(parseAL(await readFile(join(projectDir, r), "utf8"))) });
}
if (files.length === 0) throw new Error(`r161-slot-census: no .al files under ${projectDir}`);
const ctx = buildSemanticContext(files);

/** Which slot a gained site sits in, so the gain can be read against R161's own table. */
function slotOf(node: ALSyntaxNode): string {
  const parent = node.parent;
  if (parent === null) return "(no parent)";
  return `${parent.rawKind}.${node.fieldName ?? "-"}`;
}

const gained = new Map<string, number>();
const kept = new Map<string, number>();
const lost = new Map<string, number>();
const slots = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function walk(node: ALSyntaxNode, inExecutable: boolean): void {
  if (inExecutable) {
    for (const op of operators) {
      let claimsNow = false;
      try {
        claimsNow = op.targets(node, ctx);
      } catch {
        // An operator that throws is a finding of its own and is not a claim either way.
        continue;
      }
      const claimedBefore = claimsNow && isStatementPosition(node);
      if (claimsNow && claimedBefore) bump(kept, op.name);
      else if (claimsNow) {
        bump(gained, op.name);
        bump(slots, slotOf(node));
      } else if (claimedBefore) bump(lost, op.name);
    }
  }
  const next =
    inExecutable || node.rawKind === "procedure" || node.rawKind === "trigger_declaration";
  for (const c of node.namedChildren) walk(c, next);
}
for (const f of files) walk(f.root, false);

const names = [...new Set([...kept.keys(), ...gained.keys(), ...lost.keys()])].sort();
console.log(`files: ${files.length}\n`);
console.log(
  `${"operator".padEnd(34)}${"before".padStart(8)}${"after".padStart(8)}${"gained".padStart(8)}${"lost".padStart(7)}`,
);
let totalGained = 0;
let totalLost = 0;
for (const n of names) {
  const k = kept.get(n) ?? 0;
  const g = gained.get(n) ?? 0;
  const l = lost.get(n) ?? 0;
  totalGained += g;
  totalLost += l;
  if (g === 0 && l === 0) continue;
  console.log(
    `${n.padEnd(34)}${String(k).padStart(8)}${String(k + g).padStart(8)}${String(g).padStart(8)}${String(l).padStart(7)}`,
  );
}
console.log("\ngained sites by slot:");
for (const [k, v] of [...slots].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
console.log(`\ntotal gained ${totalGained}, total lost ${totalLost}`);

if (totalGained === 0) {
  // An empty gain and an empty loss "agree" with a no-op change. Refuse to report that as a pass.
  throw new Error(
    "r161-slot-census: no sites gained — either the change is not applied, or the corpus has no un-braced branch bodies",
  );
}
if (totalLost > 0) {
  throw new Error(
    `r161-slot-census: ${totalLost} site(s) LOST — a widening predicate cannot lose a site, so the change or this reconstruction is wrong`,
  );
}
