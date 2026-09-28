import { describe, expect, test } from "bun:test";
import type { RunEvent, RunPhase } from "../src/events";
import type { MutantOutcome, SessionReport } from "../src/report";
import type { NewTestResult, VerifyOutput, VerifyResult } from "../src/verify";
import { type NormalizedMutant, keyOf } from "./mutant-equality";
import {
  type StampedEvent,
  VerifyScaleError,
  allSurvivorIds,
  assertOnlyExpectedTestPageRefusal,
  assertVerifyMeasured,
  firstSurvivorIds,
  foldLibraryTimeline,
  noOpTestCodeunit,
  verdictDiffs,
  worstRatio,
} from "./verify-scale";

// Hand-built reports, the verify-agreement.test.ts pattern: every mutant carries every field
// `keyOf` reads, so ordering and joins run on the real identity key.

type Overrides = { [K in keyof MutantOutcome]?: MutantOutcome[K] | undefined };

function mutant(overrides: Overrides & { mutantCode: string }): MutantOutcome {
  const row: Record<string, unknown> = {
    file: "src\\DataMain.Table.al",
    line: 10,
    operatorName: "lethal.empty-block",
    verdict: "survived",
    batchIndex: 0,
    durationMs: 1,
    procedureName: "Proc",
    startIndex: 0,
    endIndex: 1,
    originalText: "",
    mutatedText: "",
    coveringTests: [],
    runner: "fenced",
    astHash: "hash",
    codeunitName: "Data Main",
    operatorMajor: 1,
    ...overrides,
  };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return row as unknown as MutantOutcome;
}

interface Extra {
  readonly batches?: number;
  readonly unsupportedTests?: readonly string[];
  readonly testPageRefused?: readonly string[];
  readonly caveats?: readonly string[];
  readonly quarantined?: { readonly reason: string };
}

function report(mutants: readonly MutantOutcome[], extra: Extra = {}): SessionReport {
  return {
    mutants,
    batches: extra.batches ?? 1,
    unsupportedTests: extra.unsupportedTests ?? [],
    validity: { caveats: extra.caveats ?? [] },
    ...(extra.testPageRefused !== undefined
      ? { testPageRefused: { tests: extra.testPageRefused, diagnosis: "d" } }
      : {}),
    ...(extra.quarantined !== undefined ? { quarantined: extra.quarantined } : {}),
  } as unknown as SessionReport;
}

// Codes run AGAINST key order (hash z.. has the lowest code), so a code sort and a key sort differ.
const R = report([
  mutant({ mutantCode: "M0001", astHash: "hc" }),
  mutant({ mutantCode: "M0002", astHash: "ha" }),
  mutant({ mutantCode: "M0003", astHash: "hk", verdict: "killed", killingTest: "T" }),
  mutant({ mutantCode: "M0004", astHash: "hn", verdict: "no-coverage" }),
  mutant({ mutantCode: "M0005", astHash: "hb" }),
]);

describe("allSurvivorIds / firstSurvivorIds", () => {
  test("returns every survivor of the batch, ordered by keyOf, as <batch>/<code>", () => {
    expect(allSurvivorIds(R, 3)).toEqual(["0/M0002", "0/M0005", "0/M0001"]);
    const r2 = report([mutant({ mutantCode: "M0009", batchIndex: 2 })]);
    expect(allSurvivorIds(r2, 1)).toEqual(["2/M0009"]);
  });

  test("killed and no-coverage mutants are never included", () => {
    const ids = allSurvivorIds(R, 3);
    expect(ids).not.toContain("0/M0003");
    expect(ids).not.toContain("0/M0004");
  });

  test("a count other than expected throws (a moved fixture is not measured silently)", () => {
    expect(() => allSurvivorIds(R, 4)).toThrow(VerifyScaleError);
    expect(() => allSurvivorIds(R, 2)).toThrow(VerifyScaleError);
  });

  test("a report with two batches throws", () => {
    const twoCount = report(R.mutants, { batches: 2 });
    expect(() => allSurvivorIds(twoCount, 3)).toThrow(VerifyScaleError);
    const twoIndexes = report([...R.mutants, mutant({ mutantCode: "M0001", batchIndex: 1 })]);
    expect(() => allSurvivorIds(twoIndexes, 4)).toThrow(VerifyScaleError);
  });

  test("firstSurvivorIds: k=2 gives the first two of allSurvivorIds; k=0 and k>pool throw", () => {
    expect(firstSurvivorIds(R, 3, 2)).toEqual(["0/M0002", "0/M0005"]);
    expect(() => firstSurvivorIds(R, 3, 0)).toThrow(VerifyScaleError);
    expect(() => firstSurvivorIds(R, 3, 4)).toThrow(VerifyScaleError);
  });
});

