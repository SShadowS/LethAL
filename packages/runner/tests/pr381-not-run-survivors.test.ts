import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { V3_NOT_RUN_SUFFIX } from "../src/al-runner-v3-backend";
import type { BackendCapabilities, TestOutcome } from "../src/backend";
import { changedLineSurvivors, renderChangedLineSurvivors } from "../src/changed-line-survivors";
import type { RunEvent, RunEventInput } from "../src/events";
import { explain } from "../src/explain";
import { toMutationElements } from "../src/mutation-elements";
import {
  ALWAYS_REACHES,
  NOT_RECORDED_TEXT,
  notRunSentence,
  notRunSurvivors,
} from "../src/not-run-survivors";
import { buildReport, renderConsole } from "../src/report";
import type { SessionReport } from "../src/report";
import type { FoldStatics } from "../src/report-fold";

/**
 * PR-381 (R1197): survivors in an al-runner-v3 run with tests v3 did not run at baseline carry a
 * caveat, headline included. Spec: docs/superpowers/specs/2026-11-23-pr381-refused-test-survivors-caveat.md.
 * Every surface asserts the EXACT sentence with its numbers, and its negative twin on a fixture whose
 * only red baseline test FAILED on its own.
 */

const TAG = "[v3-refused-test-nearby]";
// A codeunit name with a dot, as a real one has: the name stays whole.
const REFUSED = "X. Y Tests.Refused";
const REFUSAL_TEXT = `NotRun: out-of-scope: the test needs a thing ${V3_NOT_RUN_SUFFIX}`;

const CAPS_V3: BackendCapabilities = {
  kind: "al-runner-v3",
  authoritative: false,
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
};
const CAPS_BC: BackendCapabilities = { ...CAPS_V3, kind: "bcdev", authoritative: true };

function statics(caps: BackendCapabilities, extra: Partial<FoldStatics> = {}): FoldStatics {
  return { caps, buildSymbols: [], ...extra };
}

function seq(events: readonly RunEventInput[]): RunEvent[] {
  return events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
}

function mutant(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 100,
    endIndex: 140,
    startLine: 10,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Sales Helper",
    procedureName: "ComputeTotal",
    procedureScope: "public",
    originalText: "TotalAmount := Quantity * UnitPrice;",
    mutatedText: "",
  };
}

interface Base {
  readonly name: string;
  readonly outcome: TestOutcome;
  readonly failureMessage?: string;
  readonly classification?: readonly "baseline-test-stopped"[];
}

const PASS: Base = { name: "Sales Helper Tests.T1", outcome: "pass" };
const REFUSED_ROW: Base = { name: REFUSED, outcome: "error", failureMessage: REFUSAL_TEXT };
const FAILED_ROW: Base = {
  name: "Sales Helper Tests.Fails",
  outcome: "fail",
  failureMessage: "Assert.AreEqual failed. Expected 1, actual 2.",
};

interface Row {
  readonly id: string;
  readonly verdict: "survived" | "known-survivor" | "killed" | "error" | "no-coverage";
  readonly failureNote?: string;
}

const TAGGED = `${TAG} ${REFUSED}: refused by v3 at baseline in a covering test's codeunit, so a kill it might make on BC is not measured here`;

function build(
  caps: BackendCapabilities,
  baseline: readonly Base[],
  rows: readonly Row[],
  extra: Partial<FoldStatics> = {},
): SessionReport {
  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: rows.length,
      deployedCount: rows.length,
      hangCapableCount: 0,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      preprocExcludedFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
    },
    {
      type: "tests-discovered",
      tests: baseline.map((v, i) => {
        const dot = v.name.lastIndexOf(".");
        return { codeunitId: i, codeunitName: v.name.slice(0, dot), method: v.name.slice(dot + 1) };
      }),
    },
    {
      type: "baseline-batch-finished",
      batchIndex: 0,
      ...(baseline.some((v) => v.classification !== undefined) ? { stoppedBudgetMs: 5000 } : {}),
      verdicts: baseline.map((v) => ({
        name: v.name,
        outcome: v.outcome,
        classification: v.classification ?? [],
        ...(v.failureMessage !== undefined ? { failureMessage: v.failureMessage } : {}),
      })),
    },
  ];
  if (baseline.some((v) => v.outcome === "pass")) {
    events.push({
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: 0,
      coveredCount: 1,
      noCoverageCount: 0,
      unplaceableCount: 0,
      unplaceableMutants: [],
    });
  }
  for (const r of rows) {
    events.push({
      type: "mutant-scored",
      mutant: mutant(r.id),
      verdict: r.verdict,
      batchIndex: 0,
      durationMs: 1,
      coveringTests: ["Sales Helper Tests.T1"],
      coverageAttribution: "exact",
      ...(r.verdict === "killed" ? { killingTest: "Sales Helper Tests.T1" } : {}),
      ...(r.failureNote !== undefined ? { failureNote: r.failureNote } : {}),
    });
  }
  events.push({ type: "session-finished", elapsedMs: 10 });
  return buildReport(statics(caps, extra), seq(events));
}

