import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { type MutantManifest, writeInstrumentedProject } from "@lethal/schemata";
import {
  alRunnerCoverageFrom,
  buildAlRunnerCoverageIndex,
  parseCobertura,
} from "../src/al-runner-coverage";
import { AppMethodIndex, objectTypeName } from "../src/app-package";
import { assertManifestObjectsDeclared, buildLineMap } from "../src/line-map";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { buildCoverageIndex, coverageFilter } from "../src/selection";

/**
 * R254: a `reportextension` is a carrier kind. Measured (scripts/r254-probe/README.md): BC keys its
 * coverage `22:<extension id>` at the extension's own source lines, and al-runner gives it its own
 * Cobertura `<class>`. Before R254 the file was skipped (`not-instrumentable-files-skipped`) and a
 * test reaching only extension code covered nothing (`unmapped BC object type 22`).
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "R254",
  publisher: "P",
  version: "1.0.0.0",
  runtime: "16.0",
  idRanges: [{ from: 50200, to: 50299 }],
});

const BASE = "src/Base.Report.al";
const NO_VAR = "src/NoVar.ReportExt.al";
const WITH_VAR = "src/WithVar.ReportExt.al";

const BASE_AL = `report 50200 "R254 Base"
{
    ProcessingOnly = true;
    UsageCategory = None;

    dataset
    {
        dataitem(IntItem; Integer)
        {
            DataItemTableView = where(Number = filter(1 .. 3));
        }
    }
}
`;

/** No var section but a dataset: the selector var must be appended after the last member (alc
 *  AL0926 refuses a `var` before `dataset`, measured with `isTrailingOnly` reverted). Its `N + 1`
 *  is `swap-additive`'s site, which needs the extension's scope (the parameter typed Integer). */
const NO_VAR_AL = `reportextension 50201 "R254 NoVar" extends "R254 Base"
{
    dataset
    {
        modify(IntItem)
        {
            trigger OnAfterAfterGetRecord()
            begin
                if IntItem.Number > 1 then
                    exit;
            end;
        }
    }

    procedure Step(N: Integer): Integer
    begin
        exit(N + 1);
    end;
}
`;

/** A var section, a dataset trigger and a report trigger, like the tables fixture's arm. */
const WITH_VAR_AL = `reportextension 50202 "R254 WithVar" extends "R254 Base"
{
    dataset
    {
        modify(IntItem)
        {
            trigger OnAfterAfterGetRecord()
            begin
                Total += IntItem.Number;
            end;
        }
    }

    trigger OnPreReport()
    begin
        Total := 0;
    end;

    procedure GetTotal(): Integer
    begin
        exit(Total);
    end;

    var
        Total: Integer;
}
`;

