import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import { renderConsole, withheldKillOf } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * PR-116 (R1108): an `error` row whose covering test FAILED, but which al-runner v3 reported as
 * `NotRun ... this failure is not trusted: <failure>`, is named a withheld kill.
 */

const REFUSED =
  "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (T1: the test opens a TestPage; this failure is not trusted: Assert.AreEqual failed";
const AFTER_FAIL =
  "NotRun: out-of-scope: a test before this one in the codeunit did not pass (T2: failed with X) and left state; this failure is not trusted: Expected 1 got 2";
const AFTER_TIMEOUT =
  "NotRun: out-of-scope: a test before this one in the codeunit did not pass (T3: Test exceeded 3s timeout.) and left state; this failure is not trusted: boom";

/** Verbatim v3 texts committed elsewhere in the repo, so a change in v3's wording reddens this file too. */
// al-runner-v3-contract.test.ts NOT_TRUSTED_MESSAGE (R637/R639: after a timeout)
const REAL_AFTER_TIMEOUT =
  "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HangsDirty: did not run (the test used more than the time limit of 3 s of CPU time and was stopped (--test-timeout-secs)): it can change the global variable Probe Cut.Dirty that this test reads, so the state it would have left is not BC's; this failure is not trusted: dirty";
// pr56-measured-refusals.json (a measured cascade after a refused test), with the row's own prefix
const REAL_AFTER_REFUSAL =
  "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (FeatureKeyRollback: did not run (a rollback of an uncommitted Feature Key change (whether it is undone is a Linux suspec): it can write the table Feature Key that this test reads, so the state it would have left is not BC's; this failure is not trusted: The record in table Refusal Probe already exists. Identification fields and values: Id='1'";

describe("withheldKillOf on real v3 texts", () => {
  test("the contract row after a timeout, and a measured cascade after a refusal", () => {
    expect(
      withheldKillOf("error", "runner-refused", `${REAL_AFTER_TIMEOUT} ${V3_NOT_RUN_SUFFIX}`),
    ).toEqual({
      failure: "dirty",
      afterTest: "HangsDirty",
    });
    expect(
      withheldKillOf("error", "runner-refused", `${REAL_AFTER_REFUSAL} ${V3_NOT_RUN_SUFFIX}`),
    ).toEqual({
      failure:
        "The record in table Refusal Probe already exists. Identification fields and values: Id='1'",
      afterTest: "FeatureKeyRollback",
    });
  });
});

describe("withheldKillOf", () => {
  test("detects the three v3 shapes, with failure and afterTest", () => {
    expect(withheldKillOf("error", "runner-refused", REFUSED)).toEqual({
      failure: "Assert.AreEqual failed",
      afterTest: "T1",
    });
    expect(withheldKillOf("error", "runner-refused", AFTER_FAIL)).toEqual({
      failure: "Expected 1 got 2",
      afterTest: "T2",
    });
    expect(withheldKillOf("error", "runner-refused", AFTER_TIMEOUT)).toEqual({
      failure: "boom",
      afterTest: "T3",
    });
  });

  test("a note with another start has no afterTest", () => {
    expect(
      withheldKillOf(
        "error",
        "runner-refused",
        "NotRun: out-of-scope: other; this failure is not trusted: f",
      ),
    ).toEqual({ failure: "f" });
  });

  test("excluded: no phrase, killed, another cause, no cause, no note", () => {
    expect(withheldKillOf("error", "runner-refused", "NotRun: out-of-scope: x")).toBeUndefined();
    expect(withheldKillOf("killed", "runner-refused", REFUSED)).toBeUndefined();
    expect(withheldKillOf("error", "unstable", REFUSED)).toBeUndefined();
    expect(withheldKillOf("error", undefined, REFUSED)).toBeUndefined();
    expect(withheldKillOf("error", "runner-refused", undefined)).toBeUndefined();
  });

  test("excluded: the manual-binding cascade", () => {
    const note =
      "NotRun: out-of-scope: a test before this one in the codeunit did not pass (T: failed) and left a manual event subscription bound that it would have unbound later: the bindings this test starts with are not BC's; this failure is not trusted: The binding of codeunit 5 was unsuccessful.";
    expect(withheldKillOf("error", "runner-refused", note)).toBeUndefined();
  });

  test("excluded: a confirm or reproduce note (another prefix)", () => {
    expect(withheldKillOf("error", "runner-refused", `confirming T: ${REFUSED}`)).toBeUndefined();
    expect(withheldKillOf("error", "runner-refused", `reproducing T: ${REFUSED}`)).toBeUndefined();
  });

  test("the LAST occurrence of the phrase is used", () => {
    const note = `${AFTER_FAIL} then this failure is not trusted: second`;
    expect(withheldKillOf("error", "runner-refused", note)?.failure).toBe("second");
  });

  test("v3's suffix and LethAL's held and cap notes are cut", () => {
    const f = (tail: string) =>
      withheldKillOf("error", "runner-refused", `${AFTER_FAIL} ${tail}`)?.failure;
    expect(f(V3_NOT_RUN_SUFFIX)).toBe("Expected 1 got 2");
    expect(f("the timeout of T9 was not scored: U failed under the mutant")).toBe(
      "Expected 1 got 2",
    );
    expect(f("a timeout of T9 was held earlier in this walk and not scored")).toBe(
      "Expected 1 got 2",
    );
    expect(f("after the timeout: T8, T9")).toBe("Expected 1 got 2");
    expect(
      f(
        "the walk stopped after 3 timeouts (PR-108, R1057's cap); 4 covering test(s) after them were not run",
      ),
    ).toBe("Expected 1 got 2");
    expect(
      f(`${V3_NOT_RUN_SUFFIX} a timeout of T9 was held earlier in this walk and not scored`),
    ).toBe("Expected 1 got 2");
  });

  test("with v3's suffix present, a failure text holding LethAL's note words is kept whole", () => {
    // red when the fallback cuts apply even with the suffix: the failure is cut at " a timeout of "
    const note = `${AFTER_FAIL.replace("Expected 1 got 2", "Expected a timeout of 5 s, got none")} ${V3_NOT_RUN_SUFFIX} after the timeout: T8`;
    expect(withheldKillOf("error", "runner-refused", note)?.failure).toBe(
      "Expected a timeout of 5 s, got none",
    );
  });
});

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
} as const;

