import { describe, expect, it } from "bun:test";
import {
  StaleDependencyMemberError,
  staleDependencyMember,
  staleTargetMember,
} from "../src/stale-test-app";

/**
 * R740: BC's stale-member sentence naming a DEPENDENCY's object (measured on bc2, R-740: a library
 * upgraded through altool under a tests app that was not recompiled). Same anchoring as R738; a
 * target object still belongs to R738.
 */

const MEASURED =
  "Function ID 1425126407 was called. The object with ID 93820 does not have a member with that ID.\n" +
  "R740 Tests(CodeUnit 93840).TestLib line 2 - R740 Probe Tests by LethAL Probe version 1.0.0.1;" +
  "Test Runner - Mgt(CodeUnit 130454).RunTests line 26 - Test Runner by Microsoft version 28.4.53241.56646;";
const TARGET = new Set([93830]);

describe("staleDependencyMember (R740)", () => {
  it("the measured message on a NON-target object: that id and the first stack frame", () => {
    // red when a non-target object id is not read
    expect(staleDependencyMember(MEASURED, TARGET)).toEqual({
      objectId: 93820,
      frame:
        "R740 Tests(CodeUnit 93840).TestLib line 2 - R740 Probe Tests by LethAL Probe version 1.0.0.1",
    });
  });

  it("a TARGET object is R738's, not this one", () => {
    // red when a target id is also read as a dependency's
    expect(staleDependencyMember(MEASURED, new Set([93820]))).toBeUndefined();
    expect(staleTargetMember(MEASURED, new Set([93820]))).toBe(93820);
  });

  it("a genuine failure, an Assert quoting the sentence, and the call stack are not read", () => {
    expect(
      staleDependencyMember("genuine failure\nR740 Tests(CodeUnit 93840).TestFails line 2", TARGET),
    ).toBeUndefined();
    // red when the sentence is matched anywhere on the first line, not at BC's measured start
    expect(
      staleDependencyMember(
        "Assert.AreEqual failed. Expected: 1. Actual: The object with ID 93820 does not have a member with that ID.",
        TARGET,
      ),
    ).toBeUndefined();
    // red when the stack text is searched
    expect(
      staleDependencyMember(
        "genuine failure\nFunction ID 1 was called. The object with ID 93820 does not have a member with that ID.",
        TARGET,
      ),
    ).toBeUndefined();
  });

  it("the refusal names the tests, the object and the calling frame, with a neutral remedy", () => {
    const err = new StaleDependencyMemberError([
      {
        name: "R740 Tests.TestLib",
        objectId: 93820,
        frame:
          "R740 Tests(CodeUnit 93840).TestLib line 2 - R740 Probe Tests by LethAL Probe version 1.0.0.1",
      },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.staleTests).toEqual(["R740 Tests.TestLib"]);
    expect(err.message).toContain("93820");
    expect(err.message).toContain("R740 Tests(CodeUnit 93840).TestLib line 2");
    expect(err.message).toContain("--tests-only");
    // red when the remedy blames the target (that is R738's case, not this one)
    expect(err.message).not.toContain("target build");
  });
});
