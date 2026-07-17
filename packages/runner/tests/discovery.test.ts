import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTests } from "../src/discovery";

// Get the fixtures path (account for running from dist/tests vs source tests)
const fixturesDir = import.meta.dir.includes("dist")
  ? join(import.meta.dir, "../..", "tests", "fixtures", "al")
  : join(import.meta.dir, "fixtures", "al");

describe("discoverTests", () => {
  test("finds [Test] methods in Subtype=Test codeunits, skips helpers and handlers", async () => {
    const refs = await discoverTests(fixturesDir);
    expect(refs).toEqual([
      { codeunitId: 79210, codeunitName: "First Suite", method: "FirstTest" },
      { codeunitId: 79211, codeunitName: "Second Suite", method: "SecondTest" },
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" },
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "DiscountCapped" },
    ]);
  });

  test("correctly attributes methods to each codeunit when multiple codeunits in one file", async () => {
    const refs = await discoverTests(fixturesDir);
    // Verify that FirstTest is attributed to 79210, not to a previous codeunit
    const firstSuite = refs.filter((r) => r.codeunitId === 79210);
    expect(firstSuite).toEqual([
      { codeunitId: 79210, codeunitName: "First Suite", method: "FirstTest" },
    ]);
    // Verify that SecondTest is attributed to 79211
    const secondSuite = refs.filter((r) => r.codeunitId === 79211);
    expect(secondSuite).toEqual([
      { codeunitId: 79211, codeunitName: "Second Suite", method: "SecondTest" },
    ]);
    // Verify that ThirdTest (without Subtype=Test) is not included
    const thirdSuite = refs.filter((r) => r.codeunitId === 79212);
    expect(thirdSuite).toEqual([]);
  });
});
