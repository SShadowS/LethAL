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
    originalText: "Original();",
    mutatedText: "",
    ...over,
  };
}

describe("identityKeyOf", () => {
  test("major version extracted; file/line excluded", () => {
    const k = identityKeyOf(entry({ operatorVersion: "2.9.1" }));
    expect(k).toEqual({
      astHash: "abc123",
      codeunitName: "Sample",
      procedureName: "Post",
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

// A local procedure never appears in SymbolReference.json, so a mutant in one can never hit
// `byMember` — the same structural shape as a trigger. When coverage saw SOME unnameable member
// execute in the same object (an object-level entry), that observation may be the mutant's own
// procedure: run those tests at object grain. Without the branch, genuinely-executed locals
// report `no-coverage` (measured on the sandbox fixture's `LogAudit`, frozen `survived`).
describe("coverage: unnamed-member fallback (locals)", () => {
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [
          { objectType: "Codeunit", objectId: 70000, procedure: "ApplyAudit" },
          // t1 executed SOME member coverage cannot name (here: the local LogAudit) —
          // the only signal a local-procedure mutant can ever join on.
          { objectType: "Codeunit", objectId: 70000 },
        ],
      },
    },
    {
      ref: t2,
      coverage: {
        granularity: "procedure" as const,
        // t2 executed the object too, but only NAMED members — it never touched anything
        // unnameable, so it must NOT join the local mutant's covering set.
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "IsOverBudget" }],
      },
    },
  ];

  test("ordinary mutant in a local procedure is covered at object grain by tests with unnamed-member executions", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "LogAudit", procedureScope: "local" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.attribution.get("M0001")).toBe("object");
    expect(split.uncovered.length).toBe(0);
  });

  test("ordinary mutant with no member hit and NO unnamed-member observations is no-coverage", () => {
    const index = buildCoverageIndex(baseline);
    // A different object whose coverage is entirely member-named: nothing unnameable ever
    // executed there, so there is no honest object-grain set to run.
    const m = entry({
      codeunitId: 70001,
      procedureName: "DiscountedPrice",
      procedureScope: "local",
    });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered.length).toBe(1);
  });

  test("a PUBLIC procedure mutant is NOT widened by unnamed-member observations — it did not execute", () => {
    const index = buildCoverageIndex(baseline);
    // The object-level entry says something UNNAMEABLE ran in 70000 — a local or a trigger —
    // which is never evidence for a public member: had TouchCount executed, it would have
    // resolved by name.
    const m = entry({ procedureName: "TouchCount", procedureScope: "public" });
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered.length).toBe(1);
  });

  test("a mutant whose manifest predates procedureScope is not widened either (fail closed)", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "LogAudit" }); // no procedureScope — old manifest shape
    const split = coverageFilter([m], index, [t1, t2]);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered.length).toBe(1);
  });

  test("the fallback does not steal the trigger path: a trigger mutant still takes the full byObject set", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ procedureName: "", triggerName: "OnRun" });
    const split = coverageFilter([m], index, [t1, t2]);
    // Both tests executed the object (named or not) — triggers widen to ALL of byObject.
    expect(split.covered.get("M0001")).toEqual([t1, t2]);
    expect(split.attribution.get("M0001")).toBe("object");
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
      originalText: "Original();",
      mutatedText: "",
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

