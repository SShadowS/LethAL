import { describe, expect, test } from "bun:test";
import { type ArmMutant, R254_ARM_FILE, R254_ARM_ORACLE, armOracleDiffs } from "./r254-arm-oracle";

/** The oracle's own rows as a report would carry them, codes M0005.. in row order. */
function exact(): ArmMutant[] {
  return R254_ARM_ORACLE.map((r, i) => ({
    mutantCode: `M${String(5 + i).padStart(4, "0")}`,
    file: R254_ARM_FILE,
    line: r.line,
    operatorName: `lethal.${r.operator}`,
    verdict: r.verdict,
    ...(r.killingTest !== undefined ? { killingTest: r.killingTest } : {}),
    ...(r.killPosition !== undefined ? { killPosition: r.killPosition } : {}),
    ...(r.failure !== undefined
      ? { killingTestFailure: `Error: ${r.failure}\nCallStack: Data Tests(CodeUnit 79310)` }
      : {}),
  }));
}

const other: ArmMutant = {
  mutantCode: "M0001",
  file: "src/DataMain.Table.al",
  line: 10,
  operatorName: "lethal.empty-block",
  verdict: "survived",
};

describe("R254 arm oracle", () => {
  // R-463 adds `CountBand`'s four rows, all killed (15 -> 19, 9 -> 13 killed).
  test("has the 19 pre-committed rows: 13 killed, 2 survived, 4 no-coverage", () => {
    const n = (v: string) => R254_ARM_ORACLE.filter((r) => r.verdict === v).length;
    expect([R254_ARM_ORACLE.length, n("killed"), n("survived"), n("no-coverage")]).toEqual([
      19, 13, 2, 4,
    ]);
  });

  test("the exact rows (and mutants in other files) give no diff; backslash paths too", () => {
    expect(armOracleDiffs([other, ...exact()])).toEqual([]);
    expect(
      armOracleDiffs(exact().map((m) => ({ ...m, file: m.file.replaceAll("/", "\\") }))),
    ).toEqual([]);
  });

  test("two verdicts swapped with the totals unchanged is a diff", () => {
    const ms = exact().map((m) => {
      // M0007 (19 empty-block, survived) <-> M0016 (36 empty-block, no-coverage)
      if (m.line === 19) return { ...m, verdict: "no-coverage" as const };
      if (m.line === 36) return { ...m, verdict: "survived" as const };
      return m;
    });
    expect(armOracleDiffs(ms)).toEqual([
      "M0007 src/DataBandExt.ReportExt.al line 19 empty-block: verdict no-coverage, expected survived",
      "M0016 src/DataBandExt.ReportExt.al line 36 empty-block: verdict survived, expected no-coverage",
    ]);
  });

  test("M0009 at position 1 is a diff", () => {
    const ms = exact().map((m) => (m.mutantCode === "M0009" ? { ...m, killPosition: 1 } : m));
    expect(armOracleDiffs(ms)).toEqual([
      "M0009 src/DataBandExt.ReportExt.al line 20 shift-integer: killPosition 1, expected 3",
    ]);
  });

  test("a different killer or failure text is a diff", () => {
    const ms = exact().map((m) =>
      m.mutantCode === "M0010"
        ? {
            ...m,
            killingTest: "BandReportSumsBands",
            killingTestFailure: "band total should be 6, got 4",
          }
        : m,
    );
    expect(armOracleDiffs(ms)).toEqual([
      "M0010 src/DataBandExt.ReportExt.al line 24 empty-block: killingTest BandReportSumsBands, expected BandClassifiesDirectly",
      'M0010 src/DataBandExt.ReportExt.al line 24 empty-block: killingTestFailure "band total should be 6, got 4" lacks "Band(3) should be 2, got 0"',
    ]);
  });

  test("an extra arm mutant, a missing one and a duplicate are diffs", () => {
    const ms = exact();
    const extra = {
      ...other,
      mutantCode: "M0020",
      file: R254_ARM_FILE,
      line: 13,
      operatorName: "lethal.swap-additive",
    };
    expect(armOracleDiffs([...ms, extra])).toEqual([
      "src/DataBandExt.ReportExt.al line 13 swap-additive: M0020 is not in the oracle",
    ]);
    expect(armOracleDiffs(ms.slice(1))).toEqual([
      "src/DataBandExt.ReportExt.al line 12 empty-block: expected exactly one mutant, found 0",
    ]);
    const [first] = ms;
    if (first === undefined) throw new Error("no rows");
    expect(armOracleDiffs([...ms, { ...first, mutantCode: "M0099" }])).toEqual([
      "src/DataBandExt.ReportExt.al line 12 empty-block: expected exactly one mutant, found 2",
    ]);
  });

  test("an empty report is a diff for every row, never a pass", () => {
    expect(armOracleDiffs([])).toHaveLength(19);
  });
});
