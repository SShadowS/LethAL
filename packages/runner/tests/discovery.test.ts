import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTests } from "../src/discovery";

// Get the fixtures path (account for running from dist/tests vs source tests)
const fixturesDir = import.meta.dir.includes("dist")
  ? join(import.meta.dir, "../..", "tests", "fixtures", "al")
  : join(import.meta.dir, "fixtures", "al");

// `file` is asserted, not ignored: it is what lets a report turn a survivor's covering test
// (a qualified `Codeunit.method`) into a path someone can open, so a discovery that silently
// stopped populating it would quietly cost every consumer a project-wide grep.
describe("discoverTests", () => {
  test("finds [Test] methods in Subtype=Test codeunits, skips helpers and handlers", async () => {
    const refs = await discoverTests(fixturesDir);
    expect(refs).toEqual([
      {
        codeunitId: 79210,
        codeunitName: "First Suite",
        method: "FirstTest",
        file: "MultipleCodeunits.Codeunit.al",
      },
      {
        codeunitId: 79211,
        codeunitName: "Second Suite",
        method: "SecondTest",
        file: "MultipleCodeunits.Codeunit.al",
      },
      {
        codeunitId: 79100,
        codeunitName: "Sandbox Tests",
        method: "PostingUpdatesTotal",
        file: "SampleTests.Codeunit.al",
      },
      {
        codeunitId: 79100,
        codeunitName: "Sandbox Tests",
        method: "DiscountCapped",
        file: "SampleTests.Codeunit.al",
      },
    ]);
  });

  test("correctly attributes methods to each codeunit when multiple codeunits in one file", async () => {
    const refs = await discoverTests(fixturesDir);
    // Verify that FirstTest is attributed to 79210, not to a previous codeunit
    const firstSuite = refs.filter((r) => r.codeunitId === 79210);
    expect(firstSuite).toEqual([
      {
        codeunitId: 79210,
        codeunitName: "First Suite",
        method: "FirstTest",
        file: "MultipleCodeunits.Codeunit.al",
      },
    ]);
    // Verify that SecondTest is attributed to 79211
    const secondSuite = refs.filter((r) => r.codeunitId === 79211);
    expect(secondSuite).toEqual([
      {
        codeunitId: 79211,
        codeunitName: "Second Suite",
        method: "SecondTest",
        file: "MultipleCodeunits.Codeunit.al",
      },
    ]);
    // Verify that ThirdTest (without Subtype=Test) is not included
    const thirdSuite = refs.filter((r) => r.codeunitId === 79212);
    expect(thirdSuite).toEqual([]);
  });
});
