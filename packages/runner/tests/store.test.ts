import { describe, expect, test } from "bun:test";
import { type MutantVerdict, ResultsStore } from "../src/store";

const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };

function mutantRow(verdict: MutantVerdict, over: Record<string, unknown> = {}) {
  return {
    mutantCode: "M0001",
    astHash: "abc123",
    codeunitName: "Sample",
    operatorName: "conditional-boundary",
    operatorMajor: 1,
    file: "Sample.Codeunit.al",
    line: 12,
    verdict,
    durationMs: 40,
    ...over,
  };
}

describe("ResultsStore", () => {
  test("round-trips a run with mutants and test results", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.1.1" });
    store.recordTestResult(runId, null, ref, "pass", 30);
    store.recordMutant(runId, mutantRow("killed", { killingTest: "PostingUpdatesTotal" }));
    store.recordMutant(runId, mutantRow("survived", { mutantCode: "M0002", astHash: "def456" }));
    store.finishRun(runId, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p")).toEqual(
      new Set(["def456|Sample|conditional-boundary|1"]),
    );
    store.close();
  });

  test("priorSurvivorKeys reads only the latest finished run for the project", () => {
    const store = new ResultsStore(":memory:");
    const r1 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1" });
    store.recordMutant(r1, mutantRow("survived"));
    store.finishRun(r1, { batchCount: 1, baselineGreen: true });
    const r2 = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "2" });
    store.recordMutant(r2, mutantRow("killed"));
    store.finishRun(r2, { batchCount: 1, baselineGreen: true });
    expect(store.priorSurvivorKeys("/p").size).toBe(0);
    store.close();
  });
});
