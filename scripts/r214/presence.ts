// R-214 plan r2 scratch (Decision 6 item 4): PRESENCE. Joins the expected rows and the full-twin
// rows of each decided directive file on (file, start, end, operator).
// Usage: bun presence.ts <expected.txt> <full-twin.txt> <regions.json> <project-dir> [<full-twin-dir>]
//
// A full-twin row with no expected row is an EXCLUSION, classified by the smallest directive node
// (ERROR, or a preproc_* container; preproc_split_begin counts as part of its parent, T1-a) of the
// ORIGINAL parse that contains its start: any ERROR ancestor R339; preproc_split_declaration R305;
// preproc_fragmented_else_tail R287-C7; preproc_split_if_then_begin* / _begin_asymmetric R304; a
// directive node whose parent is the file root (a wrapped object) R343; a
// preproc_conditional_statement not in a statement list `slot`; then the named reasons of T1-a and
// T1-g: dup-arm-typing and cond-var-typing (semantic operators only), split-case-body,
// split-if-operators, split-call-statement.
// An expected row with no full-twin row whose span is nested in (or equal to) the span of a
// classified full-twin-only row is `displaced-by:<that reason>` (T1-g).
// Ruling 1 (orchestrator, q-20260930T062258-5a3574ac): the STOP check covers only operators with
// an EMPTY requiresSemantic. A semantic operator's unmatched rows are `typing-unmatched` (twin
// only) or `typing-expected-only`, counted per operator, never a STOP.
// T1-f: a file whose full twin gains ERROR/MISSING nodes the original lacks is not a program under
// this set: `unbuildable-under-set`, one line per file, not joined (needs <full-twin-dir>).
// Undecided files are refused whole (no expected row by construction) and are not joined.
// Output: `EXCLUDED <reason>\t<file:line>\t<operator>\t<start-end>` per row (per file for
// unbuildable-under-set), `UNCLASSIFIED-ROW` / `EXTRA-ROW` lines, `excluded <reason> <n>` counts,
// `typing <operator> twin-only <n> expected-only <n>` counts, then always the two final lines
// `UNCLASSIFIED <n>` and `EXTRA <n>`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser, parseAL } from "H:/LethAL-wt/lane-preproc/packages/engine/src/ast/parser";
import {
  type ALSyntaxNode,
  visit,
  wrapRoot,
} from "H:/LethAL-wt/lane-preproc/packages/engine/src/ast/syntax-node";

const [ePath, fPath, rPath, root, fullDir] = process.argv.slice(2);
if (ePath === undefined || fPath === undefined || rPath === undefined || root === undefined)
  throw new Error("usage: presence.ts <expected> <full-twin> <regions> <project> [<full-dir>]");
await initParser();
type Row = { file: string; site: string; op: string; span: string; start: number; k: string };
const rows = (p: string): Row[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const c = l.split("\t");
      const site = c[0] ?? "";
      const file = site.slice(0, site.lastIndexOf(":"));
      const span = c[5] ?? "";
      const op = c[1] ?? "";
      return {
        file,
        site,
        op,
        span,
        start: Number(span.split("-")[0]),
        k: `${file}|${span}|${op}`,
      };
    });
const regions = JSON.parse(readFileSync(rPath, "utf8")).files as Record<
  string,
  { undecided: string | null }
>;
const parseErrors = (text: string) => {
  let n = 0;
  visit(wrapRoot(parseAL(text)), (x) => {
    if (x.rawKind === "ERROR" || x.isMissing) n++;
  });
  return n;
};
// T1-f: the files whose full twin gains parse errors under this set.
const unbuildable = new Set<string>();
if (fullDir !== undefined)
  for (const [f, g] of Object.entries(regions))
    if (
      g.undecided === null &&
      parseErrors(readFileSync(join(fullDir, f), "utf8")) >
        parseErrors(readFileSync(join(root, f), "utf8"))
    )
      unbuildable.add(f);
const joined = (f: string) =>
  regions[f] !== undefined && regions[f]?.undecided === null && !unbuildable.has(f);
const allExpected = rows(ePath);
const allFull = rows(fPath);
const expected = allExpected.filter((r) => joined(r.file));
const full = allFull.filter((r) => joined(r.file));
const eKeys = new Set(expected.map((r) => r.k));
const fKeys = new Set(full.map((r) => r.k));

const DIRECTIVE_MARKER = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
  "preproc_define",
  "preproc_undef",
  "preproc_open",
  "preproc_close",
  // T1-a: a part of its parent split construct, never a container of its own.
  "preproc_split_begin",
]);
// Operators whose requiresSemantic is non-empty (grep requiresSemantic in builtin-tier1/2 src,
// 2026-09-30). Ruling 1: they are outside the UNCLASSIFIED/EXTRA STOP.
const SEMANTIC_OPERATORS = new Set([
  "lethal.flip-boolean-literal",
  "lethal.remove-assignment",
  "lethal.return-value",
  "lethal.shift-integer",
  "lethal.swap-additive",
  "lethal.swap-call-arguments",
  "lethal.flip-filter-literal",
  "lethal.remove-calcfields",
  "lethal.remove-commit",
  "lethal.remove-setrange",
  "lethal.remove-testfield",
  "lethal.swap-enum-member",
  "lethal.swap-find-direction",
  "lethal.swap-modify-flag",
  "lethal.swap-rec-xrec",
  "lethal.validate-to-assign",
]);
const STATEMENT_LIST = new Set(["statement_block", "code_block"]);
const isDirectiveNode = (n: ALSyntaxNode) =>
  n.rawKind === "ERROR" || (n.rawKind.startsWith("preproc_") && !DIRECTIVE_MARKER.has(n.rawKind));