function norm(m: MutantOutcome, overrides: Partial<NormalizedMutant> = {}): NormalizedMutant {
  return {
    key: keyOf(m),
    verdict: m.verdict,
    killingTest: m.killingTest ?? null,
    coverageFiltered: m.verdict === "no-coverage",
    errorClass: null,
    ...overrides,
  };
}

const K = mutant({ mutantCode: "M0001", astHash: "k", verdict: "killed", killingTest: "Kill1" });
const S = mutant({ mutantCode: "M0002", astHash: "s" });

describe("verdictDiffs", () => {
  test("equal verdicts with DIFFERENT killingTest give no diff", () => {
    expect(verdictDiffs([norm(K, { killingTest: "Kill2" }), norm(S)], report([K, S]))).toEqual([]);
  });

  test("one differing verdict gives one line naming the key and both verdicts", () => {
    const diffs = verdictDiffs([norm(K), norm(S, { verdict: "killed" })], report([K, S]));
    expect(diffs).toEqual([`${keyOf(S)}: baseline killed, report survived`]);
  });

  test("a key missing from the report, and an extra key in it, give one line each", () => {
    const X = mutant({ mutantCode: "M0003", astHash: "x" });
    const diffs = verdictDiffs([norm(K), norm(S)], report([K, X]));
    expect(diffs).toEqual([
      `${keyOf(S)}: missing from the report`,
      `${keyOf(X)}: not in the baseline`,
    ]);
  });

  test("a key twice on either side throws", () => {
    expect(() => verdictDiffs([norm(K), norm(K)], report([K]))).toThrow(VerifyScaleError);
    const K2 = mutant({ ...K, mutantCode: "M0009" });
    expect(() => verdictDiffs([norm(K)], report([K, K2]))).toThrow(VerifyScaleError);
  });

  // The R270 s1 anomaly: a session quarantined before scoring returns a report with NO mutants
  // (orchestrator.test.ts pins that), and the diff read it as every baseline key "missing".
  test("a quarantined report throws naming the reason, never a list of missing keys", () => {
    const q = report([], { quarantined: { reason: "baseline test in-flight-unknown running X" } });
    expect(() => verdictDiffs([norm(K), norm(S)], q)).toThrow(
      /quarantined: baseline test in-flight-unknown running X/,
    );
  });

  test("a quarantined report that still HAS mutants (a partial run) throws naming the reason", () => {
    const q = report([K, S], { quarantined: { reason: "mutant test in-flight-unknown M0002" } });
    expect(() => verdictDiffs([norm(K), norm(S)], q)).toThrow(
      /quarantined: mutant test in-flight-unknown M0002/,
    );
  });

  test("a report with no mutants against a non-empty baseline throws", () => {
    expect(() => verdictDiffs([norm(K)], report([]))).toThrow(/no mutants/);
  });
});

const PAGE_TEST = "Data Tests.PageActionComputesNonZero";

describe("assertOnlyExpectedTestPageRefusal", () => {
  const OK = { testPageRefused: [PAGE_TEST], caveats: ["tests-testpage-refused"] };

  test("accepts exactly the TestPage test refused, named, and no baseline failure", () => {
    expect(() => assertOnlyExpectedTestPageRefusal(report([], OK))).not.toThrow();
  });

  test("refuses a baseline failure, even the TestPage test itself (it was sent)", () => {
    for (const u of [[PAGE_TEST], ["Data Tests.Other"]]) {
      expect(() =>
        assertOnlyExpectedTestPageRefusal(report([], { ...OK, unsupportedTests: u })),
      ).toThrow(VerifyScaleError);
    }
  });

  test("refuses no refusal, a different one, and that one plus another", () => {
    for (const r of [undefined, [], ["Data Tests.Other"], [PAGE_TEST, "Data Tests.Other"]]) {
      const extra = r === undefined ? { caveats: OK.caveats } : { ...OK, testPageRefused: r };
      expect(() => assertOnlyExpectedTestPageRefusal(report([], extra))).toThrow(VerifyScaleError);
    }
  });

  test("refuses an unnamed refusal and BC's own TestPage refusal", () => {
    for (const caveats of [[], ["tests-testpage-refused", "tests-testpage-unsupported"]]) {
      expect(() => assertOnlyExpectedTestPageRefusal(report([], { ...OK, caveats }))).toThrow(
        VerifyScaleError,
      );
    }
  });
});

