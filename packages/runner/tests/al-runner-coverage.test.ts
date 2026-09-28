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
    expect([...index.byFile.values()]).toEqual([{ objectType: "Codeunit", objectId: 79150 }]);
  });

  test("NAMES a file declaring two objects, which is what disables coverage for the run", async () => {
    // The upstream defect this guards: al-runner reports one Cobertura class per FILE and loses
    // every object after the first, so a mutant in the second object would get no entry and
    // `coverageFilter` would report it `no-coverage` rather than running it. Measured on 2.11.0.
    const two = `${ONE_OBJECT}\ncodeunit 79151 "Probe Two"\n{\n    procedure P()\n    begin\n    end;\n}\n`;
    const dir = await bundle({ "src/Two.Codeunit.al": two });
    const index = await buildAlRunnerCoverageIndex(dir);
    expect(index.multiObjectFiles).toEqual(["src/Two.Codeunit.al"]);
    // And it is not indexed, so nothing can accidentally resolve against half of it.
    expect(index.byFile.size).toBe(0);
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
const R298_REFUSED =
  "[lethal] coverage refused for Codeunit:50103 (src/B2.Codeunit.al): it is declared inside, or after, a #if ... #endif object wrapper, and how the compiled arm's lines are numbered is not yet measured (R300). Its mutants read no-coverage.";

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
    expect(await alRunnerCoverageSupport(dir)).toEqual({ supported: true, multiObjectFiles: [] });
  });

  test("a bare object plus a wrapped one IS two objects for the guard", async () => {
    const dir = await bundle({ "src/Mixed.Codeunit.al": R298_MIXED });
    expect(await alRunnerCoverageSupport(dir)).toEqual({
      supported: false,
      multiObjectFiles: ["src/Mixed.Codeunit.al"],
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

/** R298 end to end: a wrapped TABLE's trigger, through the al-runner conversion into selection. */
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
      expect(await alRunnerCoverageSupport(dir)).toEqual({ supported: true, multiObjectFiles: [] });
      const index = await buildAlRunnerCoverageIndex(dir);
      expect(index.refusedFiles).toEqual(["src/T.Table.al"]);
      await initParser();
      const refused = coverageRefusedObjects(
        Object.entries(files).map(([path, text]) => ({ path, root: wrapRoot(parseAL(text)) })),
      );
      const sentence =
        "coverage refused for Table:50110 (src/T.Table.al): its file also holds a #if ... #endif object wrapper, and al-runner refuses such a file whole (R298, R300). Its mutants read no-coverage.";
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
