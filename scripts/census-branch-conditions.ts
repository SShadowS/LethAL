#!/usr/bin/env bun
/**
 * Per-DECISION-POINT operator coverage: for every branch condition in a corpus, does any operator
 * claim a mutation site at the condition, or strictly inside it?
 *
 * This is the falsifiable form of "do we have a mutant everywhere the code branches". The tempting
 * form — comparing mutant COUNT against cyclomatic complexity — is not: measured on this repo's
 * fixtures, complexity and mutant count correlate at r=0.48 and only 6% of mutants are
 * decision-flavoured at all, because most operators fire on statements and call sites. Count tells
 * you how much code there is. Only per-site coverage tells you whether a decision can be tested.
 *
 * Reads RAW tree-sitter node types, never `ALNodeKind`, for the reason `census-node-kind-coverage.ts`
 * gives: the curated enum is a subset chosen by us, so censusing it could only report that the kinds
 * we named are the kinds we handle.
 *
 *   bun scripts/census-branch-conditions.ts <project-dir> [<project-dir> ...]
 *
 * Point it at real AL, which must never be committed here.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: bun scripts/census-branch-conditions.ts <project-dir> [...]");
  process.exit(2);
}
const operators = [...tier1Operators, ...tier2Operators];

function walk(n: ALSyntaxNode, v: (x: ALSyntaxNode) => void): void {
  v(n);
  for (const c of n.namedChildren) walk(c, v);
}
/** R159's convention: only nodes with a procedure/trigger ancestor carry behaviour. */
function inBody(n: ALSyntaxNode): boolean {
  for (let p = n.parent; p !== null; p = p.parent) {
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") return true;
  }
  return false;
}

/** Branch kinds and the field their condition lives in. */
const BRANCHES: ReadonlyMap<string, string> = new Map([
  ["if_statement", "condition"],
  ["while_statement", "condition"],
  ["repeat_statement", "condition"],
]);

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
// ONE context over the whole corpus: Tier-2 operators resolve receivers through the symbol table,
// so a per-file context answers null for anything declared elsewhere and they claim fewer sites for
// a reason that has nothing to do with coverage.
const ctx = buildSemanticContext(files);

interface Bucket {
  total: number;
  covered: number;
  /** covered by an operator that mutates the DECISION (polarity/boundary), not an incidental one. */
  decisionCovered: number;
  examples: string[];
}
const byShape = new Map<string, Bucket>();
/** Operators whose mutation changes which way the branch goes. */
const DECISION_OPS = new Set([
  "lethal.negate-conditional",
  "lethal.conditional-boundary",
  "lethal.remove-not",
]);

let conditions = 0;
for (const file of files) {
  walk(file.root, (n) => {
    const field = BRANCHES.get(n.rawKind);
    if (field === undefined || !inBody(n)) return;
    const cond = n.childForFieldName?.(field) ?? null;
    if (cond === null) return;
    conditions++;

    let covered = false;
    let decisionCovered = false;
    walk(cond, (inner) => {
      for (const op of operators) {
        let claims = false;
        try {
          claims = op.targets(inner, ctx);
        } catch {
          continue;
        }
        if (!claims) continue;
        let count = 0;
        try {
          count = op.generate(inner, ctx).length;
        } catch {
          continue;
        }
        if (count === 0) continue;
        covered = true;
        if (DECISION_OPS.has(op.name)) decisionCovered = true;
      }
    });

    const shapeKey = `${n.rawKind.replace("_statement", "")}/${cond.rawKind}`;
    const b = byShape.get(shapeKey) ?? { total: 0, covered: 0, decisionCovered: 0, examples: [] };
    b.total++;
    if (covered) b.covered++;
    if (decisionCovered) b.decisionCovered++;
    if (!decisionCovered && b.examples.length < 4) {
      b.examples.push(cond.text.replace(/\s+/g, " ").slice(0, 52));
    }
    byShape.set(shapeKey, b);
  });
}

const rows = [...byShape].sort((a, b) => b[1].total - a[1].total);
const tot = rows.reduce((a, [, b]) => a + b.total, 0);
const totDec = rows.reduce((a, [, b]) => a + b.decisionCovered, 0);
console.log(`files: ${files.length}`);
console.log(
  `branch conditions (if / while / repeat-until, inside procedure or trigger bodies): ${conditions}\n`,
);
console.log(
  `${"branch / condition shape".padEnd(38)} ${"total".padStart(6)} ${"decision-mut".padStart(13)} ${"gap".padStart(6)} ${"any mutant in cond".padStart(19)} ${"MARGINAL".padStart(9)}`,
);
// MARGINAL = the gap sites where NO operator claims anything inside the condition at all. R13's bar
// is marginal sites, not raw ones: a site that already carries a mutant gains less from a new one.
for (const [kind, b] of rows) {
  const gap = b.total - b.decisionCovered;
  const marginal = b.total - b.covered;
  console.log(
    `${kind.padEnd(38)} ${String(b.total).padStart(6)} ${String(b.decisionCovered).padStart(13)} ${String(gap).padStart(6)} ${String(b.covered).padStart(19)} ${String(marginal).padStart(9)}`,
  );
}
const totCov = rows.reduce((a, [, b]) => a + b.covered, 0);
console.log(
  `${"TOTAL".padEnd(38)} ${String(tot).padStart(6)} ${String(totDec).padStart(13)} ${String(tot - totDec).padStart(6)} ${String(totCov).padStart(19)} ${String(tot - totCov).padStart(9)}`,
);
console.log(
  `\ndecision points with NO polarity/boundary mutant: ${tot - totDec} of ${tot} (${((100 * (tot - totDec)) / tot).toFixed(1)}%)\n`,
);

// `if` and loop conditions are different propositions and must not be summed. Negating a loop-exit
// condition is R164's hang risk; negating an `if` guard is not.
const slice = (pred: (k: string) => boolean) => {
  const rs = rows.filter(([k]) => pred(k));
  const t = rs.reduce((a, [, b]) => a + b.total, 0);
  const d = rs.reduce((a, [, b]) => a + b.decisionCovered, 0);
  const c = rs.reduce((a, [, b]) => a + b.covered, 0);
  return { total: t, gap: t - d, marginal: t - c };
};
const ifs = slice((k) => k.startsWith("if/"));
const loops = slice((k) => !k.startsWith("if/"));
console.log(
  `  if guards:      ${ifs.total} total, ${ifs.gap} with no polarity mutant, ${ifs.marginal} MARGINAL`,
);
console.log(
  `  while / repeat: ${loops.total} total, ${loops.gap} with no polarity mutant, ${loops.marginal} MARGINAL (R164: negating these can hang)`,
);
for (const [kind, b] of rows) {
  if (b.total - b.decisionCovered === 0) continue;
  console.log(`  ${kind} (${b.total - b.decisionCovered} uncovered), e.g.:`);
  for (const e of b.examples) console.log(`      ${e}`);
}
if (conditions === 0)
  throw new Error("census-branch-conditions: no conditions found — refusing to report");
