import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// `freezeStageTo` is the pure archive-and-freeze half, tested here directly. Its production caller
// is `runCampaignFreeze` (`campaign-subcommands.ts`), reached as `lethal campaign freeze` and
// covered in `campaign-subcommands.test.ts` — including that the git check runs BEFORE anything
// here writes. (It used to be `scripts/campaign/freeze.ts`, deleted with that subcommand.)
//
// The stage name here stays `rung1` on purpose. A stage NAME is the campaign author's to choose,
// and the 2026-08-03 campaign's stages are named `rung1`/`rung2`/`rung3` in committed records this
// rename does not touch — so exercising the flag under exactly that name is the standing check
// that those records still resolve.
import { freezeStageTo } from "../src/campaign-freeze";
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
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
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

describe("freezeStageTo", () => {
  test("throws when the report's mutant count does not match expectedCount, BEFORE touching the records directory", async () => {
    const r = report([
      outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" }),
      outcome({ mutantCode: "M0002", astHash: "hash-M0002", verdict: "survived" }),
    ]);
    await writeFile(reportPath, JSON.stringify(r), "utf8");

    await expect(freezeStageTo(reportPath, "rung1", 176, recordsDir)).rejects.toThrow(
      /rung1 freeze.*expected 176.*got 2/,
    );

    // The ordering is the whole point (see campaign-freeze.ts's doc comment): if the cardinality
    // check ran AFTER the copy/baseline step, this mismatched report would have been archived and
    // frozen as the new baseline anyway, and every later stage would compare against that hollow
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

    await expect(freezeStageTo(reportPath, "rung1", 2, recordsDir)).resolves.toBeUndefined();

    const files = (await readdir(recordsDir)).sort();
    expect(files).toEqual(["rung1.baseline.json", "rung1.report.json"]);
  });

  test("a second freeze against the same records directory with an unchanged report does not throw", async () => {
    const r = report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]);
    await writeFile(reportPath, JSON.stringify(r), "utf8");

    await freezeStageTo(reportPath, "rung1", 1, recordsDir); // records the baseline
    await expect(freezeStageTo(reportPath, "rung1", 1, recordsDir)).resolves.toBeUndefined();
  });

  test("a second freeze against the same records directory with a per-mutant regression throws", async () => {
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await writeFile(reportPath, JSON.stringify(first), "utf8");
    await freezeStageTo(reportPath, "rung1", 1, recordsDir); // records the baseline

    const second = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "survived" }),
    ]);
    await writeFile(reportPath, JSON.stringify(second), "utf8");
    await expect(freezeStageTo(reportPath, "rung1", 1, recordsDir)).rejects.toThrow(
      /per-mutant regression/,
    );
  });

  /**
   * The property the archive is supposed to have: `<stage>.report.json` and `<stage>.baseline.json`
   * describe the SAME run. With the copy before the comparison, a failing second freeze left run
   * 2's report next to run 1's baseline — a mismatched evidence pair, produced by the component
   * whose whole purpose is durable evidence.
   */
  test("a FAILING second freeze leaves the archived report and the baseline describing the same run", async () => {
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await writeFile(reportPath, JSON.stringify(first), "utf8");
    await freezeStageTo(reportPath, "rung1", 1, recordsDir);

    const regressed = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "survived" }),
    ]);
    await writeFile(reportPath, JSON.stringify(regressed), "utf8");
    await expect(freezeStageTo(reportPath, "rung1", 1, recordsDir)).rejects.toThrow();

    const archived = JSON.parse(
      await readFile(join(recordsDir, "rung1.report.json"), "utf8"),
    ) as SessionReport;
    // The baseline file is a bare array of semantic-identity-keyed records (baseline-guard.ts).
    const baseline = JSON.parse(
      await readFile(join(recordsDir, "rung1.baseline.json"), "utf8"),
    ) as readonly { verdict: string }[];
    // Run 1 was killed; the regressed run 2 was survived. The archived report must still be run 1
    // — the run its neighbouring baseline was recorded from.
    expect(archived.mutants[0]?.verdict).toBe("killed");
    expect(baseline[0]?.verdict).toBe("killed");
    // ...and run 2's report is not discarded either: it is the finding.
    const mismatched = JSON.parse(
      await readFile(join(recordsDir, "rung1.mismatch.report.json"), "utf8"),
    ) as SessionReport;
    expect(mismatched.mutants[0]?.verdict).toBe("survived");
  });

  test("a second failing freeze does not overwrite the first failure's archived report", async () => {
    const first = report([
      outcome({ mutantCode: "M0001", astHash: "hash-X", verdict: "killed", killingTest: "T1" }),
    ]);
    await writeFile(reportPath, JSON.stringify(first), "utf8");
    await freezeStageTo(reportPath, "rung1", 1, recordsDir);

    for (const verdict of ["survived", "no-coverage"] as const) {
      await writeFile(
        reportPath,
        JSON.stringify(report([outcome({ mutantCode: "M0001", astHash: "hash-X", verdict })])),
        "utf8",
      );
      await expect(freezeStageTo(reportPath, "rung1", 1, recordsDir)).rejects.toThrow();
    }

    const files = (await readdir(recordsDir)).sort();
    expect(files).toEqual([
      "rung1.baseline.json",
      "rung1.mismatch-2.report.json",
      "rung1.mismatch.report.json",
      "rung1.report.json",
    ]);
  });

  test("the SUCCESS path archives the report the baseline was just recorded from", async () => {
    const r = report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T1" })]);
    await writeFile(reportPath, JSON.stringify(r), "utf8");
    await freezeStageTo(reportPath, "rung1", 1, recordsDir);

    const archived = JSON.parse(
      await readFile(join(recordsDir, "rung1.report.json"), "utf8"),
    ) as SessionReport;
    const baseline = JSON.parse(
      await readFile(join(recordsDir, "rung1.baseline.json"), "utf8"),
    ) as readonly { verdict: string; key: string }[];
    expect(archived.mutants.map((m) => String(m.verdict))).toEqual(baseline.map((m) => m.verdict));
    // The baseline is keyed on semantic identity (astHash|codeunitName|operatorName|major), so
    // "the same run" is checkable field by field, not merely by count.
    expect(baseline[0]?.key).toContain(archived.mutants[0]?.astHash ?? "MISSING");
  });
});
