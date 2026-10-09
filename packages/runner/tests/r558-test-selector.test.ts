import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { reportTestSelectorFailures } from "../itest/cli-default-leg";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R558 — `ExecutionContext.testSelector` / `testSelectorReason` record which al-runner test selector
 * R551's probe chose. Gated exactly as R147's `platformAppsDir`: directly-measured entries on a
 * non-authoritative backend only; never a carried entry, never bcdev, never the zero-outcome
 * placeholder.
 */

const CAPS_AL_RUNNER = {
  coverage: "none",
  deploy: "none",
  isolation: "full-reset",
  authoritative: false,
} as const;
const CAPS_BCDEV = {
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
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "Original();",
    mutatedText: "",
  };
}

const measured: SessionOutcome = { mutant: entry("M0001"), verdict: "killed", batchIndex: 0 };
const carried: SessionOutcome = {
  mutant: entry("M0002"),
  verdict: "survived",
  batchIndex: 0,
  carried: true,
};

function build(outcomes: SessionOutcome[], over: Record<string, unknown> = {}) {
  return legacyBuildReport({
    caps: CAPS_AL_RUNNER,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
    ...over,
  });
}

describe("ExecutionContext.testSelector (R558)", () => {
  test("exact: the measured context says exact, with no reason", () => {
    const [ctx, ...rest] = build([measured], {
      alRunnerTestSelector: { selector: "exact" },
    }).validity.executionContexts;
    expect(rest).toEqual([]);
    expect(ctx?.testSelector).toBe("exact");
    expect(ctx !== undefined && "testSelectorReason" in ctx).toBe(false);
  });

  test("substring-with-excludes carries the probe's reason verbatim", () => {
    const [ctx] = build([measured], {
      alRunnerTestSelector: {
        selector: "substring-with-excludes",
        reason: "exit 2; Unknown option",
      },
    }).validity.executionContexts;
    expect(ctx?.testSelector).toBe("substring-with-excludes");
    expect(ctx?.testSelectorReason).toBe("exit 2; Unknown option");
  });

  test("a CARRIED entry gets neither field; the measured entry beside it does", () => {
    const contexts = build([measured, carried], {
      alRunnerTestSelector: { selector: "exact" },
      resumedFrom: { runId: 7, carriedMutants: 1, skippedStranded: 0 },
    }).validity.executionContexts;
    const direct = contexts.find((c) => !c.basis.includes("carried"));
    const fromRun7 = contexts.find((c) => c.basis.includes("carried"));
    expect(direct?.testSelector).toBe("exact");
    expect(fromRun7).toBeDefined();
    expect(fromRun7?.testSelector).toBeUndefined();
    expect(fromRun7?.testSelectorReason).toBeUndefined();
  });

  test("an authoritative (bcdev) backend gets neither field, even if handed the event", () => {
    const [ctx] = build([measured], {
      caps: CAPS_BCDEV,
      alRunnerTestSelector: { selector: "substring-with-excludes", reason: "x" },
    }).validity.executionContexts;
    expect(ctx?.verdictCount).toBe(1);
    expect(ctx?.testSelector).toBeUndefined();
    expect(ctx?.testSelectorReason).toBeUndefined();
  });

  test("no event (a --server session, whose probe is not-applicable): neither field", () => {
    const [ctx] = build([measured]).validity.executionContexts;
    expect(ctx?.verdictCount).toBe(1);
    expect(ctx?.testSelector).toBeUndefined();
  });

  test("a session that probed but scored nothing: the zero-count placeholder gets neither field", () => {
    const [ctx, ...rest] = build([], {
      alRunnerTestSelector: { selector: "exact" },
    }).validity.executionContexts;
    expect(rest).toEqual([]);
    expect(ctx?.verdictCount).toBe(0);
    expect(ctx?.testSelector).toBeUndefined();
  });
});

describe("reportTestSelectorFailures — the itest:alrunner per-leg check (R558)", () => {
  const exact = build([measured], { alRunnerTestSelector: { selector: "exact" } });
  const substring = build([measured], {
    alRunnerTestSelector: { selector: "substring-with-excludes", reason: "exit 2" },
  });
  const none = build([measured]);

  test("one-shot: either value passes; the value itself is not pinned", () => {
    expect(reportTestSelectorFailures(exact, true)).toEqual([]);
    expect(reportTestSelectorFailures(substring, true)).toEqual([]);
  });

  test("one-shot: a measured context WITHOUT the field fails", () => {
    expect(reportTestSelectorFailures(none, true)).not.toEqual([]);
  });

  test("one-shot: substring-with-excludes without its reason fails", () => {
    const noReason = build([measured], {
      alRunnerTestSelector: { selector: "substring-with-excludes" },
    });
    expect(reportTestSelectorFailures(noReason, true)).not.toEqual([]);
  });

  test("--server: no field passes; a recorded field fails", () => {
    expect(reportTestSelectorFailures(none, false)).toEqual([]);
    expect(reportTestSelectorFailures(exact, false)).not.toEqual([]);
  });

  test("one-shot with no measured context at all fails: an absent field there proves nothing", () => {
    expect(reportTestSelectorFailures(build([]), true)).not.toEqual([]);
  });
});
