import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutantManifestEntry } from "@lethal/schemata";
import {
  ASSERTION_SCREEN_DISCRIMINATION_NOTES,
  ASSERTION_SCREEN_VACUOUS_AL_RUNNER_NOTE,
  killMessageOf,
  looksLikeAssertionFailure,
  looksLikeRunnerRefusal,
  screenMessageOf,
} from "../src/assertion-screen";
import type { BackendCapabilities } from "../src/backend";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R121 — the assertion SCREEN, and the two things that make it honest rather than merely present.
 *
 * 1. The rule that ships is the rule that was MEASURED. The last describe block below re-scores it
 *    against the committed 73-kill corpus and pins the exact numbers R121 recorded, so a change to
 *    the predicate that quietly alters what it flags fails here rather than in a campaign months
 *    later.
 * 2. The screen reports its own DISCRIMINATION. The same flagged count means opposite things on a
 *    suite using an assertion library and on one raising via bare `Error(...)`, and the `vacuous`
 *    case is asserted directly because it is the case the tables fixture actually produces.
 *
 * Verdicts never move — asserted here as well as in the R72 screen's tests, because it is the one
 * property that would invalidate every frozen figure in the repo if it broke.
 */

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

function entry(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.swap-call-arguments",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "F(a, b)",
    mutatedText: "F(b, a)",
  };
}

function kill(id: string, failure?: string): SessionOutcome {
  return {
    mutant: entry(id),
    verdict: "killed",
    batchIndex: 0,
    ...(failure !== undefined ? { killingTestFailure: failure } : {}),
  };
}

/** R553: the al-runner backend's identity, as `AlRunnerBackend.capabilities()` declares it. */
const AL_RUNNER_CAPS: BackendCapabilities = {
  ...CAPS,
  coverage: "none",
  authoritative: false,
  kind: "al-runner",
};
const BCDEV_CAPS: BackendCapabilities = { ...CAPS, kind: "bcdev" };

function build(outcomes: readonly SessionOutcome[], caps: BackendCapabilities = CAPS) {
  return legacyBuildReport({
    caps,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
  });
}

const ASSERTION =
  "Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2>.\nA(CodeUnit 1).P line 3";
const OVERFLOW =
  "The length of the string is 18, but it must be less than or equal to 10 characters.\nA(CodeUnit 1).P line 3";

describe("looksLikeAssertionFailure", () => {
  test("recognises Microsoft's Library Assert prefix, case-insensitively", () => {
    expect(looksLikeAssertionFailure("Assert.AreEqual failed.")).toBe(true);
    // AL is case-insensitive and so is the library's own spelling in older suites.
    expect(looksLikeAssertionFailure("ASSERT.IsTrue failed.")).toBe(true);
  });

  test("does not recognise a bare Error(), which is the whole measured limitation", () => {
    // All 22 tests in fixtures/sandbox-data-tests raise this way, which is why the tables gate's
    // screen is `vacuous` rather than informative.
    expect(looksLikeAssertionFailure("expected 2 in-filter rows, got 5")).toBe(false);
  });

  test("does not match `Assert` used mid-sentence — the anchor is load-bearing", () => {
    expect(looksLikeAssertionFailure("the Assert. library was not loaded")).toBe(false);
  });
});

describe("looksLikeRunnerRefusal (R101(f))", () => {
  test("recognises al-runner's measured out-of-scope marker", () => {
    expect(
      looksLikeRunnerRefusal(
        "InvalidOperationException: out-of-scope: HttpClient.Get - external-http - see docs/scope.md#external-http",
      ),
    ).toBe(true);
  });

  test("does NOT claim BC's file-sandbox refusal, which is a different mechanism", () => {
    // R101 measured these as two mechanisms, and its own row conflated them. BC's is prose and
    // localises (R66); al-runner's does not. Claiming both here would put a localising rule behind
    // a name that promises it does not localise.
    expect(
      looksLikeRunnerRefusal(
        "NavNCLInvalidPathException: Files outside of the current users folder cannot be accessed",
      ),
    ).toBe(false);
  });
});

