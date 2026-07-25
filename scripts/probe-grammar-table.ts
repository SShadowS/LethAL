#!/usr/bin/env bun
/**
 * Grammar probe for Layer 6 (Tier-2 operators): does the VENDORED tree-sitter-al wasm parse a
 * table object into usable named nodes?
 *
 * The Tier-2 design (docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §8)
 * names this as the risk the whole trigger half of Tier 2 rests on: schemata must locate a table's
 * `fields`/`keys`/`var`/trigger members by node kind to inject the selector variable in a legal
 * position, and `ALNodeKind` (packages/engine/src/ast/node-kinds.ts) currently declares no kinds
 * for field declarations, keys, or field-level triggers.
 *
 * This answers it by observation rather than by reading grammar.js: parse a table containing every
 * member shape Phase 0 must handle, and report the actual node kinds, plus whether the specific
 * sites Tier-2 operators target are reachable.
 *
 *   bun run scripts/probe-grammar-table.ts [path-to.al]
 */
import { readFile } from "node:fs/promises";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { isStatementPosition } from "../packages/engine/src/ast/tree-walks";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";

const DEFAULT_FIXTURE = "fixtures/grammar-probe/ProbeTable.Table.al";

/** Member shapes Phase 0's selector injection must be able to find inside a table. */
const PHASE0_MEMBERS = [
  "table_declaration",
  "field_declaration",
  "keys_section",
  "fieldgroups_section",
  "var_section",
  "trigger_declaration",
];

/** Call sites the Tier-2 operator predicates must be able to claim. */
const TIER2_CALLS = ["TestField", "CalcFields", "SetRange", "SetLoadFields", "Modify", "Commit"];

function walk(
  node: ALSyntaxNode,
  visit: (n: ALSyntaxNode, depth: number) => void,
  depth = 0,
): void {
  visit(node, depth);
  for (const child of node.namedChildren) walk(child, visit, depth + 1);
}

const path = process.argv[2] ?? DEFAULT_FIXTURE;
const source = await readFile(path, "utf8");
await initParser();
const root = wrapRoot(parseAL(source));

console.log(`parsed ${path} — root kind: ${root.kind}`);

// 1. Did it parse at all? A grammar that cannot handle tables shows up as ERROR/MISSING nodes.
const errors: string[] = [];
walk(root, (n) => {
  if (n.kind === "ERROR" || n.kind === "MISSING") {
    errors.push(
      `${n.kind} at ${n.startIndex}-${n.endIndex}: ${JSON.stringify(n.text.slice(0, 60))}`,
    );
  }
});
console.log(`\n=== parse errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log(`  ${e}`);

// 2. Which node kinds actually appear, and how often.
const kinds = new Map<string, number>();
walk(root, (n) => kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1));
console.log(`\n=== distinct named node kinds: ${kinds.size}`);

// 3. The Phase 0 question: are the table members addressable by kind?
console.log("\n=== Phase 0 selector-injection members");
for (const want of PHASE0_MEMBERS) {
  const n = kinds.get(want) ?? 0;
  console.log(`  ${n > 0 ? "FOUND" : "ABSENT"}  ${want}${n > 0 ? ` (x${n})` : ""}`);
}

// 4. The Tier-2 question: is each targeted call reachable as a statement-position call_expression,
//    and does it carry a receiver? Both matter — §4.1 requires matching the implicit-Rec form too.
console.log("\n=== Tier-2 target call sites (statement position)");
const found = new Map<string, { qualified: number; implicit: number }>();
walk(root, (n) => {
  if (n.kind !== ALNodeKind.procedure_call) return;
  if (!isStatementPosition(n)) return;
  const fn = n.childForFieldName("function");
  const text = (fn ?? n).text;
  const qualified = text.includes(".");
  const name = (qualified ? (text.split(".").pop() ?? text) : text).replace(/\s*\(.*$/s, "").trim();
  for (const call of TIER2_CALLS) {
    if (name.toLowerCase() !== call.toLowerCase()) continue;
    const cur = found.get(call) ?? { qualified: 0, implicit: 0 };
    if (qualified) cur.qualified++;
    else cur.implicit++;
    found.set(call, cur);
  }
});
for (const call of TIER2_CALLS) {
  const c = found.get(call);
  console.log(
    c === undefined
      ? `  NOT REACHED  ${call}`
      : `  reached      ${call}  qualified=${c.qualified} implicit=${c.implicit}`,
  );
}

// 5. Are trigger bodies reachable as blocks whose parent is a trigger? This is what Tier-1
//    empty-block already keys on, and what any trigger mutation depends on.
let triggerBlocks = 0;
walk(root, (n) => {
  if (n.kind === ALNodeKind.block && n.parent !== null && n.parent.kind === ALNodeKind.trigger)
    triggerBlocks++;
});
console.log(`\n=== blocks whose parent is trigger_declaration: ${triggerBlocks}`);

console.log(
  `\nVERDICT: ${errors.length === 0 && triggerBlocks > 0 ? "table parses cleanly and trigger bodies are addressable" : "SEE ERRORS ABOVE"}`,
);