const ROWS: readonly Row[] = [
  { id: "M0001", verdict: "survived", failureNote: TAGGED },
  { id: "M0002", verdict: "survived" },
  { id: "M0003", verdict: "killed" },
];

const SENT_TAGGED =
  "2 survivors, all in a run with 1 tests v3 did not run at baseline (refused, timed out or stopped; such a test kills nothing, so a survivor only it would kill is unknown); 1 carry the nearby tag (a hint, not a bound)";
const SENT_NO_HINT =
  "2 survivors, all in a run with 1 tests v3 did not run at baseline (refused, timed out or stopped; such a test kills nothing, so a survivor only it would kill is unknown)";

describe("PR-381 the report", () => {
  test("1: a refused test and survivors: the field, the caveat, the counts and the sentence", () => {
    const r = build(CAPS_V3, [PASS, REFUSED_ROW], ROWS);
    expect(r.v3NotRunAtBaseline).toEqual([REFUSED]);
    expect(r.validity.caveats).toContain("survivors-beside-unrun-tests");
    expect(r.survivorsBesideUnrunTests).toEqual({
      survivors: 2,
      notRunTests: 1,
      sharingACodeunit: 1,
    });
    expect(notRunSentence(r.survivorsBesideUnrunTests as never)).toBe(SENT_TAGGED);
    expect(renderConsole(r)).toContain(SENT_TAGGED);
  });

  test("1b: a timed out baseline test and a stopped one count too", () => {
    const timeout: Base = { name: "Sales Helper Tests.Slow", outcome: "timeout" };
    const stopped: Base = {
      name: "Sales Helper Tests.Hung",
      outcome: "timeout",
      classification: ["baseline-test-stopped"],
    };
    const r = build(CAPS_V3, [PASS, timeout, stopped], ROWS);
    expect(r.v3NotRunAtBaseline).toEqual(["Sales Helper Tests.Hung", "Sales Helper Tests.Slow"]);
  });

  test("2: a refused test and only kills and errors: no caveat, no count, verdicts unchanged", () => {
    const rows: Row[] = [
      { id: "M0001", verdict: "killed" },
      { id: "M0002", verdict: "error" },
      { id: "M0003", verdict: "no-coverage" },
    ];
    const r = build(CAPS_V3, [PASS, REFUSED_ROW], rows);
    expect(r.v3NotRunAtBaseline).toEqual([REFUSED]);
    expect(r.validity.caveats).not.toContain("survivors-beside-unrun-tests");
    expect(r.survivorsBesideUnrunTests).toBeUndefined();
    expect(r.mutants.map((m) => m.verdict)).toEqual(["killed", "error", "no-coverage"]);
    expect(renderConsole(r)).not.toContain("did not run at baseline");
  });

  test("3: survivors and only a test that ran and FAILED: no caveat, the field is written empty", () => {
    const r = build(CAPS_V3, [PASS, FAILED_ROW], ROWS);
    expect(r.v3NotRunAtBaseline).toEqual([]);
    expect(r.validity.caveats).not.toContain("survivors-beside-unrun-tests");
    expect(r.survivorsBesideUnrunTests).toBeUndefined();
    expect(renderConsole(r)).not.toContain("did not run at baseline");
    expect(renderConsole(r)).not.toContain(NOT_RECORDED_TEXT);
  });

  test("4: bcdev, test 1's fixture: no caveat and no field in this PR (PR-385 turns this around)", () => {
    const r = build(CAPS_BC, [PASS, REFUSED_ROW], ROWS);
    expect(r.validity.caveats).not.toContain("survivors-beside-unrun-tests");
    expect(r.v3NotRunAtBaseline).toBeUndefined();
    expect(r.survivorsBesideUnrunTests).toBeUndefined();
    expect(renderConsole(r)).not.toContain("did not run at baseline");
  });

  test("5: the hint counts survivors that carry the tag, whatever the codeunit's name holds", () => {
    const rows: Row[] = [
      { id: "M0001", verdict: "survived", failureNote: TAGGED },
      { id: "M0002", verdict: "survived", failureNote: TAGGED },
      { id: "M0003", verdict: "survived", failureNote: "[singleinstance-carry-unobservable] x" },
    ];
    const r = build(CAPS_V3, [PASS, REFUSED_ROW], rows);
    expect(r.v3NotRunAtBaseline).toEqual(["X. Y Tests.Refused"]);
    expect(r.survivorsBesideUnrunTests?.sharingACodeunit).toBe(2);
    expect(r.survivorsBesideUnrunTests?.survivors).toBe(3);
  });

  test("6: a resumed session's reused baseline emits the same rows, so carried survivors count", () => {
    const events: RunEventInput[] = [
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        hangCapableCount: 0,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        preprocExcludedFiles: [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
      },
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [
          { name: PASS.name, outcome: "pass", classification: [] },
          { name: REFUSED, outcome: "error", classification: [], failureMessage: REFUSAL_TEXT },
        ],
      },
      {
        type: "coverage-split",
        batchIndex: 0,
        untargetedTriggerCount: 0,
        coveredCount: 1,
        noCoverageCount: 0,
        unplaceableCount: 0,
        unplaceableMutants: [],
      },
      {
        type: "mutant-carried",
        mutant: mutant("M0001"),
        verdict: "survived",
        fromRunId: 1,
        batchIndex: 0,
        priorDurationMs: 9,
        coveringTests: [],
      },
      { type: "session-finished", elapsedMs: 10 },
    ];
    const r = buildReport(statics(CAPS_V3), seq(events));
    expect(r.survivorsBesideUnrunTests).toEqual({
      survivors: 1,
      notRunTests: 1,
      sharingACodeunit: 0,
    });
  });

  test("7: known-survivor rows alone: the caveat applies", () => {
    const rows: Row[] = [{ id: "M0001", verdict: "known-survivor" }];
    const r = build(CAPS_V3, [PASS, REFUSED_ROW], rows);
    expect(r.survivorsBesideUnrunTests).toEqual({
      survivors: 1,
      notRunTests: 1,
      sharingACodeunit: 0,
    });
    expect(r.validity.caveats).toContain("survivors-beside-unrun-tests");
  });

  test("8: coverage off: the caveat, without sharingACodeunit", () => {
    const r = build({ ...CAPS_V3, coverageOffFiles: ["a.al"] }, [PASS, REFUSED_ROW], ROWS);
    expect(r.survivorsBesideUnrunTests).toEqual({ survivors: 2, notRunTests: 1 });
    expect(renderConsole(r)).toContain(SENT_NO_HINT);
    expect(renderConsole(r)).not.toContain("carry the nearby tag");
  });

  test('a narrowed run says "of this session\'s tests"', () => {
    const r = build(CAPS_V3, [PASS, REFUSED_ROW], ROWS, { testsOnly: ["test/Posting/**"] });
    expect(renderConsole(r)).toContain(
      "2 survivors, all in a run with 1 of this session's tests v3 did not run at baseline (refused, timed out or stopped; such a test kills nothing, so a survivor only it would kill is unknown); 1 carry the nearby tag (a hint, not a bound)",
    );
  });

  test("an older al-runner-v3 report with survivors and no field: not recorded, never silence", () => {
    const r = build(CAPS_V3, [PASS, REFUSED_ROW], ROWS);
    const { v3NotRunAtBaseline: _a, survivorsBesideUnrunTests: _b, ...old } = r;
    expect(notRunSurvivors(old)).toBeUndefined();
    expect(renderConsole(old as SessionReport)).toContain(NOT_RECORDED_TEXT);
    // and an old bcdev report prints nothing of the kind
    const bc = build(CAPS_BC, [PASS], ROWS);
    expect(renderConsole(bc)).not.toContain(NOT_RECORDED_TEXT);
  });
});

