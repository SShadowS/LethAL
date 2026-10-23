import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { NO_RESULT_FOR_METHOD } from "../src/bcdev-backend";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import {
  GROUP_SUITE_UNRESOLVED_HEAD,
  MutantBrokeTestDiscoveryError,
  ONRUN_HINT,
  STALE_TEST_APP_REMEDY,
  StaleTestAppError,
  TestAppChangedError,
  TestCodeunitDiscoveryError,
  baselineFoundNoneRefusal,
  describeStaleTestApp,
  groupedFoundNone,
  isRunMutantFoundNone,
  runMutantLineCountMessage,
} from "../src/stale-test-app";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R31. Publishing the test app is deliberately the user's own workflow, so LethAL republishes the
 * instrumented target on every run but never the tests. When what is deployed is older than the
 * source being measured, the symptom is badly disguised: the baseline goes red, dozens of mutants
 * fall to `no-coverage`, and the whole thing reads as a mutation-scoring problem. It has cost two
 * debugging sessions.
 *
 * The evidence was already there per-test — the backend returns `NO_RESULT_FOR_METHOD` when the
 * server has no result for a method it was asked to run, which means the published app does not
 * contain it. Nothing aggregated it into a statement.
 */

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
} as const;

function entry(): MutantManifestEntry {
  return {
    mutantId: "M0001",
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: "hash",
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "Original();",
    mutatedText: "",
  };
}

function build(over: Record<string, unknown> = {}) {
  const outcomes: SessionOutcome[] = [{ mutant: entry(), verdict: "no-coverage", batchIndex: 0 }];
  return legacyBuildReport({
    caps: CAPS,
    baselineGreen: false,
    batches: 1,
    outcomes,
    unsupportedTests: ["Tests.Gone", "Tests.AlsoGone"],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
    ...over,
  });
}

describe("SessionReport.staleTestApp (R31)", () => {
  test("names the tests the server had no result for, sorted", () => {
    // Sorted for the same reason `permissionsRefused.tests`/`testPageUnsupported.tests` are: the
    // orchestrator's real caller always fed this pre-sorted (`[...missingFromServer].sort()`), and
    // the event-stream fold now does the sorting itself (report-fold.ts) rather than relying on
    // every caller to have already deduped/sorted its own Set — the same treatment the other two
    // "list of test names" fields already got from `buildReport` directly.
    const r = build({ staleTestApp: { missingTests: ["Tests.Gone", "Tests.AlsoGone"] } });
    expect(r.staleTestApp?.missingTests).toEqual(["Tests.AlsoGone", "Tests.Gone"]);
    expect(r.validity.caveats).toContain("stale-test-app");
  });

  test("absent — not an empty list — when every test produced a result", () => {
    // An empty `staleTestApp` block would read as "checked, and the app is current"; absence is
    // the honest encoding of "nothing indicated staleness".
    const r = build();
    expect(r.staleTestApp).toBeUndefined();
    expect(r.validity.caveats).not.toContain("stale-test-app");
  });

  test("the console says what to DO, not just that something is wrong", () => {
    const text = renderConsole(build({ staleTestApp: { missingTests: ["Tests.Gone"] } }));
    expect(text).toContain("STALE TEST APP");
    expect(text).toContain("Republish");
    // And it must explain the disguised symptom, since that is what sent two sessions the wrong
    // way: the mutants land as no-coverage/survived and look like a scoring problem.
    expect(text).toMatch(/no-coverage|survived/);
    expect(text).toContain("Tests.Gone");
  });

  test("it is distinct from a merely red baseline", () => {
    // A red baseline has many causes; only this one means the DEPLOYED tests are out of date.
    // Collapsing them would send a reader to debug their assertions instead of republishing.
    const redOnly = build();
    const stale = build({ staleTestApp: { missingTests: ["Tests.Gone"] } });
    expect(redOnly.validity.caveats).toContain("baseline-red");
    expect(stale.validity.caveats).toEqual(
      expect.arrayContaining(["baseline-red", "stale-test-app"]),
    );
    expect(renderConsole(redOnly)).not.toContain("STALE TEST APP");
  });
});

describe("NO_RESULT_FOR_METHOD — producer and detector share one constant", () => {
  test("is the exact text the backend emits, so the detector cannot silently stop matching", () => {
    // The detector in runSession compares `failureMessage` against this constant. If the backend
    // reworded its literal independently, the diagnosis would quietly never fire again and the
    // symptom would go back to reading as a scoring problem.
    expect(NO_RESULT_FOR_METHOD).toBe("bcdev_test_run returned no result for the requested method");
  });
});

