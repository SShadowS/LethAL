import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { BackendCapabilities, TestOutcome } from "../src/backend";
import type { BaselineClassification, RunEvent, RunEventInput } from "../src/events";
import { explain } from "../src/explain";
import {
  NOT_RECORDED_TEXT,
  isBcdevNotRunBaselineRow,
  isNotRunBaselineRow,
  notRunLine,
  notRunSurvivors,
} from "../src/not-run-survivors";
import { buildReport, renderConsole } from "../src/report";
import type { SessionReport } from "../src/report";
import type { FoldStatics } from "../src/report-fold";

/**
 * PR-387: the not-run-at-baseline survivor caveat (PR-381) for bcdev. Spec:
 * docs/superpowers/specs/2026-11-23-pr387-bcdev-not-run-caveat.md. The `runSession` tests (spec 8, 9)
 * are in orchestrator.test.ts, beside the fake bcdev backend they need.
 */

const CAPS_V3: BackendCapabilities = {
  kind: "al-runner-v3",
  authoritative: false,
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
};
const CAPS_BC: BackendCapabilities = { ...CAPS_V3, kind: "bcdev", authoritative: true };

const BC_SENTENCE = (survivors: number, tests: number) =>
  `${survivors} survivors, all in a run with ${tests} ${tests === 1 ? "test" : "tests"} BC could not run at baseline in LethAL's session (TestPage or permission refusals, timed out or stopped; such a test kills nothing, so a survivor only it would kill is unknown)`;

interface Base {
  readonly name: string;
  readonly outcome: TestOutcome;
  readonly failureMessage?: string;
  readonly classification?: readonly BaselineClassification[];
  readonly notRun?: true;
}
const PASS: Base = { name: "Sales Helper Tests.T1", outcome: "pass" };
const row = (name: string, extra: Partial<Base> = {}): Base => ({
  name: `Sales Helper Tests.${name}`,
  outcome: "skip",
  ...extra,
});
const REFUSED = row("PageRefused", { classification: ["tests-testpage-refused"] });
const FAILED = row("Fails", {
  outcome: "fail",
  failureMessage: "Assert.AreEqual failed. Expected 1, actual 2.",
});

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

type Verdict = "survived" | "known-survivor" | "killed" | "error" | "no-coverage";
const SURV: readonly Verdict[] = ["survived", "survived", "killed"];

function build(
  caps: BackendCapabilities,
  baseline: readonly Base[],
  verdicts: readonly Verdict[] = SURV,
): SessionReport {
  const events: RunEventInput[] = [
    {
      type: "mutation-set-generated",
      siteCount: verdicts.length,
      deployedCount: verdicts.length,
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
      ...(baseline.some((v) => v.classification?.includes("baseline-test-stopped"))
        ? { stoppedBudgetMs: 5000 }
        : {}),
      verdicts: baseline.map((v) => ({
        name: v.name,
        outcome: v.outcome,
        classification: v.classification ?? [],
        ...(v.failureMessage !== undefined ? { failureMessage: v.failureMessage } : {}),
        ...(v.notRun === true ? { notRun: true as const } : {}),
      })),
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
    ...verdicts.map(
      (verdict, i): RunEventInput => ({
        type: "mutant-scored",
        mutant: mutant(`M000${i + 1}`),
        verdict,
        batchIndex: 0,
        durationMs: 1,
        coveringTests: ["Sales Helper Tests.T1"],
        coverageAttribution: "exact",
        ...(verdict === "killed" ? { killingTest: "Sales Helper Tests.T1" } : {}),
      }),
    ),
    { type: "session-finished", elapsedMs: 10 },
  ];
  const statics: FoldStatics = { caps, buildSymbols: [] };
  return buildReport(
    statics,
    events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent),
  );
}

describe("PR-387 test 1: the refused class and its negative twin", () => {
  test("a tests-testpage-refused row and survivors: caveat, counts, exact sentence, no sharingACodeunit", () => {
    const r = build(CAPS_BC, [PASS, REFUSED]);
    expect(r.notRunAtBaseline).toEqual([REFUSED.name]);
    expect(r.validity.caveats).toContain("survivors-beside-unrun-tests");
    expect(r.survivorsBesideUnrunTests).toEqual({ survivors: 2, notRunTests: 1 });
    expect(renderConsole(r)).toContain(BC_SENTENCE(2, 1));
  });
  test("that row's class removed (a skip of no known origin still counts; a pass does not)", () => {
    const r = build(CAPS_BC, [PASS, { ...REFUSED, outcome: "pass", classification: [] }]);
    expect(r.notRunAtBaseline).toEqual([]);
    expect(r.validity.caveats).not.toContain("survivors-beside-unrun-tests");
    expect(renderConsole(r)).not.toContain("could not run at baseline");
  });
});

