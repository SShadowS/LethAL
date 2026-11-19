import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { TestOutcome } from "../src/backend";
import type { RunEvent, RunEventInput } from "../src/events";
import { ResultsStore } from "../src/store";
import {
  LEFT_OUT_OF_SET,
  type NestedRow,
  RECHECK_SKIPPED_CODE,
  type RecheckIdentity,
  type RecheckTarget,
  decideRecheck,
  recheckTestSetOf,
  runWithheldRecheck,
} from "../src/withheld-recheck";

/**
 * PR-225 (R1142, option A; spec docs/superpowers/specs/2026-11-19-pr225-r1142-recheck-set.md): the recheck baseline runs
 * only each target's candidate killers (its covering tests that did not pass under the mutant in the main pass) and the
 * main-baseline tests of their codeunits. A test a rule needs and the set left out is unmeasured: never a kill.
 */

function manifest(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "x",
    mutatedText: "y",
  };
}

function target(id: string, coveringTests: readonly string[]): RecheckTarget {
  return {
    mutant: manifest(id),
    batchIndex: 0,
    verdict: "error",
    cause: "runner-refused",
    failureNote:
      "NotRun: out-of-scope: a test before this one in the codeunit did not pass (K1: failed with X) and left state; this failure is not trusted: Expected 1",
    coveringTests,
  };
}

const MAIN: RecheckIdentity = {
  version: "alrunner 3.0.0 (abc)",
  binarySha256: "bin1",
  sourceSha256: "src1",
  dependencySourceSha256: "dep1",
};

// Main baseline: codeunit K (the candidate's) has K1, K2, K3; codeunit P (passing-only covering tests) has P1, P2.
const MAIN_BASELINE = new Map<string, boolean>([
  ["K.K1", true],
  ["K.K2", true],
  ["K.K3", true],
  ["P.P1", true],
  ["P.P2", true],
]);

describe("recheckTestSetOf: only the candidate killers and their codeunits", () => {
  test("direction 1: a target's not-pass covering test and every main-baseline test of its codeunit are in the set", () => {
    const t = target("M1", ["K.K1", "P.P1"]);
    const notPass = new Map([["M1", ["K.K1"]]]);
    const set = recheckTestSetOf([t], (x) => notPass.get(x.mutant.mutantId) ?? [], MAIN_BASELINE);
    expect(set).toContain("K.K1");
    // The codeunit siblings rule (e) reads, covering or not.
    expect(set).toContain("K.K2");
    expect(set).toContain("K.K3");
  });

  test("direction 2: a covering test that passed under the mutant, in a codeunit with no candidate, is NOT in the set", () => {
    const t = target("M1", ["K.K1", "P.P1"]);
    const notPass = new Map([["M1", ["K.K1"]]]);
    const set = recheckTestSetOf([t], (x) => notPass.get(x.mutant.mutantId) ?? [], MAIN_BASELINE);
    expect(set).not.toContain("P.P1");
    expect(set).not.toContain("P.P2");
    expect([...set].sort()).toEqual(["K.K1", "K.K2", "K.K3"]);
  });

  test("a target with no not-pass covering test adds no test (it can have no killer the rules accept)", () => {
    const t = target("M2", ["P.P1"]);
    const set = recheckTestSetOf([t], () => [], MAIN_BASELINE);
    expect([...set]).toEqual([]);
  });

  test("a not-pass test that is not a covering test of the target is not a candidate", () => {
    const t = target("M3", ["P.P1"]);
    const set = recheckTestSetOf([t], () => ["K.K1"], MAIN_BASELINE);
    expect([...set]).toEqual([]);
  });

  test("the set is the union over targets, each test once", () => {
    const a = target("A1", ["K.K1"]);
    const b = target("B1", ["K.K2", "P.P1"]);
    const notPass = new Map([
      ["A1", ["K.K1"]],
      ["B1", ["K.K2"]],
    ]);
    const set = [
      ...recheckTestSetOf([a, b], (x) => notPass.get(x.mutant.mutantId) ?? [], MAIN_BASELINE),
    ];
    expect(set.sort()).toEqual(["K.K1", "K.K2", "K.K3"]);
  });
});

describe("runWithheldRecheck with no candidate at all", () => {
  test("skips the nested run with a named warning, and every row stays error", async () => {
    const events = [
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [{ name: "P.P1", outcome: "pass", classification: [] }],
      },
      {
        type: "mutant-scored",
        mutant: manifest("M1"),
        verdict: "error",
        batchIndex: 0,
        durationMs: 1,
        cause: "runner-refused",
        failureNote: target("M1", []).failureNote,
        coveringTests: ["P.P1"],
      },
    ].map((e, i) => ({ ...e, seq: i + 1 })) as unknown as RunEvent[];
    const emitted: RunEventInput[] = [];
    let calls = 0;
    const summary = await runWithheldRecheck({
      events,
      notPassOf: () => [],
      emit: (e) => emitted.push(e),
      main: MAIN,
      budgetSeconds: 10,
      runner: async () => {
        calls += 1;
        throw new Error("the nested run must not start");
      },
      backend: { serveEntries: true },
    });
    expect(calls).toBe(0);
    expect(summary).toEqual({
      targets: 1,
      recovered: 0,
      skipped: "no withheld kill has a covering test that did not pass under its mutant",
    });
    expect(emitted.some((e) => e.type === "warning" && e.code === RECHECK_SKIPPED_CODE)).toBe(true);
  });
});