describe("PR-381 the reach injection point (PR-386)", () => {
  const r = build(CAPS_V3, [PASS, REFUSED_ROW], ROWS);
  test("the default reaches everything; false for every pair: 0 survivors, no result", () => {
    expect(notRunSurvivors(r)?.survivors).toBe(2);
    expect(notRunSurvivors(r, ALWAYS_REACHES)?.survivors).toBe(2);
    expect(notRunSurvivors(r, () => false)).toBeUndefined();
  });
  test('"unknown" counts as reaching; only a reached survivor is counted', () => {
    expect(notRunSurvivors(r, () => "unknown")?.survivors).toBe(2);
    const only1 = notRunSurvivors(r, (_t, m) => m.line === 10 && m.file.length > 0);
    expect(only1?.survivors).toBe(2);
    // the WHOLE report row is passed, and the test is the qualified name from the field
    const seen: string[] = [];
    notRunSurvivors(r, (t, m) => {
      seen.push(`${t}|${m.operatorName}|${m.mutantCode}`);
      return true;
    });
    expect(seen).toEqual([
      `${REFUSED}|lethal.void-method-call|M0001`,
      `${REFUSED}|lethal.void-method-call|M0002`,
    ]);
    const none = notRunSurvivors(r, (_t, m) => m.line === 999);
    expect(none).toBeUndefined();
  });
});

