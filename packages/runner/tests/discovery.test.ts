import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { discoverTests } from "../src/discovery";
import { effectiveBuildSymbols } from "../src/preprocessor-symbols";

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

// ————————————————————————————————————————————————————————————————————————
// R79: a `codeunit <id> "Name"` shape occurring in PROSE — a comment, or a string literal —
// used to open a bogus section, and every `[Test]` after it in the file was dropped. The
// direction is silent under-reporting: the tests are simply absent, the baseline reports green,
// and the mutants they covered read `no-coverage`, which a reader takes to mean "nobody tests
// this". Found by accident on `fixtures/sandbox-data-tests` — 22 `[Test]` in source, 21
// discovered, no warning anywhere.
// ————————————————————————————————————————————————————————————————————————
const tempRoots: string[] = [];

async function discoverSource(name: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), "lethal-discovery-"));
  tempRoots.push(root);
  await writeFile(join(root, name), source, "utf8");
  return discoverTests(root);
}

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("discoverTests — a codeunit header shape in prose (R79)", () => {
  test("a `//` comment naming another codeunit does not drop the tests below it", async () => {
    const refs = await discoverSource(
      "Prose.Codeunit.al",
      `codeunit 79300 "Sales Suite"
{
    Subtype = Test;

    [Test]
    procedure AboveTheComment()
    begin
    end;

    // Exercises codeunit 50100 "Sales Post" through the posting routine.
    [Test]
    procedure BelowTheComment()
    begin
    end;
}
`,
    );
    expect(refs.map((r) => r.method)).toEqual(["AboveTheComment", "BelowTheComment"]);
  });

  test("a `/* */` comment naming another codeunit does not drop the tests below it", async () => {
    const refs = await discoverSource(
      "BlockProse.Codeunit.al",
      `codeunit 79301 "Block Suite"
{
    Subtype = Test;

    [Test]
    procedure AboveTheBlock()
    begin
    end;

    /* Regression guard for
       codeunit 50100 "Sales Post"
       which posts twice. */
    [Test]
    procedure BelowTheBlock()
    begin
    end;
}
`,
    );
    expect(refs.map((r) => r.method)).toEqual(["AboveTheBlock", "BelowTheBlock"]);
  });

  test("a string literal naming another codeunit does not drop the tests below it", async () => {
    const refs = await discoverSource(
      "Literal.Codeunit.al",
      `codeunit 79302 "Literal Suite"
{
    Subtype = Test;

    [Test]
    procedure AboveTheLiteral()
    var
        Msg: Text;
    begin
        Msg := 'codeunit 50100 "Sales Post" must be installed';
    end;

    [Test]
    procedure BelowTheLiteral()
    begin
    end;
}
`,
    );
    expect(refs.map((r) => r.method)).toEqual(["AboveTheLiteral", "BelowTheLiteral"]);
  });

  test("a commented-out `Subtype = Test` does not turn a helper codeunit into a test suite", async () => {
    // The same masking, in the other direction: prose must not ADD tests either, or a helper
    // codeunit's procedures get scheduled as tests that BC will refuse to run.
    const refs = await discoverSource(
      "Helper.Codeunit.al",
      `codeunit 79303 "Helper Suite"
{
    // Subtype = Test; — deliberately not a test codeunit any more.

    [Test]
    procedure NotReallyATest()
    begin
    end;
}
`,
    );
    expect(refs).toEqual([]);
  });

  test("refuses when a [Test] belongs to no codeunit section at all", async () => {
    // The sibling silent-loss shape: if a codeunit header does not parse, its tests belong to no
    // section and today they would simply be absent — the same direction as the comment bug.
    // A skipped codeunit (one with no `Subtype = Test;`) is NOT this: its tests are attributed,
    // so the guard stays silent on the `Helper Suite` case above.
    await expect(
      discoverSource(
        "Orphan.Codeunit.al",
        `[Test]
procedure OrphanTest()
begin
end;
`,
      ),
    ).rejects.toThrow(/lost 1 of 1 \[Test\] procedures in "Orphan\.Codeunit\.al"/);
  });
});

// ————————————————————————————————————————————————————————————————————————
// R403: a `[Test]` that exists only in an `#if` arm the test app's build compiles out was
// discovered anyway, and the run then asked for a method the build does not have (al-runner:
// baseline `error`; bcdev: R31's refusal). Arm-aware discovery evaluates each file's arms under
// the TEST app's derived symbol set and returns both lists.
// ————————————————————————————————————————————————————————————————————————
const R403_SHAPE = `codeunit 50140 "R403 Tests"
{
    Subtype = Test;

#if LETHALX
    [Test]
    procedure OnlyUnderX()
    begin
    end;
#endif

    [Test]
    procedure PlainDoubles()
    begin
    end;
}
`;

async function testDirWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r403-"));
  tempRoots.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text, "utf8");
  return root;
}

const methods = (refs: readonly { readonly method: string }[]) => refs.map((r) => r.method);

