/**
 * Per-mutant healthy-path regression guard, wired into the live env-gated itests (Task 15,
 * design spec §14). `mutant-equality.ts`'s `normalizeForComparison`/`diffMutants` already do the
 * pure comparison work (semantic-identity-keyed — astHash/codeunitName/operatorName/
 * operatorMajor, never mutantCode or file:line, ignoring nondeterministic fields like duration/
 * runId/version/artifactId); this module adds the one piece those pure functions deliberately
 * don't own — durable storage of a COMMITTED baseline on disk, so a live itest run compares
 * against a known-good history, not just against itself.
 *
 * `bcdev.itest.ts`/`al-runner.itest.ts` already run the session twice per invocation and assert
 * `shape(first) === shape(second)` — that only proves same-PROCESS determinism (two runs THIS
 * invocation agree). It says nothing about a real regression introduced since the last time the
 * itest was run: two runs of a silently-broken build could still agree with each other. This
 * closes that gap by diffing against a file committed to the repo.
 *
 * No committed baseline yet at `baselinePath` -> this run's normalized report BECOMES the new
 * baseline (written to disk; the caller must `git add`/commit it — see fixtures/README.md
 * "Integration scripts"). A committed baseline present -> `diffMutants` must be empty or the
 * itest throws, naming every differing mutant — a per-mutant difference fails the itest, exactly
 * like a per-mutant-count mismatch already does.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { SessionReport } from "../src/report";
import { diffMutants, normalizeForComparison } from "./mutant-equality";
import type { NormalizedMutant } from "./mutant-equality";

/** Deterministic on-disk ordering — a baseline file's diff must never depend on report order. */
function sortedForDisk(mutants: readonly NormalizedMutant[]): NormalizedMutant[] {
  return [...mutants].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Compares `report` against the committed baseline at `baselinePath`, recording a fresh baseline
 * when none exists yet. Throws (never returns a "differences" value the caller could accidentally
 * ignore) when a committed baseline exists and at least one mutant differs — a per-mutant
 * regression must fail the itest exactly as loudly as an aggregate-count mismatch does.
 */
export async function assertMatchesBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
): Promise<void> {
  const actual = sortedForDisk(normalizeForComparison(report));
  let baselineRaw: string | undefined;
  try {
    baselineRaw = await readFile(baselinePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (baselineRaw === undefined) {
    await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    console.log(
      `${label}: no committed baseline at ${baselinePath} — recorded this run's per-mutant verdicts as the new baseline. Review and commit this file.`,
    );
    return;
  }
  const baseline = JSON.parse(baselineRaw) as NormalizedMutant[];
  const diffs = diffMutants(baseline, actual);
  if (diffs.length > 0) {
    throw new Error(
      `${label}: per-mutant regression against the committed baseline at ${baselinePath} (${diffs.length} mutant(s) differ):\n${diffs.map((d) => `  - ${d}`).join("\n")}\n` +
        `If this difference is EXPECTED (the fixture or an operator legitimately changed), delete ${baselinePath}, re-run to record a new baseline, review the diff, then commit it.`,
    );
  }
}
