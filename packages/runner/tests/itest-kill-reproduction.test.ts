import { describe, expect, test } from "bun:test";
import {
  REPRODUCTION_EXPECTED,
  killReproductionFailures,
  latestRunId,
  unmeasuredReproductionFigures,
} from "../itest/kill-reproduction";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";

/**
 * R577: the gate's anti-inertness check, offline. A report and a store are built by hand so each
 * direction can be shown red without a live run.
 */
type Row = {
  code: string;
  verdict: string;
  reproduced?: boolean;
  cause?: string;
  rows: number;
  /** The `op_kind` of each killer row, in order; all `many` when absent. */
  kinds?: readonly ("many" | "single")[];
};

/** Records `rows` as one run of `store`; returns that run's id. */
function recordRun(store: ResultsStore, rows: readonly Row[]): number {
  const runId = store.createRun({
    testScope: [],
    coverageMode: "al-runner",
    identityScheme: 1,
    buildSymbols: [],
    projectPath: "/p",
    backend: "al-runner",
    appVersion: "1",
  });
  const ref = { codeunitId: 1, codeunitName: "Tests", method: "T1" };
  for (const r of rows) {
    const kill = r.verdict === "killed";
    const id = store.recordMutant(runId, {
      mutantCode: r.code,
      astHash: `h-${r.code}`,
      codeunitName: "C",
      procedureName: "P",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 1,
      verdict: r.verdict as "killed",
      durationMs: 1,
      batchIndex: 0,
      ...(kill ? { killingTest: "T1" } : {}),
    });
    for (let i = 0; i < r.rows; i++) {
      store.recordTestResult(runId, id, r.code, ref, "fail", 1, undefined, r.kinds?.[i] ?? "many");
    }
    // An unmutated confirm row never counts.
    if (kill) store.recordTestResult(runId, id, null, ref, "pass", 1);
  }
  return runId;
}

function reportOf(rows: readonly Row[]): SessionReport {
  return {
    mutants: rows.map((r) => ({
      mutantCode: r.code,
      batchIndex: 0,
      verdict: r.verdict,
      ...(r.reproduced === true ? { killReproduced: true } : {}),
      ...(r.cause !== undefined ? { cause: r.cause } : {}),
    })),
  } as unknown as SessionReport;
}

function fixture(rows: readonly Row[]): {
  report: SessionReport;
  store: ResultsStore;
  runId: number;
} {
  const store = new ResultsStore(":memory:");
  const runId = recordRun(store, rows);
  return { report: reportOf(rows), store, runId };
}

const TABLE = { leg: { killerRowsPerKill: 2 }, blank: { killerRowsPerKill: null } };