describe("discoverTests — the test app's #if arms (R403)", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("under [] OnlyUnderX is compiled out and recorded; under [LETHALX] both are kept", async () => {
    const dir = await testDirWith({ "R403.Codeunit.al": R403_SHAPE });
    const none = await discoverTests(dir, { buildSymbols: [] });
    expect(methods(none.filtered)).toEqual(["PlainDoubles"]);
    expect(methods(none.unfiltered)).toEqual(["OnlyUnderX", "PlainDoubles"]);
    expect(none.excluded).toEqual([
      {
        test: {
          codeunitId: 50140,
          codeunitName: "R403 Tests",
          method: "OnlyUnderX",
          file: "R403.Codeunit.al",
        },
        file: "R403.Codeunit.al",
        reason: "compiled-out",
      },
    ]);

    const x = await discoverTests(dir, { buildSymbols: ["LETHALX"] });
    expect(methods(x.filtered)).toEqual(["OnlyUnderX", "PlainDoubles"]);
    expect(methods(x.unfiltered)).toEqual(["OnlyUnderX", "PlainDoubles"]);
    expect(x.excluded).toEqual([]);
    expect(x.buildSymbols).toEqual(["LETHALX"]);
  });

  test("`#if not` is the mirror image", async () => {
    const dir = await testDirWith({
      "Not.Codeunit.al": R403_SHAPE.replace("#if LETHALX", "#if not LETHALX"),
    });
    expect(methods((await discoverTests(dir, { buildSymbols: [] })).filtered)).toEqual([
      "OnlyUnderX",
      "PlainDoubles",
    ]);
    expect(methods((await discoverTests(dir, { buildSymbols: ["LETHALX"] })).filtered)).toEqual([
      "PlainDoubles",
    ]);
  });

  test("a file's own #define is applied", async () => {
    const dir = await testDirWith({ "Def.Codeunit.al": `#define LETHALX\n${R403_SHAPE}` });
    expect(methods((await discoverTests(dir, { buildSymbols: [] })).filtered)).toEqual([
      "OnlyUnderX",
      "PlainDoubles",
    ]);
  });

  test("the test app.json's own symbols reach the set, through effectiveBuildSymbols", async () => {
    const dir = await testDirWith({
      "app.json": JSON.stringify({ preprocessorSymbols: ["LETHALX"] }),
      "R403.Codeunit.al": R403_SHAPE,
    });
    const symbols = await effectiveBuildSymbols(dir, [], undefined, { kind: "bcdev" });
    expect(symbols).toEqual(["LETHALX"]);
    const found = await discoverTests(dir, { buildSymbols: symbols });
    expect(methods(found.filtered)).toEqual(["OnlyUnderX", "PlainDoubles"]);
    expect(found.excluded).toEqual([]);
  });

  test("an undecided file (R402's s13) keeps every test and records each as undecided-kept", async () => {
    const s13 = `codeunit 50141 "R403 Undecided"
{
    Subtype = Test;

#if LETHALX
    [Test]
    procedure OnlyUnderX()
    begin
    end;
#endif

    [Test]
    procedure Looping()
    var
        A: Integer;
        B: Integer;
    begin
#if LETHALX
        while (B < 5)
#else
        while (A < 10)
#endif
        do begin
            A := A + 1;
            B := B + 1;
        end;
    end;
}
`;
    const dir = await testDirWith({ "S13.Codeunit.al": s13 });
    for (const symbols of [[], ["LETHALX"]]) {
      const found = await discoverTests(dir, { buildSymbols: symbols });
      expect(methods(found.filtered)).toEqual(["OnlyUnderX", "Looping"]);
      expect(found.excluded.map((e) => [e.test.method, e.reason])).toEqual([
        ["OnlyUnderX", "preproc-undecided-kept"],
        ["Looping", "preproc-undecided-kept"],
      ]);
      for (const e of found.excluded) expect(e.detail).toStartWith("marker-mismatch");
    }
  });

  test("offsets line up in a file with non-ASCII text, including characters outside the BMP", async () => {
    // Forty astral characters before the `#if`: under a mask that split by code points, the
    // `[Test]` offset came out 40 units early, before the inactive range, and OnlyUnderX was kept.
    const comment = `    // ${"\u{1F600}".repeat(40)} æøå\n    // '${"\u{1F600}".repeat(4)}'\n`;
    const dir = await testDirWith({
      "Wide.Codeunit.al": R403_SHAPE.replace("#if LETHALX", `${comment}#if LETHALX`),
    });
    const none = await discoverTests(dir, { buildSymbols: [] });
    expect(methods(none.filtered)).toEqual(["PlainDoubles"]);
    expect(none.excluded.map((e) => e.test.method)).toEqual(["OnlyUnderX"]);
    const x = await discoverTests(dir, { buildSymbols: ["LETHALX"] });
    expect(methods(x.filtered)).toEqual(["OnlyUnderX", "PlainDoubles"]);
  });

  test("--tests-only still narrows both lists", async () => {
    const dir = await testDirWith({
      "R403.Codeunit.al": R403_SHAPE,
      "Other.Codeunit.al": R403_SHAPE.replace("50140", "50142").replace("R403 Tests", "Other"),
    });
    const found = await discoverTests(dir, { only: ["R403*"], buildSymbols: [] });
    expect(found.unfiltered.every((r) => r.file === "R403.Codeunit.al")).toBe(true);
    expect(methods(found.filtered)).toEqual(["PlainDoubles"]);
  });

  test("without buildSymbols the pre-R403 shape is returned: every arm read", async () => {
    const dir = await testDirWith({ "R403.Codeunit.al": R403_SHAPE });
    expect(methods(await discoverTests(dir))).toEqual(["OnlyUnderX", "PlainDoubles"]);
  });
});
