import { describe, expect, test } from "bun:test";
import { BatchProtocolError, runOneBatchMethod, validateResultJson } from "../src/batch-transport";

/** A result JSON in the shape codeunit 79218 actually produced (ROADMAP R69, 2026-08-01). */
function resultJson(method: string, result = 1, message = "") {
  return { name: "T", codeUnit: 79218, testResults: [{ method, result, message }] };
}

function fakes(row: Record<string, unknown> | undefined, calls: string[] = []) {
  const odata = {
    post: async (action: string) => {
      calls.push(action);
      if (action !== "GetBatchResults") return undefined;
      return { value: JSON.stringify(row === undefined ? [] : [row]) };
    },
  };
  const ws = {
    runBatchAction: async () => {
      calls.push("RunBatch");
    },
  };
  return { odata, ws, calls };
}

const REQ = {
  codeunitId: 79218,
  method: "TestFoo",
  mutantId: "M0001",
  targetAppId: "app",
  artifactId: "art",
  nonce: "N1",
  // The brief's literal REQ fixture omitted this — `BatchRunRequest` (also from the brief)
  // declares it required, and CONTEXT confirms AL sends all seven `SeedBatchItem` args always.
  coverageFilter: "",
};

describe("validateResultJson (R69 §3.2 — the only server-produced evidence)", () => {
  test("accepts exactly one line whose method matches", () => {
    // Deviation from the brief's literal text, evidence-backed (see task-3-report.md): result=2 is
    // `Test Method Line.Result::Success` (`TestResultSuccess()` in ControlApi.Codeunit.al,
    // confirmed live; the same RESULT_SUCCESS `run-mutant-transport.ts` already relies on).
    // `resultJson()`'s default of 1 faithfully mirrors codeunit 79218's ACTUAL captured JSON
    // (task-0-report.md) — but that probe's [Test] unconditionally `Error(...)`s, so its own
    // real result=1 is a FAILING line, not a passing one. A passing case needs an explicit 2.
    expect(validateResultJson(resultJson("TestFoo", 2), "TestFoo").outcome).toBe("pass");
  });

  // Zero lines is a protocol fault, never a verdict — the fenced mapRanResult's own rule.
  test("throws when the result carries no test line", () => {
    const empty = { testResults: [] };
    expect(() => validateResultJson(empty, "TestFoo")).toThrow(BatchProtocolError);
  });

  test("throws when the result carries more than one test line", () => {
    const two = {
      testResults: [
        { method: "TestFoo", result: 1 },
        { method: "TestBar", result: 1 },
      ],
    };
    expect(() => validateResultJson(two, "TestFoo")).toThrow(BatchProtocolError);
  });

  // The false-survive door: the platform ran a DIFFERENT method, and the row's own Method field
  // says TestFoo because RunBatch copied it from the queue LethAL seeded.
  test("throws when the line's method is not the requested one", () => {
    expect(() => validateResultJson(resultJson("TestBar"), "TestFoo")).toThrow(BatchProtocolError);
  });

  test("throws on an unrecognised result enum", () => {
    expect(() => validateResultJson(resultJson("TestFoo", 99), "TestFoo")).toThrow(
      BatchProtocolError,
    );
  });
});

describe("runOneBatchMethod (R69 §3.2/§3.3)", () => {
  test("seeds, runs and reads back in that order", async () => {
    const calls: string[] = [];
    const { odata, ws } = fakes(
      {
        nonce: "N1",
        ok: true,
        attested: true,
        identityMismatch: false,
        errorText: "",
        result: resultJson("TestFoo"),
      },
      calls,
    );
    await runOneBatchMethod(odata, ws, REQ);
    // Call-counter ordering, never wall-clock (CLAUDE.md).
    expect(calls).toEqual(["ClearBatch", "SeedBatchItem", "RunBatch", "GetBatchResults"]);
  });

  test("throws when no result row came back — never an empty default", async () => {
    const { odata, ws } = fakes(undefined);
    await expect(runOneBatchMethod(odata, ws, REQ)).rejects.toThrow(BatchProtocolError);
  });

  // The nonce proves the row is THIS invocation's. A stale row must never be read as an answer.
  test("throws when the row's nonce is not this invocation's", async () => {
    const { odata, ws } = fakes({
      nonce: "STALE",
      ok: true,
      attested: true,
      identityMismatch: false,
      errorText: "",
      result: resultJson("TestFoo"),
    });
    await expect(runOneBatchMethod(odata, ws, REQ)).rejects.toThrow(BatchProtocolError);
  });

  test("throws when the control app reports an identity mismatch", async () => {
    const { odata, ws } = fakes({
      nonce: "N1",
      ok: true,
      attested: true,
      identityMismatch: true,
      errorText: "",
      result: resultJson("TestFoo"),
    });
    await expect(runOneBatchMethod(odata, ws, REQ)).rejects.toThrow(BatchProtocolError);
  });
});
