// scripts/census-fixture-mutants.ts — per-mutant offline census over a fixture project.
// Mirrors the real planning pipeline: targets -> generate -> validateSpec -> isMutableSite ->
// dedupeSpecs. Usage: bun scripts/census-fixture-mutants.ts <dir-with-al-files>
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import type { MutationSpec } from "../packages/engine/src/operator/interface";
import { buildSpanIndex, validateSpec } from "../packages/engine/src/operator/spec-validation";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { dedupeSpecs } from "../packages/schemata/src/dedup";
import { isMutableSite } from "../packages/schemata/src/enclosing";

const projectDir = process.argv[2];
if (projectDir === undefined) throw new Error("usage: bun scripts/census-fixture-mutants.ts <dir>");

await initParser();
const allOperators = [...tier1Operators, ...tier2Operators];
const tiers = new Map(allOperators.map((op) => [op.name, op.tier]));

const entries = (await readdir(projectDir)).filter((f) => f.endsWith(".al")).sort();
const parsed = await Promise.all(
  entries.map(async (rel) => {
    const source = await readFile(join(projectDir, rel), "utf8");
    return { path: rel, source, root: wrapRoot(parseAL(source)) };
  }),
);
const ctx = buildSemanticContext(parsed.map(({ path, root }) => ({ path, root })));

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

let kept = 0;
for (const { path: rel, source, root } of parsed) {
  const spanIndex = buildSpanIndex(root);
  const raw: MutationSpec[] = [];
  visit(root, (node) => {
    for (const op of allOperators) {
      if (!op.targets(node, ctx)) continue;
      for (const spec of op.generate(node, ctx)) {
        if (!validateSpec(spec, root, spanIndex).ok) continue;
        if (!isMutableSite(spec.before)) continue;
        raw.push(spec);
      }
    }
  });
  const dedupedSet = new Set(dedupeSpecs(raw, (name) => tiers.get(name)));
  for (const s of raw.sort((a, b) => a.before.startIndex - b.before.startIndex)) {
    const mark = dedupedSet.has(s) ? "" : " [DISPLACED]";
    const after = s.after.text === "" ? "(deleted)" : s.after.text.replace(/\n/g, "\\n");
    console.log(
      `${rel}:${lineOf(source, s.before.startIndex)} ${s.operatorName} | ${s.before.text.replace(/\n/g, "\\n")} => ${after}${mark}`,
    );
    if (dedupedSet.has(s)) kept++;
  }
}
console.log(`\nTOTAL deployed (post-dedup): ${kept}`);
