import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { unsupportedCoverageNote } from "../src/orchestrator";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { describeTestPageUnsupported } from "../src/testpage-unsupported";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R69. A test that opens a `TestPage` cannot run in the fenced `GuiAllowed=No` /
 * `ClientType=ODataV4` session R58 made the default: the platform refuses to build the test
 * service the TestPage needs. MEASURED 2026-07-31 on Cronus281 (`fixtures/sandbox-probes`), and
 * it is a FAST refusal (87 ms), not the hang the row was originally filed as:
 *
 *     Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not
 *     supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()
 *
 * Before this, such a test was reported only as "did not pass at baseline". On a real suite that
 * is N unexplained baseline failures — 9 of Continia Document Output's 104 test files declare a
 * TestPage — and the reader is sent to debug tests that are perfectly correct.
 *
 * The distinction from R35 is the whole point and is asserted below: R35's refusal has a
 * ONE-LINE FIX IN THE USER'S OWN SOURCE (`TestPermissions = Disabled`). This one has NO
 * target-side fix at all — the test is fine, the execution path cannot run it. A diagnosis that
 * told the reader to change their test would be actively wrong.
 */

/** The refusal exactly as BC produced it (ROADMAP R69, measured 2026-07-31). */
const MEASURED_REFUSAL =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
  "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
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
    unsupportedTests: ["Tests.OpensPage", "Tests.AlsoBroken"],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
    ...over,
  });
}

describe("describeTestPageUnsupported (R69)", () => {
  test("recognises the measured CreateNavTestService refusal", () => {
    expect(describeTestPageUnsupported(MEASURED_REFUSAL)).toBeDefined();
  });

  // `failureMessage` is `message` + "\n" + `stackTrace`, so the refusal routinely arrives with
  // frames attached. Matching only a bare message would miss every real occurrence.
  test("still recognises it with a stack trace appended", () => {
    const withFrames = `${MEASURED_REFUSAL}\n  at Some.Frame()\n  at Another.Frame()`;
    expect(describeTestPageUnsupported(withFrames)).toBeDefined();
  });

  test("says the path cannot run the test, and does NOT tell the reader to change their test", () => {
    const d = describeTestPageUnsupported(MEASURED_REFUSAL);
    expect(d).toContain("TestPage");
    // The actionable content: it is the session type, not the test, that is at fault.
    expect(d).toContain("ODataV4");
    // Must never mimic R35's "declare X and re-run" shape — there is no such fix here.
    expect(d).not.toContain("and re-run");
  });

  // The detector is a hedged match on platform text; the verbatim quote is what lets a reader who
  // disagrees with the diagnosis overrule it (the R35 precedent).
  test("quotes BC's own words verbatim rather than only summarising them", () => {
    expect(describeTestPageUnsupported(MEASURED_REFUSAL)).toContain("CreateNavTestService");
  });

  test("returns undefined when there is no message to read", () => {
    expect(describeTestPageUnsupported(undefined)).toBeUndefined();
  });

  test("does not fire on an ordinary assertion failure", () => {
    expect(
      describeTestPageUnsupported("Assert.AreEqual failed: expected 3, got 4"),
    ).toBeUndefined();
  });

  // Cross-matching would put a permissions refusal under a heading whose stated fix is "nothing
  // you can do" — the exact inversion R35 exists to prevent.
  test("does not fire on BC's permission refusal", () => {
    const permissions =
      "Sorry, the current permissions prevented the action. " +
      "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";
    expect(describeTestPageUnsupported(permissions)).toBeUndefined();
  });

  // "not supported" is common English in failure text; the mechanism token is what makes this a
  // TestPage refusal rather than any other NotSupportedException.
  test("does not fire on an unrelated NotSupportedException", () => {
    const unrelated =
      "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
      "supported. at Microsoft.Dynamics.Nav.Runtime.NavStream.Seek()";
    expect(describeTestPageUnsupported(unrelated)).toBeUndefined();
  });
});