describe("R577: the gate's kill-reproduction check", () => {
  test("holds when every kill carries the marker and has exactly the table's killer rows", () => {
    const { report, store, runId } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 2 },
      { code: "M0002", verdict: "survived", rows: 1 },
    ]);
    expect(killReproductionFailures("leg", report, store, runId, {}, TABLE)).toEqual([]);
  });

  test("a kill without killReproduced fails by name (the rule switched off)", () => {
    const { report, store, runId } = fixture([{ code: "M0001", verdict: "killed", rows: 2 }]);
    const f = killReproductionFailures("leg", report, store, runId, {}, TABLE);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("0/M0001 is killed without killReproduced");
  });

  test("a kill-not-reproduced mutant fails by name", () => {
    const { report, store, runId } = fixture([
      { code: "M0001", verdict: "error", cause: "kill-not-reproduced", rows: 1 },
    ]);
    expect(killReproductionFailures("leg", report, store, runId, {}, TABLE)[0]).toContain(
      "0/M0001 is kill-not-reproduced",
    );
  });

  test("a marker wired without the reproduction run (one killer row) fails the exact count", () => {
    const { report, store, runId } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 1 },
    ]);
    expect(killReproductionFailures("leg", report, store, runId, {}, TABLE)).toEqual([
      "R577 leg: killerRowsPerKill expected 2, measured 1",
    ]);
  });

  test("R582: a BC-shaped kill (a `many` first run and a `single` re-run row) counts 2", () => {
    const { report, store, runId } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 2, kinds: ["many", "single"] },
    ]);
    expect(killReproductionFailures("tables", report, store, runId)).toEqual([]);
  });

  test("R582 I1 (size): only the checked run's kills are counted, so an older run's kill adds no key", () => {
    const store = new ResultsStore(":memory:");
    recordRun(store, [{ code: "M0001", verdict: "killed", reproduced: true, rows: 1 }]);
    const run2: Row[] = [
      { code: "M0001", verdict: "survived", rows: 0 },
      { code: "M0002", verdict: "killed", reproduced: true, rows: 2 },
    ];
    const runId = recordRun(store, run2);
    expect(latestRunId(store)).toBe(runId);
    expect(killReproductionFailures("leg", reportOf(run2), store, runId, {}, TABLE)).toEqual([]);
  });

  test("R582 I1 (collision, F1): checking the OLDER run reads that run's rows, never the newer run's for the same key", () => {
    const store = new ResultsStore(":memory:");
    const run1: Row[] = [{ code: "M0002", verdict: "killed", reproduced: true, rows: 2 }];
    const runId = recordRun(store, run1);
    recordRun(store, [{ code: "M0002", verdict: "killed", reproduced: true, rows: 1 }]);
    expect(killReproductionFailures("leg", reportOf(run1), store, runId, {}, TABLE)).toEqual([]);
  });

  test("latestRunId refuses an empty store", () => {
    expect(() => latestRunId(new ResultsStore(":memory:"))).toThrow("holds no run");
  });

  test("the cli-default leg's activations and runTests requests are held to the table too", () => {
    const { report, store, runId } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 2 },
    ]);
    const cli = { cli: { killerRowsPerKill: 2, activations: 5, serverSuiteRuns: 4 } };
    const figures = (activations: number, serverSuiteRuns: number) =>
      killReproductionFailures("cli", report, store, runId, { activations, serverSuiteRuns }, cli);
    expect(figures(5, 4)).toEqual([]);
    expect(figures(6, 3)).toEqual([
      "R577 cli: activations expected 5, measured 6",
      "R577 cli: serverSuiteRuns expected 4, measured 3",
    ]);
  });

  test("a null figure is not checked but recorded as unmeasured, so the gate cannot pass on it", () => {
    const { report, store, runId } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 3 },
    ]);
    const before = unmeasuredReproductionFigures().length;
    expect(killReproductionFailures("blank", report, store, runId, {}, TABLE)).toEqual([]);
    expect(unmeasuredReproductionFigures().slice(before)).toEqual(["blank killerRowsPerKill=3"]);
  });

  test("an unknown leg throws, and the real table names every leg the gates run", () => {
    const { report, store, runId } = fixture([]);
    expect(() => killReproductionFailures("nope", report, store, runId, {}, TABLE)).toThrow(
      "has no row in REPRODUCTION_EXPECTED",
    );
    // 20 al-runner legs (measured at 102821df; R557's names legs pre-committed, a40097fc) and,
    // since R582, 20 BC legs (pre-committed, 39eaf536), envtool's included.
    expect(Object.keys(REPRODUCTION_EXPECTED)).toHaveLength(40);
    const blanks = Object.entries(REPRODUCTION_EXPECTED)
      .filter(([, f]) => Object.values(f).some((v) => v === null))
      .map(([leg]) => leg);
    expect(blanks).toEqual([]);
    expect(Object.keys(REPRODUCTION_EXPECTED["cli-default"] ?? {}).sort()).toEqual([
      "activations",
      "killerRowsPerKill",
      "serverSuiteRuns",
    ]);
    for (const leg of ["bcdev", "tables", "hang/on", "hang/single", "chunked/chunked", "envtool"]) {
      expect(REPRODUCTION_EXPECTED[leg]).toEqual({ killerRowsPerKill: 2 });
    }
  });
});
