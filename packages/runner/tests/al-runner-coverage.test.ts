import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import {
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  alRunnerCoverageSupport,
  buildAlRunnerCoverageIndex,
  parseCobertura,
} from "../src/al-runner-coverage";
import type { ServerPerTestCoverage } from "../src/al-runner-server";
import { coverageRefusedObjects } from "../src/line-map";
import { buildCoverageIndex, coverageFilter } from "../src/selection";

/**
 * Verbatim al-runner 2.11.0 output, captured by running
 *
 *   al-runner --coverage --coverage-out cov.xml fixtures/sandbox-app fixtures/sandbox-tests
 *
 * and kept verbatim BECAUSE it is the producer's real shape rather than one invented to suit the
 * parser. `SandboxPricing` at `line-rate 0.0000` with every line at `hits="0"` is the case this
 * whole feature exists for: those are the four mutants `itest:bcdev` calls `no-coverage` and
 * `itest:alrunner` currently calls `survived`.
 */
const REAL_COBERTURA = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage line-rate="0.6111" branch-rate="0" lines-covered="11" lines-valid="18" version="1.0" timestamp="1788960915">
  <sources>
    <source>.</source>
  </sources>
  <packages>
    <package name="al-source" line-rate="0.6111" branch-rate="0">
      <classes>
        <class name="SandboxLogic.Codeunit" filename="fixtures/sandbox-app/src/SandboxLogic.Codeunit.al" line-rate="0.8571" branch-rate="0">
          <lines>
            <line number="5" hits="3" />
            <line number="10" hits="1" />
            <line number="11" hits="0" />
            <line number="12" hits="1" />
          </lines>
        </class>
        <class name="SandboxPricing.Codeunit" filename="fixtures/sandbox-app/src/SandboxPricing.Codeunit.al" line-rate="0.0000" branch-rate="0">
          <lines>
            <line number="5" hits="0" />
            <line number="6" hits="0" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

const scratchDirs: string[] = [];
afterAll(async () => {
  for (const d of scratchDirs) await rm(d, { recursive: true, force: true });
});

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-cov-"));
  scratchDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, body, "utf8");
  }
  return dir;
}

/** Each indexed file's objects, `(type, id)` only, in file order. */
function identities(
  index: Awaited<ReturnType<typeof buildAlRunnerCoverageIndex>>,
): { objectType: string; objectId: number }[][] {
  return [...index.byFile.values()].map((es) =>
    es.map((e) => ({ objectType: e.objectType, objectId: e.objectId })),
  );
}

const ONE_OBJECT = `codeunit 79150 "Probe One"
{
    procedure Reached(): Integer
    begin
        exit(11);
    end;

    procedure NotReached(): Integer
    begin
        exit(22);
    end;
}
`;

describe("parseCobertura", () => {
  test("reads every line of every class from al-runner's real output", () => {
    const lines = parseCobertura(REAL_COBERTURA);
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => l.file.endsWith("SandboxPricing.Codeunit.al"))).toEqual([
      { file: "fixtures/sandbox-app/src/SandboxPricing.Codeunit.al", line: 5, hits: 0 },
      { file: "fixtures/sandbox-app/src/SandboxPricing.Codeunit.al", line: 6, hits: 0 },
    ]);
  });

  test("keeps hits, so an unhit line stays distinguishable from an absent one", () => {
    const lines = parseCobertura(REAL_COBERTURA);
    const logic = lines.filter((l) => l.file.endsWith("SandboxLogic.Codeunit.al"));
    expect(logic.map((l) => [l.line, l.hits])).toEqual([
      [5, 3],
      [10, 1],
      [11, 0],
      [12, 1],
    ]);
  });

  test("returns nothing for output carrying no classes", () => {
    expect(parseCobertura("<coverage></coverage>")).toEqual([]);
  });
});

describe("buildAlRunnerCoverageIndex", () => {
  test("indexes a single-object file and reports no multi-object files", async () => {
    const dir = await bundle({ "src/One.Codeunit.al": ONE_OBJECT });
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual([]);
    expect(identities(index)).toEqual([[{ objectType: "Codeunit", objectId: 79150 }]]);
  });

  test("NAMES a file declaring two objects, which is what disables coverage for the run", async () => {
    // The upstream defect this guards, as of R383: al-runner v2.12.0-main.c39ad5de reports every
    // object after a file's first at (previous object's end in the SOURCE) + (distance in the
    // INSTRUMENTED text), so a later object's lines land in the wrong object. Before that (2.11.0,
    // #3713, fixed upstream) it lost those objects outright.
    const two = `${ONE_OBJECT}\ncodeunit 79151 "Probe Two"\n{\n    procedure P()\n    begin\n    end;\n}\n`;
    const dir = await bundle({ "src/Two.Codeunit.al": two });
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual(["src/Two.Codeunit.al"]);
    // And it is not indexed, so nothing can accidentally resolve against half of it.
    expect(index.byFile.size).toBe(0);
  });

  test("R383: admitMultiObjectFiles (infrastructure, tests only) indexes both objects, in order", async () => {
    const two = `${ONE_OBJECT}\ncodeunit 79151 "Probe Two"\n{\n    procedure P()\n    begin\n    end;\n}\n`;
    const dir = await bundle({ "src/Two.Codeunit.al": two });
    const index = await buildAlRunnerCoverageIndex(dir, { admitMultiObjectFiles: true });
    expect(index.multiObjectFiles).toEqual(["src/Two.Codeunit.al"]);
    expect(identities(index)).toEqual([
      [
        { objectType: "Codeunit", objectId: 79150 },
        { objectType: "Codeunit", objectId: 79151 },
      ],
    ]);
    expect(index.lineMap.declares("Codeunit", 79151)).toBe(true);
  });
});

