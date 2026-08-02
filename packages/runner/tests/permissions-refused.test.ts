import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { unsupportedCoverageNote } from "../src/orchestrator";
import { describeTestPermissionsRefusal } from "../src/permission-canary";
import { buildReport, renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";

/**
 * R35. R27 taught LethAL to name the `TestPermissions` cause — but only on the `unstable` path,
 * where a test fails under the mutant AND at baseline confirmation. A test BC refuses at BASELINE
 * DISCOVERY never reaches that path: it is dropped from the green set, its mutants are recorded
 * against the "did not pass at baseline" wording, and the reader is sent to debug a test whose
 * actual fix is one property in their own source.
 *
 * Measured A/B (2026-07-26, see `permission-canary.ts`): two probe codeunits identical except
 * `TestPermissions`, same app, same tables, same server — omitted (AL's Restrictive default) is
 * refused, `Disabled` succeeds.
 */

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
  const outcomes: SessionOutcome[] = [{ mutant: entry(), verdict: "error", batchIndex: 0 }];
  return buildReport({
    caps: CAPS,
    baselineGreen: false,
    batches: 1,
    outcomes,
    unsupportedTests: ["Tests.Writes", "Tests.AlsoWrites"],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
    ...over,
  });
}

describe("SessionReport.permissionsRefused (R35)", () => {
  test("absent when nothing was refused — an absent field and a measured zero must not look alike", () => {
    const r = build();
    expect(r.permissionsRefused).toBeUndefined();
    expect(r.validity.caveats).not.toContain("tests-permission-refused");
  });

  test("names the refused tests, sorted, with the one-line fix", () => {
    const r = build({ permissionsRefusedTests: ["Tests.Writes", "Tests.AlsoWrites"] });
    expect(r.permissionsRefused?.tests).toEqual(["Tests.AlsoWrites", "Tests.Writes"]);
    expect(r.permissionsRefused?.diagnosis).toContain("TestPermissions = Disabled");
  });

  // The distinction is the entire point of the field: `baseline-red` says the measurement is
  // degraded, this says the degradation has a known one-line cause in the target's own source.
  test("carries its own caveat, distinct from baseline-red", () => {
    const r = build({ permissionsRefusedTests: ["Tests.Writes"] });
    expect(r.validity.caveats).toContain("tests-permission-refused");
    expect(r.validity.caveats).toContain("baseline-red");
  });

  test("stays a strict subset of unsupportedTests rather than replacing it", () => {
    const r = build({ permissionsRefusedTests: ["Tests.Writes"] });
    expect(r.unsupportedTests).toContain("Tests.Writes");
    expect(r.unsupportedTests).toContain("Tests.AlsoWrites");
    expect(r.permissionsRefused?.tests).not.toContain("Tests.AlsoWrites");
  });

  test("the console report states it at the same prominence as a stale test app", () => {
    const text = renderConsole(build({ permissionsRefusedTests: ["Tests.Writes"] }));
    expect(text).toContain("PERMISSIONS REFUSED");
    expect(text).toContain("Tests.Writes");
    expect(text).toContain("TestPermissions = Disabled");
  });

  test("the console report says nothing when nothing was refused", () => {
    expect(renderConsole(build())).not.toContain("PERMISSIONS REFUSED");
  });
});

describe("unsupportedCoverageNote (R35)", () => {
  const DIAGNOSIS = 'permissions diagnosis: … BC\'s own words: "…prevented the action."';

  test("keeps the old wording when no covering test was refused", () => {
    const note = unsupportedCoverageNote(["T.A", "T.B"], new Map());
    expect(note).toStartWith("unsupported test type:");
    expect(note).toContain("T.A, T.B");
  });

  test("names the permissions cause and appends BC's words verbatim", () => {
    const note = unsupportedCoverageNote(["T.A"], new Map([["T.A", DIAGNOSIS]]));
    expect(note).toStartWith("permissions refusal:");
    expect(note).toContain(DIAGNOSIS);
    expect(note).toContain("and by no test that passed");
  });

  // The mixed case is where a careless note contradicts itself: claiming the mutant is covered
  // "only" by refused tests, then listing another one right after.
  test("separates refused tests from tests that failed for another reason", () => {
    const note = unsupportedCoverageNote(
      ["T.Broken", "T.Refused"],
      new Map([["T.Refused", DIAGNOSIS]]),
    );
    expect(note).toContain("BC refused at baseline (T.Refused)");
    expect(note).toContain("did not pass for another reason (T.Broken)");
    expect(note).not.toContain("only by test(s) BC refused");
  });

  // A map entry for a test that does not cover this mutant must not drag the diagnosis in.
  test("ignores refusals for tests that do not cover this mutant", () => {
    const note = unsupportedCoverageNote(["T.A"], new Map([["T.Elsewhere", DIAGNOSIS]]));
    expect(note).toStartWith("unsupported test type:");
    expect(note).not.toContain(DIAGNOSIS);
  });
});

