import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  alRunnerCoverageSupport,
  buildAlRunnerCoverageIndex,
  parseCobertura,
} from "../src/al-runner-coverage";

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
