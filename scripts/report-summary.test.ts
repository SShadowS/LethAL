import { describe, expect, test } from "bun:test";
import { ReportFileError, parseReport, summarize } from "./report-summary.ts";

const REPORT = JSON.stringify({
  groupedCalls: 5,
  warmKills: 1,
  counts: { killed: 999 },
  mutants: [
    { verdict: "killed", operatorName: "lethal.return-value" },
    { verdict: "survived", operatorName: "lethal.return-value" },
    { verdict: "killed", operatorName: "lethal.empty-block" },
    { verdict: "no-coverage", operatorName: "lethal.empty-block" },
  ],
});

describe("report-summary", () => {
  test("totals by verdict and operator come from mutants[], plus group counters", () => {
    expect(summarize(parseReport(REPORT, "r.json"))).toBe(
      [
        "mutants: 4",
        "by verdict: killed 2 / no-coverage 1 / survived 1",
        "by operator:",
        "  lethal.empty-block: killed 1 / no-coverage 1",
        "  lethal.return-value: killed 1 / survived 1",
        "groupedCalls: 5",
        "warmKills: 1",
      ].join("\n"),
    );
  });
  test("group counters are omitted when the report has none", () => {
    expect(summarize(parseReport('{"mutants":[]}', "r.json"))).not.toContain("groupedCalls");
  });
  test("a file that is not a report is refused", () => {
    expect(() => parseReport("{}", "r.json")).toThrow(ReportFileError);
    expect(() => parseReport("nope", "r.json")).toThrow(ReportFileError);
    expect(() => parseReport('{"mutants":[{"verdict":"killed"}]}', "r.json")).toThrow(
      /mutants\[0\]/,
    );
  });
});
