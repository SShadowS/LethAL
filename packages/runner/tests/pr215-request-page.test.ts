import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { unsupportedCoverageNote } from "../src/orchestrator";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import {
  REQUEST_PAGE_DIAGNOSIS,
  TESTPAGE_DIAGNOSIS,
  describeRequestPageRefusal,
  describeTestPageRefusal,
} from "../src/testpage-unsupported";
import { legacyBuildReport } from "./helpers/legacy-report";

/** PR-215 / R1135: the report request page refusal, named like the TestPage one. */
const REQUEST_REFUSAL = "The report request page cannot be used in background or server sessions.";
const TESTPAGE_REFUSAL =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
  "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
} as const;

const entry: MutantManifestEntry = {
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

function build(tests: Record<string, string>) {
  const names = Object.keys(tests);
  const outcomes: SessionOutcome[] = [{ mutant: entry, verdict: "no-coverage", batchIndex: 0 }];
  return legacyBuildReport({
    caps: CAPS,
    baselineGreen: false,
    batches: 1,
    outcomes,
    unsupportedTests: names,
    testPageUnsupportedTests: names,
    failureMessages: tests,
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
  });
}

describe("PR-215 P1: request-page only", () => {
  test("names the test, uses the request-page diagnosis, keeps the caveat", () => {
    const r = build({ "Tests.RunsReport": REQUEST_REFUSAL });
    expect(r.testPageUnsupported?.tests).toEqual(["Tests.RunsReport"]);
    expect(r.testPageUnsupported?.diagnosis).toBe(REQUEST_PAGE_DIAGNOSIS);
    expect(r.testPageUnsupported?.diagnosis).not.toContain("TestPage");
    expect(r.validity.caveats).toContain("tests-testpage-unsupported");
    expect(renderConsole(r)).toContain("refused for opening a report request page.");
  });
});

describe("PR-215 P2: other combinations", () => {
  test("TestPage only is unchanged", () => {
    const r = build({ "Tests.OpensPage": TESTPAGE_REFUSAL });
    expect(r.testPageUnsupported?.diagnosis).toBe(TESTPAGE_DIAGNOSIS);
    expect(renderConsole(r)).toContain("refused for opening a TestPage.");
  });

  test("both kinds give the TestPage text plus one sentence", () => {
    const r = build({ "Tests.OpensPage": TESTPAGE_REFUSAL, "Tests.RunsReport": REQUEST_REFUSAL });
    const d = r.testPageUnsupported?.diagnosis ?? "";
    expect(d.startsWith(`${TESTPAGE_DIAGNOSIS} `)).toBe(true);
    expect(d).toContain("R1135");
    expect(d).not.toBe(TESTPAGE_DIAGNOSIS);
    expect(renderConsole(r)).toContain("a TestPage or a report request page");
  });
});

describe("PR-215 P3: what is not classified", () => {
  // A pass and a line-count answer are kept out by the orchestrator's own guards (didNotPassAtBaseline,
  // isRunMutantLineCountMessage), which this file does not exercise; the matcher's part is the text alone.
  test("no text, other text, and a stack-frame-only match are not named", () => {
    expect(describeRequestPageRefusal(undefined)).toBeUndefined();
    expect(describeRequestPageRefusal("")).toBeUndefined();
    expect(
      describeRequestPageRefusal("Assert.AreEqual failed. Expected:<1> Actual:<2>"),
    ).toBeUndefined();
    const onFrame = `Assert failed\n  at ${REQUEST_REFUSAL}`;
    expect(describeRequestPageRefusal(onFrame)).toBeUndefined();
    expect(describeTestPageRefusal(onFrame, undefined)).toBeUndefined();
  });

  test("the Windows TestPage text wins, in the describer and in the report fold alike", () => {
    const both = `${REQUEST_REFUSAL}\n${TESTPAGE_REFUSAL}`;
    const described = describeTestPageRefusal(both, undefined);
    expect(described).toBeDefined();
    expect(described?.startsWith(REQUEST_PAGE_DIAGNOSIS)).toBe(false);
    const r = build({ "Tests.Both": both });
    expect(r.testPageUnsupported?.diagnosis).toBe(TESTPAGE_DIAGNOSIS);
  });

  test("line one with frames after it is named, quoting line one only", () => {
    const d = describeRequestPageRefusal(`${REQUEST_REFUSAL}\n  at Some.Frame()`);
    expect(d).toContain(REQUEST_PAGE_DIAGNOSIS);
    expect(d).not.toContain("Some.Frame");
  });
});

describe("PR-215 P4: per-mutant note", () => {
  test("a mutant covered only by a request-page test gets the request-page lead and diagnosis", () => {
    const text = describeTestPageRefusal(REQUEST_REFUSAL, undefined);
    expect(text).toBeDefined();
    const note = unsupportedCoverageNote(
      ["Tests.RunsReport"],
      new Map(),
      new Map([["Tests.RunsReport", text ?? ""]]),
    );
    expect(note).toStartWith(
      "request page unsupported on this path: mutant covered by test(s) that open a report request page, which this session type cannot show (Tests.RunsReport)",
    );
    expect(note).toContain(REQUEST_PAGE_DIAGNOSIS);
  });

  test("a TestPage test keeps the TestPage lead when both are present", () => {
    const note = unsupportedCoverageNote(
      ["Tests.OpensPage", "Tests.RunsReport"],
      new Map(),
      new Map([
        ["Tests.OpensPage", describeTestPageRefusal(TESTPAGE_REFUSAL, undefined) ?? ""],
        ["Tests.RunsReport", describeTestPageRefusal(REQUEST_REFUSAL, undefined) ?? ""],
      ]),
    );
    expect(note).toStartWith("testpage unsupported on this path");
  });
});
