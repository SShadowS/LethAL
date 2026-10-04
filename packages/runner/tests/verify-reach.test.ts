import { describe, expect, spyOn, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { CoverageEntry, CoverageMode, TestMethodRef, TestVerdict } from "../src/backend";
import { testKeyOf } from "../src/selection";
import { type ReachInput, narrowVerifyRequests, reachStateOf } from "../src/verify-reach";

// R-384: verify's reach filter. Every fixture that pins a fail-closed case gives the failing test
// coverage of a SIBLING member of S's object only, so the case goes red if its clause is reverted
// (the test would then be dropped from S, not joined to it).

const OBJ = 50000;

function mutant(mutantId: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId,
    file: "Logic.Codeunit.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.negate-conditional",
    operatorVersion: "1.0.0",
    astHash: `hash-${mutantId}`,
    objectType: "codeunit",
    codeunitId: OBJ,
    codeunitName: "Logic",
    procedureName: "Post",
    originalText: "a",
    mutatedText: "b",
    ...over,
  };
}

const ref = (method: string, codeunitId = 50100, codeunitName = "T"): TestMethodRef => ({
  codeunitId,
  codeunitName,
  method,
});

const hit = (procedure: string, objectId = OBJ, objectType = "Codeunit"): CoverageEntry => ({
  objectType,
  objectId,
  procedure,
});
const objectHit = (objectId: number, objectType = "Codeunit"): CoverageEntry => ({
  objectType,
  objectId,
});

/** A fresh green baseline row with these coverage entries. */
function pass(r: TestMethodRef, entries: readonly CoverageEntry[], sessionId = 1): TestVerdict {
  return {
    ref: r,
    outcome: "pass",
    durationMs: 1,
    coverage: { granularity: "line", entries },
    sessionId,
    testRunsBefore: 0,
  };
}

/** A `ReachInput` whose baseline is given as verdicts; each row's `ref` is its verdict's. */
function input(
  over: Partial<Omit<ReachInput, "baseline">> &
    Pick<ReachInput, "survivors"> & { readonly baseline?: readonly TestVerdict[] },
): ReachInput {
  const { baseline = [], ...rest } = over;
  return {
    mode: "fenced",
    enabled: true,
    coveringKeys: new Map(),
    newTests: [],
    refusedObjects: new Map(),
    ...rest,
    baseline: baseline.map((verdict) => ({ ref: verdict.ref, verdict })),
  };
}

const keysOf = (r: ReturnType<typeof narrowVerifyRequests>, id: string) =>
  (r.methods.get(id) ?? []).map(testKeyOf);

/** Runs `f` with `console.warn` silenced, returning what it was called with. */
function quietly<T>(f: () => T): { value: T; warned: unknown[][] } {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const value = f();
    return { value, warned: spy.mock.calls.map((c) => [...c]) };
  } finally {
    spy.mockRestore();
  }
}

const S = mutant("M0001"); // procedure Post
const SIB = [hit("Other")]; // a sibling member of S's object: never Post

describe("R-384: reachStateOf (rule 1)", () => {
  const cases: Array<[CoverageMode, boolean, string | undefined]> = [
    ["fenced", true, undefined],
    ["fenced", false, "--no-reach-filter"],
    ["procedure", true, 'coverage mode "procedure" is a hub mode'],
    ["line", true, 'coverage mode "line" is a hub mode'],
    ["none", true, 'coverage mode "none"'],
  ];
  for (const [mode, enabled, why] of cases) {
    test(`${mode}, enabled ${enabled}: ${why ?? "on"}`, () => {
      expect(reachStateOf(mode, enabled)).toEqual(
        why === undefined ? { on: true } : { on: false, why },
      );
    });
  }
});