const trees = new Map<string, ALSyntaxNode>();
const tree = (file: string) => {
  let t = trees.get(file);
  if (t === undefined) {
    t = wrapRoot(parseAL(readFileSync(join(root, file), "utf8")));
    trees.set(file, t);
  }
  return t;
};
function classify(r: Row): string {
  const top = tree(r.file);
  // The chain of nodes containing the start, outermost first.
  const chain: ALSyntaxNode[] = [];
  let n: ALSyntaxNode | undefined = top;
  while (n !== undefined) {
    chain.push(n);
    n = n.children.find((c) => c.startIndex <= r.start && r.start < c.endIndex);
  }
  if (chain.some((c) => c.rawKind === "ERROR")) return "R339";
  const d = [...chain].reverse().find(isDirectiveNode);
  if (d === undefined) return "UNCLASSIFIED";
  const k = d.rawKind;
  if (k === "preproc_split_declaration") return "R305";
  if (k === "preproc_fragmented_else_tail") return "R287-C7";
  if (k.startsWith("preproc_split_if_then_begin") || k === "preproc_split_if_begin_asymmetric")
    return "R304";
  const atRoot = d.parent !== null && d.parent.parent === null;
  if (atRoot) return "R343";
  if (k === "preproc_conditional_statement") {
    // A conditional nested in a statement-level conditional is still in statement position.
    let p = d.parent;
    while (p !== null && p.rawKind === "preproc_conditional_statement") p = p.parent;
    if (p === null || !STATEMENT_LIST.has(p.rawKind)) return "slot";
  }
  const semantic = SEMANTIC_OPERATORS.has(r.op);
  // T1-a dup-arm-typing: a semantic operator in a member declared in more than one arm of a
  // declaration-level conditional; the duplicate member stops the operand types resolving.
  if (k === "preproc_conditional" && semantic) return "dup-arm-typing";
  // T1-g cond-var-typing: a semantic operator inside a var-section conditional (the tree can
  // extend one across members); declarations inside it are not seen by the semantic layer.
  if (k === "preproc_conditional_var" && semantic) return "cond-var-typing";
  // T1-a split-case-body: an empty-block on a case body inside a split case label.
  if (k === "preproc_split_case_extended" && r.op === "lethal.empty-block")
    return "split-case-body";
  // T1-a split-if-operators: an empty-block or negate-guard of a split if/else (not R304's shapes).
  if (
    (k === "preproc_split_if_statement" || k === "preproc_split_if_else_statement") &&
    (r.op === "lethal.empty-block" || r.op === "lethal.negate-guard")
  )
    return "split-if-operators";
  // T1-g split-call-statement: a call statement split by a directive (its head in one arm).
  if (k === "preproc_split_call_statement" && r.op === "lethal.void-method-call")
    return "split-call-statement";
  return "UNCLASSIFIED";
}
const counts = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const typingTwin = new Map<string, number>();
const typingExp = new Map<string, number>();
const spanOf = (r: Row) => r.span.split("-").map(Number) as [number, number];
const classified: { file: string; s: number; e: number; reason: string }[] = [];
let unclassified = 0;
for (const r of full) {
  if (eKeys.has(r.k)) continue;
  const semantic = SEMANTIC_OPERATORS.has(r.op);
  if (semantic) bump(typingTwin, r.op);
  let reason = classify(r);
  if (reason === "UNCLASSIFIED") {
    if (!semantic) {
      unclassified++;
      console.log(`UNCLASSIFIED-ROW\t${r.site}\t${r.op}\t${r.span}`);
      continue;
    }
    reason = "typing-unmatched";
  }
  const [s0, e0] = spanOf(r);
  classified.push({ file: r.file, s: s0, e: e0, reason });
  bump(counts, reason);
  console.log(`EXCLUDED ${reason}\t${r.site}\t${r.op}\t${r.span}`);
}
let extra = 0;
for (const r of expected) {
  if (fKeys.has(r.k)) continue;
  const semantic = SEMANTIC_OPERATORS.has(r.op);
  if (semantic) bump(typingExp, r.op);
  const [s0, e0] = spanOf(r);
  const host = classified.find((c) => c.file === r.file && c.s <= s0 && e0 <= c.e);
  let reason: string;
  if (host !== undefined) reason = `displaced-by:${host.reason}`;
  else if (semantic) reason = "typing-expected-only";
  else {
    extra++;
    console.log(`EXTRA-ROW\t${r.site}\t${r.op}\t${r.span}`);
    continue;
  }
  bump(counts, reason);
  console.log(`EXCLUDED ${reason}\t${r.site}\t${r.op}\t${r.span}`);
}
for (const f of [...unbuildable].sort()) {
  const n = allExpected.filter((r) => r.file === f).length;
  const m = allFull.filter((r) => r.file === f).length;
  bump(counts, "unbuildable-under-set");
  console.log(`EXCLUDED unbuildable-under-set\t${f}\texpected=${n}\tfullTwin=${m}`);
}
for (const [k, v] of [...counts].sort()) console.log(`excluded ${k} ${v}`);
for (const op of [...new Set([...typingTwin.keys(), ...typingExp.keys()])].sort())
  console.log(
    `typing ${op} twin-only ${typingTwin.get(op) ?? 0} expected-only ${typingExp.get(op) ?? 0}`,
  );
console.log(`UNCLASSIFIED ${unclassified}`);
console.log(`EXTRA ${extra}`);
