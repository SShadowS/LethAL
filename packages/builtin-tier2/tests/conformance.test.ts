import { beforeAll, describe, expect, it } from "bun:test";
/**
 * Runs the golden cases every Tier-2 operator declares in its own `conformanceTests`.
 *
 * Spec (2026-07-25-tier2-mutation-operators-design.md §7) lists the golden cases as a verification
 * deliverable, and each operator has carried them since it landed — but nothing executed them, so
 * a golden could rot (or an operator could stop matching its own documented behaviour) in silence.
 * Mirrors `packages/builtin-tier1/tests/conformance.test.ts` exactly, pointed at `tier2Operators`.
 */
import { initParser } from "@lethal/engine";
import { runConformance } from "@lethal/operator-sdk";
import { tier2Operators } from "../src";

describe("tier 2 conformance", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Guards the loop below against passing vacuously: an empty (or accidentally emptied) registry
  // would register zero `it`s and the file would report green having asserted nothing.
  it("every Tier-2 operator declares at least one conformance case", () => {
    expect(tier2Operators.length).toBeGreaterThan(0);
    for (const op of tier2Operators) {
      expect(op.conformanceTests.length).toBeGreaterThan(0);
    }
  });

  for (const op of tier2Operators) {
    it(`${op.name} passes its conformance suite`, async () => {
      const result = await runConformance(op);
      if (!result.allPassed) {
        console.error(JSON.stringify(result.failures, null, 2));
      }
      expect(result.allPassed).toBe(true);
    });
  }
});
