import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Imports from packages/runner/src, not scripts/campaign/freeze.ts directly — see that file's
// doc comment for why (scripts/ sits outside this package's tsconfig project graph).
import { freezeRungTo } from "../src/campaign-freeze";
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
    untargetedTriggerCount: 0,
  };
}

let dir: string;
let reportPath: string;
let recordsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-campaign-freeze-"));
  reportPath = join(dir, "report.json");
  recordsDir = join(dir, "records");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("freezeRungTo", () => {
  test("throws when the report's mutant count does not match expectedCount, BEFORE touching the records directory", async () => {
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", astHash: "hash-M0002", verdict: "survived" }),
    ]);
    await writeFile(reportPath, JSON.stringify(r), "utf8");

    await expect(freezeRungTo(reportPath, "rung1", 176, recordsDir)).rejects.toThrow(
      /rung1 freeze.*expected 176.*got 2/,
    );

    // The ordering is the whole point (see campaign-freeze.ts's doc comment): if the cardinality
    // check ran AFTER the copy/baseline step, this mismatched report would have been archived and
    // frozen as the new baseline anyway, and every later rung would compare against that hollow
    // record and agree forever. Assert directly that NOTHING was written — the records directory
    // must not even exist yet.
    await expect(readdir(recordsDir)).rejects.toThrow(/ENOENT/);
  });

  test("succeeds on the exact pre-committed count: archives the report and records a fresh baseline", async () => {
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", astHash: "hash-M0002", verdict: "survived" }),
    ]);
    await writeFile(reportPath, JSON.stringify(r), "utf8");

    await expect(freezeRungTo(reportPath, "rung1", 2, recordsDir)).resolves.toBeUndefined();

    const files = (await readdir(recordsDir)).sort();
    expect(files).toEqual(["rung1.baseline.json", "rung1.report.json"]);
  });

  test("a second freeze against the same records directory with an unchanged report does not throw", async () => {
    const r = report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]);
    await writeFile(reportPath, JSON.stringify(r), "utf8");

    await freezeRungTo(reportPath, "rung1", 1, recordsDir); // records the baseline
    await expect(freezeRungTo(reportPath, "rung1", 1, recordsDir)).resolves.toBeUndefined();
  });

  test("a second freeze against the same records directory with a per-mutant regression throws", async () => {
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await writeFile(reportPath, JSON.stringify(first), "utf8");
    await freezeRungTo(reportPath, "rung1", 1, recordsDir); // records the baseline

    const second = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "survived" }),
    ]);
    await writeFile(reportPath, JSON.stringify(second), "utf8");
    await expect(freezeRungTo(reportPath, "rung1", 1, recordsDir)).rejects.toThrow(
      /per-mutant regression/,
    );
  });
});
