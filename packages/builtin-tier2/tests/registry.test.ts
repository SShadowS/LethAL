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
  // Phase 2 (R33) shipped ONE operator. `RemoveSetLoadFields` was refused and must not be added
  // back without new evidence (deleting a load restriction only WIDENS the load, so no real
  // assertion can go from passing to failing).
  "lethal.remove-commit",
  // R71. `SwapRecXRec` was ALSO refused in Phase 2, on a measurement that turned out not to
  // support the refusal: `differ=No` was measured for `Modify(true)` alone, and the conclusion
  // generalised to every `xRec` site. Follow-up probes measured `differ=YES` for field
  // `OnValidate` and for `OnRename`, so the operator ships scoped to exactly those two trigger
  // kinds — and it must NOT re-acquire `OnModify`, which stays measured-equivalent.
  "lethal.swap-rec-xrec",
  // R136: FindFirst <-> FindLast, both directions, one mutant per site. Cannot manufacture the
  // platform-kill class `swap-modify-flag`'s Insert/Delete extension can: both methods return the
  // same found-or-not-found answer over the same filtered set, so only which row loads changes.
  "lethal.swap-find-direction",
] as const;

describe("tier2Operators", () => {
  it("holds exactly the registered operators, in registration order", () => {
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
