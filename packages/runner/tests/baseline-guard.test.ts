import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMatchesBaseline } from "../itest/baseline-guard";
import type { MutantOutcome, SessionReport } from "../src/report";

function outcome(
  overrides: Partial<MutantOutcome> & Pick<MutantOutcome, "mutantCode">,
): MutantOutcome {
  return {
    file: "SandboxLogic.Codeunit.al",
    line: 10,
    operatorName: "conditional-boundary",
    verdict: "survived",
    batchIndex: 0,
    astHash: `hash-${overrides.mutantCode}`,
    codeunitName: "Sandbox Logic",
    operatorMajor: 1,
    runner: "fenced",
    durationMs: 0,
    procedureName: "Post",
    startIndex: 0,
    endIndex: 1,
    originalText: "Original();",
    mutatedText: "",
    coveringTests: [],
    ...overrides,
  };
}

function report(mutants: readonly MutantOutcome[]): SessionReport {
  const counts = {
    killed: mutants.filter((m) => m.verdict === "killed").length,
    survived: mutants.filter((m) => m.verdict === "survived").length,
    noCoverage: mutants.filter((m) => m.verdict === "no-coverage").length,
    timeoutKilled: mutants.filter((m) => m.verdict === "timeout-killed").length,
    knownSurvivors: mutants.filter((m) => m.verdict === "known-survivor").length,
    unstable: mutants.filter((m) => m.cause === "unstable").length,
    errors: mutants.filter((m) => m.verdict === "error").length,
    deadlineExceeded: mutants.filter((m) => m.cause === "deadline-exceeded").length,
  };
  return {
    schemaVersion: 2,
    validity: {
      reliability: "full" as const,
      caveats: [],
      scoreDescribes: "test fixture",
      baselineTests: { total: 0, failing: 0 },
      scoredMutants: { scored: 0, recorded: 0 },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: mutants.length,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts,
    mutationScore: null,
    mutants,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-baseline-guard-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assertMatchesBaseline", () => {
  test("no committed baseline: records this run's verdicts as the new baseline and does not throw", async () => {
    const path = join(dir, "baseline.json");
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "OverBudgetDetected" }),
      outcome({ mutantCode: "M0002", astHash: "hash-M0002", verdict: "survived" }),
    ]);
    await assertMatchesBaseline(r, path, "test itest");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual([
      {
        key: "hash-M0001|Sandbox Logic|conditional-boundary|1",
        verdict: "killed",
        killingTest: "OverBudgetDetected",
        coverageFiltered: false,
        errorClass: null,
      },
      {
        key: "hash-M0002|Sandbox Logic|conditional-boundary|1",
        verdict: "survived",
        killingTest: null,
        coverageFiltered: false,
        errorClass: null,
      },
    ]);
  });

  test("a committed baseline that matches (mutantCode renumbered, semantic identity unchanged) does not throw", async () => {
    const path = join(dir, "baseline.json");
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await assertMatchesBaseline(first, path, "test itest"); // records the baseline

    // A "second run" whose mutant got renumbered (M0099, not M0001) but keeps the same semantic
    // identity — must NOT be reported as a regression (mirrors mutant-equality.test.ts's own
    // "ignores fields outside the comparable set" case).
    const second = report([
      outcome({ mutantCode: "M0099", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await expect(assertMatchesBaseline(second, path, "test itest")).resolves.toBeUndefined();
  });

  test("a committed baseline that DIFFERS throws, naming the differing mutant", async () => {
    const path = join(dir, "baseline.json");
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await assertMatchesBaseline(first, path, "test itest"); // records the baseline

    // Same mutant, verdict flipped killed -> survived: a real per-mutant regression.
    const second = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "survived" }),
    ]);
    await expect(assertMatchesBaseline(second, path, "test itest")).rejects.toThrow(
      /per-mutant regression/,
    );
    await expect(assertMatchesBaseline(second, path, "test itest")).rejects.toThrow(
      /verdict killed -> survived/,
    );
  });

  test("a per-mutant swap with unchanged aggregate counts still throws (the whole point of this guard)", async () => {
    const path = join(dir, "baseline.json");
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-A", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", astHash: "hash-B", verdict: "survived" }),
    ]);
    await assertMatchesBaseline(first, path, "test itest");

    // Aggregate counts (1 killed, 1 survived) are identical — only WHICH mutant holds which
    // verdict changed. An aggregate-only comparison (assertVerdictTable's counts) would see no
    // regression at all; this guard must still catch it.
    const second = report([
      outcome({ mutantCode: "M0001", astHash: "hash-A", verdict: "survived" }),
      outcome({ mutantCode: "M0002", astHash: "hash-B", verdict: "killed", killingTest: "T1" }),
    ]);
    await expect(assertMatchesBaseline(second, path, "test itest")).rejects.toThrow(
      /per-mutant regression/,
    );
  });
});
