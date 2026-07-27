import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { MAX_MUTATION_TEXT, clipMutationText } from "@lethal/schemata";
import { buildReport, renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";

/**
 * A survivor is only a finding if someone can act on it. Before this, a report entry said
 * `lethal.empty-block at line 6` and nothing else — not which span the operator chose, not what it
 * became, not which procedure it sits in, not which tests ran past it. Acting on that meant
 * re-opening the source at exactly the mutated revision and guessing.
 *
 * These pin the fields that make a survivor actionable, and the distinction that decides what to
 * DO about one: a survivor with covering tests wants a stronger assertion in an existing test; a
 * survivor with none wants a new test.
 */

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

function entry(over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: "M0001",
    file: "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al",
    startIndex: 4120,
    endIndex: 4171,
    startLine: 316,
    operatorName: "lethal.remove-setrange",
    operatorVersion: "1.0.0",
    astHash: "hash",
    objectType: "codeunit",
    codeunitId: 6175297,
    codeunitName: "CDO Send Cust. Statement Mgt.",
    procedureName: "IsCustomerStatementReport",
    originalText: 'CDOEMailTemplateLine.SetRange("Report ID", ReportId);',
    mutatedText: "",
    ...over,
  };
}

function build(outcomes: readonly SessionOutcome[]) {
  return buildReport({
    caps: CAPS,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    untargetedTriggerCount: 0,
    baselineTests: [],
  });
}

describe("MutantOutcome — a survivor carries everything needed to act on it", () => {
  test("states the mutation itself, not just where it happened", () => {
    const r = build([
      {
        mutant: entry(),
        verdict: "survived",
        batchIndex: 0,
        coveringTests: ["CDO Send Cust Statement Tests.SendsToCustomer"],
      },
    ]);
    const m = r.mutants[0];
    if (m === undefined) throw new Error("fixture drift");
    expect(m.originalText).toBe('CDOEMailTemplateLine.SetRange("Report ID", ReportId);');
    // A deletion operator's mutation IS the empty string — meaningful, not a missing field.
    expect(m.mutatedText).toBe("");
    expect(m.procedureName).toBe("IsCustomerStatementReport");
    expect(m.startIndex).toBe(4120);
    expect(m.endIndex).toBe(4171);
  });

  test("names the tests that ran past the survivor", () => {
    // The actionable part: these are the tests that already exercise this code and did not
    // notice the change, so this is where an assertion is missing.
    const r = build([
      {
        mutant: entry(),
        verdict: "survived",
        batchIndex: 0,
        coveringTests: ["Tests.A", "Tests.B"],
      },
    ]);
    expect(r.mutants[0]?.coveringTests).toEqual(["Tests.A", "Tests.B"]);
  });

  test("a no-coverage mutant reports NO covering tests, distinguishing 'needs a new test'", () => {
    // The two survivor kinds need opposite responses, and the only thing separating them in the
    // report is this list being empty. An absent field, or a placeholder, would collapse them.
    const r = build([{ mutant: entry(), verdict: "no-coverage", batchIndex: 0 }]);
    expect(r.mutants[0]?.coveringTests).toEqual([]);
  });

  test("a trigger-sited mutant names its trigger", () => {
    const r = build([
      {
        mutant: entry({ triggerName: "OnInsert", procedureName: "" }),
        verdict: "survived",
        batchIndex: 0,
      },
    ]);
    expect(r.mutants[0]?.triggerName).toBe("OnInsert");
  });
});

describe("clipMutationText", () => {
  test("passes an ordinary statement through whole", () => {
    const stmt = 'CDOEMailTemplateLine.SetRange("Report ID", ReportId);';
    expect(clipMutationText(stmt)).toBe(stmt);
  });

  test("marks a clipped fragment so it cannot be mistaken for the whole mutation", () => {
    // A block-rooted `empty-block` span can be an entire procedure body. Silently returning the
    // first N characters would read as complete text and mislead anyone acting on it.
    const long = "X".repeat(MAX_MUTATION_TEXT + 250);
    const clipped = clipMutationText(long);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped).toContain("truncated 250 chars");
    expect(clipped.startsWith("X".repeat(MAX_MUTATION_TEXT))).toBe(true);
  });

  test("does not clip at exactly the limit (off-by-one both ways)", () => {
    const exact = "Y".repeat(MAX_MUTATION_TEXT);
    expect(clipMutationText(exact)).toBe(exact);
    expect(clipMutationText(`${exact}Z`)).toContain("truncated 1 chars");
  });
});

