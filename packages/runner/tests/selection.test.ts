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
    objectType: "codeunit",
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
// table trigger mutant's member-level key can never hit. These prove the object-level fallback: it
// widens to "any test that covered ANYTHING in this object" only for a TABLE trigger, and never
// manufactures coverage where none exists.
describe("coverage: trigger fallback", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [
          { objectType: "Codeunit", objectId: 70000, procedure: "Post" },
          // Table 70000 is a DIFFERENT object from codeunit 70000 — both indexes key on the
          // (type, id) pair, so this entry is what makes the object-level fallback below hit.
          { objectType: "Table", objectId: 70000, procedure: "Insert" },
        ],
      },
    },
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];

  test("table trigger mutant with no member-level entry falls back to object-level coverage", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: "table", procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.uncovered.length).toBe(0);
  });

  // Superseded by the "run untargeted" describe block below (Task 5 amendment): a table trigger
  // mutant whose object has no coverage anywhere no longer lands in `uncovered` — it now runs
  // against every green test, because we cannot silently report no-coverage on a mutation site
  // BC's coverage index can never name. See that block for the full behavior + the warning.
  test("table trigger mutant whose object has no coverage anywhere still resolves — not uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "table",
      codeunitId: 99999,
      procedureName: "",
      triggerName: "OnInsert",
    });
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
describe("coverage: table trigger mutants run untargeted when coverage cannot see them", () => {
  const t3 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OtherProc" };
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Table", objectId: 70000, procedure: "Post" }],
      },
    },
    {
      ref: t3,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Table", objectId: 70000, procedure: "OtherProc" }],
      },
    },
    // t2 covers nothing — present only so "all green tests" is a strictly wider set than the
    // object-level index for table 70000 (which is {t1, t3}), so the tests below can tell
    // "narrower, matched set" apart from "all tests, because nothing matched".
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];
  const allGreen = [t1, t2, t3];

  test("1. table trigger mutant with no coverage anywhere resolves to all green tests, not uncovered", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "table",
      codeunitId: 99999,
      procedureName: "",
      triggerName: "OnInsert",
    });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual(allGreen);
    expect(split.uncovered.length).toBe(0);
  });

  test("2. table trigger mutant with object-level coverage uses that narrower set, not all tests", () => {
    // objectId 70000, no member hit
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: "table", procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual([t1, t3]); // object-level for 70000 — not [t1, t2, t3]
    expect(split.uncovered.length).toBe(0);
  });

  test("3. table trigger mutant with member-level coverage uses that, not the wider fallbacks", () => {
    // member AND object both resolvable
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: "table", procedureName: "Post", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual([t1]); // member-exact — not [t1, t3] and not all tests
    expect(split.uncovered.length).toBe(0);
  });

  test("4. non-trigger mutant with no coverage anywhere stays uncovered — guards against inflating every run", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: "table", codeunitId: 99999, procedureName: "Untested" }); // no triggerName
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
        objectType: "table",
        codeunitId: 99999,
        procedureName: "",
        triggerName: "OnInsert",
      });
      const m2 = entry({
        mutantId: "M0002",
        objectType: "table",
        codeunitId: 99998,
        procedureName: "",
        triggerName: "OnModify",
      });
      coverageFilter([m1, m2], index, allGreen);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0]);
      expect(message).toContain("2 table trigger mutant");
      expect(message).toContain("3 green test");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not warn when no table trigger mutant needed the untargeted fallback", () => {
    const index = buildCoverageIndex(baseline);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // member-level hit
      const m = entry({ objectType: "table", procedureName: "Post", triggerName: "OnInsert" });
      coverageFilter([m], index, allGreen);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// A BC object id is unique only WITHIN a type — `table 50100` and `codeunit 50100` are two
// different objects and a project routinely holds both. Keying coverage on the bare numeric id
// merges them, and the merge silently defeats the untargeted fallback above: the table trigger
// mutant's member key misses, the bare-id object lookup returns the CODEUNIT's covering tests
// (non-empty), so the mutant runs against tests that cannot reach it and is scored `survived`.
describe("coverage: object id collisions across object types", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        // ONLY the codeunit is covered. Nothing anywhere covers table 50100.
        entries: [{ objectType: "Codeunit", objectId: 50100, procedure: "Run" }],
      },
    },
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];
  const allGreen = [t1, t2];

  test("a table trigger mutant does NOT inherit the same-id codeunit's covering tests", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "table",
      codeunitId: 50100,
      procedureName: "",
      triggerName: "OnValidate",
    });
    const split = coverageFilter([m], index, allGreen);
    // Bare-id keying would answer [t1] here — the codeunit's test, which never touches the
    // table — and the all-green-tests safety net would never fire.
    expect(split.covered.get("M0001")).not.toEqual([t1]);
    expect(split.covered.get("M0001")).toEqual(allGreen);
    expect(split.uncovered.length).toBe(0);
  });

  test("an ordinary procedure mutant does NOT match a same-id other-type coverage entry", () => {
    const index = buildCoverageIndex(baseline);
    // table 50100 has a procedure that happens to share the codeunit procedure's name.
    const m = entry({ objectType: "table", codeunitId: 50100, procedureName: "Run" });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("the covered codeunit itself still matches, member-exact", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: "codeunit", codeunitId: 50100, procedureName: "Run" });
    expect(coverageFilter([m], index, allGreen).covered.get("M0001")).toEqual([t1]);
  });
});

