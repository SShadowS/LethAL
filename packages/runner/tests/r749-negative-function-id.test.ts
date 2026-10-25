import { describe, expect, it } from "bun:test";
import { staleDependencyMember, staleTargetMember } from "../src/stale-test-app";

/**
 * R749: BC's function id in the stale-member sentence is SIGNED, measured on bc2 (R-741,
 * `/coord/handoff/R-741/measure.md`): the page member's failure read "Function ID -935096164 was
 * called." Before R749 the anchor took only digits, so a negative id matched neither R738's nor
 * R740's refusal and the test left the green set silently.
 */

const MEASURED_PAGE =
  "Function ID -935096164 was called. The object with ID 93861 does not have a member with that ID.\n" +
  "R741 Tests(CodeUnit 93870).TestPageAnswer line 4 - R741 Probe Tests by LethAL Probe version 1.0.0.1;";
const TARGET = new Set([93860, 93861]);

describe("a negative function id (R749)", () => {
  it("the measured message on a target object: that object id (R738)", () => {
    // red when the anchor reads only unsigned function ids
    expect(staleTargetMember(MEASURED_PAGE, TARGET)).toBe(93861);
  });

  it("the same message on a non-target object: a dependency member with its frame (R740)", () => {
    // red when the anchor reads only unsigned function ids
    expect(staleDependencyMember(MEASURED_PAGE, new Set([50000]))).toEqual({
      objectId: 93861,
      frame:
        "R741 Tests(CodeUnit 93870).TestPageAnswer line 4 - R741 Probe Tests by LethAL Probe version 1.0.0.1",
    });
  });

  it("a sign anywhere but directly before the digits does not match", () => {
    const near = (fn: string) =>
      `Function ID ${fn} was called. The object with ID 93861 does not have a member with that ID.`;
    // red when the sign is optional in a looser form (spaced, doubled, plus, or inside the number)
    for (const fn of ["- 935096164", "--935096164", "+935096164", "935-096164", "-"])
      expect(staleTargetMember(near(fn), TARGET)).toBeUndefined();
  });
});