describe("MutantOutcome.coverageAttribution — how much coveringTests is worth", () => {
  test("carries the attribution path through to the report", () => {
    const r = build([
      {
        mutant: entry(),
        verdict: "survived",
        batchIndex: 0,
        coveringTests: ["Tests.A"],
        coverageAttribution: "object",
      },
    ]);
    expect(r.mutants[0]?.coverageAttribution).toBe("object");
  });

  test("an exact match and an object-level fallback are DISTINGUISHABLE", () => {
    // The whole point. Both produce a non-empty coveringTests list, and reporting them
    // identically is approximate attribution wearing the costume of an exact one — the shape
    // that produced 10 false survivors out of 20 in R29. An agent told to strengthen a test
    // that never ran the mutated member is chasing nothing.
    const exact = build([
      {
        mutant: entry(),
        verdict: "survived",
        batchIndex: 0,
        coveringTests: ["Tests.A"],
        coverageAttribution: "exact",
      },
    ]);
    const coarse = build([
      {
        mutant: entry(),
        verdict: "survived",
        batchIndex: 0,
        coveringTests: ["Tests.A"],
        coverageAttribution: "object",
      },
    ]);
    expect(exact.mutants[0]?.coveringTests).toEqual(coarse.mutants[0]?.coveringTests);
    expect(exact.mutants[0]?.coverageAttribution).not.toBe(coarse.mutants[0]?.coverageAttribution);
  });
});

describe("SessionReport.validity — the score's own limits", () => {
  function withScope(over: Parameters<typeof buildReport>[0] extends infer T ? Partial<T> : never) {
    return buildReport({
      caps: CAPS,
      baselineGreen: true,
      batches: 1,
      outcomes: [{ mutant: entry(), verdict: "survived", batchIndex: 0 }],
      unsupportedTests: [],
      notInstrumented: { totalFiles: 551, files: [] },
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      untargetedTriggerCount: 0,
      baselineTests: [],
      ...over,
    });
  }

  test("a clean whole-project run is 'full' with no caveats", () => {
    const r = withScope({});
    expect(r.validity.reliability).toBe("full");
    expect(r.validity.caveats).toEqual([]);
  });

  test("a red baseline degrades the report and states the failing fraction", () => {
    // 105 failing tests means nothing without the denominator: "105 of 120" and "105 of 3000"
    // are different worlds, and the report used to carry only the numerator.
    const r = withScope({
      baselineGreen: false,
      unsupportedTests: ["A.x", "B.y"],
      baselineTests: [{ codeunitName: "A" }, { codeunitName: "B" }, { codeunitName: "C" }],
    });
    expect(r.validity.reliability).toBe("degraded");
    expect(r.validity.caveats).toContain("baseline-red");
    expect(r.validity.baselineTests).toEqual({ total: 3, failing: 2 });
    expect(r.validity.scoreDescribes).toContain("2 of 3 baseline tests failing");
  });

  test("narrowing and a red baseline compound rather than mask each other", () => {
    const r = withScope({
      baselineGreen: false,
      unsupportedTests: ["A.x"],
      baselineTests: [{ codeunitName: "A" }],
      only: { patterns: ["Al/Codeunit/**"], excludedFileCount: 550 },
    });
    expect(r.validity.reliability).toBe("narrowed-degraded");
    expect(r.validity.caveats).toEqual(expect.arrayContaining(["baseline-red", "narrowed"]));
  });

  test("scoredMutants names the denominator the score is actually computed over", () => {
    const r = withScope({
      outcomes: [
        { mutant: entry({ mutantId: "M1" }), verdict: "survived", batchIndex: 0 },
        { mutant: entry({ mutantId: "M2" }), verdict: "killed", batchIndex: 0 },
        { mutant: entry({ mutantId: "M3" }), verdict: "no-coverage", batchIndex: 0 },
        { mutant: entry({ mutantId: "M4" }), verdict: "error", batchIndex: 0 },
      ],
    });
    // 4 recorded, but only survived+killed are scoreable — the gap is the point.
    expect(r.validity.scoredMutants).toEqual({ scored: 2, recorded: 4 });
  });
});

