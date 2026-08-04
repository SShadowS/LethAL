import { describe, expect, test } from "bun:test";
import {
  assertCardinality,
  checkAnchors,
  notInstrumentedOracle,
  reconcileNotInstrumented,
} from "../src/campaign-anchors";
import type { CardinalityVerifiedReport } from "../src/campaign-anchors";
import type { SessionReport } from "../src/report";

/**
 * `checkAnchors` takes a report whose cardinality has already been verified — the precondition is
 * the parameter type now, not a doc comment. These tests are about the anchors, not the count, so
 * they verify against the report's own length; a real gate reads the count from a config committed
 * before the run (see `campaign-anchors-run.test.ts`).
 */
function verifiedForAnchors(report: SessionReport): CardinalityVerifiedReport {
  return assertCardinality(report, report.mutants.length, "test");
}

/** Minimal report fixture. Only the fields the anchors read are populated. */
function reportWith(
  mutants: readonly Partial<SessionReport["mutants"][number]>[],
  extra: Partial<SessionReport> = {},
): SessionReport {
  const full = mutants.map((m, i) => ({
    mutantCode: m.mutantCode ?? `M${String(i).padStart(4, "0")}`,
    file: m.file ?? "Codeunit 6175297 CDO Send Cust. Statement Mgt.al",
    line: m.line ?? 100,
    operatorName: m.operatorName ?? "lethal.negate-conditional",
    verdict: m.verdict ?? "no-coverage",
    batchIndex: 0,
    durationMs: 0,
    ...(m.guardObserved !== undefined ? { guardObserved: m.guardObserved } : {}),
    ...(m.coverageAttribution !== undefined ? { coverageAttribution: m.coverageAttribution } : {}),
  }));
  return {
    mutants: full,
    unsupportedTests: [],
    baselineGreen: true,
    baselineTestCount: 56,
    ...extra,
  } as unknown as SessionReport;
}

const CFG = {
  coveredProcedureRanges: [{ name: "SendPeriodStatements", startLine: 90, endLine: 200 }],
  expectedBaselineTests: 56,
};

describe("assertCardinality", () => {
  test("throws when the report holds fewer mutants than pre-committed", () => {
    expect(() => assertCardinality(reportWith([{}, {}]), 176, "rung 1")).toThrow(
      /rung 1.*expected 176.*got 2/,
    );
  });

  test("throws on an EMPTY report — the empty-vs-empty door", () => {
    expect(() => assertCardinality(reportWith([]), 176, "rung 1")).toThrow(/got 0/);
  });

  test("passes on the exact pre-committed count", () => {
    const many = Array.from({ length: 176 }, () => ({}));
    expect(() => assertCardinality(reportWith(many), 176, "rung 1")).not.toThrow();
  });
});

describe("checkAnchors", () => {
  test("anchor 1 fails when the baseline was not fully green", () => {
    const r = checkAnchors(
      verifiedForAnchors(reportWith([{ verdict: "killed", line: 100 }], { baselineGreen: false })),
      CFG,
    );
    const a1 = r.find((a) => a.id === "baseline-green");
    expect(a1?.passed).toBe(false);
  });

  test("anchor 2 fails when a COVERED mutant sits outside the covered procedure", () => {
    const r = checkAnchors(
      verifiedForAnchors(
        reportWith([
          { verdict: "killed", line: 100 },
          { verdict: "survived", line: 900 }, // outside SendPeriodStatements
        ]),
      ),
      CFG,
    );
    const a2 = r.find((a) => a.id === "coverage-location");
    expect(a2?.passed).toBe(false);
    expect(a2?.detail).toContain("900");
  });

  test("anchor 2 ALLOWS an object-level-attributed covered mutant outside the range", () => {
    const r = checkAnchors(
      verifiedForAnchors(
        reportWith([
          { verdict: "killed", line: 100 },
          { verdict: "survived", line: 900, coverageAttribution: "object" },
        ]),
      ),
      CFG,
    );
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(true);
  });

  test("anchor 2 ALLOWS a new-operator mutant INSIDE the range to be covered", () => {
    const r = checkAnchors(
      verifiedForAnchors(
        reportWith([{ verdict: "killed", line: 150, operatorName: "lethal.swap-call-arguments" }]),
      ),
      CFG,
    );
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(true);
  });

  test("anchor 4 fails when nothing was killed", () => {
    const r = checkAnchors(
      verifiedForAnchors(reportWith([{ verdict: "survived", line: 100 }])),
      CFG,
    );
    expect(r.find((a) => a.id === "killed-at-least-one")?.passed).toBe(false);
  });

  test("the empty-report guards: coverage-location and killed-at-least-one both fail on an empty report", () => {
    // baseline-green is deliberately excluded here: "was the baseline green" is genuinely
    // independent of mutant count, so an empty report with baselineGreen: true is a real state
    // and this anchor legitimately passes on it. assertCardinality is the actual empty-report
    // gate — these two anchors just fail explicitly too, as a courtesy, rather than passing
    // vacuously via filter/every-on-empty.
    const r = checkAnchors(verifiedForAnchors(reportWith([])), CFG);
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(false);
    expect(r.find((a) => a.id === "killed-at-least-one")?.passed).toBe(false);
  });
});

