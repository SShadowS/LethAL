import { describe, expect, test } from "bun:test";
import { BC_HTTP_HUB_TEXT, BC_HTTP_INTERNAL_TEXT } from "../src/al-runner-v3-contract";
import { unsupportedCoverageNote } from "../src/orchestrator";
import { runMutantLineCountMessage } from "../src/stale-test-app";
import { describeWebServiceHttpText } from "../src/webservice-http-text";

/**
 * R713. A test red at baseline is already dropped from the green set by outcome. When its failure
 * text holds the web-service HTTP text, the note and one warning now say why. Nothing here moves a
 * verdict. The orchestrator-level tests (warning, no verdict move) are in `orchestrator.test.ts`.
 */

const PERMISSIONS =
  "Sorry, the current permissions prevented the action. " +
  "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";
const TESTPAGE_TEXT =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
  "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";

describe("describeWebServiceHttpText (R713)", () => {
  test("matches the bare web-service text", () => {
    const d = describeWebServiceHttpText(BC_HTTP_INTERNAL_TEXT);
    expect(d).toBeString();
    expect(d).toContain("R706");
    expect(d).toContain("R712");
    expect(d).toContain("No verdict was changed");
  });

  test("matches an Assert failure that wraps the text, with a call stack after it", () => {
    const text = [
      `Assert.AreEqual failed. Expected:<${BC_HTTP_HUB_TEXT}> Actual:<${BC_HTTP_INTERNAL_TEXT}>. x`,
      '"Tests"(CodeUnit 50100).T line 5',
    ].join("\n");
    expect(describeWebServiceHttpText(text)).toContain("No verdict was changed");
  });

  test("claims nothing else", () => {
    expect(describeWebServiceHttpText(undefined)).toBeUndefined();
    expect(describeWebServiceHttpText(BC_HTTP_HUB_TEXT)).toBeUndefined();
    expect(describeWebServiceHttpText(PERMISSIONS)).toBeUndefined();
    expect(describeWebServiceHttpText(TESTPAGE_TEXT)).toBeUndefined();
    expect(describeWebServiceHttpText(runMutantLineCountMessage(0, "boom"))).toBeUndefined();
  });
});

describe("unsupportedCoverageNote, HTTP branch (R713)", () => {
  const HTTP = new Map([["T.A", "HTTP DIAGNOSIS"]]);
  const none = new Map<string, string>();

  test("leads with the HTTP wording and quotes the diagnosis", () => {
    const note = unsupportedCoverageNote(["T.A"], none, none, new Set(), HTTP);
    expect(note).toStartWith("web-service HTTP text differs from the hub's:");
    expect(note).toContain("HTTP DIAGNOSIS");
    expect(note).toContain("T.A");
  });

  test("a permissions refusal on another test still leads", () => {
    const note = unsupportedCoverageNote(
      ["T.A", "T.B"],
      new Map([["T.B", "PERM"]]),
      none,
      new Set(),
      HTTP,
    );
    expect(note).toStartWith("permissions refusal:");
  });

  test("TestPage beats HTTP", () => {
    const note = unsupportedCoverageNote(
      ["T.A", "T.B"],
      none,
      new Map([["T.B", "TP"]]),
      new Set(),
      HTTP,
    );
    expect(note).toStartWith("testpage unsupported on this path:");
  });

  test("HTTP beats v3 and the generic wording", () => {
    const note = unsupportedCoverageNote(["T.A", "T.V"], none, none, new Set(["T.V"]), HTTP);
    expect(note).toStartWith("web-service HTTP text differs from the hub's:");
  });

  test("an absent map, or one naming other tests, keeps today's output byte for byte", () => {
    const base = unsupportedCoverageNote(["T.A"], none);
    expect(base).toStartWith("unsupported test type:");
    expect(unsupportedCoverageNote(["T.A"], none, none, new Set(), new Map())).toBe(base);
    expect(unsupportedCoverageNote(["T.A"], none, none, new Set(), new Map([["T.Z", "x"]]))).toBe(
      base,
    );
  });
});
