#!/usr/bin/env bun
/**
 * Parse a corpus of real AL files with the CURRENTLY VENDORED tree-sitter-al wasm and report how
 * much of it the grammar actually understands.
 *
 * Why this exists: every LethAL operator keys on node kinds from `packages/engine/vendor/
 * tree-sitter-al.wasm`, and until now the only AL the parser had ever been measured against was a
 * 2-codeunit fixture. A grammar that silently produces ERROR nodes on real code does not fail
 * loudly — it just yields fewer mutation sites, which looks like "this project has little to
 * mutate" rather than "the parser could not read it".
 *
 * This is also the instrument for a grammar upgrade: run it against the vendored wasm, swap the
 * wasm, run it again, and diff. A bump that raises the error rate, or that changes the node-kind
 * histogram the operators depend on, is a regression regardless of what the grammar's own test
 * suite says.
 *
 *   bun run scripts/probe-grammar-corpus.ts <corpus-dir> [--json out.json] [--limit N]
 *
 * NOTE: point this at a scratch directory. The intended corpus is extracted Microsoft BC test-app
 * source, which is proprietary and must never be committed to this repo.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";

interface FileResult {
  readonly file: string;
  readonly bytes: number;
  readonly errorNodes: number;
  readonly missingNodes: number;
  /** Bytes covered by the largest ERROR node — a proxy for "how much did we fail to read". */
  readonly worstErrorBytes: number;
}

const args = process.argv.slice(2);
const dir = args[0];
if (dir === undefined) {
  console.error(
    "usage: bun run scripts/probe-grammar-corpus.ts <corpus-dir> [--json out] [--limit N]",
  );
  process.exit(2);
}
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Number.POSITIVE_INFINITY;

function walk(node: ALSyntaxNode, visit: (n: ALSyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

await initParser();

const entries = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".al")).slice(0, limit);
const results: FileResult[] = [];
const kindHistogram = new Map<string, number>();
/** Sites the operators actually consume — a drop here is a silent capability loss. */
const siteCounts = { statementCalls: 0, blocks: 0, triggerBlocks: 0, procedures: 0, exits: 0 };
let parseFailures = 0;

for (const [i, name] of entries.entries()) {
  if (i % 250 === 0) console.log(`  ... ${i}/${entries.length}`);
  const source = await readFile(join(dir, name), "utf8");
  let root: ALSyntaxNode;
  try {
    root = wrapRoot(parseAL(source));
  } catch {
    parseFailures++;
    continue;
  }
  let errorNodes = 0;
  let missingNodes = 0;
  let worstErrorBytes = 0;
  walk(root, (n) => {
    kindHistogram.set(n.kind, (kindHistogram.get(n.kind) ?? 0) + 1);
    if (n.kind === "ERROR") {
      errorNodes++;
      worstErrorBytes = Math.max(worstErrorBytes, n.endIndex - n.startIndex);
    } else if (n.kind === "MISSING") {
      missingNodes++;
    }
    if (n.kind === ALNodeKind.block) {
      siteCounts.blocks++;
      if (n.parent !== null && n.parent.kind === ALNodeKind.trigger) siteCounts.triggerBlocks++;
    }
    if (n.kind === ALNodeKind.procedure) siteCounts.procedures++;
    if (n.kind === ALNodeKind.exit_statement) siteCounts.exits++;
    if (
      n.kind === ALNodeKind.procedure_call &&
      n.parent !== null &&
      n.parent.kind === ALNodeKind.block
    ) {
      siteCounts.statementCalls++;
    }
  });
  results.push({ file: name, bytes: source.length, errorNodes, missingNodes, worstErrorBytes });
}

const clean = results.filter((r) => r.errorNodes === 0 && r.missingNodes === 0);
const totalBytes = results.reduce((n, r) => n + r.bytes, 0);
const totalErrorNodes = results.reduce((n, r) => n + r.errorNodes, 0);

console.log(`\n=== corpus: ${dir}`);
console.log(`files parsed      : ${results.length} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`hard parse failures: ${parseFailures}`);
console.log(
  `clean files       : ${clean.length} (${((clean.length / Math.max(1, results.length)) * 100).toFixed(1)}%)`,
);
console.log(`files with ERRORs : ${results.length - clean.length}`);
console.log(`total ERROR nodes : ${totalErrorNodes}`);

console.log(
  `\n=== operator-relevant sites (a drop here after a grammar bump is a capability loss)`,
);
for (const [k, v] of Object.entries(siteCounts)) console.log(`  ${k.padEnd(16)} ${v}`);

console.log(`\n=== worst files by unreadable bytes`);
for (const r of [...results].sort((a, b) => b.worstErrorBytes - a.worstErrorBytes).slice(0, 10)) {
  if (r.worstErrorBytes === 0) break;
  console.log(`  ${String(r.worstErrorBytes).padStart(7)}B  ${r.errorNodes} err  ${r.file}`);
}

if (jsonOut !== undefined) {
  await writeFile(
    jsonOut,
    JSON.stringify(
      {
        files: results.length,
        cleanFiles: clean.length,
        totalErrorNodes,
        parseFailures,
        siteCounts,
        kinds: Object.fromEntries([...kindHistogram].sort((a, b) => b[1] - a[1])),
        worst: [...results].sort((a, b) => b.worstErrorBytes - a.worstErrorBytes).slice(0, 50),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nwrote ${jsonOut}`);
}