describe("alRunnerCoverageFrom", () => {
  test("an unhit line produces NO entry, which is what makes no-coverage real", async () => {
    const dir = await bundle({ "src/One.Codeunit.al": ONE_OBJECT });
    const index = await buildAlRunnerCoverageIndex(dir);
    const map = alRunnerCoverageFrom([{ file: "src/One.Codeunit.al", line: 5, hits: 0 }], index);
    expect(map.entries).toEqual([]);
  });

  test("a hit line resolves to its object AND its procedure", async () => {
    const dir = await bundle({ "src/One.Codeunit.al": ONE_OBJECT });
    const index = await buildAlRunnerCoverageIndex(dir);
    const map = alRunnerCoverageFrom([{ file: "src/One.Codeunit.al", line: 5, hits: 1 }], index);
    expect(map.granularity).toBe("line");
    expect(map.entries).toEqual([
      { objectType: "Codeunit", objectId: 79150, procedure: "Reached", line: 5 },
    ]);
  });

  test("distinguishes the two procedures of one object, so selection can be narrow", async () => {
    const dir = await bundle({ "src/One.Codeunit.al": ONE_OBJECT });
    const index = await buildAlRunnerCoverageIndex(dir);
    const map = alRunnerCoverageFrom(
      [
        { file: "src/One.Codeunit.al", line: 5, hits: 1 },
        { file: "src/One.Codeunit.al", line: 10, hits: 1 },
      ],
      index,
    );
    expect(map.entries.map((e) => e.procedure)).toEqual(["Reached", "NotReached"]);
  });

  test("matches an ABSOLUTE Cobertura path against a project-relative index", async () => {
    // al-runner echoes whatever path it was given, and LethAL hands it an absolute bundle dir, so
    // the tail match is what makes the lookup work at all rather than silently finding nothing.
    const dir = await bundle({ "src/One.Codeunit.al": ONE_OBJECT });
    const index = await buildAlRunnerCoverageIndex(dir);
    const map = alRunnerCoverageFrom(
      [{ file: "C:/somewhere/else/instrumented/active/src/One.Codeunit.al", line: 5, hits: 1 }],
      index,
    );
    expect(map.entries).toHaveLength(1);
    expect(map.entries[0]?.objectId).toBe(79150);
  });

  test("skips a row for a file this bundle does not declare", async () => {
    const dir = await bundle({ "src/One.Codeunit.al": ONE_OBJECT });
    const index = await buildAlRunnerCoverageIndex(dir);
    const map = alRunnerCoverageFrom(
      [{ file: "fixtures/sandbox-tests/src/SandboxTests.Codeunit.al", line: 11, hits: 1 }],
      index,
    );
    expect(map.entries).toEqual([]);
  });

  test("end to end on al-runner's real output: Logic is covered, Pricing is not", async () => {
    const dir = await bundle({
      "fixtures/sandbox-app/src/SandboxLogic.Codeunit.al": ONE_OBJECT,
      "fixtures/sandbox-app/src/SandboxPricing.Codeunit.al": `codeunit 79151 "Probe Pricing"
{
    procedure Never(): Integer
    begin
        exit(1);
    end;
}
`,
    });
    const index = await buildAlRunnerCoverageIndex(dir);
    const map = alRunnerCoverageFrom(parseCobertura(REAL_COBERTURA), index);
    const objects = new Set(map.entries.map((e) => e.objectId));
    expect(objects.has(79150)).toBe(true);
    // The whole point: every Pricing line came back hits="0", so it contributes NO evidence and
    // its mutants are no-coverage rather than survived.
    expect(objects.has(79151)).toBe(false);
  });
});

/** R298 repros, hand-written. */
const R298_BODY = (name: string): string => `{
    procedure ${name}()
    var
        L: Integer;
    begin
        L := 1;
        Message('%1', L);
    end;
}
`;
const R298_TWO_ARM = `#if CLEAN27
codeunit 50103 "Repro B2"
${R298_BODY("AIf")}#else
codeunit 50103 "Repro B2"
${R298_BODY("AElse")}#endif
`;
const R298_MIXED = `codeunit 50104 Plain
${R298_BODY("P")}#if not CLEAN27
codeunit 50105 Wrapped
${R298_BODY("W")}#endif
`;
const R298_PLAIN = `codeunit 50107 Other
${R298_BODY("R")}`;
/** R383 r3: `#if`-alternated headers over ONE shared body, `preproc_split_declaration`. */
const R383_SPLIT = `#if FEATURE
codeunit 50108 "Split B"
#else
codeunit 50108 "Split B"
#endif
${R298_BODY("Q")}`;
/** R-300b: a two-arm wrapper is a shape al-runner is not admitted on, named as such. */
const R298_REFUSED =
  "[lethal] coverage refused for Codeunit:50103 (src/B2.Codeunit.al): its file holds a #if object wrapper of a shape not measured on al-runner (R300). Its mutants read no-coverage.";

