import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "@lethal/engine";
import { runConformance } from "@lethal/operator-sdk";
import { tier1Operators } from "../src";
import { shiftInteger } from "../src/shift-integer";

/**
 * `lethal.shift-integer` is SPIKED and RECOMMENDED but deliberately NOT registered — R159, see
 * `docs/superpowers/specs/2026-08-26-r159-shift-integer-spike.md`. The build owes it two
 * `sandbox-data` fixture arms first: a loop-condition refusal witness, and an assertion-raised kill
 * so R121's screen separates on it.
 *
 * Which leaves the operator in a state nothing else in this package is in: `tests/conformance.test.ts`
 * enumerates `tier1Operators`, so an unregistered operator's six cases would never run, and a later
 * change to `mutate-helpers` or `ALNodeKind` could rot the spike's proof with no test going red. The
 * file would still be there and would still look measured. This runs them directly.
 *
 * DELETE this file when the build registers the operator — `conformance.test.ts` covers it then, and
 * the assertion below is what enforces the swap rather than leaving both to run forever.
 */
describe("shift-integer (spiked, unregistered)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("passes its conformance suite even though nothing registers it", async () => {
    const result = await runConformance(shiftInteger);
    if (!result.allPassed) {
      console.error(JSON.stringify(result.failures, null, 2));
    }
    expect(result.allPassed).toBe(true);
  });

  it("is still unregistered, so this file is still the only thing running those cases", () => {
    // Reverse the guard: once the build registers it, `conformance.test.ts` runs the same six cases
    // and this file is redundant. Failing HERE is the signal to delete it, not to relax the check.
    const registered = tier1Operators.some((op) => op.name === shiftInteger.name);
    expect(registered).toBe(false);
  });
});
