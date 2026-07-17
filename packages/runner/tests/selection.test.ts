import { describe, expect, test } from "bun:test";
import { batchByOverlap, filterHistory, identityKeyOf, serializeKey } from "../src/selection";

function entry(over: Partial<Record<string, unknown>> = {}) {
  return {
    mutantId: "M0001",
    file: "Sample.Codeunit.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 2,
    operatorName: "conditional-boundary",
    operatorVersion: "1.2.0",
    astHash: "abc123",
    codeunitId: 70000,
    codeunitName: "Sample",
    procedureName: "Post",
    ...over,
  };
}

describe("identityKeyOf", () => {
  test("major version extracted; file/line excluded", () => {
    const k = identityKeyOf(entry({ operatorVersion: "2.9.1" }));
    expect(k).toEqual({
      astHash: "abc123",
      codeunitName: "Sample",
      operatorName: "conditional-boundary",
      operatorMajor: 2,
    });
  });
});

describe("filterHistory", () => {
  const survivorKey = serializeKey(identityKeyOf(entry()));
  test("default: everything executes", () => {
    const s = filterHistory([entry()], new Set([survivorKey]), { skipKnownSurvivors: false });
    expect(s.execute.length).toBe(1);
    expect(s.knownSurvivors.length).toBe(0);
  });
  test("skipKnownSurvivors demotes matching keys", () => {
    const fresh = entry({ mutantId: "M0002", astHash: "zzz999" });
    const s = filterHistory([entry(), fresh], new Set([survivorKey]), { skipKnownSurvivors: true });
    expect(s.execute).toEqual([fresh]);
    expect(s.knownSurvivors.length).toBe(1);
  });
});

describe("batchByOverlap", () => {
  test("non-overlapping mutants share a batch", () => {
    const a = entry({ mutantId: "M0001", startIndex: 0, endIndex: 10 });
    const b = entry({ mutantId: "M0002", startIndex: 20, endIndex: 30 });
    expect(batchByOverlap([a, b])).toEqual([[a, b]]);
  });
  test("overlapping mutants split into later batches", () => {
    const a = entry({ mutantId: "M0001", startIndex: 0, endIndex: 15 });
    const b = entry({ mutantId: "M0002", startIndex: 10, endIndex: 30 });
    const c = entry({ mutantId: "M0003", startIndex: 12, endIndex: 14 });
    const batches = batchByOverlap([a, b, c]);
    expect(batches.length).toBe(3);
    expect(batches.flat().length).toBe(3);
  });
  test("same offsets in different files do not overlap", () => {
    const a = entry({ mutantId: "M0001" });
    const b = entry({ mutantId: "M0002", file: "Other.Codeunit.al" });
    expect(batchByOverlap([a, b]).length).toBe(1);
  });
});
