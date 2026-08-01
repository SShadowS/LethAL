import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
