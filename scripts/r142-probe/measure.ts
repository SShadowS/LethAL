/**
 * R142 measurement: for every operator's NON-EMPTY conformance cases, run the same walk
 * `runConformance` runs and report the specs the case's `expectedSpecs` does NOT account for.
 *
 * Read-only, offline. Mirrors `runConformance`'s matching exactly (parentContext + trimmed
 * before/after text, drained one-for-one) so the leftovers reported here are precisely what an
 * exactness check would fail on. Kept as the record of what was measured before the check was
 * turned on — see this directory's README for the result.
 */
import { tier1Operators } from "../../packages/builtin-tier1/src/index";
import { tier2Operators } from "../../packages/builtin-tier2/src/index";
import type { MutationOperator, MutationSpec } from "../../packages/engine/src/index";
import {
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "../../packages/engine/src/index";

function renderAfter(spec: MutationSpec): string {
  const after = spec.after as { text?: string };
  return after.text ?? "";
}

await initParser();

let totalCases = 0;
let emptyCases = 0;
let overCases = 0;

for (const op of [...tier1Operators, ...tier2Operators] as MutationOperator[]) {
  for (const c of op.conformanceTests) {
    totalCases++;
    if (c.expectedSpecs.length === 0) {
      emptyCases++;
      continue;
    }
    const tree = parseAL(c.sourceAL);
    const root = wrapRoot(tree);
    const ctx = buildSemanticContext([{ path: `conformance://${c.name}`, root }]);
    const produced: MutationSpec[] = [];
    visit(root, (node) => {
      if (op.targets(node, ctx)) {
        for (const spec of op.generate(node, ctx)) produced.push(spec);
      }
    });

    const expectedRemaining = c.expectedSpecs.slice();
    const unmatched: MutationSpec[] = [];
    for (const spec of produced) {
      const idx = expectedRemaining.findIndex(
        (e) =>
          e.parentContext === spec.parentContext &&
          e.beforeText === spec.before.text.trim() &&
          e.afterText === renderAfter(spec).trim(),
      );
      if (idx >= 0) expectedRemaining.splice(idx, 1);
      else unmatched.push(spec);
    }

    if (unmatched.length > 0) {
      overCases++;
      console.log(`\n[EXTRA] ${op.name} :: ${c.name}`);
      console.log(`  expected ${c.expectedSpecs.length}, produced ${produced.length}`);
      for (const s of unmatched) {
        console.log(
          `    + ${s.parentContext} | ${JSON.stringify(s.before.text.trim())} -> ${JSON.stringify(renderAfter(s).trim())}`,
        );
      }
    }
    if (expectedRemaining.length > 0) {
      console.log(`\n[MISSING] ${op.name} :: ${c.name} — ${expectedRemaining.length} not produced`);
    }
  }
}

console.log(
  `\ntotal cases ${totalCases}, empty (refusal) cases ${emptyCases}, non-empty cases with EXTRA specs ${overCases}`,
);

// Printed so a run proves both registries actually loaded: a registry that failed to import would
// report zero extras just as convincingly as an exhaustive set of goldens does.
console.log("\nper-operator case counts:");
for (const op of [...tier1Operators, ...tier2Operators] as MutationOperator[]) {
  const empty = op.conformanceTests.filter((c) => c.expectedSpecs.length === 0).length;
  console.log(`  ${op.name}: ${op.conformanceTests.length} case(s), ${empty} refusal`);
}