describe("SessionReport.assertionScreen (R121)", () => {
  test("flags the non-assertion kill and leaves the assertion kill alone", () => {
    const r = build([kill("M0001", OVERFLOW), kill("M0002", ASSERTION)]);
    expect(r.assertionScreen?.kills).toBe(2);
    expect(r.assertionScreen?.killsWithText).toBe(2);
    expect(r.assertionScreen?.flagged).toBe(1);
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001"]);
    expect(r.assertionScreen?.discrimination).toBe("partial");
    expect(r.validity.caveats).toContain("kills-without-assertion");
  });

  test("says VACUOUS when every kill is flagged — the bare-Error() suite", () => {
    // The measured shape of the tables gate. Without this field the count `2 of 2` would read as a
    // finding, when what it actually says is that the rule cannot see anything on this suite.
    const r = build([
      kill("M0001", "expected 2 rows, got 5\nA(CodeUnit 1).P line 3"),
      kill("M0002", OVERFLOW),
    ]);
    expect(r.assertionScreen?.flagged).toBe(2);
    expect(r.assertionScreen?.discrimination).toBe("vacuous");
    expect(r.assertionScreen?.discriminationNote).toContain("separated nothing");
  });

  test("says NONE when every kill came from an assertion, and pushes no caveat", () => {
    const r = build([kill("M0001", ASSERTION), kill("M0002", ASSERTION)]);
    expect(r.assertionScreen?.flagged).toBe(0);
    expect(r.assertionScreen?.discrimination).toBe("none");
    expect(r.validity.caveats).not.toContain("kills-without-assertion");
    // Still PRESENT: "checked, and every kill came from an assertion" must not look like
    // "not checked".
    expect(r.assertionScreen).toBeDefined();
  });

  test("says NO-TEXT when nothing carried a message, rather than NONE", () => {
    // `none` would read as "every kill came from an assertion" when in fact the rule was never
    // applied to anything. Two different facts must not share one word.
    const r = build([kill("M0001"), kill("M0002")]);
    expect(r.assertionScreen?.discrimination).toBe("no-text");
    expect(r.assertionScreen?.discriminationNote).toContain("never applied");
    expect(r.validity.caveats).not.toContain("kills-without-assertion");
  });

  test("counts textless kills separately instead of flagging them", () => {
    // The corpus the rule was scored on carried text on every kill. Flagging a textless kill would
    // apply the rule outside its own measurement and inflate the count with mutants it knows
    // nothing about.
    const r = build([kill("M0001"), kill("M0002", ASSERTION)]);
    expect(r.assertionScreen?.killsWithoutText).toBe(1);
    expect(r.assertionScreen?.killsWithText).toBe(1);
    expect(r.assertionScreen?.flagged).toBe(0);
  });

  test("names al-runner's out-of-scope refusals as a subset of the flagged", () => {
    const r = build([
      kill(
        "M0001",
        "InvalidOperationException: out-of-scope: HttpClient.Get - external-http - see docs/scope.md#external-http",
      ),
      kill("M0002", OVERFLOW),
      kill("M0003", ASSERTION),
    ]);
    expect(r.assertionScreen?.flagged).toBe(2);
    expect(r.assertionScreen?.runnerRefusals).toBe(1);
    expect(r.assertionScreen?.runnerRefusalMutants).toEqual(["0/M0001"]);
  });

  test("does not move a verdict, a count, or the score", () => {
    const flagged = build([kill("M0001", OVERFLOW), kill("M0002", ASSERTION)]);
    const clean = build([kill("M0001", ASSERTION), kill("M0002", ASSERTION)]);
    expect(flagged.counts).toEqual(clean.counts);
    expect(flagged.mutationScore).toBe(clean.mutationScore);
    expect(flagged.mutants.map((m) => m.verdict)).toEqual(clean.mutants.map((m) => m.verdict));
    // And the screen really did differ between the two, or the equality proves nothing.
    expect(flagged.assertionScreen?.flagged).toBe(1);
    expect(clean.assertionScreen?.flagged).toBe(0);
  });

  test("absent only when the run produced no kill at all", () => {
    const r = build([{ mutant: entry("M0001"), verdict: "survived", batchIndex: 0 }]);
    expect(r.assertionScreen).toBeUndefined();
  });

  test("the console leads with the discrimination, not the count", () => {
    const text = renderConsole(build([kill("M0001", OVERFLOW), kill("M0002", ASSERTION)]));
    expect(text).toContain("ASSERTION SCREEN");
    expect(text).toContain("[partial]");
    expect(text).toContain("M0001");
    // The hedge: a screen that told a reader to subtract these would be the classifier R121
    // measured as unshippable.
    expect(text).toContain("do not");
  });
});

/**
 * R553: al-runner writes every failure as `{Type.Name}: {Message}` (R101(f)), so the `Assert.`
 * prefix the rule looks for sits behind an exception type name and the screen flagged every kill.
 * The screen now reads past ONE leading `...Exception: ` on the al-runner backend only, keyed on the
 * backend's own identity (`caps.kind`), never on `authoritative` and never on the text. All texts
 * here are synthetic.
 */