describe("ResultsStore.notPassTestsOf: the candidate killers come from the run's own stored results", () => {
  function storeWith(): { store: ResultsStore; runId: number } {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({
      testScope: [],
      coverageMode: "al-runner",
      identityScheme: 1,
      buildSymbols: [],
      projectPath: "/p",
      backend: "al-runner-v3",
      appVersion: "1",
    });
    const mutant = (batchIndex: number) =>
      store.recordMutant(runId, {
        mutantCode: "M1",
        astHash: `h-${batchIndex}`,
        codeunitName: "C",
        procedureName: "P",
        operatorName: "op",
        operatorMajor: 1,
        file: "f.al",
        line: 1,
        verdict: "error",
        durationMs: 1,
        batchIndex,
      });
    const b0 = mutant(0);
    const b1 = mutant(1);
    const ref = (method: string) => ({ codeunitId: 1, codeunitName: "K", method });
    store.recordTestResult(runId, b0, "M1", ref("K1"), "error", 1, "distrusted failure");
    store.recordTestResult(runId, b0, "M1", ref("K2"), "pass", 1);
    store.recordTestResult(runId, b1, "M1", ref("K3"), "fail", 1, "other batch");
    return { store, runId };
  }

  test("returns the not-pass tests of the mutant in its own batch, qualified, and never a passing one", () => {
    const { store, runId } = storeWith();
    expect(store.notPassTestsOf(runId, "M1", 0)).toEqual(["K.K1"]);
  });

  test("the same mutant code in another batch is another mutant (code alone is unique only within a batch)", () => {
    const { store, runId } = storeWith();
    expect(store.notPassTestsOf(runId, "M1", 1)).toEqual(["K.K3"]);
    expect(store.notPassTestsOf(runId, "M1", 2)).toEqual([]);
  });
});

describe("a rule missing its test means unmeasured, never a kill", () => {
  function row(over: Partial<NestedRow> = {}): NestedRow {
    const m = manifest("M9");
    return {
      file: m.file,
      startIndex: m.startIndex,
      endIndex: m.endIndex,
      operatorName: m.operatorName,
      mutatedText: m.mutatedText,
      verdict: "killed",
      killingTest: "P1",
      killReproduced: true,
      killingTestFailure: "Expected 1 got 2",
      coveringTests: ["K.K1", "P.P1"],
      durationMs: 5,
      ...over,
    };
  }

  test("(c): a killer the set left out of the recheck baseline keeps the row error, naming rule (c)", () => {
    // P.P1 passed under the mutant in the main pass, so option A leaves it out; the nested row names it anyway.
    const recheckBaseline = new Map<string, TestOutcome>([
      ["K.K1", "pass"],
      ["K.K2", "pass"],
      ["K.K3", "pass"],
    ]);
    const d = decideRecheck({
      target: target("M9", ["K.K1", "P.P1"]),
      row: row(),
      mainBaseline: MAIN_BASELINE,
      recheckBaseline,
      main: MAIN,
      recheck: MAIN,
      recheckSet: new Set(["K.K1", "K.K2", "K.K3"]),
    });
    expect(d.kind).toBe("kept");
    if (d.kind === "kept") {
      expect(d.failed).toContain("c");
      expect(d.note).toContain("is not in the recheck baseline");
      // The owner's ruling: the report names these rows as unmeasured, left out by the set (R1142).
      expect(d.note).toContain(LEFT_OUT_OF_SET);
    }
  });

  test("(c): a killer IN the set but with no recheck result keeps the plain note (not blamed on the set)", () => {
    const d = decideRecheck({
      target: target("M9", ["K.K1", "P.P1"]),
      row: row(),
      mainBaseline: MAIN_BASELINE,
      recheckBaseline: new Map<string, TestOutcome>([["K.K1", "pass"]]),
      main: MAIN,
      recheck: MAIN,
      recheckSet: new Set(["K.K1", "P.P1"]),
    });
    expect(d.kind).toBe("kept");
    if (d.kind === "kept") {
      expect(d.note).toContain("P.P1 is not in the recheck baseline");
      expect(d.note).not.toContain(LEFT_OUT_OF_SET);
    }
  });

  test("(e): a codeunit sibling with no recheck result is lost, so the row stays error", () => {
    const recheckBaseline = new Map<string, TestOutcome>([
      ["K.K1", "pass"],
      ["K.K2", "pass"],
    ]); // K.K3 missing
    const d = decideRecheck({
      target: target("M9", ["K.K1"]),
      row: row({ killingTest: "K1", coveringTests: ["K.K1"] }),
      mainBaseline: MAIN_BASELINE,
      recheckBaseline,
      main: MAIN,
      recheck: MAIN,
    });
    expect(d.kind).toBe("kept");
    if (d.kind === "kept") expect(d.failed).toContain("e");
  });
});