// The two fallbacks are gated DIFFERENTLY, and this block pins the seam between them.
//
// `triggerNameOf` (@lethal/schemata) walks to the nearest `trigger_declaration`, so it names a
// codeunit's `trigger OnRun()` and a page's `OnOpenPage` as readily as a table trigger — and
// SymbolReference.json records none of them, so NONE can hit at member level.
//
//   Fallback 1 (object-level, "tests that covered something in THIS object") applies to every
//   trigger: it is evidence-based (the key carries objectType) and it is a codeunit `OnRun`
//   mutant's only route to being executed at all. Gating it on table-ness silently reported
//   covered codeunit `OnRun` mutants as `no-coverage` and dropped them from the score.
//
//   Fallback 2 (ALL green tests, when even the object level is empty) stays table-only: "coverage
//   sees nothing in this object, yet the trigger is reachable" is measured for tables only.
//
// The baseline below makes the two distinguishable: the object-level set for any single object is
// a strict subset of `allGreen`, so "matched narrowly" can never be confused with "everything".
describe("coverage: fallback 1 applies to any trigger; fallback 2 is TABLE-only", () => {
  const t3 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PageProc" };
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
        entries: [{ objectType: "Page", objectId: 70200, procedure: "Refresh" }],
      },
    },
    // Covers nothing — present only so `allGreen` is STRICTLY wider than either object-level set.
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];
  const allGreen = [t1, t2, t3];

  test("an uncovered codeunit OnRun mutant reports no-coverage, not survived-against-everything", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "codeunit",
      codeunitId: 88888, // nothing covers this codeunit at all
      procedureName: "",
      triggerName: "OnRun",
    });
    const split = coverageFilter([m], index, allGreen);
    // Fallback 1 found nothing (correctly — nothing covers 88888) and fallback 2 does not apply
    // to a codeunit, so the honest answer is no-coverage, NOT "run it against every green test".
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("a covered codeunit OnRun mutant DOES widen to that codeunit's covering tests", () => {
    const index = buildCoverageIndex(baseline);
    // codeunit 70000 IS covered (procedure Post). `OnRun` can never hit at member level, so this
    // object-level widening is the only way the mutant ever executes. Gating it on table-ness
    // reported it `no-coverage` and silently excluded a live mutation site from the score.
    const m = entry({ objectType: "codeunit", procedureName: "", triggerName: "OnRun" });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual([t1]);
    // ...and it stops there: [t1] is the object-level set, not the all-green fallback.
    expect(split.covered.get("M0001")).not.toEqual(allGreen);
    expect(split.uncovered.length).toBe(0);
  });

  test("a covered page trigger mutant likewise gets that page's covering tests, not all of them", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "page",
      codeunitId: 70200,
      procedureName: "",
      triggerName: "OnOpenPage",
    });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.get("M0001")).toEqual([t3]);
    expect(split.covered.get("M0001")).not.toEqual(allGreen);
    expect(split.uncovered.length).toBe(0);
  });

  test("an uncovered page trigger mutant stays no-coverage — fallback 2 never reaches it", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "page",
      codeunitId: 70300, // nothing covers this page
      procedureName: "",
      triggerName: "OnOpenPage",
    });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("the object-level widening respects the (type, id) pair — a codeunit trigger never takes a same-id table's tests", () => {
    const index = buildCoverageIndex([
      {
        ref: t1,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Table", objectId: 70000, procedure: "Insert" }],
        },
      },
      { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
    ]);
    // Only TABLE 70000 is covered. A codeunit 70000 `OnRun` mutant must not inherit its tests.
    const m = entry({
      objectType: "codeunit",
      codeunitId: 70000,
      procedureName: "",
      triggerName: "OnRun",
    });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("no warning fires for a non-table trigger mutant — covered or not", () => {
    const index = buildCoverageIndex(baseline);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const uncovered = entry({
        mutantId: "M0001",
        objectType: "codeunit",
        codeunitId: 88888,
        triggerName: "OnRun",
      });
      const covered = entry({
        mutantId: "M0002",
        objectType: "codeunit",
        codeunitId: 70000,
        procedureName: "",
        triggerName: "OnRun",
      });
      coverageFilter([uncovered, covered], index, allGreen);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// A manifest that predates `objectType` parses to `undefined` here. Defaulting it would resurrect
// exactly the bare-id merge the pair key exists to prevent, so it is refused loudly instead.
describe("coverage: a manifest entry with no objectType is refused, never defaulted", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
      },
    },
  ];

  test("coverageFilter throws, naming the mutant", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: undefined, procedureName: "Post" });
    expect(() => coverageFilter([m], index, [t1])).toThrow(/objectType|object type/i);
    expect(() => coverageFilter([m], index, [t1])).toThrow(/M0001/);
  });

  test("buildCoverageIndex throws on a coverage entry with no objectType", () => {
    expect(() =>
      buildCoverageIndex([
        {
          ref: t1,
          coverage: {
            granularity: "procedure" as const,
            entries: [{ objectType: "", objectId: 70000, procedure: "Post" }],
          },
        },
      ]),
    ).toThrow(/object type/i);
  });
});