describe("R553: the screen reads past al-runner's exception-type prefix", () => {
  const CS = "\nA(CodeUnit 1).P line 3";
  const P_ASSERT = `NavNCLDialogException: Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2>.${CS}`;
  const P_BARE = `NavNCLDialogException: expected 2 rows, got 5${CS}`;
  const P_DUPKEY = `NavCSideDuplicateKeyException: The record already exists.${CS}`;
  const BARE = `expected 2 rows, got 5${CS}`;
  const WRAPPED =
    "An OnBeforeTestMethodRun subscriber (codeunit 50100) failed, so the test did not run: NavNCLDialogException: Assert.IsTrue failed.";

  function timeoutKill(id: string, failure: string): SessionOutcome {
    return {
      mutant: entry(id),
      verdict: "timeout-killed",
      batchIndex: 0,
      killingTestFailure: failure,
    };
  }

  test("1. a prefixed assertion is read as an assertion on al-runner", () => {
    const r = build([kill("M0001", P_ASSERT), kill("M0002", P_BARE)], AL_RUNNER_CAPS);
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0002"]);
    expect(r.assertionScreen?.discrimination).toBe("partial");
  });

  test("2. a prefixed NON-assertion is still flagged", () => {
    const r = build([kill("M0001", P_DUPKEY), kill("M0002", P_ASSERT)], AL_RUNNER_CAPS);
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001"]);
  });

  test("2. the prefix is anchored: a type name later in the text is not stripped (I2)", () => {
    expect(screenMessageOf(WRAPPED, "al-runner")).toBe(killMessageOf(WRAPPED));
  });

  test("2. only a name ending in `Exception` is stripped", () => {
    const r = build([kill("M0001", `Total: Assert.AreEqual failed.${CS}`)], AL_RUNNER_CAPS);
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001"]);
  });

  test("2. the prefix is stripped ONCE", () => {
    const r = build(
      [kill("M0001", `XException: YException: Assert.AreEqual failed.${CS}`)],
      AL_RUNNER_CAPS,
    );
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001"]);
  });

  test("2. a namespaced type name is stripped too", () => {
    expect(
      screenMessageOf(`System.InvalidOperationException: Assert.IsTrue failed.${CS}`, "al-runner"),
    ).toBe("Assert.IsTrue failed.");
  });

  test("3. bcdev text is unchanged, whatever it starts with", () => {
    const x = `NavNCLDialogException: Assert.AreEqual failed.${CS}`;
    expect(screenMessageOf(x, "bcdev")).toBe(killMessageOf(x));
    for (const caps of [CAPS, BCDEV_CAPS]) {
      const r = build([kill("M0001", x), kill("M0002", ASSERTION)], caps);
      expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001"]);
    }
  });

  test("ruling: an al-runner backend forced authoritative still strips", () => {
    const r = build([kill("M0001", P_ASSERT), kill("M0002", P_BARE)], {
      ...AL_RUNNER_CAPS,
      authoritative: true,
    });
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0002"]);
    expect(r.backend).toBe("al-runner");
  });

  test("ruling: a bcdev backend never strips, even when not authoritative", () => {
    const r = build([kill("M0001", P_ASSERT), kill("M0002", P_BARE)], {
      ...BCDEV_CAPS,
      authoritative: false,
    });
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001", "0/M0002"]);
    expect(r.backend).toBe("bcdev");
  });

  test("4. the stored failure text is never changed", () => {
    const r = build([kill("M0001", P_ASSERT), kill("M0002", P_BARE)], AL_RUNNER_CAPS);
    expect(r.mutants.map((m) => m.killingTestFailure)).toEqual([P_ASSERT, P_BARE]);
  });

  test("5a. al-runner, a killed kill without the prefix: the backend note", () => {
    const r = build([kill("M0001", BARE), kill("M0002", OVERFLOW)], AL_RUNNER_CAPS);
    expect(r.assertionScreen?.discrimination).toBe("vacuous");
    expect(r.assertionScreen?.discriminationNote).toBe(ASSERTION_SCREEN_VACUOUS_AL_RUNNER_NOTE);
    expect(r.assertionScreen?.discriminationNote).toContain("al-runner");
  });

  test("5b. al-runner, every killed kill prefixed with bare text: the standard note", () => {
    const r = build([kill("M0001", P_BARE), kill("M0002", P_DUPKEY)], AL_RUNNER_CAPS);
    expect(r.assertionScreen?.discrimination).toBe("vacuous");
    expect(r.assertionScreen?.discriminationNote).toBe(
      ASSERTION_SCREEN_DISCRIMINATION_NOTES.vacuous,
    );
  });

  test("5c. bcdev, the same texts as 5a: the standard note", () => {
    const r = build([kill("M0001", BARE), kill("M0002", OVERFLOW)], BCDEV_CAPS);
    expect(r.assertionScreen?.discrimination).toBe("vacuous");
    expect(r.assertionScreen?.discriminationNote).toBe(
      ASSERTION_SCREEN_DISCRIMINATION_NOTES.vacuous,
    );
  });

  test("5d. a timeout kill's unprefixed text does not pick the backend note (I3)", () => {
    const r = build(
      [
        kill("M0001", P_BARE),
        kill("M0002", P_DUPKEY),
        timeoutKill("M0003", "Test exceeded 5s timeout."),
      ],
      AL_RUNNER_CAPS,
    );
    expect(r.assertionScreen?.discrimination).toBe("vacuous");
    expect(r.assertionScreen?.flagged).toBe(3);
    expect(r.assertionScreen?.discriminationNote).toBe(
      ASSERTION_SCREEN_DISCRIMINATION_NOTES.vacuous,
    );
  });

  test("5e. ONE unprefixed killed kill among prefixed ones picks the backend note (some, not every)", () => {
    const r = build(
      [kill("M0001", P_BARE), kill("M0002", BARE), kill("M0003", P_DUPKEY)],
      AL_RUNNER_CAPS,
    );
    expect(r.assertionScreen?.discrimination).toBe("vacuous");
    expect(r.assertionScreen?.discriminationNote).toBe(ASSERTION_SCREEN_VACUOUS_AL_RUNNER_NOTE);
  });

  test("6. al-runner's out-of-scope refusal is still counted under al-runner caps", () => {
    const r = build(
      [
        kill(
          "M0001",
          "InvalidOperationException: out-of-scope: HttpClient.Get - external-http - see docs/scope.md#external-http",
        ),
        kill("M0002", P_ASSERT),
      ],
      AL_RUNNER_CAPS,
    );
    expect(r.assertionScreen?.flaggedMutants).toEqual(["0/M0001"]);
    expect(r.assertionScreen?.runnerRefusals).toBe(1);
    expect(r.assertionScreen?.runnerRefusalMutants).toEqual(["0/M0001"]);
  });
});