describe("SessionReport.testPageUnsupported (R69)", () => {
  test("absent when nothing was refused — an absent field and a measured zero must not look alike", () => {
    const r = build();
    expect(r.testPageUnsupported).toBeUndefined();
    expect(r.validity.caveats).not.toContain("tests-testpage-unsupported");
  });

  test("names the affected tests, sorted, with the diagnosis", () => {
    const r = build({ testPageUnsupportedTests: ["Tests.OpensPage", "Tests.AlsoOpensPage"] });
    expect(r.testPageUnsupported?.tests).toEqual(["Tests.AlsoOpensPage", "Tests.OpensPage"]);
    expect(r.testPageUnsupported?.diagnosis).toContain("TestPage");
  });

  // `baseline-red` says the measurement is degraded; this says the degradation has a known cause
  // that is a property of the PATH, and that no change to the target's source will fix.
  test("carries its own caveat, distinct from baseline-red", () => {
    const r = build({ testPageUnsupportedTests: ["Tests.OpensPage"] });
    expect(r.validity.caveats).toContain("tests-testpage-unsupported");
    expect(r.validity.caveats).toContain("baseline-red");
  });

  // Two different causes with two different fixes must never collapse into one bucket.
  test("is distinct from the permissions caveat, and neither implies the other", () => {
    const r = build({ testPageUnsupportedTests: ["Tests.OpensPage"] });
    expect(r.validity.caveats).not.toContain("tests-permission-refused");
    expect(r.permissionsRefused).toBeUndefined();
  });

  test("stays a strict subset of unsupportedTests rather than replacing it", () => {
    const r = build({ testPageUnsupportedTests: ["Tests.OpensPage"] });
    expect(r.unsupportedTests).toContain("Tests.OpensPage");
    expect(r.unsupportedTests).toContain("Tests.AlsoBroken");
    expect(r.testPageUnsupported?.tests).not.toContain("Tests.AlsoBroken");
  });

  test("the console report states it at the same prominence as a permissions refusal", () => {
    const text = renderConsole(build({ testPageUnsupportedTests: ["Tests.OpensPage"] }));
    expect(text).toContain("TESTPAGE UNSUPPORTED");
    expect(text).toContain("Tests.OpensPage");
  });

  test("the console report says nothing when no test hit the refusal", () => {
    expect(renderConsole(build())).not.toContain("TESTPAGE UNSUPPORTED");
  });
});

describe("unsupportedCoverageNote names the TestPage cause (R69)", () => {
  const TESTPAGE = 'testpage diagnosis: … BC\'s own words: "…CreateNavTestService()"';
  const PERMISSIONS = 'permissions diagnosis: … BC\'s own words: "…prevented the action."';

  test("keeps the generic wording when no covering test hit the refusal", () => {
    expect(unsupportedCoverageNote(["T.A"], new Map(), new Map())).toStartWith(
      "unsupported test type:",
    );
  });

  test("names the TestPage cause and appends BC's words verbatim", () => {
    const note = unsupportedCoverageNote(["T.A"], new Map(), new Map([["T.A", TESTPAGE]]));
    expect(note).toStartWith("testpage unsupported on this path:");
    expect(note).toContain(TESTPAGE);
    expect(note).toContain("and by no test that passed");
  });

  test("separates affected tests from tests that failed for another reason", () => {
    const note = unsupportedCoverageNote(
      ["T.Broken", "T.OpensPage"],
      new Map(),
      new Map([["T.OpensPage", TESTPAGE]]),
    );
    expect(note).toContain("(T.OpensPage)");
    expect(note).toContain("did not pass for another reason (T.Broken)");
  });

  test("ignores refusals for tests that do not cover this mutant", () => {
    const note = unsupportedCoverageNote(["T.A"], new Map(), new Map([["T.Elsewhere", TESTPAGE]]));
    expect(note).toStartWith("unsupported test type:");
    expect(note).not.toContain(TESTPAGE);
  });

  // A permissions refusal has a one-line fix in the reader's own source; a TestPage refusal has
  // none. When a mutant is covered by one of each, the note must lead with the ACTIONABLE one, or
  // a reader with a fixable problem is told there is nothing to be done.
  test("lets the actionable permissions cause win when both are present", () => {
    const note = unsupportedCoverageNote(
      ["T.Refused", "T.OpensPage"],
      new Map([["T.Refused", PERMISSIONS]]),
      new Map([["T.OpensPage", TESTPAGE]]),
    );
    expect(note).toStartWith("permissions refusal:");
    expect(note).toContain(PERMISSIONS);
  });

  // The existing two-argument call sites must keep their exact behaviour.
  test("is backward compatible with the two-argument R35 call shape", () => {
    expect(unsupportedCoverageNote(["T.A", "T.B"], new Map())).toStartWith(
      "unsupported test type:",
    );
  });
});
