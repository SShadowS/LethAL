import { describe, expect, test } from "bun:test";
import {
  type ReportView,
  changedLineSurvivors,
  renderChangedLineSurvivors,
} from "../src/changed-line-survivors";
import {
  QUARANTINED_EXIT_CODE,
  SURVIVORS_ON_CHANGED_LINES_EXIT_CODE,
  TIME_BUDGET_EXIT_CODE,
  exitCodeForReport,
  parseCliConfig,
  runExitCode,
} from "../src/cli";

type Row = NonNullable<ReportView["mutants"]>[number];

function mutant(over: Partial<Row> & { mutantCode: string }): Row {
  return {
    file: "src/A.al",
    line: 10,
    operatorName: "lethal.op",
    verdict: "survived",
    batchIndex: 0,
    procedureName: "Proc",
    coveringTests: [],
    ...over,
  } as unknown as Row;
}

const narrowed = ["line-narrowed"];

function report(over: Partial<ReportView> & { mutants: Row[] }, caveats = narrowed): ReportView {
  return { backend: "al-runner-v3", validity: { caveats }, ...over };
}

describe("PR-77: changedLineSurvivors", () => {
  test("a report without the line-narrowed caveat gives undefined", () => {
    expect(changedLineSurvivors(report({ mutants: [mutant({ mutantCode: "M1" })] }, []))).toBe(
      undefined,
    );
  });

  test("only survived verdicts are listed", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [
          mutant({ mutantCode: "M1" }),
          mutant({ mutantCode: "M2", verdict: "killed" }),
          mutant({ mutantCode: "M3", verdict: "no-coverage" }),
          mutant({ mutantCode: "M4", verdict: "error" }),
        ],
      }),
    );
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M1"]);
    expect(r?.apart).toEqual([]);
  });

  test("sorted by file, line, then code", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [
          mutant({ mutantCode: "M3", file: "src/B.al", line: 1 }),
          mutant({ mutantCode: "M2", line: 20 }),
          mutant({ mutantCode: "M9", line: 10 }),
          mutant({ mutantCode: "M1", line: 10 }),
        ],
      }),
    );
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M1", "M9", "M2", "M3"]);
  });

  const covered = mutant({ mutantCode: "M1", coveringTests: ["T.One"] });
  const plain = mutant({ mutantCode: "M2", line: 11 });

  test("(a) a covering test with baselineFlagged puts the survivor apart", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [covered, plain],
        testMethods: [{ name: "T.One", baselineFlagged: true }],
      }),
    );
    expect(r?.apart.map((m) => [m.mutantCode, m.reasons])).toEqual([["M1", ["baselineFlagged"]]]);
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M2"]);
  });

  // Addendum 1: unknown and unrecorded flags count; fresh (serve) and resumed reports agree.
  const serveStyle = report({
    mutants: [covered, plain],
    testMethods: [{ name: "T.One", baselineFlaggedUnknown: true }],
  });
  const resumedStyle = {
    ...report({ mutants: [covered, plain], testMethods: [{ name: "T.One" }] }),
    resumedFrom: { runId: 1, carriedMutants: 2, skippedStranded: 0 },
  } as ReportView;

  test("a serve-style report (all flags unknown) counts the survivors and says how many", () => {
    const r = changedLineSurvivors(serveStyle);
    expect(r?.apart).toEqual([]);
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M1", "M2"]);
    expect(r?.unknownFlagCount).toBe(1);
    expect(renderChangedLineSurvivors(r as never)).toContain(
      "1 survivor(s) on the changed lines have a covering test whose al-runner flag is unknown",
    );
  });

  test("a resumed report with no flag fields agrees with the fresh serve-style one", () => {
    const fresh = changedLineSurvivors(serveStyle);
    const resumed = changedLineSurvivors(resumedStyle);
    expect(resumed?.counted).toEqual(fresh?.counted);
    expect(resumed?.apart).toEqual(fresh?.apart);
    expect(resumed?.unknownFlagCount).toBe(fresh?.unknownFlagCount ?? -1);
    expect(exitCodeForReport(resumedStyle, true)).toBe(exitCodeForReport(serveStyle, true));
    expect(exitCodeForReport(resumedStyle, true)).toBe(SURVIVORS_ON_CHANGED_LINES_EXIT_CODE);
  });

  test("a fresh report whose covering test has no flag is truly unflagged: not in the unknown count", () => {
    const r = changedLineSurvivors(
      report({ mutants: [covered], testMethods: [{ name: "T.One" }] }),
    );
    expect(r?.unknownFlagCount).toBe(0);
    expect(renderChangedLineSurvivors(r as never)).not.toContain("flag is unknown");
  });

  test("known-survivor verdicts count as survivors", () => {
    const r = changedLineSurvivors(
      report({ mutants: [mutant({ mutantCode: "M1", verdict: "known-survivor" })] }),
    );
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M1"]);
  });

  test("carried survived rows are listed and counted", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [mutant({ mutantCode: "M1", carried: true })],
        resumedFrom: { runId: 3, carriedMutants: 1, skippedStranded: 0 },
      }),
    );
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M1"]);
  });

  test("a quarantined or time-budget report marks the section partial", () => {
    const q = changedLineSurvivors({
      ...report({ mutants: [] }),
      quarantined: { reason: "x" },
    } as ReportView);
    expect(renderChangedLineSurvivors(q as never)).toContain("(partial: the run was quarantined");
    const t = changedLineSurvivors(report({ mutants: [] }, [...narrowed, "time-budget-reached"]));
    expect(renderChangedLineSurvivors(t as never)).toContain("stopped by its time budget");
    expect(
      renderChangedLineSurvivors(changedLineSurvivors(report({ mutants: [] })) as never),
    ).not.toContain("partial");
  });

  test("(c) a file in coverageOffFiles puts the survivor apart", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [mutant({ mutantCode: "M1", file: "src/Off.al" }), plain],
        coverageOffFiles: ["src/Off.al"],
      }),
    );
    expect(r?.apart.map((m) => [m.mutantCode, m.reasons])).toEqual([["M1", ["coverageOff"]]]);
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M2"]);
  });

  test("(d) a ref in restrictiveDefault.survivors puts the survivor apart, matched by batch/code", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [
          mutant({ mutantCode: "M1", batchIndex: 2 }),
          mutant({ mutantCode: "M1", batchIndex: 0, line: 12 }),
        ],
        restrictiveDefault: { survivors: ["2/M1"] } as never,
      }),
    );
    expect(r?.apart.map((m) => [m.batchIndex, m.reasons])).toEqual([[2, ["restrictiveDefault"]]]);
    expect(r?.counted.map((m) => m.batchIndex)).toEqual([0]);
  });

  test("several reasons are all listed", () => {
    const r = changedLineSurvivors(
      report({
        mutants: [mutant({ mutantCode: "M1", coveringTests: ["T.One"] })],
        testMethods: [{ name: "T.One", baselineFlagged: true, baselineFlaggedUnknown: true }],
        coverageOffFiles: ["src/A.al"],
        restrictiveDefault: { survivors: ["0/M1"] } as never,
      }),
    );
    expect(r?.apart[0]?.reasons).toEqual(["baselineFlagged", "coverageOff", "restrictiveDefault"]);
  });

  test("a bcdev report caveats nothing, whatever the flags say", () => {
    const r = changedLineSurvivors(
      report({
        backend: "bcdev",
        mutants: [covered],
        testMethods: [{ name: "T.One", baselineFlagged: true }],
        coverageOffFiles: ["src/A.al"],
        restrictiveDefault: { survivors: ["0/M1"] } as never,
      }),
    );
    expect(r?.apart).toEqual([]);
    expect(r?.counted.map((m) => m.mutantCode)).toEqual(["M1"]);
  });

  test("the section prints both parts with their reasons", () => {
    const text = renderChangedLineSurvivors({
      counted: [
        {
          batchIndex: 0,
          mutantCode: "M2",
          file: "src/A.al",
          line: 11,
          operatorName: "op",
          procedureName: "P",
        },
      ],
      apart: [
        {
          batchIndex: 1,
          mutantCode: "M1",
          file: "src/A.al",
          line: 10,
          operatorName: "op",
          procedureName: "Q",
          reasons: ["coverageOff"],
        },
      ],
      unknownFlagCount: 0,
    });
    expect(text).toContain("SURVIVORS ON THE CHANGED LINES");
    // R117: the `file:line` form is built, not written, so the citation guard does not read it.
    expect(text).toContain(`0/M2 src/A.al:${11} op P`);
    expect(text).toContain("listed apart (al-runner-v3 caveat, never fails)");
    expect(text).toContain(`1/M1 src/A.al:${10} op Q  [coverageOff]`);
  });
});

