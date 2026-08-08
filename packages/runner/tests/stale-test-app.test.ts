import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { NO_RESULT_FOR_METHOD } from "../src/bcdev-backend";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
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
