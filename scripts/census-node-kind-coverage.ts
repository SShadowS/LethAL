#!/usr/bin/env bun
/**
 * "Is there an AL construct we never mutate?", answered mechanically rather than by brainstorm.
 *
 * The operator set was grown one justified operator at a time, and every REFUSAL is written down
 * (`RemoveSetLoadFields`, the three Tier-3 candidates). What was never written down is the
 * complement: the AL node kinds no shipped operator inspects AT ALL. A brainstormed list of
 * "operators we could add" is unfalsifiable; a histogram of the grammar's own node kinds over a
 * real corpus, marked with which ones any operator claims, is not.
 *
 *   bun scripts/census-node-kind-coverage.ts <project-dir> [out.json]
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here. Only counts and node-kind names leave the process; no source text is written.
 *
 * Reads RAW tree-sitter node types, never `ALNodeKind`. `ALNodeKind` is a CURATED subset and
 * `ALSyntaxNode.kind` casts into it, so censusing the curated set could only ever report that the
 * kinds we chose to name are the kinds we handle. The blind spot this instrument exists to find
 * would be invisible in exactly that way.
 *
 * A kind is counted as EXECUTABLE when it has a `procedure` or `trigger_declaration` ancestor,
 * an object property or a `var` declaration is not a statement any test can run, so counting it as
 * unmutated surface would inflate the gap with nodes no mutation operator could ever target.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined) {
  console.error("usage: bun scripts/census-node-kind-coverage.ts <project-dir> [out.json]");
  process.exit(2);
}

const operators = [...tier1Operators, ...tier2Operators];

interface KindRow {
  readonly kind: string;
  /** Every occurrence, anywhere in the file. */
  total: number;
  /** Occurrences with a `procedure` / `trigger_declaration` ancestor. */
  executable: number;
  /** Executable occurrences at least one operator's `targets()` claims. */
  claimed: number;
  /** Which operators claim this kind, so a partially-covered kind is not read as a covered one. */
  readonly claimants: Set<string>;
}

const EXECUTABLE_ANCESTORS = new Set(["procedure", "trigger_declaration"]);

await initParser();

const entries = (await readdir(projectDir, { recursive: true })).filter((f) =>
  f.toLowerCase().endsWith(".al"),
);
const files: SourceFile[] = [];
for (const rel of entries) {
  const source = await readFile(join(projectDir, rel), "utf8");
  files.push({ path: rel, root: wrapRoot(parseAL(source)) });
}
if (files.length === 0) throw new Error(`census: no .al files under ${projectDir}`);

// ONE context over the whole corpus, same reason as census-tier1-sites.ts: a per-file context
// answers `null` for anything declared elsewhere, and type-consulting operators would claim fewer
// sites for a reason that has nothing to do with the grammar.
const ctx = buildSemanticContext(files);

const rows = new Map<string, KindRow>();
const row = (kind: string): KindRow => {
  const existing = rows.get(kind);
  if (existing !== undefined) return existing;
  const fresh: KindRow = { kind, total: 0, executable: 0, claimed: 0, claimants: new Set() };
  rows.set(kind, fresh);
  return fresh;
};

function walk(node: ALSyntaxNode, inExecutable: boolean): void {
  const r = row(node.rawKind);
  r.total += 1;
  if (inExecutable) {
    r.executable += 1;
    let claimedHere = false;
    for (const op of operators) {
      let claims = false;
      try {
        claims = op.targets(node, ctx);
      } catch {
        // An operator that THROWS on a node shape is a finding in its own right, not a non-claim.
        r.claimants.add(`${op.name}<threw>`);
        claimedHere = true;
        continue;
      }
      if (claims) {
        r.claimants.add(op.name);
        claimedHere = true;
      }
    }
    if (claimedHere) r.claimed += 1;
  }
  const nextExecutable = inExecutable || EXECUTABLE_ANCESTORS.has(node.rawKind);
  for (const child of node.namedChildren) walk(child, nextExecutable);
}

for (const file of files) walk(file.root, false);

const sorted = [...rows.values()].sort(
  (a, b) => b.executable - a.executable || a.kind.localeCompare(b.kind),
);
const executableKinds = sorted.filter((r) => r.executable > 0);
const unclaimed = executableKinds.filter((r) => r.claimed === 0);

console.log(`files:            ${files.length}`);
console.log(
  `distinct kinds:   ${rows.size} (${executableKinds.length} occur inside procedure/trigger bodies)`,
);
console.log(`never claimed:    ${unclaimed.length} of those ${executableKinds.length}`);
console.log("");
console.log(`${"kind".padEnd(34)}${"exec".padStart(8)}${"claimed".padStart(9)}  operators`);
for (const r of executableKinds) {
  const ops = r.claimants.size === 0 ? " NEVER MUTATED" : [...r.claimants].sort().join(", ");
  console.log(
    `${r.kind.padEnd(34)}${String(r.executable).padStart(8)}${String(r.claimed).padStart(9)}  ${ops}`,
  );
}

// The raw count above includes kinds no operator SHOULD target, keywords, type nodes, comments,
// `var` sections. Quoting "109 of 115 never claimed" as the gap would overstate it. So the headline
// is narrowed by a MECHANICAL rule on the grammar's own naming convention rather than by a
// hand-curated taste list: a kind whose name ends in `_statement` or `_expression`, plus the literal
// nodes. Those are the nodes that carry behaviour, and a behaviour-carrying kind no operator
// inspects is a real hole whoever reads this can argue with by name.
const LITERAL_KINDS = new Set([
  "boolean",
  "integer",
  "decimal",
  "string_literal",
  "verbatim_string",
  "date_literal",
  "datetime_literal",
  "time_literal",
]);
const behavioural = executableKinds.filter(
  (r) =>
    r.kind.endsWith("_statement") || r.kind.endsWith("_expression") || LITERAL_KINDS.has(r.kind),
);
const behaviouralUnclaimed = behavioural.filter((r) => r.claimed === 0);
const unclaimedSites = behaviouralUnclaimed.reduce((n, r) => n + r.executable, 0);
console.log("");
console.log("--- behaviour-carrying kinds (name ends _statement/_expression, or a literal) ---");
console.log(
  `${behavioural.length} kinds, ${behaviouralUnclaimed.length} never claimed by any operator, ` +
    `${unclaimedSites} occurrences`,
);
for (const r of behaviouralUnclaimed) {
  console.log(`  ${r.kind.padEnd(30)} ${String(r.executable).padStart(7)}`);
}

if (outPath !== undefined) {
  const json = executableKinds.map((r) => ({
    kind: r.kind,
    total: r.total,
    executable: r.executable,
    claimed: r.claimed,
    claimants: [...r.claimants].sort(),
  }));
  await writeFile(outPath, `${JSON.stringify(json, null, 1)}\n`, "utf8");
}
