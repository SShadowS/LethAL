import { describe, expect, test } from "bun:test";
import {
  buildCoverageIndex,
  coverageFilter,
  filterHistory,
  identityKeyOf,
  serializeKey,
  testKeyOf,
} from "../src/selection";

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

const t1 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
const t2 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "DiscountCapped" };

describe("coverage", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
      },
    },
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];

  test("mutant in covered procedure maps to its covering tests", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Post" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.uncovered.length).toBe(0);
  });

  test("mutant in uncovered procedure lands in uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Untested" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered.length).toBe(1);
  });

  test("procedure match is case-insensitive", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "POST" });
    expect(coverageFilter([m], index, [t1, t2]).covered.get("M0001")).toEqual([t1]);
  });
});

// SymbolReference.json never records a trigger (AppMethodIndex.lookup can never name one), so a
// trigger mutant's member-level key can never hit. These prove the object-level fallback: it
// widens to "any test that covered ANYTHING in this object" only when triggerName is present, and
// never manufactures coverage where none exists.
describe("coverage: trigger fallback", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
      },
    },
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];

  test("trigger mutant with no member-level entry falls back to object-level coverage", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.uncovered.length).toBe(0);
  });

  test("trigger mutant whose object has no coverage anywhere still lands in uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ codeunitId: 99999, procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("ordinary procedure mutant is unaffected and still matches member-first", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Post" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.uncovered.length).toBe(0);
  });

  test("no triggerName and a missing member key does NOT use the object fallback", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Untested" }); // no triggerName
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });
});
