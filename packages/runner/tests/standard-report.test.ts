import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import SCHEMA from "mutation-testing-report-schema/mutation-testing-report-schema.json";
import type { RunEvent, RunEventInput } from "../src/events";
import { buildReport } from "../src/report";
import type { SessionReport } from "../src/report";
import type { FoldStatics } from "../src/report-fold";
import { statusOf, toStandardReport } from "../src/standard-report";

// The schema is a third-party contract reached through a CARET range (^3.9.0), so an install can
// float it. These are the parts the mapper depends on; a float that moves any of them reddens here
// and names it, instead of silently changing which reports validate. Same reasoning as
// schemas.test.ts's pins, one dependency over.
describe("the mutation-testing report schema contract", () => {
  test("root requires schemaVersion, thresholds and files", () => {
    expect([...SCHEMA.required].sort()).toEqual(["files", "schemaVersion", "thresholds"]);
  });

  test("schemaVersion is a STRING with a pattern, not a number", () => {
    // Emitting a number here would be a valid-looking report the ecosystem rejects.
    expect(SCHEMA.properties.schemaVersion.type).toBe("string");
    expect(SCHEMA.properties.schemaVersion.pattern).toBeDefined();
  });

  test("FileResult is inlined under files.additionalProperties and requires source", () => {
    // NOT `definitions.fileResult`, which does not exist. `definitions` holds only location,
    // openEndLocation and position.
    const fileResult = SCHEMA.properties.files.additionalProperties;
    expect([...fileResult.required].sort()).toEqual(["language", "mutants", "source"]);
  });

  test("MutantResult requires id, mutatorName, location and status", () => {
    const mutant = SCHEMA.properties.files.additionalProperties.properties.mutants.items;
    expect([...mutant.required].sort()).toEqual(["id", "location", "mutatorName", "status"]);
  });

  test("the status enum is exactly the eight we map onto", () => {
    const status =
      SCHEMA.properties.files.additionalProperties.properties.mutants.items.properties.status;
    expect([...status.enum].sort()).toEqual([
      "CompileError",
      "Ignored",
      "Killed",
      "NoCoverage",
      "Pending",
      "RuntimeError",
      "Survived",
      "Timeout",
    ]);
  });
});

