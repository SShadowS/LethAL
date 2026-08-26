#!/usr/bin/env bun
/**
 * R159: where do AL string literals actually SIT?
 *
 * `string_literal` is the largest kind the node-kind census leaves unclaimed, and a raw count of it
 * is the wrong input to a build-or-refuse decision. A literal's context decides whether mutating it
 * changes BEHAVIOUR, changes a MESSAGE, or changes nothing an operator may touch at all — and those
 * three answers want three different verdicts.
 *
 * So this classifies every literal by its enclosing construct rather than counting them. It reads
 * RAW tree-sitter node types, never `ALNodeKind`, for the reason `census-node-kind-coverage.ts`
 * gives: the curated enum is a subset chosen by us, so censusing it could only report that the kinds
 * we named are the kinds we handle.
 *
 *   bun scripts/census-string-literals.ts <project-dir> [<project-dir> ...]
 *
 * Point it at real AL, which must never be committed here. It prints COUNTS and node kinds only,
 * never literal text: the 2026-08-09 ruling is that a measured project's source does not get
 * published, and a string literal is source.
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
  console.error("usage: bun scripts/census-string-literals.ts <project-dir> [...]");
  process.exit(2);
}
const shipped = [...tier1Operators, ...tier2Operators];

function walk(n: ALSyntaxNode, v: (x: ALSyntaxNode) => void): void {
  v(n);
  for (const c of n.namedChildren) walk(c, v);
}

/** Methods whose string argument BC re-parses as a filter — `flip-filter-literal`'s territory. */
const FILTER_METHODS = new Set(["setfilter", "setrange"]);
/** Methods whose string argument is user-facing TEXT, not a value the program branches on. */
const MESSAGE_METHODS = new Set([
  "error",
  "message",
  "confirm",
  "strsubstno",
  "fielderror",
  "testfield",
  "validate",
]);

function calleeName(call: ALSyntaxNode): string {
  const callee = call.childForFieldName?.("function") ?? null;
  if (callee === null) return "";
  const kids = callee.namedChildren;
  return (kids[kids.length - 1]?.text ?? callee.text).toLowerCase();
}

/** The enclosing construct that decides what mutating this literal would mean. */
function classify(node: ALSyntaxNode): string {
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (p.rawKind === "label_declaration" || p.rawKind === "label_attribute") {
      return "label declaration (declarative)";
    }
    if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") break;
  }
  const parent = node.parent;
  if (parent === null) return "other";
  if (parent.rawKind === "argument_list") {
    const call = parent.parent;
    if (call !== null) {
      const name = calleeName(call);
      if (FILTER_METHODS.has(name)) return "filter argument (flip-filter-literal)";
      if (MESSAGE_METHODS.has(name)) return "message / error argument";
      return "other call argument";
    }
  }
  if (parent.rawKind === "comparison_expression") return "comparison operand (behavioural)";
  if (parent.rawKind === "assignment_statement") return "assigned value (behavioural)";
  if (parent.rawKind === "in_expression") return "membership operand (behavioural)";
  return `other (${parent.rawKind})`;
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

const byContext = new Map<string, number>();
let total = 0;
let inBody = 0;
let alreadyClaimed = 0;

for (const file of files) {
  const claims = new Set<string>();
  walk(file.root, (n) => {
    for (const op of shipped) {
      try {
        if (op.targets(n, ctx)) {
          for (const s of op.generate(n, ctx)) {
            claims.add(`${s.before.startIndex}-${s.before.endIndex}`);
          }
        }
      } catch {
        /* an operator that throws on a shape is R120's business, not this census's */
      }
    }
  });
  walk(file.root, (n) => {
    if (n.rawKind !== "string_literal") return;
    total++;
    let body = false;
    for (let p = n.parent; p !== null; p = p.parent) {
      if (p.rawKind === "procedure" || p.rawKind === "trigger_declaration") {
        body = true;
        break;
      }
    }
    if (body) inBody++;
    if (claims.has(`${n.startIndex}-${n.endIndex}`)) alreadyClaimed++;
    const k = classify(n);
    byContext.set(k, (byContext.get(k) ?? 0) + 1);
  });
}

console.log(`files: ${files.length}`);
console.log(`string literals: ${total} (${inBody} inside a procedure or trigger body)`);
console.log(`  already claimed at the SAME span by a shipped operator: ${alreadyClaimed}\n`);
console.log(`${"context".padEnd(38)} ${"count".padStart(6)}  share`);
for (const [k, v] of [...byContext].sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(38)} ${String(v).padStart(6)}  ${((100 * v) / total).toFixed(1)}%`);
}

const behavioural = [...byContext]
  .filter(([k]) => k.includes("behavioural"))
  .reduce((n, [, v]) => n + v, 0);
console.log(
  `\nBEHAVIOURAL (a value the program branches on or stores): ${behavioural} of ${total}, ` +
    `${((100 * behavioural) / total).toFixed(1)}%`,
);
if (total === 0) throw new Error("census-string-literals: no literals found — refusing to report");