describe("PR-77: --fail-on-survivors exit code", () => {
  const withCounted = report({ mutants: [mutant({ mutantCode: "M1" })] });
  const onlyApart = report({
    mutants: [mutant({ mutantCode: "M1" })],
    coverageOffFiles: ["src/A.al"],
  });

  test("9 with the flag and a counted survivor", () => {
    expect(exitCodeForReport(withCounted, true)).toBe(SURVIVORS_ON_CHANGED_LINES_EXIT_CODE);
  });

  test("0 with the flag and only caveated survivors", () => {
    expect(exitCodeForReport(onlyApart, true)).toBe(0);
  });

  test("0 without the flag, counted survivor or not", () => {
    expect(exitCodeForReport(withCounted)).toBe(0);
    expect(exitCodeForReport(withCounted, false)).toBe(0);
  });

  test("0 with the flag on a report that is not line-narrowed", () => {
    expect(exitCodeForReport(report({ mutants: [mutant({ mutantCode: "M1" })] }, []), true)).toBe(
      0,
    );
  });

  test("3, 4 and 7 win over 9", () => {
    const m = [mutant({ mutantCode: "M1" })];
    expect(
      exitCodeForReport({ ...report({ mutants: m }), quarantined: { reason: "x" } as never }, true),
    ).toBe(QUARANTINED_EXIT_CODE);
    expect(exitCodeForReport(report({ mutants: m }, [...narrowed, "all-errors"]), true)).toBe(4);
    expect(
      exitCodeForReport(report({ mutants: m }, [...narrowed, "time-budget-reached"]), true),
    ).toBe(TIME_BUDGET_EXIT_CODE);
  });
});