describe("SessionReport.survivorsByProcedure — the ranking input", () => {
  test("groups survivors by procedure, most survivors first, referencing mutant codes", () => {
    const r = build([
      {
        mutant: entry({ mutantId: "M1", procedureName: "Alpha" }),
        verdict: "survived",
        batchIndex: 0,
      },
      {
        mutant: entry({ mutantId: "M2", procedureName: "Beta" }),
        verdict: "survived",
        batchIndex: 0,
      },
      {
        mutant: entry({ mutantId: "M3", procedureName: "Beta" }),
        verdict: "survived",
        batchIndex: 0,
      },
      {
        mutant: entry({ mutantId: "M4", procedureName: "Beta" }),
        verdict: "killed",
        batchIndex: 0,
      },
    ]);
    expect(r.survivorsByProcedure.map((g) => g.procedureName)).toEqual(["Beta", "Alpha"]);
    const beta = r.survivorsByProcedure[0];
    expect(beta?.survived).toBe(2);
    expect(beta?.killed).toBe(1);
    // References, not copies — the full records stay in `mutants[]` exactly once.
    expect(beta?.survivorCodes).toEqual(["M2", "M3"]);
  });

  test("a procedure with no survivors is omitted entirely", () => {
    const r = build([
      {
        mutant: entry({ mutantId: "M1", procedureName: "AllGood" }),
        verdict: "killed",
        batchIndex: 0,
      },
    ]);
    expect(r.survivorsByProcedure).toEqual([]);
  });
});

describe("SessionReport.testsOnly — the narrowing that can manufacture a survivor (R45)", () => {
  test("is flagged distinctly from --only, because only this one can change a verdict", () => {
    const r = buildReport({
      caps: CAPS,
      baselineGreen: true,
      batches: 1,
      outcomes: [{ mutant: entry(), verdict: "survived", batchIndex: 0 }],
      unsupportedTests: [],
      notInstrumented: { totalFiles: 551, files: [] },
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      untargetedTriggerCount: 0,
      baselineTests: [],
      testsOnly: ["Src/Documents/**"],
    });
    expect(r.testsOnly).toEqual(["Src/Documents/**"]);
    // Distinct caveat strings: a reader must be able to tell "fewer mutants ran" from "fewer
    // TESTS ran", because only the latter means a survivor might have been killable.
    expect(r.validity.caveats).toContain("tests-narrowed");
    expect(r.validity.caveats).not.toContain("narrowed");
    // And it must degrade reliability on its own, without --only present.
    expect(r.validity.reliability).toBe("narrowed");
  });
});

describe("MutantOutcome.guardObserved — was the survivor ever exercised?", () => {
  test("false marks a survivor that no guard fired for", () => {
    const r = build([
      {
        mutant: entry(),
        verdict: "survived",
        batchIndex: 0,
        coveringTests: ["Tests.A"],
        guardObserved: false,
      },
    ]);
    expect(r.mutants[0]?.guardObserved).toBe(false);
  });

  test("absent is NOT the same as false", () => {
    // Absent means "not measured" — al-runner has no attestation mechanism at all. Collapsing it
    // to false would accuse every al-runner survivor of never being exercised.
    const r = build([{ mutant: entry(), verdict: "survived", batchIndex: 0 }]);
    expect(r.mutants[0]?.guardObserved).toBeUndefined();
  });

  test("the console calls out unexercised survivors and says they are not suite gaps", () => {
    // The asymmetry that matters: a survivor no guard fired for was never given a chance to fail,
    // so reporting it as a test-suite weakness overstates the suite. `IsActive` is a bare string
    // compare, so an unactivated mutant is byte-identical to baseline and "the test passed"
    // proves nothing — R32 had to establish this by hand after R29's 10 false survivors.
    const text = renderConsole(
      build([
        {
          mutant: entry({ mutantId: "M0009" }),
          verdict: "survived",
          batchIndex: 0,
          guardObserved: false,
        },
        {
          mutant: entry({ mutantId: "M0010" }),
          verdict: "survived",
          batchIndex: 0,
          guardObserved: true,
        },
      ]),
    );
    expect(text).toContain("UNEXERCISED SURVIVORS");
    expect(text).toContain("M0009");
    const line = text.split("\n").find((l) => l.startsWith("UNEXERCISED SURVIVORS")) ?? "";
    expect(line).not.toContain("M0010");
  });

  test("says nothing when every survivor was observed", () => {
    const text = renderConsole(
      build([{ mutant: entry(), verdict: "survived", batchIndex: 0, guardObserved: true }]),
    );
    expect(text).not.toContain("UNEXERCISED SURVIVORS");
  });
});
