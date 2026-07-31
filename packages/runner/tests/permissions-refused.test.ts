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
describe("describeTestPermissionsRefusal is English-only (R35 blind spot 2)", () => {
  test("recognises BC's English refusal", () => {
    const english =
      "Sorry, the current permissions prevented the action. " +
      "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";
    expect(describeTestPermissionsRefusal(english)).toBeDefined();
  });

  // Danish rendering of the same platform refusal. If a future change makes this pass, R66 is
  // closed and this test should be inverted — it is here to make the limitation visible, not to
  // enshrine it.
  test("MISSES the same refusal in another language — the known gap, safe direction", () => {
    const danish =
      "Beklager, de aktuelle tilladelser forhindrede handlingen. " +
      "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";
    expect(describeTestPermissionsRefusal(danish)).toBeUndefined();
  });

  test("does not fire on an ordinary assertion failure in any language", () => {
    expect(
      describeTestPermissionsRefusal("Assert.AreEqual failed: expected 3, got 4"),
    ).toBeUndefined();
  });
});