describe("PR-381 test 9: every surface, and its negative twin", () => {
  const yes = build(CAPS_V3, [PASS, REFUSED_ROW], ROWS);
  const no = build(CAPS_V3, [PASS, FAILED_ROW], ROWS);

  test("console: the line under the score, with the R844 range and the withheld line", () => {
    const withErrors = (r: SessionReport): SessionReport => ({
      ...r,
      validity: { ...r.validity, caveats: [...r.validity.caveats, "some-errors"] },
      counts: { ...r.counts, errors: 3 },
    });
    const text = renderConsole(withErrors(yes));
    const lines = text.split("\n");
    const scoreAt = lines.findIndex((l) => l.startsWith("score:"));
    expect(lines[scoreAt + 1]).toBe(
      `${SENT_TAGGED} (validity.caveats "survivors-beside-unrun-tests", R1197)`,
    );
    const range = lines.find((l) => l.includes("had they run, it would read"));
    expect(range).toContain(`Its survivors: ${SENT_TAGGED}.`);
    expect(renderConsole(withErrors(no))).not.toContain("did not run at baseline");
  });

  test("explain: the three counts and the caveat; absent on the twin", () => {
    const out = explain(yes);
    expect(out.score.survivorsBesideUnrunTests).toEqual({
      survivors: 2,
      notRunTests: 1,
      sharingACodeunit: 1,
    });
    expect(out.caveats.map((c) => c.caveat)).toContain("survivors-beside-unrun-tests");
    const twin = explain(no);
    expect(twin.score.survivorsBesideUnrunTests).toBeUndefined();
    expect(twin.caveats.map((c) => c.caveat)).not.toContain("survivors-beside-unrun-tests");
  });

  test("changed-since: the sentence under the counted line; absent on the twin", () => {
    const narrowed = (r: SessionReport): SessionReport => ({
      ...r,
      validity: { ...r.validity, caveats: [...r.validity.caveats, "line-narrowed"] },
    });
    const s = changedLineSurvivors(narrowed(yes));
    expect(s?.notRun).toBe(SENT_TAGGED);
    expect(renderChangedLineSurvivors(s as never)).toContain(`counted: 2\n${SENT_TAGGED}`);
    const t = changedLineSurvivors(narrowed(no));
    expect(t?.notRun).toBeUndefined();
    expect(renderChangedLineSurvivors(t as never)).not.toContain("did not run at baseline");
  });

  test("Stryker export: each survivor's description, config.lethal and one loss line", async () => {
    const opts = {
      projectDir: "/p",
      thresholds: { high: 80, low: 60 },
      readSource: async () => "x".repeat(400),
    };
    const out = await toMutationElements(yes, opts);
    const mutants = Object.values(out.report.files).flatMap(
      (f) => (f as { mutants: { status: string; description?: string }[] }).mutants,
    );
    const survived = mutants.filter((m) => m.status === "Survived");
    expect(survived).toHaveLength(2);
    for (const m of survived) expect(m.description).toContain(SENT_TAGGED);
    expect(mutants.find((m) => m.status === "Killed")?.description).toBeUndefined();
    expect(out.report.config.lethal.survivorsBesideUnrunTests).toEqual({
      survivors: 2,
      notRunTests: 1,
      sharingACodeunit: 1,
    });
    expect(out.report.config.lethal.v3NotRunAtBaseline).toEqual([REFUSED]);
    expect(out.losses.some((l) => l.startsWith(SENT_TAGGED))).toBe(true);
    const twin = await toMutationElements(no, opts);
    const twinText = JSON.stringify(twin.report.files) + twin.losses.join("\n");
    expect(twinText).not.toContain("did not run at baseline");
    expect(twin.report.config.lethal.survivorsBesideUnrunTests).toBeUndefined();
  });
});
