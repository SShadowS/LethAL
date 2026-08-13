// scripts/census-fixture-mutants.ts — per-mutant offline census over a fixture project.
// Mirrors the real planning pipeline: targets -> generate -> validateSpec -> isMutableSite ->
// dedupeSpecs -> canCarryMutationSelectorVar. Usage: bun scripts/census-fixture-mutants.ts <dir>
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import type { MutationSpec } from "../packages/engine/src/operator/interface";
import { buildSpanIndex, validateSpec } from "../packages/engine/src/operator/spec-validation";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { canCarryMutationSelectorVar } from "../packages/schemata/src/compile";
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
const nonCarrierFiles: { file: string; sites: number }[] = [];
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
  // Mirrors `generateMutationSet` (packages/runner/src/orchestrator.ts): a file whose object kind
  // cannot carry the injected `var MutationSelector: Codeunit "Mutation Selector";` declaration is
  // dropped WHOLE -- none of its specs ever deploy, dedup notwithstanding. Read from
  // @lethal/schemata rather than restating the carrier-kind list here, so the two cannot drift.
  const isCarrier = canCarryMutationSelectorVar(root);
  if (!isCarrier && dedupedSet.size > 0) {
    nonCarrierFiles.push({ file: rel, sites: dedupedSet.size });
  }
  for (const s of raw.sort((a, b) => a.before.startIndex - b.before.startIndex)) {
    const displaced = !dedupedSet.has(s);
    const mark = !isCarrier
      ? " [NOT-CARRIER: file dropped whole, never deploys]"
      : displaced
        ? " [DISPLACED]"
        : "";
    const after = s.after.text === "" ? "(deleted)" : s.after.text.replace(/\n/g, "\\n");
    console.log(
      `${rel}:${lineOf(source, s.before.startIndex)} ${s.operatorName} | ${s.before.text.replace(/\n/g, "\\n")} => ${after}${mark}`,
    );
    if (!displaced && isCarrier) kept++;
  }
}
if (nonCarrierFiles.length > 0) {
  const detail = nonCarrierFiles
    .map((f) => `${f.file} (${f.sites} would-be-deployed site(s))`)
    .join(", ");
  console.log(
    `\n${nonCarrierFiles.length} file(s) dropped whole (cannot carry MutationSelector var): ${detail}`,
  );
}
console.log(`\nTOTAL deployed (post-dedup, post-carrier-filter): ${kept}`);