describe("PR-77: main's wiring", () => {
  const r = report({ mutants: [mutant({ mutantCode: "M1" })] });
  test("the parsed flag reaches the exit code: on gives 9, off gives 0, same report", () => {
    expect(runExitCode(r, { failOnSurvivors: true })).toBe(SURVIVORS_ON_CHANGED_LINES_EXIT_CODE);
    expect(runExitCode(r, {})).toBe(0);
  });
});

describe("PR-77: --fail-on-survivors parse", () => {
  const base = ["run", "--project", "P", "--tests", "T", "--backend", "bcdev"];
  const lines = ["a.al", "1-2"].join(":");

  test("refused without --lines or --changed-since", () => {
    expect(() => parseCliConfig([...base, "--fail-on-survivors"])).toThrow(
      /--lines or --changed-since/,
    );
  });

  test("accepted with --lines or with --changed-since, and stored", () => {
    expect(parseCliConfig([...base, "--fail-on-survivors", "--lines", lines])).toMatchObject({
      failOnSurvivors: true,
    });
    expect(
      parseCliConfig([...base, "--fail-on-survivors", "--changed-since", "HEAD"]),
    ).toMatchObject({ failOnSurvivors: true });
  });

  test("absent when not given", () => {
    expect(parseCliConfig([...base, "--lines", lines])).not.toHaveProperty("failOnSurvivors");
  });
});