/**
 * R35, blind spot 2 — pinned as a KNOWN LIMITATION rather than fixed.
 *
 * The detector matches BC's English refusal text. On a non-English server it misses, and the
 * refusal is reported only as "did not pass at baseline". That direction is safe (a silent miss,
 * never a wrong answer) but it IS a hole, and these tests exist so it is a stated, tested property
 * of the system rather than an unexamined assumption. Closing it needs a language-independent
 * signal measured against a localized server — filed as ROADMAP R66.
 */
describe("describeTestPermissionsRefusal is language-independent (R66)", () => {
  // R66 CLOSED. The row's premise — that closing this needs a localized BC server — was wrong:
  // BC picks error-message resources by SESSION language, which AL sets from inside a test body
  // with `GlobalLanguage(1030)`, and the DK containers already carry the Danish resources.
  // Measured on Cronus281 through the fenced path, one session, ONLY the language differing
  // (`fixtures/sandbox-probes/src/LangRefusalProbe.Codeunit.al`): the prose translates, the
  // `(TableData <id> <name> <op>: <suite>)` parenthetical survives BYTE-IDENTICALLY.

  test("recognises BC's English refusal", () => {
    const english =
      "Sorry, the current permissions prevented the action. " +
      "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";
    expect(describeTestPermissionsRefusal(english)).toBeDefined();
  });

  // The exact Danish text MEASURED on Cronus281 under GlobalLanguage(1030) — not a translation
  // written here. The previous version of this test asserted a GUESSED Danish string and pinned
  // the miss; it is inverted rather than deleted, which is what its own comment asked for.
  test("recognises the same refusal in Danish, via the structural parenthetical", () => {
    const danish =
      "De aktuelle rettigheder forhindrede handlingen. " +
      "(TableData 79201 Rec XRec Probe Insert: LethAL Sandbox Probes)";
    const diagnosis = describeTestPermissionsRefusal(danish);
    expect(diagnosis).toBeDefined();
    // BC's own words are quoted verbatim, localized prose included — a reader who disagrees with
    // the diagnosis still has the platform's message rather than ours.
    expect(diagnosis).toContain("De aktuelle rettigheder forhindrede handlingen.");
    expect(diagnosis).toContain("(TableData 79201 Rec XRec Probe Insert: LethAL Sandbox Probes)");
  });

  test("does not fire on an ordinary assertion failure in any language", () => {
    expect(
      describeTestPermissionsRefusal("Assert.AreEqual failed: expected 3, got 4"),
    ).toBeUndefined();
  });

  // The false positive this matcher must not have, and the reason the shape is matched STRICTLY
  // rather than on the word `TableData`: telling a user to declare a property they already have
  // sends them to change working code. Direction matters — a miss costs a diagnosis, a false hit
  // costs trust.
  test("does not fire on a non-refusal message carrying a SIMILAR parenthetical", () => {
    expect(
      describeTestPermissionsRefusal("Record not found. (TableData 79300 Data Main)"),
    ).toBeUndefined();
    expect(
      describeTestPermissionsRefusal(
        "Something failed. (Table 79300 Data Main Insert: LethAL Sandbox Data Tests)",
      ),
    ).toBeUndefined();
    expect(
      describeTestPermissionsRefusal(
        "Custom error mentioning TableData 79300 Data Main Insert without parentheses",
      ),
    ).toBeUndefined();
  });

  // The LEFT anchor's own test, added because a red-check proved the one below does not exercise
  // it: the pattern's trailing character class already forbids a newline after the parenthetical,
  // so "no trailing stack frame" passes even with the left anchor defeated. What the anchor
  // actually prevents is a PRECEDING line bleeding into the quote — attributing another failure's
  // words to BC's permission system.
  test("quotes only the refusal line, never a preceding line", () => {
    const withPreceding =
      "Some unrelated earlier failure line.\n" +
      "De aktuelle rettigheder forhindrede handlingen. " +
      "(TableData 79201 Rec XRec Probe Insert: LethAL Sandbox Probes)";
    const diagnosis = describeTestPermissionsRefusal(withPreceding);
    expect(diagnosis).toBeDefined();
    expect(diagnosis).not.toContain("Some unrelated earlier failure line.");
  });

  // `failureMessage` is `message` + a newline + `stackTrace`, so an unanchored match would quote a
  // stack frame back at the user as if BC had said it.
  test("quotes only the message line, never a following stack frame", () => {
    const withStack =
      "De aktuelle rettigheder forhindrede handlingen. " +
      "(TableData 79201 Rec XRec Probe Insert: LethAL Sandbox Probes)\n" +
      '"Lang Refusal Probe"(CodeUnit 79214).RunRefusal line 7';
    const diagnosis = describeTestPermissionsRefusal(withStack);
    expect(diagnosis).toBeDefined();
    expect(diagnosis).not.toContain("CodeUnit 79214");
  });
});
