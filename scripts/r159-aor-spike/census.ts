#!/usr/bin/env bun
/**
 * R159 SPIKE, what would an arithmetic operator actually be worth?
 *
 *   bun scripts/r159-aor-spike/census.ts <project-dir> [out.json]
 *
 * R159 files AOR as the one absent operator with no recorded reason, and says the next step is a
 * DECISION needing two measurements the row does not have: how many of its sites survive a
 * compile-safety type guard, and how many of the survivors sit at a statement that already carries a
 * shipped mutant. Adding an operator whose sites are already covered is what `IsolationLevelSwap`
 * was refused for (25 of 36 sites already carried a `void-method-call`), so the overlap number is
 * the one that decides this, not the raw site count.
 *
 * "Already carries a mutant" is measured at STATEMENT granularity, and `empty-block` is counted
 * separately rather than folded in. Every statement in the corpus sits inside some `code_block`, so
 * folding `empty-block` in would report ~100% overlap and prove only that a coarse operator exists.
 * The question that matters is whether a FINE-GRAINED mutant already perturbs the same statement.
 *
 * Only counts and node-kind names leave the process; no source text is written to the JSON.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../../packages/builtin-tier1/src/index";
import { tier2Operators } from "../../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../../packages/engine/src/semantic/context";
import type { SourceFile } from "../../packages/engine/src/semantic/symbol-table";
import { type AorGroup, decide } from "./aor";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/r159-aor-spike/census.ts <project-dir> [out.json]");
  process.exit(2);
}

const GROUPS: readonly AorGroup[] = ["additive", "multiplicative"];
const shipped = [...tier1Operators, ...tier2Operators];
const BLOCK_LEVEL = "lethal.empty-block";

const EXECUTABLE_ANCESTORS = new Set(["procedure", "trigger_declaration"]);

/** The statement a node belongs to: the highest ancestor still inside the same `statement_block`. */
function enclosingStatement(node: ALSyntaxNode): ALSyntaxNode {
  let current = node;
  while (current.parent !== null && current.parent.rawKind !== "statement_block") {
    current = current.parent;
  }
  return current;
}

function subtree(node: ALSyntaxNode, out: ALSyntaxNode[]): ALSyntaxNode[] {
  out.push(node);
  for (const c of node.namedChildren) subtree(c, out);
  return out;
}

interface SiteRow {
  readonly file: string;
  readonly line: number;
  readonly group: AorGroup;
  readonly token: string;
  /** Fine-grained shipped operators claiming something in the same statement. */
  readonly coveredBy: readonly string[];
  /** Whether `empty-block` claims an enclosing block. Expected true inside any begin/end. */
  readonly blockLevelMutantExists: boolean;
}

await initParser();

const entries = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const files: SourceFile[] = [];
for (const rel of entries) {
  files.push({ path: rel, root: wrapRoot(parseAL(await readFile(join(projectDir, rel), "utf8"))) });
}
if (files.length === 0) throw new Error(`aor-spike: no .al files under ${projectDir}`);
const ctx = buildSemanticContext(files);

const refusals = new Map<string, number>();
const tokens = new Map<string, number>();
const refusedTypePairs = new Map<string, number>();
/** Which node kinds the type table could not answer for. The list that says whether "unresolved"
 *  is a long tail of odd shapes or one missing case. */
const unresolvedKinds = new Map<string, number>();
const sites: SiteRow[] = [];
let candidates = 0;

/** Memoised per statement: a statement with three arithmetic sites must not be scanned three times. */
const statementCache = new Map<ALSyntaxNode, readonly string[]>();
function fineGrainedClaimants(stmt: ALSyntaxNode): readonly string[] {
  const cached = statementCache.get(stmt);
  if (cached !== undefined) return cached;
  const claimants = new Set<string>();
  for (const n of subtree(stmt, [])) {
    for (const op of shipped) {
      if (op.name === BLOCK_LEVEL) continue;
      try {
        if (op.targets(n, ctx)) claimants.add(op.name);
      } catch {
        claimants.add(`${op.name}<threw>`);
      }
    }
  }
  const list = [...claimants].sort();
  statementCache.set(stmt, list);
  return list;
}

function blockLevelMutantAbove(node: ALSyntaxNode): boolean {
  const emptyBlock = shipped.find((op) => op.name === BLOCK_LEVEL);
  if (emptyBlock === undefined) return false;
  for (let a: ALSyntaxNode | null = node; a !== null; a = a.parent) {
    if (a.rawKind !== "code_block") continue;
    try {
      if (emptyBlock.targets(a, ctx)) return true;
    } catch {
      /* an operator that throws is already counted by the fine-grained pass */
    }
  }
  return false;
}

