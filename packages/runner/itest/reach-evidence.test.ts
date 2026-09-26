import { describe, expect, test } from "bun:test";
import type { MutantOutcome, SessionReport } from "../src/report";
import {
  type DirectTransportProbe,
  type ReachControlRun,
  assertDirectTransportReach,
  assertEveryMutantHasReachGrain,
  assertKilledStatementGrainReached,
  assertNoReachAttestation,
  assertNonStatementGrainHasNoGuardReached,
  assertReachControl,
  assertReachEvidence,
  assertReachIdenticalAcrossLegs,
  assertReachedByWithinCoveringTests,
  assertSurvivedStatementGrainReachDefined,
  reachGrainCounts,
  reachSplit,
  reachSummaryLine,
} from "./reach-evidence";

/**
 * GH-24 Task 5. One test per bullet in `task-5-brief.md`: each feeds a hand-built report breaking
 * EXACTLY that bullet and nothing else, and expects a throw naming the mutant code (or, for the
 * direct-transport check, the probe label). Mirrors the fixture shape `explain.test.ts` already
 * uses for a literal `SessionReport` — a run-shaped builder would hide exactly the malformed
 * inputs these checks exist to catch.
 */

function mutant(over: Partial<MutantOutcome> & { mutantCode: string }): MutantOutcome {
  return {
    file: "src/Posting/Foo.Codeunit.al",
    line: 42,
    operatorName: "lethal.negate-conditional",
    verdict: "survived",
    batchIndex: 0,
    durationMs: 10,
    procedureName: "ComputeTotal",
    startIndex: 100,
    endIndex: 110,
    originalText: "Qty > 0",
    mutatedText: "Qty <= 0",
    coveringTests: [],
    runner: "fenced",
    astHash: `hash-${over.mutantCode}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
    ...over,
  };
}

function reportOf(mutants: readonly MutantOutcome[]): SessionReport {
  return {
    schemaVersion: 2,
    validity: {
      reliability: "full",
      caveats: [],
      scoreDescribes: "the whole project",
      baselineTests: { total: 1, failing: 0 },
      scoredMutants: { scored: mutants.length, recorded: mutants.length },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: mutants.length,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: mutants.filter((m) => m.verdict === "killed").length,
      survived: mutants.filter((m) => m.verdict === "survived").length,
      noCoverage: 0,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: null,
    mutants,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 1,
      generateMutationSetMs: 1,
      deployMs: 1,
      baselineMs: 1,
      mutantsMs: 1,
      perMutant: { count: 1, meanMs: 1, medianMs: 1, p95Ms: 1, maxMs: 1 },
    },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    unplaceableCount: 0,
    unplaceableMutants: [],
  };
}

describe("assertKilledStatementGrainReached (ruling 2: a BLOCK)", () => {
  test("a killed statement-grain mutant with guardReached true passes", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0001",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["Foo.Bar"],
      }),
    ]);
    expect(() => assertKilledStatementGrainReached(report)).not.toThrow();
  });

  test("a killed statement-grain mutant with guardReached false THROWS naming the mutant code", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0002",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: false,
        reachedBy: [],
      }),
    ]);
    expect(() => assertKilledStatementGrainReached(report)).toThrow(/M0002/);
  });

  test("a killed statement-grain mutant with guardReached undefined (unmeasured) also THROWS", () => {
    const report = reportOf([
      mutant({ mutantCode: "M0003", verdict: "killed", reachGrain: "statement" }),
    ]);
    expect(() => assertKilledStatementGrainReached(report)).toThrow(/M0003/);
  });

  test("a killed ENCLOSING-grain mutant is not decided and does not throw", () => {
    const report = reportOf([
      mutant({ mutantCode: "M0004", verdict: "killed", reachGrain: "enclosing" }),
    ]);
    expect(() => assertKilledStatementGrainReached(report)).not.toThrow();
  });
});

describe("assertSurvivedStatementGrainReachDefined", () => {
  test("a survived statement-grain mutant with guardReached defined (true or false) passes", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0010",
        verdict: "survived",
        reachGrain: "statement",
        guardReached: false,
        reachedBy: [],
      }),
    ]);
    expect(() => assertSurvivedStatementGrainReachDefined(report)).not.toThrow();
  });

  test("a survived statement-grain mutant with NO guardReached THROWS naming the mutant code", () => {
    const report = reportOf([
      mutant({ mutantCode: "M0011", verdict: "survived", reachGrain: "statement" }),
    ]);
    expect(() => assertSurvivedStatementGrainReachDefined(report)).toThrow(/M0011/);
  });
});

describe("assertNonStatementGrainHasNoGuardReached", () => {
  test("an enclosing-grain mutant with no guardReached passes", () => {
    const report = reportOf([
      mutant({ mutantCode: "M0020", verdict: "survived", reachGrain: "enclosing" }),
    ]);
    expect(() => assertNonStatementGrainHasNoGuardReached(report)).not.toThrow();
  });

  test("an enclosing-grain mutant carrying guardReached THROWS naming the mutant code", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0021",
        verdict: "killed",
        reachGrain: "enclosing",
        guardReached: true,
        reachedBy: ["X"],
      }),
    ]);
    expect(() => assertNonStatementGrainHasNoGuardReached(report)).toThrow(/M0021/);
  });

  test("an unplaced-grain mutant carrying guardReached also THROWS", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0022",
        verdict: "survived",
        reachGrain: "unplaced",
        guardReached: false,
        reachedBy: [],
      }),
    ]);
    expect(() => assertNonStatementGrainHasNoGuardReached(report)).toThrow(/M0022/);
  });
});

describe("assertReachedByWithinCoveringTests", () => {
  test("reachedBy names only tests already in coveringTests passes", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0030",
        verdict: "killed",
        reachGrain: "statement",
        coveringTests: ["Foo Tests.A", "Foo Tests.B"],
        guardReached: true,
        reachedBy: ["Foo Tests.A"],
      }),
    ]);
    expect(() => assertReachedByWithinCoveringTests(report)).not.toThrow();
  });

  test("a reachedBy entry outside coveringTests THROWS naming the mutant code", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0031",
        verdict: "killed",
        reachGrain: "statement",
        coveringTests: ["Foo Tests.A"],
        guardReached: true,
        reachedBy: ["Foo Tests.Ghost"],
      }),
    ]);
    expect(() => assertReachedByWithinCoveringTests(report)).toThrow(/M0031/);
  });
});

describe("assertEveryMutantHasReachGrain", () => {
  test("every mutant carrying a reachGrain passes", () => {
    const report = reportOf([mutant({ mutantCode: "M0040", reachGrain: "unplaced" })]);
    expect(() => assertEveryMutantHasReachGrain(report)).not.toThrow();
  });

  test("a mutant with no reachGrain THROWS naming the mutant code", () => {
    const report = reportOf([mutant({ mutantCode: "M0041" })]);
    expect(() => assertEveryMutantHasReachGrain(report)).toThrow(/M0041/);
  });
});

describe("assertNoReachAttestation (al-runner: no attestation exists there)", () => {
  test("no mutant carrying guardReached passes", () => {
    const report = reportOf([
      mutant({ mutantCode: "M0050", verdict: "killed", reachGrain: "statement" }),
    ]);
    expect(() => assertNoReachAttestation(report)).not.toThrow();
  });

  test("any mutant carrying guardReached THROWS naming the mutant code, even statement-grain", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0051",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["X"],
      }),
    ]);
    expect(() => assertNoReachAttestation(report)).toThrow(/M0051/);
  });
});

describe("assertReachIdenticalAcrossLegs (chunked: reach must not move across legs)", () => {
  test("identical guardReached and reachedBy-as-a-set across legs passes", () => {
    const control = reportOf([
      mutant({
        mutantCode: "M0060",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["A", "B"],
      }),
    ]);
    // Same set, different ORDER — "as sets" means order must not matter.
    const chunked = reportOf([
      mutant({
        mutantCode: "M0060",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["B", "A"],
      }),
    ]);
    expect(() => assertReachIdenticalAcrossLegs(control, chunked)).not.toThrow();
  });

  test("guardReached differing across legs THROWS naming the mutant code", () => {
    const control = reportOf([
      mutant({
        mutantCode: "M0061",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["A"],
      }),
    ]);
    const chunked = reportOf([
      mutant({
        mutantCode: "M0061",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: false,
        reachedBy: [],
      }),
    ]);
    expect(() => assertReachIdenticalAcrossLegs(control, chunked)).toThrow(/M0061/);
  });

  test("reachedBy differing as a SET across legs THROWS naming the mutant code", () => {
    const control = reportOf([
      mutant({
        mutantCode: "M0062",
        verdict: "survived",
        reachGrain: "statement",
        guardReached: false,
        reachedBy: [],
      }),
    ]);
    const chunked = reportOf([
      mutant({
        mutantCode: "M0062",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["Some.Test"],
      }),
    ]);
    expect(() => assertReachIdenticalAcrossLegs(control, chunked)).toThrow(/M0062/);
  });
});

describe("assertDirectTransportReach (bcdev's direct-transport attestation check)", () => {
  function probe(over: Partial<DirectTransportProbe> & { label: string }): DirectTransportProbe {
    return {
      verdict: { outcome: "pass", reachedActive: false },
      baseline: false,
      ...over,
    };
  }

  test("a ran verdict with a boolean reachedActive, false on baseline, passes", () => {
    const probes = [
      probe({ label: "order", baseline: true, verdict: { outcome: "pass", reachedActive: false } }),
      probe({
        label: "mutated",
        baseline: false,
        verdict: { outcome: "fail", reachedActive: true },
      }),
    ];
    expect(() => assertDirectTransportReach(probes)).not.toThrow();
  });

  test("a ran verdict with no boolean reachedActive THROWS naming the probe label", () => {
    const probes = [probe({ label: "mutated", baseline: false, verdict: { outcome: "fail" } })];
    expect(() => assertDirectTransportReach(probes)).toThrow(/mutated/);
  });

  test("a baseline run reporting reachedActive true THROWS naming the probe label", () => {
    const probes = [
      probe({
        label: "cleared",
        baseline: true,
        verdict: { outcome: "pass", reachedActive: true },
      }),
    ];
    expect(() => assertDirectTransportReach(probes)).toThrow(/cleared/);
  });

  test("a non-ran (error) verdict is not required to carry reachedActive", () => {
    const probes = [probe({ label: "mismatch", baseline: false, verdict: { outcome: "error" } })];
    expect(() => assertDirectTransportReach(probes)).not.toThrow();
  });
});

describe("reachGrainCounts / reachSplit / reachSummaryLine (the printed split)", () => {
  test("counts grain and split correctly, including the absent-grain and unmeasured cases", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0070",
        verdict: "killed",
        reachGrain: "statement",
        guardReached: true,
        reachedBy: ["A"],
      }),
      mutant({
        mutantCode: "M0071",
        verdict: "survived",
        reachGrain: "statement",
        guardReached: false,
        reachedBy: [],
      }),
      mutant({ mutantCode: "M0072", verdict: "error", reachGrain: "statement" }),
      mutant({ mutantCode: "M0073", verdict: "survived", reachGrain: "enclosing" }),
      mutant({ mutantCode: "M0074", verdict: "survived", reachGrain: "unplaced" }),
      mutant({ mutantCode: "M0075", verdict: "survived" }),
    ]);
    expect(reachGrainCounts(report)).toEqual({ statement: 3, enclosing: 1, unplaced: 1, none: 1 });
    expect(reachSplit(report)).toEqual({ reached: 1, notReached: 1, unmeasured: 1 });
    const line = reachSummaryLine(report);
    expect(line).toContain("statement=3");
    expect(line).toContain("enclosing=1");
    expect(line).toContain("unplaced=1");
    expect(line).toContain("none=1");
    expect(line).toContain("true=1");
    expect(line).toContain("false=1");
    expect(line).toContain("unmeasured=1");
  });
});

describe("assertReachEvidence (the combined wiring bcdev/tables/chunked/envtool call)", () => {
  test("a clean report of every grain passes all five bullets at once", () => {
    const report = reportOf([
      mutant({
        mutantCode: "M0080",
        verdict: "killed",
        reachGrain: "statement",
        coveringTests: ["Foo Tests.A"],
        guardReached: true,
        reachedBy: ["Foo Tests.A"],
      }),
      mutant({
        mutantCode: "M0081",
        verdict: "survived",
        reachGrain: "statement",
        coveringTests: ["Foo Tests.B"],
        guardReached: false,
        reachedBy: [],
      }),
      mutant({ mutantCode: "M0082", verdict: "survived", reachGrain: "enclosing" }),
    ]);
    expect(() => assertReachEvidence(report)).not.toThrow();
  });

  test("a single broken bullet still fails the combined check, naming the mutant code", () => {
    const report = reportOf([
      mutant({ mutantCode: "M0083", verdict: "killed", reachGrain: "statement" }),
    ]);
    expect(() => assertReachEvidence(report)).toThrow(/M0083/);
  });
});

describe("assertReachControl (GH-24 Task 6: the live negative control on itest:tables)", () => {
  const TAKER = "Data Tests.ReachTakesBranch";
  const SKIPPER = "Data Tests.ReachWithoutBranch";

  // The arm as the pre-commitment predicts it: two inside-branch controls reached by the first test
  // only, one enclosing mutant with no reach at all.
  function control(over: Partial<MutantOutcome> & { mutantCode: string }): MutantOutcome {
    return mutant({
      codeunitName: "Data Reach Ops",
      procedureName: "Classify",
      verdict: "survived",
      reachGrain: "statement",
      coveringTests: [TAKER, SKIPPER],
      guardReached: true,
      reachedBy: [TAKER],
      ...over,
    });
  }
  function armReport(overrides: Record<string, Partial<MutantOutcome>> = {}): SessionReport {
    return reportOf([
      control({
        mutantCode: "M0243",
        operatorName: "lethal.remove-assignment",
        originalText: "Seen := Amount",
        ...overrides.M0243,
      }),
      control({
        mutantCode: "M0242",
        operatorName: "lethal.empty-block",
        originalText: "begin\n            Seen := Amount;\n        end",
        ...overrides.M0242,
      }),
      // The body-level empty-block also contains `Seen := Amount`, so the gate must tell it apart.
      control({
        mutantCode: "M0240",
        operatorName: "lethal.empty-block",
        verdict: "killed",
        originalText:
          "begin\n        if Amount > 100 then begin\n            Seen := Amount;\n        end;\n        exit(Amount);\n    end",
      }),
      // Built without `control`'s reach defaults: an enclosing mutant carries none.
      mutant({
        mutantCode: "M0245",
        codeunitName: "Data Reach Ops",
        procedureName: "Classify",
        operatorName: "lethal.void-method-call",
        originalText: "Touch()",
        coveringTests: [TAKER, SKIPPER],
        reachGrain: "enclosing",
        ...overrides.M0245,
      }),
    ]);
  }
  function rowsFor(
    mutantCode: string,
    methods: readonly string[],
    sessionId = 7,
  ): ReachControlRun[] {
    return methods.map((method) => ({
      mutantCode,
      batchIndex: 0,
      method,
      outcome: "pass",
      opKind: "many",
      sessionId,
    }));
  }
  const goodRuns = (): ReachControlRun[] => [
    ...rowsFor("M0243", ["ReachTakesBranch", "ReachWithoutBranch"], 7),
    ...rowsFor("M0242", ["ReachTakesBranch", "ReachWithoutBranch"], 8),
  ];
  const goodBaseline = (): DirectTransportProbe[] => [
    {
      label: "ReachTakesBranch",
      verdict: { outcome: "pass", reachedActive: false },
      baseline: true,
    },
    {
      label: "ReachWithoutBranch",
      verdict: { outcome: "pass", reachedActive: false },
      baseline: true,
    },
  ];

  test("the predicted arm passes", () => {
    expect(() => assertReachControl(armReport(), goodRuns(), goodBaseline())).not.toThrow();
  });

  test("the root-grain bug (the skipper reached too) THROWS naming the control", () => {
    const report = armReport({ M0243: { reachedBy: [SKIPPER, TAKER] } });
    expect(() => assertReachControl(report, goodRuns(), goodBaseline())).toThrow(/M0243/);
  });

  test("the no-reset bug (per-entry values [true, true]) THROWS naming the control", () => {
    const report = armReport({ M0243: { reachedBy: [TAKER, SKIPPER] } });
    expect(() => assertReachControl(report, goodRuns(), goodBaseline())).toThrow(
      /M0243.*\[true,true\]/,
    );
  });

  test("ReachWithoutBranch missing from the run THROWS: a reset needs a false AFTER a true", () => {
    const runs = [
      ...rowsFor("M0243", ["ReachTakesBranch"], 7),
      ...rowsFor("M0242", ["ReachTakesBranch", "ReachWithoutBranch"], 8),
    ];
    expect(() => assertReachControl(armReport(), runs, goodBaseline())).toThrow(
      /M0243.*ReachWithoutBranch/,
    );
  });

  test("the two tests in reversed order THROWS: the set alone does not prove the reset", () => {
    const runs = [
      ...rowsFor("M0243", ["ReachWithoutBranch", "ReachTakesBranch"], 7),
      ...rowsFor("M0242", ["ReachTakesBranch", "ReachWithoutBranch"], 8),
    ];
    expect(() => assertReachControl(armReport(), runs, goodBaseline())).toThrow(/M0243/);
  });

  test("the two tests in two calls (two session ids) THROWS: the reset is inside ONE call", () => {
    // Each call on its own reads true/false correctly; only the session ids say they were two calls.
    const runs = [
      ...rowsFor("M0243", ["ReachTakesBranch"], 7),
      ...rowsFor("M0243", ["ReachWithoutBranch"], 9),
      ...rowsFor("M0242", ["ReachTakesBranch", "ReachWithoutBranch"], 8),
    ];
    expect(() => assertReachControl(armReport(), runs, goodBaseline())).toThrow(/M0243.*one/);
  });

  test("the then-block empty-block reached by both THROWS naming it", () => {
    const report = armReport({ M0242: { reachedBy: [TAKER, SKIPPER] } });
    expect(() => assertReachControl(report, goodRuns(), goodBaseline())).toThrow(/M0242/);
  });

  test("the enclosing mutant carrying guardReached THROWS naming it", () => {
    const report = armReport({ M0245: { guardReached: true, reachedBy: [TAKER] } });
    expect(() => assertReachControl(report, goodRuns(), goodBaseline())).toThrow(/M0245/);
  });

  test("the enclosing mutant at statement grain THROWS naming it", () => {
    const report = armReport({ M0245: { reachGrain: "statement" } });
    expect(() => assertReachControl(report, goodRuns(), goodBaseline())).toThrow(/M0245/);
  });

  test("a baseline run reporting reachedActive true THROWS naming the test", () => {
    const baseline = goodBaseline();
    baseline[1] = {
      label: "ReachWithoutBranch",
      verdict: { outcome: "pass", reachedActive: true },
      baseline: true,
    };
    expect(() => assertReachControl(armReport(), goodRuns(), baseline)).toThrow(
      /ReachWithoutBranch/,
    );
  });

  test("a missing baseline run THROWS: both tests must be probed", () => {
    expect(() => assertReachControl(armReport(), goodRuns(), goodBaseline().slice(0, 1))).toThrow(
      /baseline/,
    );
  });

  test("an arm missing from the report THROWS rather than passing on nothing", () => {
    expect(() => assertReachControl(reportOf([]), goodRuns(), goodBaseline())).toThrow(
      /Data Reach Ops/,
    );
  });
});
