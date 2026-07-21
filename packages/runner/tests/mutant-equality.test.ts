import { describe, expect, it } from "bun:test";
import { diffMutants, normalizeForComparison } from "../itest/mutant-equality";
import type { NormalizedMutant } from "../itest/mutant-equality";
import type { MutantOutcome, SessionReport } from "../src/report";

function outcome(
  overrides: Partial<MutantOutcome> & Pick<MutantOutcome, "mutantCode">,
): MutantOutcome {
  return {
    file: "SandboxLogic.Codeunit.al",
    line: 10,
    operatorName: "conditional-boundary",
    verdict: "survived",
    batchIndex: 0,
    astHash: `hash-${overrides.mutantCode}`,
    codeunitName: "Sandbox Logic",
    operatorMajor: 1,
    ...overrides,
  };
}

function report(mutants: readonly MutantOutcome[]): SessionReport {
  const counts = {
    killed: mutants.filter((m) => m.verdict === "killed").length,
    survived: mutants.filter((m) => m.verdict === "survived").length,
    noCoverage: mutants.filter((m) => m.verdict === "no-coverage").length,
    timeoutKilled: mutants.filter((m) => m.verdict === "timeout-killed").length,
    knownSurvivors: mutants.filter((m) => m.verdict === "known-survivor").length,
    unstable: mutants.filter((m) => m.cause === "unstable").length,
    errors: mutants.filter((m) => m.verdict === "error").length,
    deadlineExceeded: mutants.filter((m) => m.cause === "deadline-exceeded").length,
  };
  return {
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts,
    mutationScore: null,
    mutants,
    unsupportedTests: [],
  };
}

describe("normalizeForComparison", () => {
  it("projects each mutant to its semantic key plus the comparable fields, excluding duration/runId/version/artifactId", () => {
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "OverBudgetDetected" }),
      outcome({
        mutantCode: "M0002",
        file: "SandboxPricing.Codeunit.al",
        operatorName: "return-value",
        codeunitName: "Sandbox Pricing",
        astHash: "hash-M0002",
        verdict: "no-coverage",
      }),
      outcome({
        mutantCode: "M0003",
        verdict: "error",
        cause: "unstable",
        failureNote: "unstable test X: fails at baseline confirmation",
      }),
    ]);
    const normalized = normalizeForComparison(r);
    expect(normalized).toEqual([
      {
        key: "hash-M0001|Sandbox Logic|conditional-boundary|1",
        verdict: "killed",
        killingTest: "OverBudgetDetected",
        coverageFiltered: false,
        errorClass: null,
      },
      {
        key: "hash-M0002|Sandbox Pricing|return-value|1",
        verdict: "no-coverage",
        killingTest: null,
        coverageFiltered: true,
        errorClass: null,
      },
      {
        key: "hash-M0003|Sandbox Logic|conditional-boundary|1",
        verdict: "error",
        killingTest: null,
        coverageFiltered: false,
        errorClass: "unstable",
      },
    ]);
  });

  it("classifies an error verdict with no recorded cause as errorClass 'other', never null", () => {
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "error", failureNote: "bisected to mutant M0001" }),
    ]);
    const [normalized] = normalizeForComparison(r);
    expect(normalized?.errorClass).toBe("other");
  });
});

