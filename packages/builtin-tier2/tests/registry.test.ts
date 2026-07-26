import { describe, expect, it } from "bun:test";
import { tier2Operators } from "../src/index";

/**
 * The registry is the ONLY wiring a Tier-2 operator needs: `packages/runner/src/orchestrator.ts`
 * derives both its operator walk and its `operatorTiers` map from this array. Dropping an operator
 * from it therefore silently removes that operator from every run — so membership is asserted
 * exactly, not merely shape-checked.
 */
const EXPECTED_OPERATORS = [
  "lethal.remove-testfield",
  "lethal.remove-setrange",
  "lethal.remove-calcfields",
  "lethal.swap-modify-flag",
] as const;

describe("tier2Operators", () => {
  it("holds exactly the four Phase-1 operators, in registration order", () => {
    expect(tier2Operators.map((op) => op.name)).toEqual([...EXPECTED_OPERATORS]);
  });

  it("every operator declares tier 2", () => {
    // A Tier-1 tier on a Tier-2 operator would invert §3.2 dedup precedence at every shared site:
    // `void-method-call` and the narrowing would tie, and `dedupeSpecs` throws on an unresolvable
    // tie rather than guessing. Cheap to assert, expensive to discover downstream.
    expect(tier2Operators.map((op) => op.tier)).toEqual(EXPECTED_OPERATORS.map(() => 2));
  });

  it("every operator declares a lethal.-prefixed name and a semver version", () => {
    for (const op of tier2Operators) {
      expect(op.name.startsWith("lethal.")).toBe(true);
      expect(op.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
