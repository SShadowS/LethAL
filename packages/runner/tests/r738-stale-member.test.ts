import { describe, expect, it } from "bun:test";
import { describeStaleTestApp, staleTargetMember } from "../src/stale-test-app";

/**
 * R738: BC's run-time answer when a test calls a member the target no longer has, measured on bc2
 * (R-738, `/coord/handoff/R-738/measure.md`) for a REMOVED member and for a changed SIGNATURE: the
 * same wording, naming the target's object id. Matched structurally (the object id, then "does
 * not have a member"), refused only for one of the target's own object ids.
 */

const MEASURED =
  "Function ID 1933812373 was called. The object with ID 93790 does not have a member with that ID.\n" +
  "R738 Tests(CodeUnit 93800).TestAnswer line 2 - R738 Probe Tests by LethAL Probe version 1.0.0.1;" +
  "Test Runner - Mgt(CodeUnit 130454).RunTests line 26 - Test Runner by Microsoft version 28.4.53241.56646;";
const TARGET = new Set([93790, 93791]);

describe("staleTargetMember (R738)", () => {
  it("the measured message on a target object: that object id", () => {
    // red when the reader does not match BC's measured wording
    expect(staleTargetMember(MEASURED, TARGET)).toBe(93790);
  });

  it("the same wording on an object the target does not declare: undefined", () => {
    // red when any object id is read as the target's
    expect(staleTargetMember(MEASURED, new Set([50000]))).toBeUndefined();
  });

  it("a genuine failure, and a near-miss wording, are not stale members", () => {
    expect(
      staleTargetMember("genuine failure\nR738 Tests(CodeUnit 93800).TestFails line 2", TARGET),
    ).toBeUndefined();
    // red when "does not have a member" alone matches without BC's object-id sentence
    expect(
      staleTargetMember("The record does not have a member with that ID in object 93790.", TARGET),
    ).toBeUndefined();
    // red when the text after the object id is not required (a different BC error naming the id)
    expect(
      staleTargetMember("The object with ID 93790 could not be found.", TARGET),
    ).toBeUndefined();
    expect(staleTargetMember(undefined, TARGET)).toBeUndefined();
  });

  it("only the FIRST line (BC's message) is read, never the call stack", () => {
    // a test whose own message is unrelated, with BC's sentence quoted later in the stack text
    const quoted = `genuine failure\nsee: The object with ID 93790 does not have a member with that ID.`;
    // red when the whole text (stack included) is searched
    expect(staleTargetMember(quoted, TARGET)).toBeUndefined();
  });

  it("anchored to BC's measured start: a test's own message quoting the sentence is not read", () => {
    const asserted =
      "Assert.AreEqual failed. Expected: 1. Actual: The object with ID 93790 does not have a member with that ID.";
    // red when the pattern is found anywhere on the first line instead of at its measured start
    expect(staleTargetMember(asserted, TARGET)).toBeUndefined();
  });

  it("the found-0 path is untouched: a stale member is not a missing method", () => {
    expect(describeStaleTestApp(MEASURED)).toBeUndefined();
  });
});