describe("PR-387 test 2: each counted class alone gives the caveat", () => {
  const cases: [string, Base][] = [
    [
      "testpage-unsupported",
      row("A", { outcome: "error", classification: ["tests-testpage-unsupported"] }),
    ],
    [
      "permission-refused",
      row("A", { outcome: "error", classification: ["tests-permission-refused"] }),
    ],
    [
      "baseline-test-stopped",
      row("A", { outcome: "timeout", classification: ["baseline-test-stopped"] }),
    ],
    ["a plain timeout", row("A", { outcome: "timeout" })],
    ["a skip of any origin", row("A", { outcome: "skip" })],
    ["a transport failure (notRun)", row("A", { outcome: "error", notRun: true })],
  ];
  for (const [label, base] of cases) {
    test(label, () => {
      const r = build(CAPS_BC, [PASS, base]);
      expect(r.notRunAtBaseline).toEqual([base.name]);
      expect(r.validity.caveats).toContain("survivors-beside-unrun-tests");
    });
  }
});

describe("PR-387 test 3: not counted", () => {
  test("a test that FAILED by assertion: [] and no caveat", () => {
    const r = build(CAPS_BC, [PASS, FAILED]);
    expect(r.notRunAtBaseline).toEqual([]);
    expect(r.validity.caveats).not.toContain("survivors-beside-unrun-tests");
  });
  test("stale-test-app alone, and a plain error", () => {
    expect(isBcdevNotRunBaselineRow({ outcome: "error", classification: ["stale-test-app"] })).toBe(
      false,
    );
    expect(isBcdevNotRunBaselineRow({ outcome: "error", classification: [] })).toBe(false);
    expect(isBcdevNotRunBaselineRow({ outcome: "fail", classification: [] })).toBe(false);
  });
  test("a deadline-exceeded row counts (as on v3)", () => {
    expect(isBcdevNotRunBaselineRow({ outcome: "deadline-exceeded", classification: [] })).toBe(
      true,
    );
  });
  test("stale-test-app wins over a skip and a body that never ran (the session is refused whole)", () => {
    expect(
      isBcdevNotRunBaselineRow({
        outcome: "skip",
        classification: ["stale-test-app"],
        notRun: true,
      }),
    ).toBe(false);
    // Control: the same row without the stale class counts.
    expect(isBcdevNotRunBaselineRow({ outcome: "skip", classification: [], notRun: true })).toBe(
      true,
    );
  });
});

describe("PR-387 test 4: only kills, errors and no-coverage", () => {
  test("the field is filled and there is no caveat", () => {
    const r = build(CAPS_BC, [PASS, REFUSED], ["killed", "error", "no-coverage"]);
    expect(r.notRunAtBaseline).toEqual([REFUSED.name]);
    expect(r.validity.caveats).not.toContain("survivors-beside-unrun-tests");
    expect(r.survivorsBesideUnrunTests).toBeUndefined();
  });
});

describe("PR-387 test 5: an older report and an empty one", () => {
  const yes = build(CAPS_BC, [PASS, REFUSED]);
  const { notRunAtBaseline: _a, survivorsBesideUnrunTests: _b, ...old } = yes;

  test("no field: 'not recorded' in the console, notRunLine and explain", () => {
    expect(notRunSurvivors(old)).toBeUndefined();
    expect(notRunLine(old)).toBe(NOT_RECORDED_TEXT);
    expect(renderConsole(old as SessionReport)).toContain(NOT_RECORDED_TEXT);
    const c = explain(old as SessionReport).toolConditions.find(
      (t) => t.condition === "not-run-tests-not-recorded",
    );
    expect(c?.count).toBe(2);
  });
  test("the field [] gives no text", () => {
    const r = build(CAPS_BC, [PASS]);
    expect(r.notRunAtBaseline).toEqual([]);
    expect(notRunLine(r)).toBeUndefined();
    expect(renderConsole(r)).not.toContain(NOT_RECORDED_TEXT);
    expect(
      explain(r).toolConditions.some((t) => t.condition === "not-run-tests-not-recorded"),
    ).toBe(false);
  });
});

describe("PR-387 tests 6 and 7: sharingACodeunit and the sentence, both directions", () => {
  test("bcdev omits sharingACodeunit even beside a tagged survivor note; v3 keeps it", () => {
    const bc = build(CAPS_BC, [PASS, REFUSED]);
    expect(bc.survivorsBesideUnrunTests).not.toHaveProperty("sharingACodeunit");
    const v3 = build(CAPS_V3, [
      PASS,
      row("Refused", { outcome: "error", failureMessage: "NotRun: out-of-scope: needs a thing" }),
    ]);
    expect(v3.survivorsBesideUnrunTests).toHaveProperty("sharingACodeunit");
  });
  test("each backend prints its own sentence and not the other's", () => {
    const bc = renderConsole(build(CAPS_BC, [PASS, REFUSED]));
    expect(bc).toContain(BC_SENTENCE(2, 1));
    expect(bc).not.toContain("v3 did not run");
    const v3 = renderConsole(
      build(CAPS_V3, [
        PASS,
        row("Refused", { outcome: "error", failureMessage: "NotRun: out-of-scope: needs a thing" }),
      ]),
    );
    expect(v3).toContain("tests v3 did not run at baseline".replace("tests ", "test "));
    expect(v3).not.toContain("BC could not run");
  });
  test("v3's predicate is untouched by the bcdev one", () => {
    expect(isNotRunBaselineRow({ outcome: "skip" })).toBe(false);
    expect(isBcdevNotRunBaselineRow({ outcome: "skip", classification: [] })).toBe(true);
  });
});
