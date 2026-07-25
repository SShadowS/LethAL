import { describe, expect, spyOn, test } from "bun:test";
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

  // Superseded by the "run untargeted" describe block below (Task 5 amendment): a trigger
  // mutant whose object has no coverage anywhere no longer lands in `uncovered` — it now runs
  // against every green test, because we cannot silently report no-coverage on a mutation site
  // BC's coverage index can never name. See that block for the full behavior + the warning.
  test("trigger mutant whose object has no coverage anywhere still resolves — not uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ codeunitId: 99999, procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1, t2]);
    expect(split.uncovered.length).toBe(0);
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

// Task 5 amendment: a live-gate run found real trigger mutants BC's coverage index could not
// name at ALL — not even via the object-level fallback (byObject was empty too). Coverage
// filtering was silently reporting them `no-coverage`, so they generated, compiled, published,
// and never executed. Decision: stop coverage-filtering trigger mutants outright. When a trigger
// mutant resolves to nothing at either precision level, run it against every green baseline test
// instead of reporting no-coverage — over-running costs time, silently skipping hides a live
// mutation site. Resolution order stays most-precise-first: member (Task 1) > object (Task 1) >
// all-green-tests (this task) > uncovered (unchanged, and unreachable for a trigger mutant now).
describe("coverage: trigger mutants run untargeted when coverage cannot see them", () => {
  const t3 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OtherProc" };
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
      },
    },
    {
      ref: t3,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "OtherProc" }],
      },
    },
    // t2 covers nothing — present only so "all green tests" is a strictly wider set than the
    // object-level index for codeunit 70000 (which is {t1, t3}), so the tests below can tell
    // "narrower, matched set" apart from "all tests, because nothing matched".
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];
  const allGreen = [t1, t2, t3];

  test("1. trigger mutant with no coverage anywhere resolves to all green tests, not uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ codeunitId: 99999, procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual(allGreen);
    expect(split.uncovered.length).toBe(0);
  });

  test("2. trigger mutant with object-level coverage uses that narrower set, not all tests", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "", triggerName: "OnInsert" }); // codeunitId 70000, no member hit
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual([t1, t3]); // object-level for 70000 — not [t1, t2, t3]
    expect(split.uncovered.length).toBe(0);
  });

  test("3. trigger mutant with member-level coverage uses that, not the wider fallbacks", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "Post", triggerName: "OnInsert" }); // member AND object both resolvable
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual([t1]); // member-exact — not [t1, t3] and not all tests
    expect(split.uncovered.length).toBe(0);
  });

  test("4. non-trigger mutant with no coverage anywhere stays uncovered — guards against inflating every run", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ codeunitId: 99999, procedureName: "Untested" }); // no triggerName
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("warns once per run, naming the count and the total green tests — not once per mutant", () => {
    const index = buildCoverageIndex(baseline);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m1 = entry({
        mutantId: "M0001",
        codeunitId: 99999,
        procedureName: "",
        triggerName: "OnInsert",
      });
      const m2 = entry({
        mutantId: "M0002",
        codeunitId: 99998,
        procedureName: "",
        triggerName: "OnModify",
      });
      coverageFilter([m1, m2], index, allGreen);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0]);
      expect(message).toContain("2 trigger mutant");
      expect(message).toContain("3 green test");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not warn when no trigger mutant needed the untargeted fallback", () => {
    const index = buildCoverageIndex(baseline);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = entry({ procedureName: "Post", triggerName: "OnInsert" }); // member-level hit
      coverageFilter([m], index, allGreen);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