const IDS = ["0/M0002", "0/M0005", "0/M0001"];
const NOOP = "Verify Scale NoOp";
const NAMES = [1, 2, 3, 4, 5].map((i) => `${NOOP}.VerifyScaleNoOp${i}`);

function row(id: string, verdict: VerifyResult["verdict"] = "survived"): VerifyResult {
  const [b, code] = id.split("/");
  return {
    id,
    batchIndex: Number(b),
    mutantCode: code ?? "",
    file: "src\\DataMain.Table.al",
    line: 10,
    operatorName: "lethal.empty-block",
    procedureName: "Proc",
    verdict,
  };
}

function newTest(test: string, state: NewTestResult["state"] = "stable"): NewTestResult {
  return { test, codeunitId: 79590, state, runs: [] };
}

function vout(o: Partial<VerifyOutput> = {}): VerifyOutput {
  return {
    verifySchemaVersion: 2,
    ok: false,
    exitCode: 5,
    newTests: NAMES.map((n) => newTest(n)),
    results: IDS.map((id) => row(id)),
    counts: { killed: 0, survived: IDS.length, error: 0, skipped: 0 },
    timings: { totalMs: 1 },
    ...o,
  };
}

describe("assertVerifyMeasured", () => {
  test("accepts exit 5, rows for exactly the requested ids, five stable new tests with the expected names", () => {
    expect(() => assertVerifyMeasured(vout(), IDS, NAMES)).not.toThrow();
    // Order is not part of it: the same sets reversed pass too.
    const rev = vout({
      results: [...IDS].reverse().map((id) => row(id)),
      newTests: [...NAMES].reverse().map((n) => newTest(n)),
    });
    expect(() => assertVerifyMeasured(rev, IDS, NAMES)).not.toThrow();
  });

  test("refuses a row set with one requested id missing and another id twice (same count)", () => {
    const out = vout({ results: ["0/M0002", "0/M0002", "0/M0001"].map((id) => row(id)) });
    expect(() => assertVerifyMeasured(out, IDS, NAMES)).toThrow(VerifyScaleError);
  });

  test("refuses an extra id not requested, and a duplicated id", () => {
    const extra = vout({ results: [...IDS, "0/M0099"].map((id) => row(id)) });
    expect(() => assertVerifyMeasured(extra, IDS, NAMES)).toThrow(VerifyScaleError);
    const dup = vout({ results: [...IDS, "0/M0001"].map((id) => row(id)) });
    expect(() => assertVerifyMeasured(dup, IDS, NAMES)).toThrow(VerifyScaleError);
  });

  test("refuses five stable new tests whose names differ from the expected five", () => {
    const other = [1, 2, 3, 4, 6].map((i) => newTest(`${NOOP}.VerifyScaleNoOp${i}`));
    expect(() => assertVerifyMeasured(vout({ newTests: other }), IDS, NAMES)).toThrow(
      VerifyScaleError,
    );
  });

  test("refuses a refusal output (results: [], exit 6)", () => {
    const refused = vout({
      exitCode: 6,
      results: [],
      newTests: [],
      refused: { reason: "unknown-mutant", detail: "x" },
    });
    expect(() => assertVerifyMeasured(refused, IDS, NAMES)).toThrow(VerifyScaleError);
  });

  test("refuses exit 0, 3 and 4", () => {
    for (const exitCode of [0, 3, 4]) {
      expect(() => assertVerifyMeasured(vout({ exitCode }), IDS, NAMES)).toThrow(VerifyScaleError);
    }
  });

  test("refuses fewer rows than requested, and any row not survived", () => {
    const fewer = vout({ results: IDS.slice(0, 2).map((id) => row(id)) });
    expect(() => assertVerifyMeasured(fewer, IDS, NAMES)).toThrow(VerifyScaleError);
    for (const v of ["killed", "error", "skipped"] as const) {
      const out = vout({ results: IDS.map((id, i) => row(id, i === 1 ? v : "survived")) });
      expect(() => assertVerifyMeasured(out, IDS, NAMES)).toThrow(VerifyScaleError);
    }
  });

  test("refuses exit 5 caused by a flaky, red or infra-error new test, and a wrong new-test count", () => {
    for (const state of ["flaky", "red", "infra-error"] as const) {
      const tests = NAMES.map((n, i) => newTest(n, i === 2 ? state : "stable"));
      expect(() => assertVerifyMeasured(vout({ newTests: tests }), IDS, NAMES)).toThrow(
        VerifyScaleError,
      );
    }
    const four = vout({ newTests: NAMES.slice(0, 4).map((n) => newTest(n)) });
    expect(() => assertVerifyMeasured(four, IDS, NAMES)).toThrow(VerifyScaleError);
  });
});