/**
 * R139. The R31 detector above keys on `NO_RESULT_FOR_METHOD`, which only the `bcdev_test_run`
 * path produces. The tables gate runs its baseline through the FENCED RunMutant transport, whose
 * answer for a method the published app does not contain is a different string entirely, so the
 * detector has never once fired on the path that actually hit this problem — twice, on live gate
 * runs three days apart (roadmap R139).
 *
 * The server's own words are the evidence, not the client's line counter. `RunOneMethod`
 * (extensions/lethal-control/src/RunMethod.Codeunit.al) answers `{"error": "expected exactly one
 * method %1, found %2"}` with NO `testResults` key, and `BuildRunError`
 * (ControlApi.Codeunit.al) wraps EVERY caught phase-2 terminal error in that same shape. So the
 * transport sees zero test lines for a missing method, for a DUPLICATE method (`found 2`), for a
 * lock timeout, and for a failed suite load alike. Matching the line count would name a confident
 * wrong cause on every one of those; matching `found 0` names the one condition that has exactly
 * one producing code path.
 */
describe("describeStaleTestApp (R139)", () => {
  const missing = (method: string) =>
    `${runMutantLineCountMessage(0, `expected exactly one method ${method}, found ${0}`)}`;

  test("names the method when the server says it found none", () => {
    const d = describeStaleTestApp(missing("NegationFlipChangesTheCount"));
    expect(d).toBeDefined();
    expect(d).toContain("NegationFlipChangesTheCount");
    expect(d).toContain("published");
  });

  test("still matches the bcdev sentinel, so R31's own path keeps its diagnosis", () => {
    expect(describeStaleTestApp(NO_RESULT_FOR_METHOD)).toBeDefined();
  });

  test("declines a DUPLICATE method, which reaches the client as the same zero test lines", () => {
    // `found 2` takes the identical AL exit with no testResults key. It means the published app has
    // the method twice, not zero times, and republishing is the wrong remedy for it.
    const dup = runMutantLineCountMessage(0, "expected exactly one method SomeTest, found 2");
    expect(describeStaleTestApp(dup)).toBeUndefined();
  });

  test("declines a wrapped platform error, which also reaches the client as zero test lines", () => {
    const locked = runMutantLineCountMessage(
      0,
      "The AL Test Suite table cannot be changed because it is locked by another user.",
    );
    expect(describeStaleTestApp(locked)).toBeUndefined();
  });

  test("declines a bare line-count message with no server text at all", () => {
    // `{"testResults":[]}` with no `error` key is a distinct, unmeasured server state. Claiming
    // staleness for it would be a guess.
    expect(describeStaleTestApp(runMutantLineCountMessage(0, undefined))).toBeUndefined();
  });

  test("declines the server wording when it did not come from the zero-line branch", () => {
    // A test whose own Error(...) quotes this wording must not be read as a server refusal. Only
    // the transport builds the prefix, and it builds it nowhere else.
    expect(
      describeStaleTestApp("expected exactly one method PickedByHand, found 0"),
    ).toBeUndefined();
  });

  test("declines a permissions refusal, a TestPage refusal and an ordinary assertion", () => {
    expect(
      describeStaleTestApp(
        "Sorry, the current permissions prevented the action. (TableData 79300 Data Main Insert)",
      ),
    ).toBeUndefined();
    expect(
      describeStaleTestApp(
        "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
          "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()",
      ),
    ).toBeUndefined();
    expect(describeStaleTestApp("expected 2 rows other than FILT-A1, got 1")).toBeUndefined();
  });

  test("declines undefined — a verdict need not carry a message", () => {
    expect(describeStaleTestApp(undefined)).toBeUndefined();
  });
});