/**
 * The rule that ships, re-scored against the corpus it was measured on.
 *
 * `scripts/r121-classify-eval.ts` imports the same two functions, so this is not a second
 * implementation being checked against the first — it is the SHIPPED predicate run over the
 * committed 73-kill ground truth, pinning the exact figures R121 recorded. If the predicate is ever
 * "improved", this fails and the improvement has to be re-measured rather than assumed.
 */
describe("the shipped rule, re-scored on R121's committed corpus", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const corpusPath = join(
    repoRoot,
    "docs",
    "campaign",
    "2026-08-08-r85-swap-population",
    "rung2.report.json",
  );
  const LENGTH_OVERFLOW =
    /^The length of the string is \d+, but it must be less than or equal to \d+/;

  test("flags 23 of 73 kills, catching all 6 hand-classified false kills", () => {
    const report = JSON.parse(readFileSync(corpusPath, "utf8")) as {
      mutants: ReadonlyArray<{
        mutantCode: string;
        verdict: string;
        killingTestFailure?: string;
      }>;
    };
    const kills = report.mutants.filter(
      (m) => m.verdict === "killed" || m.verdict === "timeout-killed",
    );
    expect(kills.length).toBe(73);

    const messages = kills.map((m) => ({
      code: m.mutantCode,
      message: killMessageOf(m.killingTestFailure),
    }));
    const flagged = messages.filter((m) => !looksLikeAssertionFailure(m.message));
    const groundTruthFalse = messages.filter((m) => LENGTH_OVERFLOW.test(m.message));

    expect(groundTruthFalse.length).toBe(6);
    expect(flagged.length).toBe(23);
    // 100% RECALL is the property that makes this shippable at all: every hand-classified false
    // kill is inside the flagged set.
    const flaggedCodes = new Set(flagged.map((m) => m.code));
    for (const f of groundTruthFalse) expect(flaggedCodes.has(f.code)).toBe(true);
    // 26.1% precision, stated as the fraction rather than a rounded percentage so it cannot drift.
    expect(groundTruthFalse.length / flagged.length).toBeCloseTo(6 / 23, 10);
  });
});