describe("diffMutants", () => {
  it("equal inputs produce []", () => {
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", verdict: "survived" }),
    ]);
    const normalized = normalizeForComparison(r);
    expect(diffMutants(normalized, normalized)).toEqual([]);
  });

  it("a fresh call producing byte-identical field values (but a new array) still diffs to []", () => {
    const before = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]),
    );
    const after = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]),
    );
    expect(diffMutants(before, after)).toEqual([]);
  });

  // THE central test this task exists to prove: aggregate counts (1 killed, 1 survived) are
  // IDENTICAL before and after — only which specific mutant holds which verdict changed. An
  // aggregate-counts-only comparison would see no regression at all. Per-mutant identity must
  // catch it, and must report exactly two differences (one per swapped mutant), not four
  // (one per changed field) and not one (collapsing both mutants into a single line).
  it("a swapped verdict between two mutants whose aggregate counts are identical produces two differences", () => {
    const before = normalizeForComparison(
      report([
        outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "OverBudgetDetected" }),
        outcome({
          mutantCode: "M0002",
          file: "SandboxLogic.Codeunit.al",
          operatorName: "return-value",
          astHash: "hash-M0002",
          verdict: "survived",
        }),
      ]),
    );
    const after = normalizeForComparison(
      report([
        outcome({ mutantCode: "M0001", verdict: "survived" }),
        outcome({
          mutantCode: "M0002",
          file: "SandboxLogic.Codeunit.al",
          operatorName: "return-value",
          astHash: "hash-M0002",
          verdict: "killed",
          killingTest: "OverBudgetDetected",
        }),
      ]),
    );

    // Aggregates alone are blind to this regression.
    expect(before.filter((m) => m.verdict === "killed").length).toBe(1);
    expect(after.filter((m) => m.verdict === "killed").length).toBe(1);
    expect(before.filter((m) => m.verdict === "survived").length).toBe(1);
    expect(after.filter((m) => m.verdict === "survived").length).toBe(1);

    const diffs = diffMutants(before, after);
    expect(diffs).toHaveLength(2);
    expect(diffs.some((d) => d.startsWith("mutant hash-M0001|"))).toBe(true);
    expect(diffs.some((d) => d.startsWith("mutant hash-M0002|"))).toBe(true);
    expect(diffs.some((d) => d.includes("verdict killed -> survived"))).toBe(true);
    expect(diffs.some((d) => d.includes("verdict survived -> killed"))).toBe(true);
  });

  it("flags a mutant missing from 'after'", () => {
    const before = normalizeForComparison(
      report([
        outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" }),
        outcome({ mutantCode: "M0002", verdict: "survived", astHash: "hash-M0002" }),
      ]),
    );
    const after = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]),
    );
    const diffs = diffMutants(before, after);
    expect(diffs).toEqual([
      'mutant hash-M0002|Sandbox Logic|conditional-boundary|1: present in "before" but missing from "after"',
    ]);
  });

  it("flags a mutant present only in 'after'", () => {
    const before = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]),
    );
    const after = normalizeForComparison(
      report([
        outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" }),
        outcome({ mutantCode: "M0002", verdict: "survived", astHash: "hash-M0002" }),
      ]),
    );
    const diffs = diffMutants(before, after);
    expect(diffs).toEqual([
      'mutant hash-M0002|Sandbox Logic|conditional-boundary|1: present in "after" but missing from "before"',
    ]);
  });

  it("flags a duplicate semantic identity within one side", () => {
    const dup: NormalizedMutant = {
      key: "same-key",
      verdict: "survived",
      killingTest: null,
      coverageFiltered: false,
      errorClass: null,
    };
    const diffs = diffMutants([dup, dup], [dup]);
    expect(diffs.some((d) => d.includes('appears 2 times in "before"'))).toBe(true);
  });

  it("ignores fields outside the comparable set — two runs with different mutantCode/duration/runId are not inputs to diffMutants at all", () => {
    // normalizeForComparison already drops mutantCode/duration/runId/version/artifactId — this
    // test documents that by constructing two differently-CODED but semantically-identical
    // reports and confirming they normalize to the same diff-free result.
    const before = normalizeForComparison(
      report([
        outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
      ]),
    );
    const after = normalizeForComparison(
      // renumbered (M0099, not M0001) but same semantic identity (same astHash) — the
      // regression gate must not confuse a mutant-code renumbering with a real change.
      report([
        outcome({ mutantCode: "M0099", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
      ]),
    );
    expect(diffMutants(before, after)).toEqual([]);
  });

  it("detects a coverageFiltered flip even when verdict text differs only by that", () => {
    const before = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "no-coverage" })]),
    );
    const after = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "survived" })]),
    );
    const diffs = diffMutants(before, after);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("verdict no-coverage -> survived");
    expect(diffs[0]).toContain("coverageFiltered true -> false");
  });

  it("detects an errorClass change even when verdict stays 'error'", () => {
    const before = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "error", cause: "unstable" })]),
    );
    const after = normalizeForComparison(
      report([outcome({ mutantCode: "M0001", verdict: "error", cause: "deadline-exceeded" })]),
    );
    const diffs = diffMutants(before, after);
    expect(diffs).toEqual([
      "mutant hash-M0001|Sandbox Logic|conditional-boundary|1: errorClass unstable -> deadline-exceeded",
    ]);
  });
});