describe("R-384: narrowVerifyRequests, fail-closed cases", () => {
  const T1 = ref("T1");
  const T2 = ref("T2");
  // T1 covers only the sibling member; under a filter that is on, it never reaches S.
  const offInput = (mode: CoverageMode, enabled = true) =>
    input({
      mode,
      enabled,
      survivors: [S],
      newTests: [T1, T2],
      baseline: [pass(T1, SIB), pass(T2, [hit("Post")])],
    });

  for (const mode of ["none", "procedure", "line"] as const) {
    test(`case ${mode === "none" ? 1 : 2}: mode ${mode} joins every new test to every survivor`, () => {
      const r = narrowVerifyRequests(offInput(mode));
      expect(r.state.on).toBe(false);
      expect(keysOf(r, "M0001")).toEqual(["50100::T1", "50100::T2"]);
    });
  }

  test("case 2b: --no-reach-filter joins every new test to every survivor", () => {
    const r = narrowVerifyRequests(offInput("fenced", false));
    expect(r.state).toEqual({ on: false, why: "--no-reach-filter" });
    expect(keysOf(r, "M0001")).toEqual(["50100::T1", "50100::T2"]);
  });

  test("control: the same fixture with the filter on drops the sibling-only test", () => {
    const r = narrowVerifyRequests(offInput("fenced"));
    expect(r.state).toEqual({ on: true });
    expect(keysOf(r, "M0001")).toEqual(["50100::T2"]);
  });

  test("case 3: a pass with no coverage joins S", () => {
    const { coverage: _none, ...noCoverage } = pass(T1, []);
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [noCoverage, pass(T2, SIB)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    expect(r.failClosedTests.map((f) => testKeyOf(f.ref))).toEqual(["50100::T1"]);
  });

  // F2 (case 4): the row carries sibling-only coverage, so only the fail-closed clause keeps T1.
  for (const outcome of ["fail", "timeout", "skip", "error", "deadline-exceeded"] as const) {
    test(`F2 case 4: outcome ${outcome} with sibling-only coverage joins S`, () => {
      const r = narrowVerifyRequests(
        input({
          survivors: [S],
          newTests: [T1, T2],
          baseline: [{ ...pass(T1, SIB), outcome }, pass(T2, SIB, 2)],
        }),
      );
      expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    });
  }

  // F1 (case 4b, review 1): a pass that is not fresh skipped setup, so its coverage can miss S.
  test("F1 case 4b: a reused-session pass with sibling-only coverage joins S", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [{ ...pass(T1, SIB), testRunsBefore: 3 }, pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
  });

  test("F1 case 4b: a pass with no session keys and sibling-only coverage joins S", () => {
    const { sessionId: _s, testRunsBefore: _t, ...noKeys } = pass(T1, SIB);
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [noKeys, pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
  });

  test("case 5: a pass with zero coverage entries joins S", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [pass(T1, []), pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
  });

  test("F2 case 6: a new test with no baseline row joins S; the filterable sibling-only one does not", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    expect(r.failClosedTests.map((f) => [testKeyOf(f.ref), f.why])).toEqual([
      ["50100::T1", "no baseline run"],
    ]);
  });

  test("case 8: a survivor in a refused object takes every new test", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1],
        baseline: [pass(T1, SIB)],
        refusedObjects: new Map([[`codeunit:${OBJ}`, "Logic is wrapped in #if (R298)"]]),
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    expect(r.failClosedSurvivors).toEqual([{ mutantId: "M0001", why: "refused" }]);
  });

  test("case 8: an unplaceable survivor (R175) takes every new test", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1],
        baseline: [
          {
            ...pass(T1, SIB),
            coverage: {
              granularity: "line",
              entries: SIB,
              namingGaps: [{ objectType: "Codeunit", objectId: OBJ }],
            },
          },
        ],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    expect(r.failClosedSurvivors).toEqual([{ mutantId: "M0001", why: "unplaceable" }]);
  });

  test("case 8: a survivor with no member key takes every new test", () => {
    const noKey = mutant("M0002", { procedureName: "", coverageArmNames: [] });
    const r = narrowVerifyRequests(
      input({ survivors: [noKey], newTests: [T1], baseline: [pass(T1, SIB)] }),
    );
    expect(keysOf(r, "M0002")).toEqual(["50100::T1"]);
    expect(r.failClosedSurvivors).toEqual([{ mutantId: "M0002", why: "no-member-key" }]);
  });

  test("case 9: a mixed session, one readable test and one not, is decided per test", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [{ ...pass(T1, SIB), outcome: "fail" }, pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    expect(r.filterable).toBe(1);
  });

  test("case 10: a table trigger no filterable test touched takes every filterable test", () => {
    const trig = mutant("M0003", {
      objectType: "table",
      codeunitId: 50200,
      procedureName: "",
      triggerName: "OnInsert",
    });
    const r = narrowVerifyRequests(
      input({
        survivors: [trig],
        newTests: [T1, T2],
        baseline: [pass(T1, SIB), pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0003")).toEqual(["50100::T1", "50100::T2"]);
    expect(r.untargeted).toEqual(["M0003"]);
  });

  // W3: with nonGreenIndex left out, a red test touching the table cannot make fallback 2 decline.
  test("W3 case 10: with a red test touching the table, S takes every filterable test plus the red one", () => {
    const trig = mutant("M0003", {
      objectType: "table",
      codeunitId: 50200,
      procedureName: "",
      triggerName: "OnInsert",
    });
    const T3 = ref("T3");
    const r = narrowVerifyRequests(
      input({
        survivors: [trig],
        newTests: [T1, T2, T3],
        baseline: [
          pass(T1, SIB),
          pass(T2, SIB, 2),
          { ...pass(T3, [objectHit(50200, "Table")], 3), outcome: "fail" },
        ],
      }),
    );
    expect(keysOf(r, "M0003")).toEqual(["50100::T1", "50100::T2", "50100::T3"]);
  });
});

describe("R-384: narrowVerifyRequests, positives", () => {
  const T1 = ref("T1");
  const T2 = ref("T2");

  test("a member hit joins; a sibling-member hit does not", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        newTests: [T1, T2],
        baseline: [pass(T1, [hit("Post")]), pass(T2, SIB, 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1"]);
    expect(r.joins).toBe(1);
    expect(r.unreached.size).toBe(0);
  });

  test("a trigger joins on an object-level hit", () => {
    const trig = mutant("M0004", { procedureName: "", triggerName: "OnRun" });
    const r = narrowVerifyRequests(
      input({
        survivors: [trig],
        newTests: [T1, T2],
        baseline: [pass(T1, [objectHit(OBJ)]), pass(T2, [hit("Post", 50300)], 2)],
      }),
    );
    expect(keysOf(r, "M0004")).toEqual(["50100::T1"]);
  });

  test("a local needs an exact hit under fenced: an unnamed object hit does not reach it", () => {
    const local = mutant("M0005", { procedureName: "Helper", procedureScope: "local" });
    const r = narrowVerifyRequests(
      input({
        survivors: [local],
        newTests: [T1, T2],
        baseline: [pass(T1, [objectHit(OBJ)]), pass(T2, [hit("Helper")], 2)],
      }),
    );
    expect(keysOf(r, "M0005")).toEqual(["50100::T2"]);
  });

  test("a source covering test that is new and no longer reaches S is KEPT", () => {
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        coveringKeys: new Map([["M0001", [T1]]]),
        newTests: [T1, T2],
        baseline: [pass(T1, SIB), pass(T2, [hit("Post")], 2)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50100::T1", "50100::T2"]);
    // T1 was already in S's covering set, so only T2 is a join.
    expect(r.joins).toBe(1);
  });

  test("a survivor no new test reaches and with no covering test is unreached", () => {
    const r = narrowVerifyRequests(
      input({ survivors: [S], newTests: [T1], baseline: [pass(T1, SIB)] }),
    );
    expect(keysOf(r, "M0001")).toEqual([]);
    expect([...r.unreached]).toEqual(["M0001"]);
    expect([...r.noNewTest]).toEqual(["M0001"]);
  });

  test("a survivor with covering tests but no reaching new test runs its covering tests", () => {
    const old = ref("Old", 50101, "U");
    const r = narrowVerifyRequests(
      input({
        survivors: [S],
        coveringKeys: new Map([["M0001", [old]]]),
        newTests: [T1],
        baseline: [pass(T1, SIB)],
      }),
    );
    expect(keysOf(r, "M0001")).toEqual(["50101::Old"]);
    expect(r.unreached.size).toBe(0);
    expect([...r.noNewTest]).toEqual(["M0001"]);
  });
});

describe("R-384: console lines (review 2)", () => {
  // W1: verify prints its own true lines; coverageFilter's are false inside verify.
  test("W1: an unplaceable survivor and a fallback-2 trigger write nothing to console.warn", () => {
    const T1 = ref("T1");
    const trig = mutant("M0003", {
      objectType: "table",
      codeunitId: 50200,
      procedureName: "",
      triggerName: "OnInsert",
    });
    const { value: r, warned } = quietly(() =>
      narrowVerifyRequests(
        input({
          survivors: [S, trig],
          newTests: [T1],
          baseline: [
            {
              ...pass(T1, SIB),
              coverage: {
                granularity: "line",
                entries: SIB,
                namingGaps: [{ objectType: "Codeunit", objectId: OBJ }],
              },
            },
          ],
        }),
      ),
    );
    // The fixture does reach both warning paths.
    expect(r.failClosedSurvivors).toEqual([{ mutantId: "M0001", why: "unplaceable" }]);
    expect(r.untargeted).toEqual(["M0003"]);
    expect(warned).toEqual([]);
  });
});