describe("R298: a file holding a #if-wrapped object is refused whole", () => {
  test("the wrapped file is named in refusedFiles and indexed nowhere; the plain file is indexed", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await bundle({
        "src/B2.Codeunit.al": R298_TWO_ARM,
        "src/Other.Codeunit.al": R298_PLAIN,
      });
      const index = await buildAlRunnerCoverageIndex(dir);
      expect(index.refusedFiles).toEqual(["src/B2.Codeunit.al"]);
      expect(index.multiObjectFiles).toEqual([]);
      expect([...index.byFile.keys()]).toEqual(["src/other.codeunit.al"]);
      expect(index.lineMap.declares("Codeunit", 50103)).toBe(false);
      const said = warn.mock.calls.map((c) => String(c[0]));
      expect(said).toEqual([R298_REFUSED]);

      const cobertura = alRunnerCoverageFrom(
        [
          { file: "src/B2.Codeunit.al", line: 7, hits: 1 },
          { file: "src/B2.Codeunit.al", line: 18, hits: 1 },
          { file: "src/Other.Codeunit.al", line: 6, hits: 1 },
        ],
        index,
      );
      expect(cobertura.entries).toEqual([
        { objectType: "Codeunit", objectId: 50107, procedure: "R", line: 6 },
      ]);
      const server = alRunnerCoverageFromServer(
        {
          test: "Codeunit50140.T",
          coverage: [
            { file: "src/B2.Codeunit.al", statements: [{ line: 7, hits: 1, scope: "AIf" }] },
            { file: "src/Other.Codeunit.al", statements: [{ line: 6, hits: 1, scope: "R" }] },
          ],
        },
        index,
      );
      expect(server.entries).toEqual([
        { objectType: "Codeunit", objectId: 50107, procedure: "R", line: 6 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a two-arm wrapped object counts as ONE object for the multi-object guard", async () => {
    const dir = await bundle({ "src/B2.Codeunit.al": R298_TWO_ARM });
    // R387: listed as wrapped, by the index's own rule, so the CLI can fall back to no coverage.
    // `supported` still answers the multi-object question alone, as before.
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: true,
      multiObjectFiles: [],
      wrappedObjectFiles: ["src/B2.Codeunit.al"],
    });
  });

  test("a bare object plus a wrapped one IS two objects for the guard", async () => {
    const dir = await bundle({ "src/Mixed.Codeunit.al": R298_MIXED });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: false,
      multiObjectFiles: ["src/Mixed.Codeunit.al"],
      wrappedObjectFiles: ["src/Mixed.Codeunit.al"],
    });
  });

  test("R383 r2: an enum then a codeunit IS two objects: the guard refuses and the index skips", async () => {
    // The codeunit is the file's SECOND object, which is the one al-runner reports in the wrong
    // frame, though the enum has no coverage identity.
    const src = `enum 50120 E\n{\n    value(0; A) { }\n}\n${R298_PLAIN}`;
    const dir = await bundle({ "src/EnumThenCodeunit.Codeunit.al": src });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: false,
      multiObjectFiles: ["src/EnumThenCodeunit.Codeunit.al"],
      wrappedObjectFiles: [],
    });
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual(["src/EnumThenCodeunit.Codeunit.al"]);
    expect(index.byFile.size).toBe(0);
  });

  test("R383 r2 ruling: a codeunit then a permission set is ADMITTED: the guard keeps coverage and the index resolves the codeunit", async () => {
    const src = `${R298_PLAIN}permissionset 50122 PS\n{\n    Assignable = true;\n}\n`;
    const dir = await bundle({ "src/WithPerms.Codeunit.al": src });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: true,
      multiObjectFiles: [],
      wrappedObjectFiles: [],
    });
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual([]);
    expect(
      alRunnerCoverageFrom([{ file: "src/WithPerms.Codeunit.al", line: 6, hits: 1 }], index)
        .entries,
    ).toEqual([{ objectType: "Codeunit", objectId: 50107, procedure: "R", line: 6 }]);
  });

  test("R383 r3: a codeunit then a #if split-header codeunit IS two objects: guard refuses, index skips, no hit resolves on either transport", async () => {
    // Line 7 is `L := 1;` in Other.R. al-runner reports a later object's lines shifted up into
    // the first object's (r383-real-frame), so a hit of Split B's can arrive as line 7.
    const dir = await bundle({ "src/Split.Codeunit.al": `${R298_PLAIN}${R383_SPLIT}` });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: false,
      multiObjectFiles: ["src/Split.Codeunit.al"],
      wrappedObjectFiles: [],
    });
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual(["src/Split.Codeunit.al"]);
    expect(index.byFile.size).toBe(0);
    expect(
      alRunnerCoverageFrom([{ file: "src/Split.Codeunit.al", line: 7, hits: 1 }], index).entries,
    ).toEqual([]);
    const server: ServerPerTestCoverage = {
      test: "Codeunit50140.T",
      coverage: [{ file: "src/Split.Codeunit.al", statements: [{ line: 7, hits: 1, scope: "Q" }] }],
    };
    expect(alRunnerCoverageFromServer(server, index).entries).toEqual([]);
  });

  test("R383 r3: a split-header object FIRST is the first object: a code-free permission set after it is admitted, a codeunit after it is refused", async () => {
    const perms = "permissionset 50122 PS\n{\n    Assignable = true;\n}\n";
    const dir = await bundle({
      "src/SplitFirst.Codeunit.al": `${R383_SPLIT}${perms}`,
      "src/SplitThenPlain.Codeunit.al": `${R383_SPLIT}${R298_PLAIN}`,
    });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: false,
      multiObjectFiles: ["src/SplitThenPlain.Codeunit.al"],
      wrappedObjectFiles: [],
    });
    // The split object has no coverage identity, so the admitted file has no entry to resolve.
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.byFile.size).toBe(0);
  });

  test("R383 r3: a #if wrapper holding only a split-header object holds an object (R298 refuses the file)", async () => {
    const dir = await bundle({ "src/W.Codeunit.al": `#if OUTER\n${R383_SPLIT}#endif\n` });
    expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual(["src/W.Codeunit.al"]);
  });

  test("R383 r3: two separate multiline interfaces whose header keys collide stay two objects, so the second one's procedure body refuses the file", async () => {
    const i1 = 'interface\n    "I1"\n{\n    procedure P();\n}\n';
    const i2 = 'interface\n    "I2"\n{\n    procedure P()\n    begin\n    end;\n}\n';
    const dir = await bundle({
      "src/Ifaces.Codeunit.al": `${R298_PLAIN}${i1}${i2}`,
      // Merging by key across the file would also fold I2 into a FIRST object I1 and admit this.
      "src/IfaceFirst.Codeunit.al": `${i1}enum 50120 E\n{\n    value(0; A) { }\n}\n${i2}`,
      // Genuine alternative arms ARE one object, and every arm is checked, not only the first.
      "src/IfaceArms.Codeunit.al": `${R298_PLAIN}#if X\n${i1}#else\n${i1.replace("procedure P();", "procedure P()\n    begin\n    end;")}#endif\n`,
    });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: false,
      multiObjectFiles: [
        "src/IfaceArms.Codeunit.al",
        "src/IfaceFirst.Codeunit.al",
        "src/Ifaces.Codeunit.al",
      ],
      wrappedObjectFiles: ["src/IfaceArms.Codeunit.al"],
    });
  });

  test("R387: a clean project lists no file in either list", async () => {
    const dir = await bundle({ "src/A.Codeunit.al": "codeunit 50100 A\n{\n}\n" });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: true,
      multiObjectFiles: [],
      wrappedObjectFiles: [],
    });
  });
});