async function withProject<T>(
  files: Readonly<Record<string, string>>,
  body: (projectDir: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r254-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(files))
    await Bun.write(join(projectDir, rel), content);
  try {
    return await body(projectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await initParser();
});

describe("R254: a reportextension is instrumented", () => {
  let set: Awaited<ReturnType<typeof generateMutationSet>>;
  let manifest: MutantManifest;
  let instrumented: Record<string, string>;

  beforeAll(async () => {
    await withProject(
      { [BASE]: BASE_AL, [NO_VAR]: NO_VAR_AL, [WITH_VAR]: WITH_VAR_AL },
      async (dir) => {
        set = await generateMutationSet(dir, { emit: () => {} });
        const out = await mkdtemp(join(tmpdir(), "lethal-r254-out-"));
        try {
          await writeInstrumentedProject({
            targetDir: out,
            files: set.files,
            selectorIds: { selectorId: 50297, controlId: 50298, tableId: 50299 },
            artifactId: "0123456789abcdef0123456789abcdef",
            targetAppId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            operatorTiers,
            identityOrdinals: identityOrdinalsOf(set),
          });
          manifest = JSON.parse(
            await readFile(join(out, "mutant-manifest.json"), "utf8"),
          ) as MutantManifest;
          // The writer flattens to basenames.
          instrumented = {
            [NO_VAR]: await readFile(join(out, "NoVar.ReportExt.al"), "utf8"),
            [WITH_VAR]: await readFile(join(out, "WithVar.ReportExt.al"), "utf8"),
          };
        } finally {
          await rm(out, { recursive: true, force: true });
        }
      },
    );
  });

  test("both extension files carry specs; nothing is skipped or refused", () => {
    expect(set.skipped).toEqual([]);
    expect(set.refusedFiles).toEqual([]);
    expect(set.files.map((f) => f.path).sort()).toEqual([NO_VAR, WITH_VAR]);
    for (const f of set.files) expect(f.specs.length).toBeGreaterThan(0);
  });

  test("the manifest attributes the extension's mutants to reportextension:<id>", () => {
    const kinds = new Set(manifest.mutants.map((m) => `${m.file}|${m.objectType}:${m.codeunitId}`));
    expect([...kinds].sort()).toEqual([
      `${NO_VAR}|reportextension:50201`,
      `${WITH_VAR}|reportextension:50202`,
    ]);
  });

  test("the extension's members are in scope: swap-additive types `N + 1`", () => {
    const swaps = manifest.mutants.filter(
      (m) => m.file === NO_VAR && m.operatorName === "lethal.swap-additive",
    );
    expect(swaps.map((m) => [m.procedureName, m.originalText, m.mutatedText])).toEqual([
      ["Step", "N + 1", "N - 1"],
    ]);
  });

  test("each extension declares the selector var exactly once, after its members", () => {
    // R470: a reportextension's selector is named after its own object id (two extensions of one
    // report sharing a name is AL0155).
    for (const [rel, id] of [
      [NO_VAR, 50201],
      [WITH_VAR, 50202],
    ] as const) {
      const text = instrumented[rel] ?? "";
      const decl = `MutationSelector${id}: Codeunit "Mutation Selector";`;
      expect(text.split(decl).length - 1).toBe(1);
      // Never before the dataset section: alc AL0926 wants metadata sections before any `var`.
      expect(text.indexOf(decl)).toBeGreaterThan(text.indexOf("dataset"));
    }
  });
});

/** Something left to measure, so a refused file does not end the run. */
const GOOD = "src/Good.Codeunit.al";
const GOOD_AL = `codeunit 50203 "R254 Good"
{
    procedure P(): Integer
    begin
        exit(1);
    end;
}
`;

describe("R254: multi-object files keep INJECTABLE_OBJECT_TYPES (codeunit, table)", () => {
  test("a report and a reportextension in ONE file are refused object-mix, naming reportextension", () =>
    withProject({ "src/Both.al": `${BASE_AL}\n${NO_VAR_AL}`, [GOOD]: GOOD_AL }, async (dir) => {
      const set = await generateMutationSet(dir, { emit: () => {} });
      // Before R254 the header rule could not see `reportextension`, so this read unsupported-kind.
      expect(set.files.map((f) => f.path)).toEqual([GOOD]);
      expect(set.refusedFiles.map((r) => [r.file, r.shape])).toEqual([
        ["src/Both.al", "object-mix"],
      ]);
      expect(set.refusedFiles[0]?.objects).toEqual([
        { type: "report", id: 50200, name: "R254 Base" },
        { type: "reportextension", id: 50201, name: "R254 NoVar" },
      ]);
    }));
});

/** The probe's extension (scripts/r254-probe/target/src/R254ProbeRepExt.ReportExt.al), verbatim. */
const PROBE_EXT = `// The code whose coverage attribution R254 measures: a modify() dataitem trigger, a report-level
// trigger and a procedure, all declared in the EXTENSION. Expected (not yet measured): rows under
// Object Type ReportExtension (option ordinal 22) and Object ID 91601, not under the base report.
reportextension 91601 "R254 Probe RepExt" extends "R254 Probe Report"
{
    dataset
    {
        modify(IntItem)
        {
            trigger OnAfterAfterGetRecord()
            begin
                ExtTotal += Classify(IntItem.Number);
            end;
        }
    }

    trigger OnPreReport()
    begin
        ExtTotal := 0;
    end;

    trigger OnPostReport()
    var
        Sink: Codeunit "R254 Probe Sink";
    begin
        Sink.SetExt(ExtTotal);
    end;

    procedure Classify(N: Integer): Integer
    begin
        if N > 1 then
            exit(10);
        exit(1);
    end;

    // Read through the test's report variable AFTER RunModal: does the instance keep its globals?
    // If yes, a fixture arm needs no sink codeunit.
    procedure GetExtTotal(): Integer
    begin
        exit(ExtTotal);
    end;

    var
        ExtTotal: Integer;
}
`;
const PROBE_FILE = "target/src/R254ProbeRepExt.ReportExt.al";

/** The probe's SymbolReference shape, method ids as BC reported them (Classify 1710736425). */
const PROBE_SYMBOLS = {
  ReportExtensions: [
    { Id: 91601, Name: "R254 Probe RepExt", Methods: [{ Id: 1710736425, Name: "Classify" }] },
  ],
  Reports: [{ Id: 91600, Name: "R254 Probe Report" }],
};

describe("R254: fenced coverage joins a 22:<id> row to the extension's procedure", () => {
  test("row 22:91601 at a Classify line keys ReportExtension:91601, and selects its test", () =>
    withProject({ [PROBE_FILE]: PROBE_EXT }, async (dir) => {
      const declared = AppMethodIndex.fromSymbolReference(PROBE_SYMBOLS).declaredObjects();
      expect(declared.has("reportextension:91601")).toBe(true);
      const map = await buildLineMap(dir, declared);
      // The manifest key a reportextension mutant carries: declared AND mapped, so no throw.
      expect(() =>
        assertManifestObjectsDeclared(
          ["reportextension:91601"],
          declared,
          map.mappedKeys(),
          map.sourceRefusedKeys(),
        ),
      ).not.toThrow();
      // BC's row: Object Type 22, the extension's own source line (31 = `if N > 1 then`).
      const type = objectTypeName(22);
      expect(type).toBe("ReportExtension");
      expect(map.lookup(type, 91601, 31)).toBe("Classify");
      const ref = { codeunitId: 91610, codeunitName: "R254 Probe Tests", method: "CallExt" };
      const index = buildCoverageIndex([
        {
          ref,
          coverage: {
            granularity: "procedure",
            entries: [{ objectType: type, objectId: 91601, procedure: "Classify" }],
          },
        },
      ]);
      const mutant = {
        mutantId: "M0001",
        file: PROBE_FILE,
        startIndex: 0,
        endIndex: 1,
        startLine: 31,
        operatorName: "lethal.conditional-boundary",
        operatorVersion: "1.0.0",
        astHash: "h",
        objectType: "reportextension",
        codeunitId: 91601,
        codeunitName: "R254 Probe RepExt",
        procedureName: "Classify",
        originalText: "N > 1",
        mutatedText: "N >= 1",
      };
      const split = coverageFilter([mutant], index, [ref]);
      expect(split.covered.get("M0001")).toEqual([ref]);
    }));
});

/** al-runner's Cobertura for the probe, MEASURED (scripts/r254-probe/README.md section (b)). */
const PROBE_COBERTURA = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1.0000" branch-rate="0" version="1.0">
  <packages>
    <package name="al-source" line-rate="1.0000" branch-rate="0">
      <classes>
        <class name="R254ProbeRepExt.ReportExt" filename="${PROBE_FILE}" line-rate="1.0000">
          <lines>
            <line number="12" hits="6" />
            <line number="19" hits="2" />
            <line number="26" hits="2" />
            <line number="31" hits="6" />
            <line number="32" hits="4" />
            <line number="33" hits="2" />
            <line number="40" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`;

describe("R254: al-runner's own <class> for a reportextension resolves by the line map", () => {
  test("the measured class block gives ReportExtension:91601 Classify and GetExtTotal", () =>
    withProject({ [PROBE_FILE]: PROBE_EXT }, async (dir) => {
      const index = await buildAlRunnerCoverageIndex(dir);
      const map = alRunnerCoverageFrom(parseCobertura(PROBE_COBERTURA), index);
      const named = map.entries
        .filter((e) => e.procedure !== undefined)
        .map((e) => `${e.objectType}:${e.objectId}:${e.procedure}`);
      expect([...new Set(named)]).toEqual([
        "ReportExtension:91601:Classify",
        "ReportExtension:91601:GetExtTotal",
      ]);
      // The trigger lines are evidence too, at object level.
      expect(map.entries.some((e) => e.procedure === undefined && e.objectId === 91601)).toBe(true);
    }));
});
