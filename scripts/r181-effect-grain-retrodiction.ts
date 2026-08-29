#!/usr/bin/env bun
/**
 * R181 — RETRODICT the proposed effect-grain redundancy rule across every SHIPPED operator.
 *
 *   bun scripts/r181-effect-grain-retrodiction.ts <corpus-dir>
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here. Only counts and operator names leave the process, never source text.
 *
 * ## Why this runs before any rule is written down
 *
 * R181 measured that R13's bar never fixed a GRAIN, and that the same operators on the same mutants
 * are 88.4% marginal at line grain and 23.7% at file grain. The proposal is to stop choosing a
 * spatial grain at all and judge redundancy at EFFECT grain: a candidate's mutant is redundant only
 * where a shipped operator already produces the SAME EDIT.
 *
 * That is not a new invention. It is the identity the pipeline already enforces —
 * `packages/schemata/src/dedup.ts`'s `identityOf` is `kind:startIndex:endIndex:after.text` — and it
 * is the grain [[R82]] reasoned at explicitly, in its own words: "a swap's replacement text is never
 * byte-identical to `void-method-call`'s empty deletion at the same call, unlike `IsolationLevelSwap`,
 * whose 25-of-36 overlap was a genuine identity collision".
 *
 * **A rule that accepts a proposal because it is new is worthless. The test is whether it accepts
 * the operators this project already values.** So: measure every shipped operator against the set
 * MINUS ITSELF, at effect grain, and see which of them the proposed rule would have refused. Any
 * shipped operator falling under the floor is a refutation of the rule, not a finding about the
 * operator.
 *
 * ## What this does NOT settle
 *
 * The floor itself (>=13) is not derived here and R181 records that it never was: it is anchored to
 * `swap-modify-flag`'s 2026-08-02 footprint. This measures which operators clear it under a
 * different redundancy test, not whether 13 is the right number.
 *
 * `IsolationLevelSwap` and `PermissionReduce` cannot be re-measured here because neither was ever
 * implemented; their refusals stand on R13's recorded measurement. What CAN be checked is that the
 * rule does not accidentally accept everything, which is what the collision column shows.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import type { SourceFile } from "../packages/engine/src/semantic/symbol-table";

const [corpusDir] = process.argv.slice(2);
if (corpusDir === undefined) {
  console.error("usage: bun scripts/r181-effect-grain-retrodiction.ts <corpus-dir>");
  process.exit(2);
}

/** R13's bar (a), kept as-is so this measures the RULE change and not a threshold change too. */
const FLOOR = 13;

const operators = [...tier1Operators, ...tier2Operators];

function walk(node: ALSyntaxNode, visit: (n: ALSyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

await initParser();
const entries = (await readdir(corpusDir, { recursive: true })).filter(
  (f) => f.toLowerCase().endsWith(".al") && !f.includes(".dependencies"),
);
const files: SourceFile[] = [];
for (const rel of entries) {
  try {
    files.push({
      path: rel,
      root: wrapRoot(parseAL(await readFile(join(corpusDir, rel), "utf8"))),
    });
  } catch {
    // A file the grammar cannot parse is not this measurement's business.
  }
}
// ONE context over the whole corpus, same reason census-operator-sites.ts gives: a per-file context
// answers `null` for anything declared elsewhere, so operators consulting types claim fewer sites
// for a reason that has nothing to do with the rule under test.
const ctx = buildSemanticContext(files);

/** `dedup.ts`'s identity, recomputed here rather than imported so a drift is visible as a
 *  disagreement between two files rather than hidden by sharing one. */
function identityOf(file: string, before: ALSyntaxNode, afterText: string): string {
  return `${file}|${before.kind}:${before.startIndex}:${before.endIndex}:${afterText}`;
}

// identity -> the set of operators that emit exactly this edit
const claimants = new Map<string, Set<string>>();
const emitted = new Map<string, number>();

for (const file of files) {
  walk(file.root, (node) => {
    for (const op of operators) {
      let claims = false;
      try {
        claims = op.targets(node, ctx);
      } catch {
        continue;
      }
      if (!claims) continue;
      let specs: readonly { before: ALSyntaxNode; after: { text: string } }[];
      try {
        specs = op.generate(node, ctx) as never;
      } catch {
        continue;
      }
      for (const s of specs) {
        const id = identityOf(file.path, s.before, s.after.text);
        const set = claimants.get(id);
        if (set === undefined) claimants.set(id, new Set([op.name]));
        else set.add(op.name);
        emitted.set(op.name, (emitted.get(op.name) ?? 0) + 1);
      }
    }
  });
}

interface Row {
  op: string;
  total: number;
  collided: number;
  marginal: number;
}
const rows: Row[] = [];
for (const op of operators) {
  const total = emitted.get(op.name) ?? 0;
  let collided = 0;
  for (const [, set] of claimants) {
    if (set.has(op.name) && set.size > 1) collided++;
  }
  rows.push({ op: op.name, total, collided, marginal: total - collided });
}
rows.sort((a, b) => b.total - a.total);

console.log(`corpus: ${files.length} parsed .al files, ${claimants.size} distinct edits\n`);
console.log(
  `${"operator".padEnd(30)}${"emitted".padStart(9)}${"collided".padStart(10)}${"marginal".padStart(10)}${"vs floor".padStart(10)}`,
);
let refused = 0;
for (const r of rows) {
  const verdict = r.marginal >= FLOOR ? "clears" : "REFUSED";
  if (r.marginal < FLOOR) refused++;
  console.log(
    `${r.op.padEnd(30)}${String(r.total).padStart(9)}${String(r.collided).padStart(10)}${String(r.marginal).padStart(10)}${verdict.padStart(10)}`,
  );
}

const multi = [...claimants.values()].filter((s) => s.size > 1).length;
console.log(`\ndistinct edits claimed by 2+ operators: ${multi} of ${claimants.size}`);
console.log(
  `shipped operators the proposed rule would REFUSE at a floor of ${FLOOR}: ${refused} of ${rows.length}`,
);
console.log(
  "\nREAD THIS AS A REFUTATION TEST, not a ranking. Any shipped operator below the floor is",
);
console.log(
  "evidence against the RULE. A rule that refuses operators this project measured, built and",
);
console.log("values has failed, however principled its derivation.");