describe("R298: a refused file's hits never fall through to a shorter path ending", () => {
  test("a hit on the refused src/Foo.Codeunit.al is not attributed to a root Foo.Codeunit.al", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await bundle({
        "src/Foo.Codeunit.al": R298_TWO_ARM,
        "Foo.Codeunit.al": R298_PLAIN,
      });
      const index = await buildAlRunnerCoverageIndex(dir);
      expect(index.refusedFiles).toEqual(["src/Foo.Codeunit.al"]);
      expect([...index.byFile.keys()]).toEqual(["foo.codeunit.al"]);
      const cobertura = alRunnerCoverageFrom(
        [
          { file: "C:/x/instrumented/active/src/Foo.Codeunit.al", line: 7, hits: 1 },
          { file: "C:/x/instrumented/active/Foo.Codeunit.al", line: 6, hits: 1 },
        ],
        index,
      );
      expect(cobertura.entries).toEqual([
        { objectType: "Codeunit", objectId: 50107, procedure: "R", line: 6 },
      ]);
      const server = alRunnerCoverageFromServer(
        {
          test: "Codeunit50140.T",
          coverage: [
            { file: "src/Foo.Codeunit.al", statements: [{ line: 7, hits: 1, scope: "AIf" }] },
            { file: "Foo.Codeunit.al", statements: [{ line: 6, hits: 1, scope: "R" }] },
          ],
        },
        index,
      );
      expect(server.entries).toEqual([
        { objectType: "Codeunit", objectId: 50107, procedure: "R", line: 6 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("R383 r2: a hit on a skipped multi-object src/Foo.Codeunit.al is not credited to a root Foo.Codeunit.al", async () => {
    // src/Foo holds two codeunits; its line 6 is inside 50151's `Reached`. The root Foo holds one
    // codeunit, 50107, whose line 6 is inside `R`. A fall-through credits 50107.R on both paths.
    const two = `codeunit 50151 "Foo A"\n${R298_BODY("Reached")}codeunit 50152 "Foo B"\n${R298_BODY("Other")}`;
    const dir = await bundle({ "src/Foo.Codeunit.al": two, "Foo.Codeunit.al": R298_PLAIN });
    const rows = [{ file: "C:/x/instrumented/active/src/Foo.Codeunit.al", line: 6, hits: 1 }];
    const server: ServerPerTestCoverage = {
      test: "Codeunit50140.T",
      coverage: [
        { file: "src/Foo.Codeunit.al", statements: [{ line: 6, hits: 1, scope: "Reached" }] },
      ],
    };
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual(["src/Foo.Codeunit.al"]);
    expect([...index.byFile.keys()]).toEqual(["foo.codeunit.al"]);
    expect(alRunnerCoverageFrom(rows, index).entries).toEqual([]);
    expect(alRunnerCoverageFromServer(server, index).entries).toEqual([]);
    // Admitted (tests only), the same hit resolves to src/Foo's own first object: the stop-list
    // does not block an index that was let in.
    const admittedIndex = await buildAlRunnerCoverageIndex(dir, { admitMultiObjectFiles: true });
    const own = [{ objectType: "Codeunit", objectId: 50151, procedure: "Reached", line: 6 }];
    expect(alRunnerCoverageFrom(rows, admittedIndex).entries).toEqual(own);
    expect(alRunnerCoverageFromServer(server, admittedIndex).entries).toEqual(own);
  });

  test("a file holding a wrapped ENUM is refused too, though an enum has no coverage identity", async () => {
    const src = `#if not CLEAN27\nenum 50120 E\n{\n    value(0; A) { }\n}\n#endif\n${R298_PLAIN}`;
    const dir = await bundle({ "src/E.Codeunit.al": src });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const index = await buildAlRunnerCoverageIndex(dir);
      expect(index.refusedFiles).toEqual(["src/E.Codeunit.al"]);
      expect(index.byFile.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * R298 end to end: a wrapped TABLE's trigger, through the al-runner conversion into selection.
 * R-300b: two arms, so al-runner still refuses it (a one-arm table alone in its file is admitted).
 */
const R298_WRAPPED_TABLE = `#if not CLEAN27
table 50110 "Wrapped T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    begin
        Message('x');
    end;
}
#else
table 50110 "Wrapped T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
}
#endif
`;

describe("R298 end to end (al-runner): a wrapped table trigger reads no-coverage, not all-green", () => {
  test("Cobertura and --server coverage, then selection: the trigger mutant is refused by name", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const files = { "src/W.Table.al": R298_WRAPPED_TABLE, "src/Other.Codeunit.al": R298_PLAIN };
      const dir = await bundle(files);
      const index = await buildAlRunnerCoverageIndex(dir);
      await initParser();
      const refused = coverageRefusedObjects(
        Object.entries(files).map(([path, text]) => ({ path, root: wrapRoot(parseAL(text)) })),
        "al-runner",
      );
      expect([...refused.keys()]).toEqual(["table:50110"]);
      const ref = { codeunitId: 50140, codeunitName: "Tests", method: "T" };
      const other = { codeunitId: 50140, codeunitName: "Tests", method: "U" };
      const coverages = [
        alRunnerCoverageFrom(
          [
            { file: "src/W.Table.al", line: 11, hits: 1 },
            { file: "src/Other.Codeunit.al", line: 6, hits: 1 },
          ],
          index,
        ),
        alRunnerCoverageFromServer(
          {
            test: "Codeunit50140.T",
            coverage: [
              { file: "src/W.Table.al", statements: [{ line: 11, hits: 1, scope: "OnInsert" }] },
              { file: "src/Other.Codeunit.al", statements: [{ line: 6, hits: 1, scope: "R" }] },
            ],
          },
          index,
        ),
      ];
      for (const coverage of coverages) {
        const cov = buildCoverageIndex([
          { ref, coverage },
          { ref: other, coverage: { granularity: "procedure", entries: [] } },
        ]);
        const base = {
          startIndex: 10,
          endIndex: 20,
          startLine: 11,
          operatorName: "empty-block",
          operatorVersion: "1.0.0",
          astHash: "h",
          originalText: "x",
          mutatedText: "",
        };
        const trigger = {
          ...base,
          mutantId: "M1",
          file: "src/W.Table.al",
          objectType: "table",
          codeunitId: 50110,
          codeunitName: "Wrapped T",
          procedureName: "",
          triggerName: "OnInsert",
        };
        const plain = {
          ...base,
          mutantId: "M2",
          file: "src/Other.Codeunit.al",
          objectType: "codeunit",
          codeunitId: 50107,
          codeunitName: "Other",
          procedureName: "R",
        };
        const split = coverageFilter(
          [trigger, plain],
          cov,
          [ref, other],
          undefined,
          false,
          refused,
        );
        expect(split.covered.has("M1")).toBe(false);
        expect(split.untargetedTriggerCount).toBe(0);
        expect(split.uncovered.map((m) => m.mutantId)).toEqual(["M1"]);
        expect(split.refused.get("M1")).toContain(
          "coverage refused for Table:50110 (src/W.Table.al)",
        );
        expect(split.covered.get("M2")).toEqual([ref]);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * R298, run 002 re-review I1: a BARE table, then a wrapped ENUM. The enum has no coverage
 * identity, so the multi-object guard counts ONE object and coverage stays on, while al-runner
 * refuses the whole file. Selection must refuse the table too (the union rule), or its trigger
 * mutants reach the all-green fallback.
 */
const R298_TABLE_THEN_WRAPPED_ENUM = `table 50110 "Plain T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    procedure Touch()
    begin
        Message('t');
    end;

    trigger OnInsert()
    begin
        Message('x');
    end;
}
#if not CLEAN27
enum 50120 E
{
    value(0; A) { }
}
#endif
`;

describe("R298 end to end (al-runner): a bare table before a wrapped enum reads no-coverage", () => {
  test("al-runner keeps coverage on and refuses the file; selection refuses every mutant of the table", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const files = {
        "src/T.Table.al": R298_TABLE_THEN_WRAPPED_ENUM,
        "src/Other.Codeunit.al": R298_PLAIN,
      };
      const dir = await bundle(files);
      // R383 r2 ruling: the enum is the later object, and it is code-free, so not multi-object.
      expect(await alRunnerCoverageSupport(dir)).toEqual({
        supported: true,
        multiObjectFiles: [],
        wrappedObjectFiles: ["src/T.Table.al"],
      });
      const index = await buildAlRunnerCoverageIndex(dir);
      expect(index.refusedFiles).toEqual(["src/T.Table.al"]);
      await initParser();
      const refused = coverageRefusedObjects(
        Object.entries(files).map(([path, text]) => ({ path, root: wrapRoot(parseAL(text)) })),
        "al-runner",
      );
      // R-300b: a bare object beside a wrapper is a shape al-runner is not measured on.
      const sentence =
        "coverage refused for Table:50110 (src/T.Table.al): its file holds a #if object wrapper of a shape not measured on al-runner (R300). Its mutants read no-coverage.";
      expect(refused.get("table:50110")).toBe(sentence);
      // al-runner names the table with the SAME sentence selection uses, not "inside, or after".
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(`[lethal] ${sentence}`);
      const ref = { codeunitId: 50140, codeunitName: "Tests", method: "T" };
      const other = { codeunitId: 50140, codeunitName: "Tests", method: "U" };
      const coverage = alRunnerCoverageFrom(
        [
          { file: "src/T.Table.al", line: 10, hits: 1 },
          { file: "src/T.Table.al", line: 15, hits: 1 },
          { file: "src/Other.Codeunit.al", line: 6, hits: 1 },
        ],
        index,
      );
      const cov = buildCoverageIndex([
        { ref, coverage },
        { ref: other, coverage: { granularity: "procedure", entries: [] } },
      ]);
      const base = {
        file: "src/T.Table.al",
        startIndex: 10,
        endIndex: 20,
        operatorName: "empty-block",
        operatorVersion: "1.0.0",
        astHash: "h",
        objectType: "table",
        codeunitId: 50110,
        codeunitName: "Plain T",
        originalText: "x",
        mutatedText: "",
      };
      const trigger = {
        ...base,
        mutantId: "M1",
        startLine: 15,
        procedureName: "",
        triggerName: "OnInsert",
      };
      const proc = { ...base, mutantId: "M2", startLine: 10, procedureName: "Touch" };
      const split = coverageFilter([trigger, proc], cov, [ref, other], undefined, false, refused);
      expect(split.covered.size).toBe(0);
      expect(split.untargetedTriggerCount).toBe(0);
      expect([...split.refused.keys()]).toEqual(["M1", "M2"]);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * R383 infrastructure: multi-object files, both transports, through an index built with
 * `admitMultiObjectFiles`. Production does NOT admit them (al-runner v2.12.0-main.c39ad5de reports
 * later objects in the wrong frame; see the real-frame evidence test), so these pin the resolver for
 * the day it does: every row resolved by POSITION (`resolveFileLine`) from the INSTRUMENTED file
 * frame before a procedure is looked up. The probe inputs below come from an UNinstrumented probe
 * app, where the compiled text is the source, so the frame defect cannot show in them.
 */
const admitted = (dir: string) => buildAlRunnerCoverageIndex(dir, { admitMultiObjectFiles: true });

/** The probe's own `two/app/Two.Codeunit.al`, verbatim. A: 1-11, B: 13-23 (bases 1 and 12). */
const PROBE_TWO = `codeunit 50100 ProbeA
{
    procedure RunA(): Integer
    var
        x: Integer;
    begin
        x := 1;
        x := x + 10;
        exit(x);
    end;
}

codeunit 50101 ProbeB
{
    procedure RunB(): Integer
    var
        y: Integer;
    begin
        y := 2;
        y := y + 20;
        exit(y);
    end;
}
`;

/** The probe's `s1.xml` (A+B in one file, a test calling only B), trimmed to its two classes. */
const PROBE_S1 = `<coverage line-rate="0.2857" branch-rate="0" lines-covered="4" lines-valid="14" version="1.0">
  <packages>
    <package name="al-source" line-rate="0.2857" branch-rate="0">
      <classes>
        <class name="Two.Codeunit" filename="two/app/Two.Codeunit.al" line-rate="0.5000" branch-rate="0">
          <lines>
            <line number="7" hits="0" />
            <line number="8" hits="0" />
            <line number="9" hits="0" />
            <line number="19" hits="1" />
            <line number="20" hits="1" />
            <line number="21" hits="1" />
          </lines>
        </class>
        <class name="T.Codeunit" filename="two/tests/T.Codeunit.al" line-rate="0.1250" branch-rate="0">
          <lines>
            <line number="19" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

/** The probe's `server-two.json`, test `OnlyB`, trimmed to the fields LethAL reads. */
const PROBE_SERVER_ONLY_B = {
  test: "Codeunit50110.OnlyB",
  coverage: [
    {
      file: "C:/Users/SShadowS/AppData/Local/Temp/claude/r383probe/two/app/Two.Codeunit.al",
      statements: [
        { id: 0, scope: "RunB", line: 19, hits: 1 },
        { id: 1, scope: "RunB", line: 20, hits: 1 },
        { id: 2, scope: "RunB", line: 21, hits: 1 },
      ],
    },
    {
      file: "C:/Users/SShadowS/AppData/Local/Temp/claude/r383probe/two/tests/T.Codeunit.al",
      statements: [{ id: 0, scope: "OnlyB", line: 19, hits: 1 }],
    },
  ],
};

/** What both transports must make of a test that reached B's three statements and nothing else. */
const ONLY_B = [8, 9, 10].map((line) => ({
  objectType: "Codeunit",
  objectId: 50101,
  procedure: "RunB",
  line,
}));

const variantsOf = (src: string): [string, string][] => [
  ["LF", src],
  ["CRLF", src.replace(/\n/g, "\r\n")],
  ["BOM", `\uFEFF${src}`],
];

/** A server record: every statement hit once, in one file. */
const serverOne = (
  file: string,
  statements: { scope?: string; line?: number }[],
  test = "Codeunit50140.T",
) => ({ test, coverage: [{ file, statements: statements.map((s) => ({ ...s, hits: 1 })) }] });

describe("R383: a multi-object file's rows resolve by position, on both transports", () => {
  test("Cobertura: the probe's s1.xml covers B.RunB only, at object-relative lines (LF, CRLF, BOM)", async () => {
    for (const [label, src] of variantsOf(PROBE_TWO)) {
      const index = await admitted(await bundle({ "two/app/Two.Codeunit.al": src }));
      expect([label, alRunnerCoverageFrom(parseCobertura(PROBE_S1), index).entries]).toEqual([
        label,
        ONLY_B,
      ]);
    }
  });

  test("--server: the probe's OnlyB record covers B.RunB only (LF, CRLF, BOM)", async () => {
    for (const [label, src] of variantsOf(PROBE_TWO)) {
      const index = await admitted(await bundle({ "two/app/Two.Codeunit.al": src }));
      expect([label, alRunnerCoverageFromServer(PROBE_SERVER_ONLY_B, index).entries]).toEqual([
        label,
        ONLY_B,
      ]);
    }
  });

  test("a table extension then a page extension in one file, on both transports", async () => {
    //  1 tableextension 50130 ...   9 pageextension 50131 ...
    //  5         exit(1);          13         exit(2);
    const src = `tableextension 50130 "TExt" extends Customer
{
    procedure TouchT(): Integer
    begin
        exit(1);
    end;
}

pageextension 50131 "PExt" extends "Customer Card"
{
    procedure TouchP(): Integer
    begin
        exit(2);
    end;
}
`;
    const want = [
      { objectType: "TableExtension", objectId: 50130, procedure: "TouchT", line: 5 },
      // The page extension bases at 8 (the blank line after the first ends at 7), so file line 13
      // is object line 6.
      { objectType: "PageExtension", objectId: 50131, procedure: "TouchP", line: 6 },
    ];
    for (const [label, text] of variantsOf(src)) {
      const index = await admitted(await bundle({ "src/Ext.al": text }));
      const cob = alRunnerCoverageFrom(
        [5, 13].map((line) => ({ file: "src/Ext.al", line, hits: 1 })),
        index,
      );
      const srv = alRunnerCoverageFromServer(
        serverOne("src/Ext.al", [
          { scope: "TouchT", line: 5 },
          { scope: "TouchP", line: 13 },
        ]),
        index,
      );
      expect([label, cob.entries, srv.entries]).toEqual([label, want, want]);
    }
  });

  test("a blank line between objects, or B's header, yields no member evidence", async () => {
    const index = await admitted(await bundle({ "two/app/Two.Codeunit.al": PROBE_TWO }));
    const cob = alRunnerCoverageFrom(
      [12, 13, 14].map((line) => ({ file: "two/app/Two.Codeunit.al", line, hits: 1 })),
      index,
    );
    // 12 is the gap: no entry at all. 13 and 14 are B's own header: object-level, never A's.
    expect(cob.entries).toEqual([
      { objectType: "Codeunit", objectId: 50101, line: 2 },
      { objectType: "Codeunit", objectId: 50101, line: 3 },
    ]);
  });
});

describe("R383: covering sets are keyed by (file, type, id), never by a procedure name alone", () => {
  const T1 = { codeunitId: 50140, codeunitName: "Tests", method: "T1" };
  const T2 = { codeunitId: 50140, codeunitName: "Tests", method: "T2" };
  const mutant = (
    mutantId: string,
    file: string,
    objectType: string,
    codeunitId: number,
    procedureName: string,
  ) => ({
    mutantId,
    file,
    startIndex: 10,
    endIndex: 20,
    startLine: 1,
    operatorName: "empty-block",
    operatorVersion: "1.0.0",
    astHash: "h",
    originalText: "x",
    mutatedText: "",
    objectType,
    codeunitId,
    codeunitName: "N",
    procedureName,
  });
  /** M1 and M2's covering tests under both transports, T1 hitting `hit1` and T2 hitting `hit2`. */
  const covering = async (
    files: Record<string, string>,
    hit1: { file: string; line: number; scope: string },
    hit2: { file: string; line: number; scope: string },
    mutants: ReturnType<typeof mutant>[],
  ): Promise<string[][]> => {
    const index = await admitted(await bundle(files));
    const out: string[][] = [];
    for (const transport of ["cobertura", "server"]) {
      const cov = (h: typeof hit1) =>
        transport === "cobertura"
          ? alRunnerCoverageFrom([{ file: h.file, line: h.line, hits: 1 }], index)
          : alRunnerCoverageFromServer(
              serverOne(h.file, [{ scope: h.scope, line: h.line }]),
              index,
            );
      const split = coverageFilter(
        mutants,
        buildCoverageIndex([
          { ref: T1, coverage: cov(hit1) },
          { ref: T2, coverage: cov(hit2) },
        ]),
        [T1, T2],
        undefined,
        false,
      );
      out.push(
        mutants.map(
          (m) =>
            `${transport} ${m.mutantId} ${(split.covered.get(m.mutantId) ?? []).map((t) => t.method).join(",") || "-"}`,
        ),
      );
    }
    return out;
  };
  const RUN = (id: number, name: string, value: number) =>
    `codeunit ${id} ${name}\n{\n    procedure Run(): Integer\n    begin\n        exit(${value});\n    end;\n}\n`;

  test("same name, two objects of ONE file: Run in X and Run in Y get different covering sets", async () => {
    // X: lines 1-7 (`exit(1)` at 5). Y: lines 8-14 (`exit(2)` at 12, object line 5).
    const file = "src/XY.Codeunit.al";
    expect(
      await covering(
        { [file]: `${RUN(50100, "X", 1)}${RUN(50101, "Y", 2)}` },
        { file, line: 5, scope: "Run" },
        { file, line: 12, scope: "Run" },
        [
          mutant("M1", file, "codeunit", 50100, "Run"),
          mutant("M2", file, "codeunit", 50101, "Run"),
        ],
      ),
    ).toEqual([
      ["cobertura M1 T1", "cobertura M2 T2"],
      ["server M1 T1", "server M2 T2"],
    ]);
  });

  test("same name, two files: each file's Run is covered by its own test", async () => {
    expect(
      await covering(
        { "src/X.Codeunit.al": RUN(50100, "X", 1), "src/Y.Codeunit.al": RUN(50101, "Y", 2) },
        { file: "src/X.Codeunit.al", line: 5, scope: "Run" },
        { file: "src/Y.Codeunit.al", line: 5, scope: "Run" },
        [
          mutant("M1", "src/X.Codeunit.al", "codeunit", 50100, "Run"),
          mutant("M2", "src/Y.Codeunit.al", "codeunit", 50101, "Run"),
        ],
      ),
    ).toEqual([
      ["cobertura M1 T1", "cobertura M2 T2"],
      ["server M1 T1", "server M2 T2"],
    ]);
  });

  test("same id, two kinds: codeunit 50100 and table 50100 in one file are two keys", async () => {
    //  1 codeunit 50100 C ... `exit(1)` at 5, ends 7. 8 table 50100 T, `Touch`'s `exit(2)` at 17.
    const file = "src/Same.al";
    const src = `${RUN(50100, "C", 1)}table 50100 T
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    procedure Touch(): Integer
    begin
        exit(2);
    end;
}
`;
    expect(
      await covering(
        { [file]: src },
        { file, line: 5, scope: "Run" },
        { file, line: 17, scope: "Touch" },
        [mutant("M1", file, "codeunit", 50100, "Run"), mutant("M2", file, "table", 50100, "Touch")],
      ),
    ).toEqual([
      ["cobertura M1 T1", "cobertura M2 T2"],
      ["server M1 T1", "server M2 T2"],
    ]);
  });
});

describe("R383: the --server procedure rule (r3 Design 3)", () => {
  /** One object occupying lines 1-7, put before the shape for the multi-object case. */
  const BEFORE = `codeunit 50099 "Before"\n{\n    procedure Lead(): Integer\n    begin\n        exit(0);\n    end;\n}\n\n`;
  const shapes = (src: string): [string, string][] => [
    ["single", src],
    ["multi", `${BEFORE}${src}`],
  ];
  /** `--server` entries as `type:id procedure`, for statements found by a needle in the text. */
  const run = async (src: string, statements: { scope: string; needle: string }[]) => {
    const index = await admitted(await bundle({ "src/R.al": src }));
    const lines = src.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    const map = alRunnerCoverageFromServer(
      serverOne(
        "src/R.al",
        statements.map((s) => ({ scope: s.scope, line: at(s.needle) })),
      ),
      index,
    );
    return map.entries.map((e) => `${e.objectType}:${e.objectId} ${e.procedure ?? "-"}`);
  };

  test("a trigger statement (lookup names nothing) is kept, with the object and procedure: scope", async () => {
    const table = `table 50110 "Trig T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    begin
        Message('x');
    end;
}
`;
    for (const [label, src] of shapes(table)) {
      expect([label, await run(src, [{ scope: "OnInsert", needle: "Message('x')" }])]).toEqual([
        label,
        ["Table:50110 OnInsert"],
      ]);
    }
  });

  // R318's shapes, as written in preproc-instrumentation.test.ts.
  const R3 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

#if R318A
    procedure Choose(T: Text): Integer
    begin
        exit(StrLen(T) + 1);
    end;
#endif

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;
  const R4 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Alpha(X: Integer): Integer
#else
    procedure Beta(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K);
    end;

#if R318A
    procedure Beta(X: Integer): Integer
#else
    procedure Gamma(X: Integer): Integer
#endif
    var
        L: Integer;
    begin
        L := X + 2;
        exit(L);
    end;
}
`;
  const R10 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K); end; procedure Other(X: Integer): Integer begin exit(X + 7); end;

    procedure After(X: Integer): Integer
    begin
        exit(X + 5);
    end;
}
`;

  test("a renamed #if arm (R318 r3): the compiled arm's scope is re-keyed to the member, before any comparison", async () => {
    for (const [label, src] of shapes(R3)) {
      expect([
        label,
        await run(src, [
          { scope: "Choose", needle: "Glob := Glob + 2;" },
          // Not one of the member's own arm names, on its own line: kept, as R318 rules (review M2).
          { scope: "Plain", needle: "Glob := Glob + 2;" },
          { scope: "Plain", needle: "exit(X + 3)" },
        ]),
      ]).toEqual([label, ["Codeunit:50100 Pick", "Codeunit:50100 Plain", "Codeunit:50100 Plain"]]);
    }
  });

  test("a renamed #if arm (R318 r4): the server's Beta is the member spanned as Alpha", async () => {
    for (const [label, src] of shapes(R4)) {
      expect([
        label,
        await run(src, [
          { scope: "Beta", needle: "K := X + 1;" },
          { scope: "Gamma", needle: "L := X + 2;" },
        ]),
      ]).toEqual([label, ["Codeunit:50100 Alpha", "Codeunit:50100 Gamma"]]);
    }
  });

  test("a line two declarations share (R318 r10): OtherOnly keeps scope Other", async () => {
    for (const [label, src] of shapes(R10)) {
      expect([
        label,
        await run(src, [
          { scope: "Other", needle: "procedure Other(" },
          { scope: "Choose", needle: "procedure Other(" },
          { scope: "After", needle: "exit(X + 5)" },
        ]),
      ]).toEqual([
        label,
        ["Codeunit:50100 Other", "Codeunit:50100 Choose", "Codeunit:50100 After"],
      ]);
    }
  });

  test("a disagreeing scope: POSITION wins, the statement is kept, and one warning names it", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const index = await admitted(await bundle({ "two/app/Two.Codeunit.al": PROBE_TWO }));
      const map = alRunnerCoverageFromServer(
        serverOne("two/app/Two.Codeunit.al", [
          { scope: "RunA", line: 19 },
          { scope: "RunB", line: 20 },
        ]),
        index,
      );
      expect(map.entries).toEqual([
        { objectType: "Codeunit", objectId: 50101, procedure: "RunB", line: 8 },
        { objectType: "Codeunit", objectId: 50101, procedure: "RunB", line: 9 },
      ]);
      const said = warn.mock.calls.map((c) => String(c[0]));
      expect(said).toHaveLength(1);
      for (const part of ["two/app/Two.Codeunit.al", "19", "RunA", "RunB"]) {
        expect(said[0]).toContain(part);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
