import { describe, expect, test } from "bun:test";
import { selectRoutedTests } from "../src/testpage-router";

const REFUSAL =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
  "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";

const always = () => true;
const never = () => false;

describe("selectRoutedTests (R69 §3.1)", () => {
  test("routes a fence-refused test that passes gate 2", () => {
    const routed = selectRoutedTests(
      [{ codeunitName: "T", method: "OpensPage", failureMessage: REFUSAL }],
      always,
    );
    expect(routed.map((r) => r.method)).toEqual(["OpensPage"]);
  });

  // Gate 2 is not optional: a test failing on BOTH paths is broken, and routing it would build a
  // green set from tests that never passed anywhere.
  test("does NOT route a fence-refused test that also fails on the client-services path", () => {
    expect(
      selectRoutedTests(
        [{ codeunitName: "T", method: "OpensPage", failureMessage: REFUSAL }],
        never,
      ),
    ).toEqual([]);
  });

  test("does not route a test that failed for an ordinary reason", () => {
    const baseline = [
      { codeunitName: "T", method: "Broken", failureMessage: "Assert.AreEqual failed" },
    ];
    expect(selectRoutedTests(baseline, always)).toEqual([]);
  });

  test("does not route a test that passed on the fence", () => {
    expect(selectRoutedTests([{ codeunitName: "T", method: "Green" }], always)).toEqual([]);
  });

  // §3.1: gate 1 is a diagnosis regex promoted to a router. The quoted evidence is reported so a
  // reader can overrule the routing decision, exactly as R35's design lets them overrule its note.
  test("carries the quoted gate-1 evidence so a reader can overrule the routing", () => {
    const routed = selectRoutedTests(
      [{ codeunitName: "T", method: "OpensPage", failureMessage: REFUSAL }],
      always,
    );
    expect(routed[0]?.gate1Evidence).toContain("CreateNavTestService");
  });
});
