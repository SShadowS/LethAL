import { beforeAll, describe, expect, it } from "bun:test";
import { tier1Operators } from "@lethal/builtin-tier1";
import { tier2Operators } from "@lethal/builtin-tier2";
/**
 * Every operator declares its version TWICE: once as the `version` field on the operator object,
 * and once as a hard-coded `operatorVersion` string literal inside its own `generate()`. The
 * literal is the one that reaches `MutantManifestEntry.operatorVersion`, and therefore the one
 * every provenance claim actually relies on, not the field
 * (docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §2.1). Before this test, nothing
 * anywhere compared the two: bumping only the field would leave the manifest silently reporting
 * the OLD version forever, and all twelve operators (as of R136 Task A3) hard-code the pair
 * independently, so this is a live hazard for every one of them, not just `swap-modify-flag`.
 *
 * Lives here, in `@lethal/runner`'s tests, rather than under `packages/builtin-tier2/tests/`:
 * `builtin-tier2`'s `package.json` does not depend on `@lethal/builtin-tier1`, so a test importing
 * both registries from there would not resolve. `@lethal/runner` already depends on both (its
 * `orchestrator.ts` imports `tier1Operators` and `tier2Operators` directly), so it is the nearest
 * existing location that can see both without adding a dependency edge a test file should not be
 * the one to introduce.
 *
 * Each operator's own `conformanceTests` already carries at least one "claims" case, a snippet
 * proven to make that operator produce a spec, so this reuses that corpus rather than hand-
 * building a fresh claiming snippet per operator. `runConformance` (`@lethal/operator-sdk`) walks
 * each case's parsed tree the same way; this test does the same walk directly so it can inspect
 * every produced spec's `operatorVersion` rather than only comparing text.
 *
 * `MutationOperator` is imported from `@lethal/engine` rather than `@lethal/operator-sdk`: the
 * SDK re-exports the same type from there, but `@lethal/runner`'s own `package.json` does not list
 * `@lethal/operator-sdk` as a dependency, only `@lethal/engine`.
 */
import {
  type MutationOperator,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";

const allOperators: readonly MutationOperator[] = [...tier1Operators, ...tier2Operators];

describe("operator version invariant: declared version === emitted operatorVersion", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("the registry union is non-empty, so the property below cannot pass vacuously", () => {
    expect(allOperators.length).toBeGreaterThan(0);
  });

  it("every operator's generated specs carry its OWN declared version, over its own conformance corpus", () => {
    let totalSpecs = 0;
    const mismatches: string[] = [];

    for (const op of allOperators) {
      for (const c of op.conformanceTests) {
        const root = wrapRoot(parseAL(c.sourceAL));
        const ctx = buildSemanticContext([{ path: `invariant://${op.name}/${c.name}`, root }]);
        visit(root, (node) => {
          if (!op.targets(node, ctx)) return;
          for (const spec of op.generate(node, ctx)) {
            totalSpecs += 1;
            if (spec.operatorVersion !== op.version) {
              mismatches.push(
                `${op.name}: declared version "${op.version}" but generate() emitted ` +
                  `operatorVersion "${spec.operatorVersion}" (conformance case "${c.name}")`,
              );
            }
          }
        });
      }
    }

    // A registry-wide corpus that produced zero specs would make the loop above pass having
    // asserted nothing: the exact "empty-vs-empty matches" shape this repo refuses to ship.
    expect(totalSpecs).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});