function entry(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 79600,
    codeunitName: "A",
    procedureName: "P",
    originalText: "x",
    mutatedText: "",
  };
}

type Row = readonly [SessionOutcome["verdict"], string | undefined, string | undefined];

function build(rows: readonly Row[], isolation = false) {
  const outcomes = rows.map(
    ([verdict, cause, failureNote], i) =>
      ({
        mutant: entry(`M${String(i + 1).padStart(4, "0")}`),
        verdict,
        batchIndex: 0,
        ...(cause !== undefined ? { cause } : {}),
        ...(failureNote !== undefined ? { failureNote } : {}),
      }) as SessionOutcome,
  );
  const r = legacyBuildReport({
    caps: CAPS,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    baselineTests: [],
  });
  return isolation ? { ...r, isolation: { mode: "auto" as const, codeunits: [] } } : r;
}

const W: Row = ["error", "runner-refused", AFTER_FAIL];

describe("withheld-kills caveat and report field", () => {
  test("some-errors: caveat, field on the row only, score untouched", () => {
    const r = build([["killed", undefined, undefined], W, ["error", "unstable", undefined]]);
    expect(r.validity.caveats).toContain("withheld-kills");
    expect(r.validity.caveats).toContain("some-errors");
    expect(r.mutants.map((m) => m.withheldKill)).toEqual([
      undefined,
      { failure: "Expected 1 got 2", afterTest: "T2" },
      undefined,
    ]);
    expect(r.mutationScore).toBe(1);
  });

  test("all-errors: caveat comes with all-errors", () => {
    const r = build([W, W]);
    expect(r.validity.caveats).toContain("withheld-kills");
    expect(r.validity.caveats).toContain("all-errors");
  });

  test("absent when no row is a withheld kill", () => {
    const r = build([
      ["killed", undefined, undefined],
      ["error", "runner-refused", "refused"],
    ]);
    expect(r.validity.caveats).not.toContain("withheld-kills");
    expect(renderConsole(r)).not.toContain("withheld kills");
  });
});

describe("withheld-kills console line", () => {
  const lineOf = (text: string) => text.split("\n").find((l) => l.startsWith("at least ")) ?? "";

  test("forced mode: names N and E, points at auto", () => {
    const r = build([["killed", undefined, undefined], W, ["error", "unstable", undefined]]);
    expect(lineOf(renderConsole(r))).toBe(
      'at least 1 of the 2 error mutant(s) are withheld kills: a covering test failed under the mutant, but al-runner v3 did not trust the failure after an earlier test of its codeunit was refused, failed or ran out of time. The score leaves them out (validity.caveats "withheld-kills"). Isolation "auto" scores most of them (R1102).',
    );
  });

  test("auto run: the variant that names method", () => {
    const r = build([["killed", undefined, undefined], W], true);
    const line = lineOf(renderConsole(r));
    expect(line).toEndWith(
      ' They are in codeunits isolation "auto" kept on "test"; "method" runs them one test per session (R1102, #8218).',
    );
    expect(line).not.toContain('Isolation "auto" scores');
  });

  test("sits right after the error-range line", () => {
    const lines = renderConsole(build([["killed", undefined, undefined], W])).split("\n");
    const i = lines.findIndex((l) => l.includes("had they run, it would read"));
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toStartWith("at least 1 of the 1 error mutant(s)");
  });
});