describe("worstRatio", () => {
  test("is max verify over min denominator", () => {
    expect(worstRatio([10, 30, 20], [200, 150])).toBe(0.2);
  });

  test("empty lists and non-positive denominators throw", () => {
    expect(() => worstRatio([], [100])).toThrow(VerifyScaleError);
    expect(() => worstRatio([10], [])).toThrow(VerifyScaleError);
    expect(() => worstRatio([10], [100, 0])).toThrow(VerifyScaleError);
    expect(() => worstRatio([10], [-5])).toThrow(VerifyScaleError);
    expect(() => worstRatio([0], [100])).toThrow(VerifyScaleError);
  });
});

function left(at: number, phase: RunPhase, elapsedMs: number): StampedEvent {
  return { at, event: { type: "phase-left", phase, elapsedMs } as unknown as RunEvent };
}

const TIMINGS = { timings: { totalMs: 4000, compileMs: 700, publishMs: 300 } };
const SCENE = [
  left(1000, "baseline", 400),
  left(3000, "mutants", 2000),
  left(3300, "teardown", 50),
];

describe("foldLibraryTimeline", () => {
  test("a stream with baseline, mutants AND teardown phase-left: postMutantsMixed runs from mutants' phase-left to return", () => {
    expect(foldLibraryTimeline(TIMINGS, SCENE, 3500)).toEqual({
      totalMs: 4000,
      compileMs: 700,
      publishMs: 300,
      baselineMs: 400,
      mutantsMs: 2000,
      postMutantsMixedMs: 500,
      unattributedMs: 100,
    });
  });

  test("missing compileMs or publishMs throws (verify refused before measuring)", () => {
    expect(() =>
      foldLibraryTimeline({ timings: { totalMs: 4000, publishMs: 300 } }, SCENE, 3500),
    ).toThrow(VerifyScaleError);
    expect(() =>
      foldLibraryTimeline({ timings: { totalMs: 4000, compileMs: 700 } }, SCENE, 3500),
    ).toThrow(VerifyScaleError);
  });

  test("zero or two phase-left events for baseline or mutants throw", () => {
    const [b, m, t] = SCENE;
    if (b === undefined || m === undefined || t === undefined) throw new Error("scene");
    for (const events of [
      [m, t],
      [b, t],
      [b, b, m, t],
      [b, m, m, t],
    ]) {
      expect(() => foldLibraryTimeline(TIMINGS, events, 3500)).toThrow(VerifyScaleError);
    }
  });

  test("named parts larger than totalMs throw", () => {
    expect(() => foldLibraryTimeline(TIMINGS, SCENE, 3601)).toThrow(VerifyScaleError);
    expect(foldLibraryTimeline(TIMINGS, SCENE, 3600).unattributedMs).toBe(0);
  });
});

describe("noOpTestCodeunit", () => {
  const al = noOpTestCodeunit(79590, NOOP, 5);

  test("declares Subtype = Test and n uniquely named [Test] procedures", () => {
    expect(al.startsWith(`codeunit 79590 "${NOOP}"`)).toBe(true);
    expect(al).toContain("Subtype = Test;");
    expect(al.match(/\[Test\]/g)?.length).toBe(5);
    const procs = [...al.matchAll(/procedure (\w+)\(\)/g)].map((m) => m[1]);
    expect(procs).toEqual([1, 2, 3, 4, 5].map((i) => `VerifyScaleNoOp${i}`));
    expect(() => noOpTestCodeunit(79590, NOOP, 0)).toThrow(VerifyScaleError);
  });

  test("names no Record, Codeunit.Run or target object", () => {
    expect(al).not.toMatch(/Record|Codeunit\.Run|Data |Page|Table/i);
  });
});
