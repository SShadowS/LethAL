import { describe, expect, test } from "bun:test";
import {
  REPRODUCTION_EXPECTED,
  killReproductionFailures,
  unmeasuredReproductionFigures,
} from "../itest/kill-reproduction";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";

/**
 * R577: the al-runner gate's anti-inertness check, offline. A report and a store are built by hand
 * so each direction can be shown red without a live run.
 */
type Row = { code: string; verdict: string; reproduced?: boolean; cause?: string; rows: number };

function fixture(rows: readonly Row[]): { report: SessionReport; store: ResultsStore } {
  const store = new ResultsStore(":memory:");
  const runId = store.createRun({
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
    for (let i = 0; i < r.rows; i++) store.recordTestResult(runId, id, r.code, ref, "fail", 1);
    // An unmutated confirm row never counts.
    if (kill) store.recordTestResult(runId, id, null, ref, "pass", 1);
  }
  const report = {
    mutants: rows.map((r) => ({
      mutantCode: r.code,
      batchIndex: 0,
      verdict: r.verdict,
      ...(r.reproduced === true ? { killReproduced: true } : {}),
      ...(r.cause !== undefined ? { cause: r.cause } : {}),
    })),
  } as unknown as SessionReport;
  return { report, store };
}

const TABLE = { leg: { killerRowsPerKill: 2 }, blank: { killerRowsPerKill: null } };

describe("R577: the al-runner gate's kill-reproduction check", () => {
  test("holds when every kill carries the marker and has exactly the table's killer rows", () => {
    const { report, store } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 2 },
      { code: "M0002", verdict: "survived", rows: 1 },
    ]);
    expect(killReproductionFailures("leg", report, store, {}, TABLE)).toEqual([]);
  });

  test("a kill without killReproduced fails by name (the rule switched off)", () => {
    const { report, store } = fixture([{ code: "M0001", verdict: "killed", rows: 2 }]);
    const f = killReproductionFailures("leg", report, store, {}, TABLE);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("0/M0001 is killed without killReproduced");
  });

  test("a kill-not-reproduced mutant fails by name", () => {
    const { report, store } = fixture([
      { code: "M0001", verdict: "error", cause: "kill-not-reproduced", rows: 1 },
    ]);
    expect(killReproductionFailures("leg", report, store, {}, TABLE)[0]).toContain(
      "0/M0001 is kill-not-reproduced",
    );
  });

  test("a marker wired without the reproduction run (one killer row) fails the exact count", () => {
    const { report, store } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 1 },
    ]);
    expect(killReproductionFailures("leg", report, store, {}, TABLE)).toEqual([
      "R577 leg: killerRowsPerKill expected 2, measured 1",
    ]);
  });

  test("the cli-default leg's activations and runTests requests are held to the table too", () => {
    const { report, store } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 2 },
    ]);
    const cli = { cli: { killerRowsPerKill: 2, activations: 5, serverSuiteRuns: 4 } };
    expect(
      killReproductionFailures("cli", report, store, { activations: 5, serverSuiteRuns: 4 }, cli),
    ).toEqual([]);
    expect(
      killReproductionFailures("cli", report, store, { activations: 6, serverSuiteRuns: 3 }, cli),
    ).toEqual([
      "R577 cli: activations expected 5, measured 6",
      "R577 cli: serverSuiteRuns expected 4, measured 3",
    ]);
  });

  test("a null figure is not checked but recorded as unmeasured, so the gate cannot pass on it", () => {
    const { report, store } = fixture([
      { code: "M0001", verdict: "killed", reproduced: true, rows: 3 },
    ]);
    const before = unmeasuredReproductionFigures().length;
    expect(killReproductionFailures("blank", report, store, {}, TABLE)).toEqual([]);
    expect(unmeasuredReproductionFigures().slice(before)).toEqual(["blank killerRowsPerKill=3"]);
  });

  test("an unknown leg throws, and the real table names every leg the gate runs", () => {
    const { report, store } = fixture([]);
    expect(() => killReproductionFailures("nope", report, store, {}, TABLE)).toThrow(
      "has no row in REPRODUCTION_EXPECTED",
    );
    expect(Object.keys(REPRODUCTION_EXPECTED)).toHaveLength(20);
    // Measured at 102821df; only R557's names legs (merged later) are still blank, by name. Fill
    // them and this list becomes [].
    const blanks = Object.entries(REPRODUCTION_EXPECTED)
      .filter(([, f]) => Object.values(f).some((v) => v === null))
      .map(([leg]) => leg);
    expect(blanks).toEqual(["names/one-shot", "names/server"]);
    expect(Object.keys(REPRODUCTION_EXPECTED["cli-default"] ?? {}).sort()).toEqual([
      "activations",
      "killerRowsPerKill",
      "serverSuiteRuns",
    ]);
  });
});
