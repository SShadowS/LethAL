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

// ————————————————————————————————————————————————————————————————————————
// R45: the baseline runs the WHOLE suite regardless of `--only`. Measured on Continia Document
// Output: baseline was 744.8s of a 953.8s run — 78% — executing all 1,246 discovered tests for a
// run scoped to one codeunit. Narrowing the TEST set is the lever, but it is the DANGEROUS
// direction: excluding the test that would have killed a mutant turns that mutant into a
// survivor, and a false survivor is the worst output this tool can produce (R29). So the
// narrowing refuses to match nothing, and the report carries a caveat.
// ————————————————————————————————————————————————————————————————————————
describe("discoverTests — test-set narrowing (R45)", () => {
  test("without narrowing, every discovered test is returned", async () => {
    const refs = await discoverTests(fixturesDir);
    expect(refs.length).toBeGreaterThan(2);
  });

  test("a glob keeps only tests from matching files", async () => {
    const refs = await discoverTests(fixturesDir, { only: ["SampleTests*"] });
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.file?.includes("SampleTests"))).toBe(true);
    // The counterweight: the excluded file's tests really are gone, not merely reordered.
    expect(refs.some((r) => r.file?.includes("MultipleCodeunits"))).toBe(false);
  });

  test("several patterns union", async () => {
    const refs = await discoverTests(fixturesDir, {
      only: ["SampleTests*", "MultipleCodeunits*"],
    });
    const all = await discoverTests(fixturesDir);
    expect(refs.length).toBe(all.length);
  });

  test("a pattern matching no test file throws, naming it", async () => {
    // Silently discovering zero tests would make every mutant a `no-coverage` or a survivor
    // depending on the fallback — a confident-looking run over nothing at all.
    await expect(discoverTests(fixturesDir, { only: ["NoSuchTests*"] })).rejects.toThrow(
      /NoSuchTests\*/,
    );
  });

  test("throws when ONE of several patterns matches nothing", async () => {
    await expect(discoverTests(fixturesDir, { only: ["SampleTests*", "Typo*"] })).rejects.toThrow(
      /Typo\*/,
    );
  });
});