describe("R686: a test codeunit whose OnRun raises is named, not called a stale test app", () => {
  const found0 = (m: string) =>
    runMutantLineCountMessage(0, `expected exactly one method ${m}, found 0`);
  const P = "package:aaaa";
  const finding = (method: string, text = found0(method)) => ({
    name: `R537 OnRun Tests.${method}`,
    codeunit: "R537 OnRun Tests",
    description: "d",
    foundNone: isRunMutantFoundNone(text),
  });
  const both = [finding("AfterThrowingOnRun"), finding("AfterThrowingOnRunTwo")];
  const proven = {
    missing: both,
    testsPerCodeunit: new Map([["R537 OnRun Tests", 2]]),
    proven: P,
    before: P,
    after: P,
    compiledInPublishedPackage: true,
  };

  test("A1: every condition holds -> TestCodeunitDiscoveryError, naming the codeunit, no republish remedy", () => {
    const err = baselineFoundNoneRefusal(proven);
    expect(err).toBeInstanceOf(TestCodeunitDiscoveryError);
    expect(err.message).toContain("R537 OnRun Tests");
    expect(err.message).toContain("OnRun");
    expect(err.message).not.toContain(STALE_TEST_APP_REMEDY);
    expect((err as TestCodeunitDiscoveryError).missingTests).toEqual(both.map((f) => f.name));
  });

  test("A2: evidence not compiled -> StaleTestAppError, with the OnRun sentence", () => {
    const err = baselineFoundNoneRefusal({ ...proven, compiledInPublishedPackage: false });
    expect(err).toBeInstanceOf(StaleTestAppError);
    expect(err.message).toContain(STALE_TEST_APP_REMEDY);
    expect(err.message).toContain(ONRUN_HINT);
  });

  test("A3: the test app not proven installed (a staged upgrade) -> StaleTestAppError + sentence", () => {
    for (const p of [undefined, "package:bbbb", "source:aaaa"]) {
      const err = baselineFoundNoneRefusal({ ...proven, proven: p });
      expect(err).toBeInstanceOf(StaleTestAppError);
      expect(err.message).toContain(ONRUN_HINT);
    }
    // Equal `source:` hashes prove nothing either.
    const s = "source:cccc";
    expect(baselineFoundNoneRefusal({ ...proven, proven: s, before: s, after: s })).toBeInstanceOf(
      StaleTestAppError,
    );
  });

  test("A4: the package changed between the reads -> TestAppChangedError", () => {
    expect(baselineFoundNoneRefusal({ ...proven, after: "package:bbbb" })).toBeInstanceOf(
      TestAppChangedError,
    );
  });

  test("A5: one method missing beside a passing sibling -> StaleTestAppError (OnRun blanks a whole codeunit)", () => {
    const err = baselineFoundNoneRefusal({
      ...proven,
      missing: [finding("AfterThrowingOnRun")],
    });
    expect(err).toBeInstanceOf(StaleTestAppError);
  });

  test("A6: NO_RESULT_FOR_METHOD is not the found-0 form: StaleTestAppError without the sentence", () => {
    const err = baselineFoundNoneRefusal({
      ...proven,
      missing: both.map((f) => ({ ...f, foundNone: isRunMutantFoundNone(NO_RESULT_FOR_METHOD) })),
    });
    expect(err).toBeInstanceOf(StaleTestAppError);
    expect(err.message).not.toContain(ONRUN_HINT);
  });

  test("isRunMutantFoundNone: only the RunMutant found-0 form", () => {
    expect(isRunMutantFoundNone(found0("X"))).toBe(true);
    expect(
      isRunMutantFoundNone(runMutantLineCountMessage(0, "expected exactly one method X, found 2")),
    ).toBe(false);
    expect(isRunMutantFoundNone(NO_RESULT_FOR_METHOD)).toBe(false);
    expect(isRunMutantFoundNone(undefined)).toBe(false);
  });

  test("groupedFoundNone reads the method and codeunit from the reason; found 2 and same-line are not it", () => {
    const g = (reason: string) => `${GROUP_SUITE_UNRESOLVED_HEAD}${reason}`;
    expect(
      groupedFoundNone(
        g("expected exactly one method My Test, in codeunit, in codeunit 50981, found 0"),
      ),
    ).toEqual({
      method: "My Test, in codeunit,",
      codeunitId: 50981,
    });
    // A quoted AL name may hold " in codeunit " itself: the LAST one is the separator.
    expect(
      groupedFoundNone(
        g("expected exactly one method Run in codeunit X in codeunit 50981, found 0"),
      ),
    ).toEqual({ method: "Run in codeunit X", codeunitId: 50981 });
    expect(
      groupedFoundNone(g("expected exactly one method A in codeunit 50981, found 2")),
    ).toBeUndefined();
    expect(
      groupedFoundNone(g("entries 1 and 2 (50981.A) resolve to the same function line 10000")),
    ).toBeUndefined();
    expect(
      groupedFoundNone("expected exactly one method A in codeunit 50981, found 0"),
    ).toBeUndefined();
  });

  test("B: the mid-run error says one call answered, names the mutant, file and codeunit, and how to go on", () => {
    const e = new MutantBrokeTestDiscoveryError({
      mutantId: "M0007",
      file: "src/Logic.Codeunit.al",
      operator: "lethal.empty-block",
      test: "R537 OnRun Tests.AfterThrowingOnRun",
      codeunit: "R537 OnRun Tests",
      serverText: found0("AfterThrowingOnRun"),
    });
    expect(e.message).not.toContain("two consecutive");
    for (const s of [
      "M0007",
      "src/Logic.Codeunit.al",
      "R537 OnRun Tests",
      "OnRun",
      "--resume",
      '--exclude "src/Logic.Codeunit.al"',
    ])
      expect(e.message).toContain(s);
  });
});
