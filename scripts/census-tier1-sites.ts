#!/usr/bin/env bun
/**
 * R14's PER-SITE grammar-bump proof.
 *
 * `packages/engine/vendor/README.md` requires "corpus site counts plus a per-site baseline proof,
 * not a multiset signature", and until now only the first half had an instrument
 * (`probe-grammar-corpus.ts`, which reports aggregate counts and a node-kind histogram). Counts
 * caught the v2.5.0 to v3.0.1 disaster because `statementCalls` went to zero, and they would NOT
 * catch a bump that keeps every total while moving WHICH sites each operator claims. R120 is why
 * that is a live hazard rather than a theoretical one: `ALNodeKind` is a CURATED subset and
 * `ALSyntaxNode.kind` CASTS the raw tree-sitter type into it, so a renamed or re-parented node
 * changes what a comparison matches at runtime with no type error anywhere.
 *
 * So this emits the actual claimed sites — one row per (operator, file, line, column, text) —
 * which a bump can be diffed against directly.
 *
 *   bun scripts/census-tier1-sites.ts <project-dir> <out.json>
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined || outPath === undefined) {
  console.error("usage: bun scripts/census-tier1-sites.ts <project-dir> <out.json>");
  process.exit(2);
}

interface SiteRow {
  readonly operator: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Whitespace-normalised, so a formatting-only reparse is not reported as a moved site. */
  readonly before: string;
  readonly after: string;
}

function walk(node: ALSyntaxNode, visit: (n: ALSyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

await initParser();

const entries = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const files: SourceFile[] = [];
for (const rel of entries) {
  const source = await readFile(join(projectDir, rel), "utf8");
  files.push({ path: rel, root: wrapRoot(parseAL(source)) });
}
// ONE semantic context over the whole corpus: identifier resolution walks every object, so a
// per-file context answers `null` for anything declared elsewhere and operators that consult types
// would silently claim fewer sites — a difference that has nothing to do with the grammar.
const ctx = buildSemanticContext(files);

const rows: SiteRow[] = [];
for (const file of files) {
  walk(file.root, (node) => {
    for (const op of tier1Operators) {
      let claims = false;
      try {
        claims = op.targets(node, ctx);
      } catch {
        // An operator that THROWS on a node shape is itself a bump signal, and swallowing it here
        // would hide that. Recorded as a row rather than dropped.
        rows.push({
          operator: op.name,
          file: file.path,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          before: "<targets() threw>",
          after: "<targets() threw>",
        });
        continue;
      }
      if (!claims) continue;
      let specs: readonly { before: ALSyntaxNode; after: ALSyntaxNode }[];
      try {
        specs = op.generate(node, ctx);
      } catch {
        rows.push({
          operator: op.name,
          file: file.path,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          before: "<generate() threw>",
          after: "<generate() threw>",
        });
        continue;
      }
      for (const spec of specs) {
        rows.push({
          operator: op.name,
          file: file.path,
          line: spec.before.startPosition.row + 1,
          column: spec.before.startPosition.column,
          before: squash(spec.before.text),
          after: squash(spec.after.text),
        });
      }
    }
  });
}

// Sorted so two runs are diffable without the walk order being part of the comparison.
rows.sort((a, b) =>
  a.file !== b.file
    ? a.file.localeCompare(b.file)
    : a.line !== b.line
      ? a.line - b.line
      : a.column !== b.column
        ? a.column - b.column
        : a.operator !== b.operator
          ? a.operator.localeCompare(b.operator)
          : a.before.localeCompare(b.before),
);

const byOperator = new Map<string, number>();
for (const r of rows) byOperator.set(r.operator, (byOperator.get(r.operator) ?? 0) + 1);

console.log(`files: ${files.length}`);
console.log(`sites: ${rows.length}`);
for (const [op, n] of [...byOperator].sort()) console.log(`  ${op.padEnd(34)} ${n}`);
// Fail loudly rather than write an empty baseline someone would later diff against and call clean.
// Empty-vs-empty "matches" is this project's signature bug.
if (rows.length === 0) throw new Error("census-tier1-sites: no sites claimed — refusing to write");

await writeFile(outPath, `${JSON.stringify(rows, null, 1)}\n`, "utf8");
console.log(`wrote ${outPath}`);