function walk(node: ALSyntaxNode, file: string, inExecutable: boolean): void {
  if (
    inExecutable &&
    (node.rawKind === "additive_expression" || node.rawKind === "multiplicative_expression")
  ) {
    candidates += 1;
    const d = decide(node, ctx, GROUPS);
    if (d.token !== undefined) tokens.set(d.token, (tokens.get(d.token) ?? 0) + 1);
    if (!d.claimed) {
      const key = d.refusal ?? "unknown";
      refusals.set(key, (refusals.get(key) ?? 0) + 1);
      for (const k of d.unresolvedKinds ?? []) {
        if (k !== null) unresolvedKinds.set(k, (unresolvedKinds.get(k) ?? 0) + 1);
      }
      if (d.operandTypes !== undefined) {
        const pair = `${d.operandTypes[0] ?? "?"} ${d.token ?? "?"} ${d.operandTypes[1] ?? "?"}`;
        refusedTypePairs.set(pair, (refusedTypePairs.get(pair) ?? 0) + 1);
      }
    } else if (d.group !== undefined && d.token !== undefined) {
      sites.push({
        file,
        line: node.startPosition.row + 1,
        group: d.group,
        token: d.token,
        coveredBy: fineGrainedClaimants(enclosingStatement(node)),
        blockLevelMutantExists: blockLevelMutantAbove(node),
      });
    }
  }
  const next = inExecutable || EXECUTABLE_ANCESTORS.has(node.rawKind);
  for (const c of node.namedChildren) walk(c, file, next);
}

for (const f of files) walk(f.root, f.path, false);

const byGroup = (g: AorGroup) => sites.filter((s) => s.group === g);
const uncovered = sites.filter((s) => s.coveredBy.length === 0);
const noMutantAtAll = uncovered.filter((s) => !s.blockLevelMutantExists);

console.log(`files:                 ${files.length}`);
console.log(`arithmetic nodes:      ${candidates}`);
console.log(`claimed (type-safe):   ${sites.length}`);
console.log(`  additive (+ <-> -):  ${byGroup("additive").length}`);
console.log(`  multiplicative:      ${byGroup("multiplicative").length}`);
console.log("");
console.log("refused, by reason:");
for (const [k, n] of [...refusals].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${n}`);
}
console.log("");
console.log("operator token, all candidates:");
for (const [k, n] of [...tokens].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${n}`);
}
console.log("");
console.log("top refused operand-type shapes (what AL actually overloads these on):");
for (const [k, n] of [...refusedTypePairs].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${k.padEnd(40)} ${n}`);
}
console.log("");
console.log("unresolved operands, by node kind (a limit of the type table, not a fact about AL):");
for (const [k, n] of [...unresolvedKinds].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${n}`);
}
console.log("");
console.log("--- overlap: does a fine-grained mutant already perturb the same statement? ---");
console.log(`claimed sites:                              ${sites.length}`);
console.log(`  statement ALREADY carries a fine mutant:  ${sites.length - uncovered.length}`);
console.log(`  statement carries NO fine mutant:         ${uncovered.length}`);
console.log(`  and no empty-block mutant either:         ${noMutantAtAll.length}`);
const overlapPct =
  sites.length === 0 ? 0 : ((sites.length - uncovered.length) / sites.length) * 100;
console.log(`overlap: ${overlapPct.toFixed(1)}%`);
// Split by group, because the two carry different hazards and the decision can take one and refuse
// the other. R13's bar (a) is >= 13 MARGINAL sites for an operator on an existing emit path,
// calibrated on the smallest shipped operator (`swap-modify-flag`, 13), so the marginal count per
// group is the number that meets a precedent, not the raw one.
for (const g of GROUPS) {
  const marginal = uncovered.filter((s) => s.group === g).length;
  console.log(`  marginal, ${g.padEnd(15)} ${marginal}  (R13 bar (a) is >= 13)`);
}
console.log("");
console.log("what covers the overlapping statements:");
const coverCount = new Map<string, number>();
for (const s of sites) for (const c of s.coveredBy) coverCount.set(c, (coverCount.get(c) ?? 0) + 1);
for (const [k, n] of [...coverCount].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${n}`);
}

if (outPath !== undefined) {
  await writeFile(
    outPath,
    `${JSON.stringify({ candidates, sites: sites.length, uncovered: uncovered.length, rows: sites }, null, 1)}\n`,
    "utf8",
  );
}
