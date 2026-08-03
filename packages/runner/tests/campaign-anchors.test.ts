import { describe, expect, test } from "bun:test";
import { assertCardinality, checkAnchors, notInstrumentedOracle } from "../src/campaign-anchors";
import type { SessionReport } from "../src/report";

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
      reportWith([{ verdict: "killed", line: 100 }], { baselineGreen: false }),
      CFG,
    );
    const a1 = r.find((a) => a.id === "baseline-green");
    expect(a1?.passed).toBe(false);
  });

  test("anchor 2 fails when a COVERED mutant sits outside the covered procedure", () => {
    const r = checkAnchors(
      reportWith([
        { verdict: "killed", line: 100 },
        { verdict: "survived", line: 900 }, // outside SendPeriodStatements
      ]),
      CFG,
    );
    const a2 = r.find((a) => a.id === "coverage-location");
    expect(a2?.passed).toBe(false);
    expect(a2?.detail).toContain("900");
  });

  test("anchor 2 ALLOWS an object-level-attributed covered mutant outside the range", () => {
    const r = checkAnchors(
      reportWith([
        { verdict: "killed", line: 100 },
        { verdict: "survived", line: 900, coverageAttribution: "object" },
      ]),
      CFG,
    );
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(true);
  });

  test("anchor 2 ALLOWS a new-operator mutant INSIDE the range to be covered", () => {
    const r = checkAnchors(
      reportWith([{ verdict: "killed", line: 150, operatorName: "lethal.swap-call-arguments" }]),
      CFG,
    );
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(true);
  });

  test("anchor 4 fails when nothing was killed", () => {
    const r = checkAnchors(reportWith([{ verdict: "survived", line: 100 }]), CFG);
    expect(r.find((a) => a.id === "killed-at-least-one")?.passed).toBe(false);
  });

  test("the empty-report guards: coverage-location and killed-at-least-one both fail on an empty report", () => {
    // baseline-green is deliberately excluded here: "was the baseline green" is genuinely
    // independent of mutant count, so an empty report with baselineGreen: true is a real state
    // and this anchor legitimately passes on it. assertCardinality is the actual empty-report
    // gate — these two anchors just fail explicitly too, as a courtesy, rather than passing
    // vacuously via filter/every-on-empty.
    const r = checkAnchors(reportWith([]), CFG);
    expect(r.find((a) => a.id === "coverage-location")?.passed).toBe(false);
    expect(r.find((a) => a.id === "killed-at-least-one")?.passed).toBe(false);
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
