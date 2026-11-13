// R963: a test's own time is unknown unless the backend measured it. `TestVerdict.durationMs` is the
// CALL's wall clock. Readers: the mutant's summed test time (`ownTimeCharge`), the R914 estimate
// (`measuredDurationOf`), and the store's `own_duration_ms`. (R515's raise and the v3 row decoder
// are tested beside their other cases: resume.test.ts, al-runner-v3-backend.test.ts.)
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { verdictFromRunnerTest } from "../src/al-runner-rows";
import type { TestVerdict } from "../src/backend";
import { measuredDurationOf, ownTimeCharge } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { testDbPath } from "./helpers/test-db";

const ref = (method: string) => ({ codeunitId: 79100, codeunitName: "T", method });
const verdict = (method: string, durationMs: number, own?: number): TestVerdict => ({
  ref: ref(method),
  outcome: "pass",
  durationMs,
  ...(own !== undefined ? { measuredDurationMs: own } : {}),
});

describe("R963: the mutant's summed test time", () => {
  const sum = (vs: TestVerdict[]) => {
    const charged = new Set<number>();
    return vs.reduce((s, v) => s + ownTimeCharge(v, charged), 0);
  };
  test("two rows of one call with no own time charge the call's wall once, not twice", () => {
    expect(sum([verdict("A", 620_000), verdict("B", 620_000)])).toBe(620_000);
  });
  test("own times are summed, and the call's wall is not added on top", () => {
    expect(sum([verdict("A", 620_000, 8), verdict("B", 620_000, 17)])).toBe(25);
  });
  test("a row with no own time is never charged 0 when it is the only one of its call", () => {
    expect(sum([verdict("A", 500, 8), verdict("B", 900)])).toBe(908);
  });
});

describe("R963: the R914 estimate", () => {
  test("rows of one call with no own time share the call's wall (charged once in total)", () => {
    const m = measuredDurationOf([
      { ref: ref("A"), verdict: verdict("A", 600) },
      { ref: ref("B"), verdict: verdict("B", 600) },
      { ref: ref("C"), verdict: verdict("C", 600, 7) },
    ]);
    expect([...m.values()]).toEqual([300, 300, 7]);
  });
});

describe("R963: al-runner rows (verdictFromRunnerTest)", () => {
  const rowVerdict = (status: string, message: string | undefined, d?: number) =>
    verdictFromRunnerTest(
      ref("A"),
      "Codeunit79100.A",
      {
        status,
        ...(message !== undefined ? { message } : {}),
        ...(d !== undefined ? { durationMs: d } : {}),
      },
      777,
      undefined,
    );
  const cases: ReadonlyArray<[string, string, string | undefined]> = [
    ["pass", "pass", undefined],
    ["fail", "fail", "assert"],
    ["timeout", "error", "Test exceeded 3s timeout."],
    ["refusal", "fail", "RunnerOutOfScopeException: out-of-scope: X"],
    ["unclassified error", "error", "boom"],
  ];
  for (const [name, status, message] of cases) {
    test(`a ${name} row without durationMs has no measuredDurationMs`, () => {
      const v = rowVerdict(status, message);
      expect(v.durationMs).toBe(777);
      expect(v.measuredDurationMs).toBeUndefined();
    });
    test(`a ${name} row with durationMs passes it through`, () => {
      expect(rowVerdict(status, message, 9).measuredDurationMs).toBe(9);
    });
  }
});

describe("R963: the store's own_duration_ms", () => {
  const newRun = (store: ResultsStore) =>
    store.createRun({
      testScope: [],
      coverageMode: "procedure",
      testAppHash: "T",
      testAppProven: true,
      testAppDeps: "D",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.1.1",
      carryHidden: { tuples: [], files: [] },
    });
  type Row = { method: string; duration_ms: number; own_duration_ms: number | null };
  test("is NULL for an unknown row and the value for a measured one; duration_ms stays the wall", () => {
    const store = new ResultsStore(":memory:");
    const runId = newRun(store);
    store.recordTestResult(runId, null, null, ref("Unknown"), "pass", 620_000);
    store.recordTestResult(
      runId,
      null,
      null,
      ref("Measured"),
      "pass",
      620_000,
      undefined,
      undefined,
      undefined,
      8,
    );
    const rows = store.db
      .query("SELECT method, duration_ms, own_duration_ms FROM test_results ORDER BY id")
      .all() as Row[];
    expect(rows).toEqual([
      { method: "Unknown", duration_ms: 620_000, own_duration_ms: null },
      { method: "Measured", duration_ms: 620_000, own_duration_ms: 8 },
    ]);
    store.close();
  });
  test("an existing store without the column opens and gains it, its rows reading NULL", () => {
    const path = testDbPath("r963-own-duration.sqlite");
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      mutant_row_id INTEGER,
      mutant_code TEXT,
      codeunit_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      failure_message TEXT
    );
    INSERT INTO test_results (run_id, codeunit_id, method, outcome, duration_ms) VALUES (1, 1, 'Old', 'pass', 5);`);
    legacy.close();
    const store = new ResultsStore(path);
    const rows = store.db
      .query("SELECT method, duration_ms, own_duration_ms FROM test_results")
      .all() as Row[];
    expect(rows).toEqual([{ method: "Old", duration_ms: 5, own_duration_ms: null }]);
    store.close();
  });
});