describe("the cardinality precondition is structural", () => {
  test("checkAnchors throws when the verified report is mutated after verification", () => {
    // The type-level brand cannot see this: the token was minted honestly and then the report it
    // describes changed underneath it. A gate that can be entered with an unverified report is
    // not a gate, so the runtime re-check is not redundant with the parameter type.
    const r = reportWith([{ verdict: "killed", line: 100 }]);
    const v = assertCardinality(r, 1, "rung 1");
    (r as unknown as Record<string, unknown>).mutants = [];
    expect(() => checkAnchors(v, CFG)).toThrow(/verification token does not describe this report/);
  });
});

/** A report whose `notInstrumented.files` list is what the reconciliation puts on trial. */
function reportListing(files: readonly string[]): SessionReport {
  const r = reportWith([{ verdict: "killed", line: 100 }]);
  return {
    ...r,
    notInstrumented: {
      totalFiles: files.length,
      fileCount: files.length,
      siteCount: files.length,
      files: files.map((f) => ({ file: f, kinds: "unknown", sites: 1 })),
    },
  } as unknown as SessionReport;
}

describe("reconcileNotInstrumented", () => {
  test("passes when every file the report calls uninstrumentable really is, by object header", () => {
    const rec = reconcileNotInstrumented(reportListing(["Page/P.al", "Report/R.al"]), [
      { path: "Page/P.al", source: 'page 6175272 "P" { }' },
      { path: "Report/R.al", source: 'report 6175273 "R" { }' },
    ]);
    expect(rec.passed).toBe(true);
    expect(rec.checked).toBe(2);
  });

  test("FAILS, naming the file, when the report claims uninstrumentable and the header says codeunit", () => {
    const rec = reconcileNotInstrumented(reportListing(["Page/P.al", "Codeunit/C.al"]), [
      { path: "Page/P.al", source: 'page 6175272 "P" { }' },
      { path: "Codeunit/C.al", source: 'codeunit 6175271 "C" { }' },
    ]);
    expect(rec.passed).toBe(false);
    expect(rec.offenders).toEqual(["Codeunit/C.al"]);
    expect(rec.detail).toContain("Codeunit/C.al");
  });

  test("throws rather than reconciling a subset when a listed file's source is missing", () => {
    expect(() =>
      reconcileNotInstrumented(reportListing(["Page/P.al", "Report/R.al"]), [
        { path: "Page/P.al", source: 'page 6175272 "P" { }' },
      ]),
    ).toThrow(/no source supplied for 1 file/);
  });

  test("throws when handed a file the report never listed — it classifies the report's own claims", () => {
    expect(() =>
      reconcileNotInstrumented(reportListing(["Page/P.al"]), [
        { path: "Page/P.al", source: 'page 6175272 "P" { }' },
        { path: "Codeunit/Other.al", source: 'codeunit 6175271 "Other" { }' },
      ]),
    ).toThrow(/not in the report's notInstrumented list/);
  });

  test("an empty list is NOT a pass — `instrumentable === 0` over zero files is vacuous", () => {
    const rec = reconcileNotInstrumented(reportListing([]), []);
    expect(rec.passed).toBe(false);
    expect(rec.detail).toContain("vacuous");
  });
});

describe("notInstrumentedOracle", () => {
  test("counts by object header kind, independent of LethAL's own accounting", () => {
    const files = [
      { path: "a.al", source: 'codeunit 6175271 "A" { }' },
      { path: "b.al", source: 'page 6175272 "B" { }' },
      { path: "c.al", source: 'tableextension 6175273 "C" extends Customer { }' },
    ];
    const o = notInstrumentedOracle(files);
    expect(o.instrumentable).toBe(1);
    expect(o.notInstrumentable).toBe(2);
    expect(o.byKind.page).toBe(1);
    expect(o.byKind.tableextension).toBe(1);
  });
});
