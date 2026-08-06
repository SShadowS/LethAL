/**
 * Archive a rung's report and freeze its per-mutant verdicts to a committed file (Task 3, DO live
 * campaign spec 2026-08-03, "so this campaign is not the next one's dead anchor").
 *
 * The 2026-07-28 anchor died because its per-mutant record lived only in a scratch `--out` and a
 * `mkdtemp` sqlite — outside the worktree, outside git, gone the moment the temp dir was reaped.
 * Only the aggregate survived, in prose, and a whole campaign gate had to be redesigned around its
 * absence (see `campaign-anchors.ts`'s doc comment). This campaign's stated undo is
 * `git worktree remove`, which deletes everything under the worktree that was never committed —
 * so a rung's evidence has to be copied out to a COMMITTED path and diffed against a COMMITTED
 * baseline before the next rung is allowed to start.
 *
 * `assertMatchesBaseline` (packages/runner/itest/baseline-guard.ts) does the durable half: it
 * records a fresh baseline when none exists and THROWS on any per-mutant difference when one
 * does, keyed on semantic identity (astHash/codeunitName/operatorName/operatorMajor), never on
 * mutantCode or file:line — which is the identity a re-batching run can shift.
 *
 * Order matters twice over. `assertMatchesBaseline` runs BEFORE the report is archived, so the
 * archived `<rung>.report.json` and `<rung>.baseline.json` always describe the same per-mutant
 * verdicts; a mismatching report is archived under `<rung>.mismatch[-n].report.json` instead of
 * over the corresponding pair. And `assertCardinality` (`./campaign-anchors.ts`) runs FIRST of
 * all, independently of any I/O against
 * the records directory, because `assertMatchesBaseline` self-records when its target file is
 * absent: a cardinality check that ran AFTER the copy/baseline step would let an empty or
 * truncated report freeze itself as its own baseline on the very first rung, and every later rung
 * would then compare against that hollow baseline and agree forever — the empty-vs-empty failure
 * this project is named for, just deferred one step.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertMatchesBaseline } from "../itest/baseline-guard";
import { assertCardinality } from "./campaign-anchors";
import { type CampaignManifest, resolveRecordsDir } from "./campaign-manifest";
import type { SessionReport } from "./report";

// `findRepoRoot`'s public surface (used by nothing outside this module today, per a repo-wide
// grep, but exported since Task 2 landed) is unchanged: same walk-up, same refusal, just now
// shared infrastructure that lives in `campaign-manifest.ts` alongside the manifest reader that
// needs the identical mechanism. Re-exported here so this stays a compatible move, not a break.
export { findRepoRoot } from "./campaign-manifest";

/**
 * This campaign's own manifest — the recordsDir this module has defaulted to since it was
 * written (`docs/campaign/2026-08-03-do`), now expressed as a `CampaignManifest` value flowing
 * through the same `resolveRecordsDir()` a future campaign's manifest-supplied value will use
 * (`campaign-manifest.ts`), instead of an independently hardcoded `join`. This directory name
 * still has to be written down somewhere for THIS campaign's own zero-arg default — Task 3's CLI
 * subcommands are where a *different* campaign's manifest gets read from disk and threaded
 * through `freezeRungTo` directly, bypassing this default entirely.
 */
const THIS_CAMPAIGN_MANIFEST: CampaignManifest = {
  recordsDir: "docs/campaign/2026-08-03-do",
  campaignId: "2026-08-03-do",
};

/**
 * The records directory this campaign's zero-arg `freezeRung` defaults to, resolved against the
 * repository root — NEVER against `process.cwd()`. See `resolveRecordsDir`'s doc comment
 * (`campaign-manifest.ts`) for why a cwd-relative path is refused rather than silently resolved.
 */
export function defaultRecordsDir(): string {
  return resolveRecordsDir(THIS_CAMPAIGN_MANIFEST);
}

/**
 * Same contract as `freezeRung`, with the records directory injected rather than resolved from
 * this module's own location — the seam that lets a test exercise the cardinality-before-I/O
 * ordering (and the "succeeds on a matching count" path) against a throwaway temp dir instead of
 * this campaign's real committed records.
 */
export async function freezeRungTo(
  reportPath: string,
  rung: string,
  expectedCount: number,
  recordsDir: string,
): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as SessionReport;
  // Cardinality FIRST — see module doc comment. No directory is created and no file is read or
  // written against `recordsDir` until this passes.
  assertCardinality(report, expectedCount, `${rung} freeze`);
  await mkdir(recordsDir, { recursive: true });
  // COMPARE BEFORE ARCHIVING. Plan Task 6 step 3 calls this twice with the same label, so with
  // the copy first, run 2's report overwrote `<rung>.report.json` while `<rung>.baseline.json`
  // still came from run 1 — and on a FAILING second run the overwrite had already happened when
  // the throw fired, leaving a mismatched pair in the component whose entire purpose is durable
  // evidence. With the compare first, `<rung>.report.json` is only ever written after
  // `assertMatchesBaseline` has returned, so the archived report and the baseline provably
  // describe the same per-mutant verdicts: either the baseline was just minted FROM this report,
  // or this report matched it exactly.
  try {
    await assertMatchesBaseline(report, join(recordsDir, `${rung}.baseline.json`), rung);
  } catch (err) {
    // The failing report is the most interesting artifact this campaign can produce, and the
    // `--out` file it came from lives outside the worktree precisely because that location is not
    // durable. Archive it under a name that can never be mistaken for the corresponding pair,
    // then rethrow — the caller must still fail.
    const dest = mismatchDestination(recordsDir, rung);
    await copyFile(reportPath, dest);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${rung} freeze: the report does not match the committed baseline. ${rung}.report.json was NOT overwritten (it still holds the run the baseline was recorded from); the mismatching report is archived at ${dest}.\n${detail}`,
      { cause: err },
    );
  }
  await copyFile(reportPath, join(recordsDir, `${rung}.report.json`));
  console.log(`[freeze] ${rung}: ${report.mutants.length} mutants archived and frozen`);
}

/**
 * First free `<rung>.mismatch[-n].report.json`. A fixed name would let a second failing run
 * destroy the first one's evidence — the exact loss this module exists to prevent, one level down.
 */
function mismatchDestination(recordsDir: string, rung: string): string {
  for (let n = 1; n <= 100; n++) {
    const p = join(
      recordsDir,
      n === 1 ? `${rung}.mismatch.report.json` : `${rung}.mismatch-${n}.report.json`,
    );
    if (!existsSync(p)) return p;
  }
  throw new Error(
    `campaign-freeze: 100 mismatching ${rung} reports are already archived in ${recordsDir}. Refusing to overwrite evidence — clear them out deliberately.`,
  );
}

/** Archive `reportPath` and freeze its per-mutant verdicts under this campaign's committed
 *  records directory (`docs/campaign/2026-08-03-do`, resolved against the repository root). */
export async function freezeRung(
  reportPath: string,
  rung: string,
  expectedCount: number,
): Promise<void> {
  await freezeRungTo(reportPath, rung, expectedCount, defaultRecordsDir());
}