describe("verdict to MutantStatus", () => {
  test("the four straightforward verdicts", () => {
    expect(statusOf({ verdict: "killed" })).toBe("Killed");
    expect(statusOf({ verdict: "survived" })).toBe("Survived");
    expect(statusOf({ verdict: "no-coverage" })).toBe("NoCoverage");
    expect(statusOf({ verdict: "timeout-killed" })).toBe("Timeout");
  });

  test("a carried survivor is Survived, not Pending", () => {
    // `known-survivor` means a prior run recorded it surviving and this run did not re-execute it.
    // Survived is what was MEASURED; that it was carried rather than re-run belongs in
    // statusReason. Pending would claim the mutant is still queued, which is false.
    expect(statusOf({ verdict: "known-survivor" })).toBe("Survived");
  });

  test("an error maps by cause, and a compile culprit is CompileError", () => {
    expect(statusOf({ verdict: "error", cause: "unstable" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "stranded" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "deadline-exceeded" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "result-lost" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", compileCulprit: true })).toBe("CompileError");
  });

  test("an unmapped verdict throws rather than defaulting", () => {
    // Fail loudly on a caller-contract violation: a new MutantVerdict must force a decision here,
    // not silently inherit whatever the default branch returned. Empty-vs-empty agreement is this
    // project's signature bug.
    expect(() => statusOf({ verdict: "invented" as never })).toThrow(/unmapped verdict/);
  });
});

// Fixed 8-space indent, spelled out via `.repeat` rather than typed literally, so the column
// arithmetic below is provably 8 rather than trusting a hand-count of spaces in a string literal.
const INDENT = " ".repeat(8);
const DO_CALL = "DoSomething();";
const MSG_CALL = "Message('Hi');";

// Multi-line on purpose (design spec 2026-08-26-excluded-sites-and-report-schema-design.md
// section 2.3's location test needs row arithmetic genuinely exercised, not just column 1) — the
// mutated call sits on line 5, well past the file's first line.
const FOO_SOURCE = [
  'codeunit 50100 "Foo"',
  "{",
  "    procedure Bar()",
  "    begin",
  `${INDENT}${DO_CALL}`,
  `${INDENT}${MSG_CALL}`,
  "    end;",
  "}",
  "",
].join("\n");

const BAR_SOURCE = [
  'table 50101 "Bar"',
  "{",
  '    fields { field(1; "No."; Code[20]) { } }',
  "}",
  "",
].join("\n");

const BAZ_SOURCE = ['page 50110 "Baz"', "{", "}", ""].join("\n");

const DO_START = FOO_SOURCE.indexOf(DO_CALL);
const DO_END = DO_START + DO_CALL.length;
const MSG_START = FOO_SOURCE.indexOf(MSG_CALL);
const MSG_END = MSG_START + MSG_CALL.length;

/** Same shape/defaults pattern as `report-fold.test.ts`'s own `mutant()` helper — every required
 *  `MutantManifestEntry` field defaulted to a Foo/M0001 shape, overridden per call. */
function mutantEntry(id: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: id,
    file: "Al/Codeunit/Foo.Codeunit.al",
    startIndex: DO_START,
    endIndex: DO_END,
    startLine: 5,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Foo",
    procedureName: "Bar",
    procedureScope: "public",
    originalText: DO_CALL,
    mutatedText: "",
    ...over,
  };
}

/**
 * A minimal report built through the REAL fold (`buildReport`), per the task brief: reuse the
 * event-stream harness `report-equality.test.ts`/`report-fold.test.ts` already established rather
 * than hand-constructing a `SessionReport` literal (a third way neither existing test file uses).
 *
 * Deliberately small — just enough to exercise every field `toStandardReport` reads: two files'
 * worth of real mutants (killed with a covering-test list longer than its kill index, survived,
 * no-coverage) plus one `excludedSites` row on a THIRD file that carries no mutant at all.
 *
 * Called fresh in every test (never shared/cached) for the same reason report-equality.test.ts's
 * `buildScenarioReport` is: a shared report would leave one test's pass/fail accidentally coupled
 * to another having already run.
 */
function buildScenarioReport(): SessionReport {
  const statics: FoldStatics = {
    caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
  };

  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: 4,
      deployedCount: 3,
      totalFiles: 3,
      instrumentableFiles: 2,
      excludedByOnly: 0,
      excludedByOperator: 0,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [{ file: "Al/Page/Baz.Page.al", kinds: "page_property", sites: 2 }],
    },
    // Empty `verdicts`: the whole baseline passed (report-equality.test.ts's own comment on this
    // event — "only the tests that did NOT pass ... need a verdict here").
    { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
    // R106: a batch with a green baseline test under a coverage-claiming mode always owes one of
    // these — see report-fold.ts's own throw for a batch that doesn't.
    {
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: 0,
      coveredCount: 2,
      noCoverageCount: 1,
      unplaceableCount: 0,
      unplaceableMutants: [],
    },
    {
      type: "mutant-scored",
      mutant: mutantEntry("M0001"),
      verdict: "killed",
      batchIndex: 0,
      durationMs: 500,
      // Three covering tests; the loop broke at the SECOND, so testsCompleted (2) must read below
      // coveredBy.length (3) — the exact shape the schema's `testsCompleted` field exists for.
      coveringTests: ["Foo Tests.T1", "Foo Tests.T2", "Foo Tests.T3"],
      killingTest: "Foo Tests.T2",
      killingTestFailure: "Error: expected 42, got 0",
      coverageAttribution: "exact",
    },
    {
      type: "mutant-scored",
      mutant: mutantEntry("M0002", {
        startIndex: MSG_START,
        endIndex: MSG_END,
        startLine: 6,
        originalText: MSG_CALL,
      }),
      verdict: "survived",
      batchIndex: 0,
      durationMs: 300,
      coveringTests: ["Foo Tests.T1"],
      coverageAttribution: "exact",
    },
    {
      type: "mutant-scored",
      mutant: mutantEntry("M0003", {
        file: "Al/Table/Bar.Table.al",
        startIndex: 0,
        endIndex: 0,
        startLine: 1,
        objectType: "table",
        codeunitId: 50101,
        codeunitName: "Bar",
      }),
      verdict: "no-coverage",
      batchIndex: 0,
      durationMs: 0,
      coveringTests: [],
    },
    { type: "session-finished", elapsedMs: 100 },
  ];

  const stamped: RunEvent[] = events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
  return buildReport(statics, stamped);
}

function scenarioSources(): Map<string, string> {
  return new Map([
    ["Al/Codeunit/Foo.Codeunit.al", FOO_SOURCE],
    ["Al/Table/Bar.Table.al", BAR_SOURCE],
    ["Al/Page/Baz.Page.al", BAZ_SOURCE],
  ]);
}

describe("toStandardReport", () => {
  test('emits schemaVersion as the STRING "2" and the required root fields', () => {
    // A number here type-errors against MutationTestResult and is rejected by the schema's pattern.
    const result = toStandardReport(buildScenarioReport(), scenarioSources());
    expect(result.schemaVersion).toBe("2");
    expect(typeof result.schemaVersion).toBe("string");
    // The ecosystem default (design spec section 2.3) — LethAL has no threshold concept of its own.
    expect(result.thresholds).toEqual({ high: 80, low: 60 });
    expect(Object.keys(result).sort()).toEqual(["files", "schemaVersion", "thresholds"]);
  });

  test('groups mutants by file, with language "al" and the file\'s source', () => {
    const result = toStandardReport(buildScenarioReport(), scenarioSources());

    const foo = result.files["Al/Codeunit/Foo.Codeunit.al"];
    expect(foo?.language).toBe("al");
    expect(foo?.source).toBe(FOO_SOURCE);
    expect(foo?.mutants.map((m) => m.id).sort()).toEqual(["M0001", "M0002"]);

    const bar = result.files["Al/Table/Bar.Table.al"];
    expect(bar?.language).toBe("al");
    expect(bar?.source).toBe(BAR_SOURCE);
    expect(bar?.mutants.map((m) => m.id)).toEqual(["M0003"]);
  });

  test("location is 1-based with an exclusive end, derived from byte offsets", () => {
    // Use a MULTI-LINE source so the row arithmetic is genuinely exercised, not just column 1.
    const result = toStandardReport(buildScenarioReport(), scenarioSources());
    const foo = result.files["Al/Codeunit/Foo.Codeunit.al"];
    const killed = foo?.mutants.find((m) => m.id === "M0001");
    // "DoSomething();" sits on line 5, 8 columns in (an 8-space indent) — start is INCLUSIVE at
    // the "D", end is EXCLUSIVE one past the final ";" (14 characters later).
    expect(killed?.location).toEqual({
      start: { line: 5, column: 9 },
      end: { line: 5, column: 23 },
    });
  });

  test("coveredBy, killedBy, statusReason and testsCompleted carry the report's own fields", () => {
    // coveringTests -> coveredBy; killingTest -> killedBy; killingTestFailure -> statusReason.
    // testsCompleted may be LESS than coveredBy on a kill: the covering-test loop breaks on the
    // first confirmed kill, which is exactly why the schema has that field.
    const result = toStandardReport(buildScenarioReport(), scenarioSources());
    const foo = result.files["Al/Codeunit/Foo.Codeunit.al"];
    const killed = foo?.mutants.find((m) => m.id === "M0001");
    expect(killed?.coveredBy).toEqual(["Foo Tests.T1", "Foo Tests.T2", "Foo Tests.T3"]);
    expect(killed?.killedBy).toEqual(["Foo Tests.T2"]);
    expect(killed?.statusReason).toBe("Error: expected 42, got 0");
    expect(killed?.testsCompleted).toBe(2);
    expect(killed?.coveredBy?.length).toBe(3);
  });

  test("every excludedSites row becomes an Ignored entry carrying its reason", () => {
    // An excluded FILE with no mutants still appears, so the refusal is visible in the viewer
    // rather than being an absence a reader has to notice.
    const result = toStandardReport(buildScenarioReport(), scenarioSources());
    const baz = result.files["Al/Page/Baz.Page.al"];
    expect(baz?.language).toBe("al");
    expect(baz?.source).toBe(BAZ_SOURCE);
    expect(baz?.mutants).toEqual([
      {
        id: "ignored:Al/Page/Baz.Page.al:declarative",
        mutatorName: "declarative",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
        status: "Ignored",
        statusReason: "declarative (page_property, 2 site(s) not mutated)",
      },
    ]);
  });

  test("a file with no source supplied throws rather than emitting an invalid report", () => {
    const report = buildScenarioReport();
    expect(() => toStandardReport(report, new Map())).toThrow(/no source for/);
  });
});