// DRIFT TRIPWIRE for `ATTRIBUTION_INTERPRETATIONS.object` (selection.ts).
//
// Semantic drift — `object` attribution quietly becoming a PRECISE claim while keeping its name —
// is not provable against prose; co-locating the constant next to `byObject` (so whoever edits
// precedence here has the meaning on screen) is the first defence, but it is not a mechanical one.
// This test is the second: a fixture where the ONLY covering test's own coverage record proves,
// by naming a DIFFERENT member and nothing else, that it never executed the mutated trigger — yet
// attribution still returns "object". That is exactly the gap `ATTRIBUTION_INTERPRETATIONS.object`
// warns about ("whether they reached the mutated member is unknown" / "may be no finding at all").
//
// If this test is ever changed or deleted, `ATTRIBUTION_INTERPRETATIONS.object` in selection.ts
// must be re-reviewed alongside it — a change here that stops failing under a broken `byObject`
// precedence is the regression this whole test exists to catch (see the R70 pattern in ROADMAP.md).
describe("drift tripwire: object attribution is NOT proof of execution", () => {
  test("a test whose own coverage names a DIFFERENT member still attributes 'object' to a trigger mutant", () => {
    const onlyTouchedUnrelated = {
      codeunitId: 70000,
      codeunitName: "Sample",
      method: "OnlyTouchedUnrelated",
    };
    const baseline = [
      {
        ref: onlyTouchedUnrelated,
        coverage: {
          granularity: "procedure" as const,
          // This is the whole point: the ONLY thing this test's coverage names is "Unrelated" —
          // proof, not silence, that it executed that member and named nothing else. A
          // member-named entry means the coverage tool positively identified that execution;
          // it is not an absence that could be hiding the trigger.
          entries: [{ objectType: "Table", objectId: 70000, procedure: "Unrelated" }],
        },
      },
    ];
    const index = buildCoverageIndex(baseline);
    // A TABLE trigger: SymbolReference.json never records triggers, so this mutant's member-level
    // key can never hit — it must take FALLBACK 1 (object-level) unconditionally.
    const m = entry({ objectType: "table", procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], index, [onlyTouchedUnrelated]);

    expect(split.attribution.get("M0001")).toBe("object");
    // The covering-test list names a test that PROVABLY never touched the trigger — the
    // behavioural fact `ATTRIBUTION_INTERPRETATIONS.object` (selection.ts) exists to warn about.
    // Deliberately no assertion against that constant's literal wording: a legitimate reword must
    // not turn this detector red for a non-behavioural reason.
    expect(split.covered.get("M0001")?.map((t) => t.method)).toEqual(["OnlyTouchedUnrelated"]);
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
      originalText: "Original();",
      mutatedText: "",
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
        originalText: "Original();",
        mutatedText: "",
        triggerName: "OnInsert",
      });
      const m2 = entry({
        mutantId: "M0002",
        objectType: "table",
        codeunitId: 99998,
        procedureName: "",
        originalText: "Original();",
        mutatedText: "",
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

  // The warning above is unassertable by any gate: it goes to stderr and vanishes. The same tally
  // is returned on `CoverageSplit` so `SessionReport.untargetedTriggerCount` can carry it into
  // `tables.itest.ts`, which pins it at 0. Without the number, a regression re-emptying `byObject`
  // (the `0a463fd` bug) silently swaps precise attribution for "run every test" while leaving
  // every verdict and every aggregate count identical.
  test("returns the untargeted tally as DATA, counting exactly the mutants that took fallback 2", () => {
    const index = buildCoverageIndex(baseline);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fellBack = entry({
        mutantId: "M0001",
        objectType: "table",
        codeunitId: 99999, // nothing in the coverage index at all
        procedureName: "",
        originalText: "Original();",
        mutatedText: "",
        triggerName: "OnInsert",
      });
      const attributed = entry({
        mutantId: "M0002",
        objectType: "table", // objectId 70000 — object-level (fallback 1) answers
        procedureName: "",
        originalText: "Original();",
        mutatedText: "",
        triggerName: "OnModify",
      });
      const split = coverageFilter([fellBack, attributed], index, allGreen);
      // Both ran; only one of them ran untargeted. The verdict-visible state is identical.
      expect(split.covered.get("M0001")).toEqual(allGreen);
      expect(split.covered.get("M0002")).toEqual([t1, t3]);
      expect(split.untargetedTriggerCount).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the tally is 0 — not undefined — when every trigger was attributed precisely", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({ objectType: "table", procedureName: "Post", triggerName: "OnInsert" });
    expect(coverageFilter([m], index, allGreen).untargetedTriggerCount).toBe(0);
  });
});

// R140. Fallback 2 runs an unplaceable table trigger mutant against every GREEN test. When the
// object's only covering test is one that did NOT pass at baseline, that green set by construction
// excludes the one test able to kill the mutant, so it comes back `survived` — reliably, silently,
// and wrongly. Measured 2026-08-13: two mutants took that path, both pre-committed `killed`, and
// the pre-commitment was right.
//
// The member-level path already declines in exactly this situation (the mutant lands in
// `uncovered`, and the orchestrator then re-attributes it against the non-green baseline and
// records `error` with a note naming the red test). These tests hold fallback 2 to the same rule:
// when a non-green test covers the object, DECLINE rather than score, because a false `survived`
// is a manufactured defect report against the user's suite, not merely lost information.
describe("R140: fallback 2 declines when only a non-green test covers the object", () => {
  const redTest = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "RedAtBaseline" };
  // Green coverage names ONLY codeunit 70000 — nothing green mentions table 99999 at any
  // precision, so a table 99999 trigger mutant misses member level and object level alike.
  const greenBaseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Codeunit", objectId: 70000, procedure: "Post" }],
      },
    },
  ];
  const allGreen = [t1];
  const triggerMutant = () =>
    entry({
      objectType: "table",
      codeunitId: 99999,
      procedureName: "",
      originalText: "Original();",
      mutatedText: "",
      triggerName: "OnInsert",
    });

  test("declines: the mutant lands in `uncovered`, is not scored, and is not tallied as untargeted", () => {
    // The red test DID execute something in table 99999 — it is the only test that can reach the
    // trigger, and it is exactly the test the green set excludes.
    const nonGreenIndex = buildCoverageIndex([
      {
        ref: redTest,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Table", objectId: 99999 }],
        },
      },
    ]);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const m = triggerMutant();
      const split = coverageFilter([m], buildCoverageIndex(greenBaseline), allGreen, nonGreenIndex);
      expect(split.covered.size).toBe(0);
      expect(split.uncovered).toEqual([m]);
      expect(split.attribution.has("M0001")).toBe(false);
      // Not "we gave up and ran everything" — we declined, so the untargeted tally must not
      // claim this mutant was run untargeted.
      expect(split.untargetedTriggerCount).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("still falls back when NO test covers the object — green or otherwise", () => {
    // A non-green index that names a DIFFERENT table. Nothing anywhere saw table 99999, which is
    // the genuine "we don't know, so run everything" case fallback 2 was built for.
    const nonGreenIndex = buildCoverageIndex([
      {
        ref: redTest,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Table", objectId: 88888 }],
        },
      },
    ]);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const split = coverageFilter(
        [triggerMutant()],
        buildCoverageIndex(greenBaseline),
        allGreen,
        nonGreenIndex,
      );
      expect(split.covered.get("M0001")).toEqual(allGreen);
      expect(split.attribution.get("M0001")).toBe("all-green");
      expect(split.untargetedTriggerCount).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The decline is keyed on the (objectType, objectId) PAIR for the same reason every other
  // lookup in this file is — see `objectKeyOf`. A red test that covered `codeunit 99999` says
  // nothing about `table 99999`, and declining on it would turn a legitimate fallback into a
  // silent `no-coverage` for an unrelated object. R70's cross-kind name collision is this shape.
  test("does not decline on a non-green hit for the same id under a DIFFERENT object type", () => {
    const nonGreenIndex = buildCoverageIndex([
      {
        ref: redTest,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Codeunit", objectId: 99999, procedure: "Run" }],
        },
      },
    ]);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const split = coverageFilter(
        [triggerMutant()],
        buildCoverageIndex(greenBaseline),
        allGreen,
        nonGreenIndex,
      );
      expect(split.covered.get("M0001")).toEqual(allGreen);
      expect(split.untargetedTriggerCount).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Green coverage wins outright: fallback 2 is never reached, so the decline cannot fire and
  // cannot demote a mutant coverage placed precisely.
  test("a trigger the green index places at object level is unaffected by the non-green index", () => {
    const nonGreenIndex = buildCoverageIndex([
      {
        ref: redTest,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Table", objectId: 70000 }],
        },
      },
    ]);
    const green = [
      {
        ref: t1,
        coverage: {
          granularity: "procedure" as const,
          entries: [{ objectType: "Table", objectId: 70000, procedure: "Post" }],
        },
      },
    ];
    const m = entry({ objectType: "table", procedureName: "", triggerName: "OnInsert" });
    const split = coverageFilter([m], buildCoverageIndex(green), [t1], nonGreenIndex);
    expect(split.covered.get("M0001")).toEqual([t1]);
    expect(split.attribution.get("M0001")).toBe("object");
    expect(split.uncovered.length).toBe(0);
  });

  // Omitting the argument must leave every existing caller — including `coverageFilter`'s own
  // second, non-green-index invocation in the orchestrator — behaving exactly as before.
  test("omitting the non-green index keeps the pre-R140 behaviour", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const split = coverageFilter([triggerMutant()], buildCoverageIndex(greenBaseline), allGreen);
      expect(split.covered.get("M0001")).toEqual(allGreen);
      expect(split.untargetedTriggerCount).toBe(1);
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
      originalText: "Original();",
      mutatedText: "",
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
      originalText: "Original();",
      mutatedText: "",
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
      originalText: "Original();",
      mutatedText: "",
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
      originalText: "Original();",
      mutatedText: "",
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
      originalText: "Original();",
      mutatedText: "",
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
        originalText: "Original();",
        mutatedText: "",
        triggerName: "OnRun",
      });
      coverageFilter([uncovered, covered], index, allGreen);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// The other half of the false-survivor fix (bcdev-backend's `buildCoverageMap` emits it; this is
// where it has to LAND). An observation BC measured but whose member neither SymbolReference.json
// nor the local-procedure scan can name arrives here with `procedure` absent. It is evidence that
// the test executed SOMETHING in that object and no evidence about any member — so it must join
// `byObject` and stay out of `byMember`.
//
// Both directions matter. Dropping it (the bug) leaves `byObject` holding only whichever sibling
// test happened to resolve, so FALLBACK 1 answers non-empty-but-wrong and FALLBACK 2 never fires.
// Indexing it at member level with an empty name is the mirror-image trap: `<type>:<id>::` is the
// exact key `coverageFilter` builds for a trigger mutant, so the object-level entry would come
// back as an "exact member match" and both fallbacks would be skipped.
describe("coverage: an observation that names no member credits the object only", () => {
  const t3 = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "TouchesCount" };
  // Table 79300 = the live `Data Main` shape: one test's methodId resolved to a public procedure,
  // the other's was a TRIGGER and resolved to nothing at all.
  const baseline = [
    {
      ref: t1,
      coverage: {
        granularity: "procedure" as const,
        // trigger observation — measured, unnameable
        entries: [{ objectType: "Table", objectId: 79300 }],
      },
    },
    {
      ref: t3,
      coverage: {
        granularity: "procedure" as const,
        entries: [{ objectType: "Table", objectId: 79300, procedure: "TouchCount" }],
      },
    },
    // Covers nothing — so the object-level set {t1, t3} is STRICTLY narrower than all green
    // tests, and "matched precisely" can never be mistaken for "ran against everything".
    { ref: t2, coverage: { granularity: "procedure" as const, entries: [] } },
  ];
  const allGreen = [t1, t2, t3];

  test("it joins byObject", () => {
    const index = buildCoverageIndex(baseline);
    expect(index.byObject.get("table:79300")).toEqual(new Set([testKeyOf(t1), testKeyOf(t3)]));
  });

  test("it never joins byMember — no empty-named key is synthesized", () => {
    const index = buildCoverageIndex(baseline);
    // The collision key a trigger mutant's own member lookup would build.
    expect(index.byMember.has("table:79300::")).toBe(false);
    // ...and t1 contributed no member key at all, at any name.
    expect([...index.byMember.keys()]).toEqual(["table:79300::touchcount"]);
    expect(index.byMember.get("table:79300::touchcount")).toEqual(new Set([testKeyOf(t3)]));
  });

  test("a trigger mutant in that object is matched to the object-level-only test", () => {
    const index = buildCoverageIndex(baseline);
    const m = entry({
      objectType: "table",
      codeunitId: 79300,
      procedureName: "",
      originalText: "Original();",
      mutatedText: "",
      triggerName: "OnValidate",
    });
    const split = coverageFilter([m], index, allGreen);
    // The bug's signature: without t1's object-level entry this answered [t3] — the ONE test that
    // happened to resolve, which does not exercise the trigger — and scored the mutant survived.
    expect(split.covered.get("M0001")).toEqual([t1, t3]);
    expect(split.covered.get("M0001")).not.toEqual([t3]);
    expect(split.uncovered.length).toBe(0);
  });

  test("an ordinary procedure mutant is NOT credited by an object-level-only entry", () => {
    const index = buildCoverageIndex(baseline);
    // `Touch` is covered by nobody. t1's object-level entry must not be read as covering it —
    // object-level evidence says nothing about any particular member.
    const m = entry({ objectType: "table", codeunitId: 79300, procedureName: "Touch" });
    const split = coverageFilter([m], index, allGreen);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("a blank-but-present procedure name is refused, never indexed", () => {
    expect(() =>
      buildCoverageIndex([
        {
          ref: t1,
          coverage: {
            granularity: "procedure" as const,
            entries: [{ objectType: "Table", objectId: 79300, procedure: "" }],
          },
        },
      ]),
    ).toThrow(/blank/i);
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
