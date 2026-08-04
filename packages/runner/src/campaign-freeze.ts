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
import { dirname, join, resolve } from "node:path";
import { assertMatchesBaseline } from "../itest/baseline-guard";
import { assertCardinality } from "./campaign-anchors";
import type { SessionReport } from "./report";

/** Where this campaign's committed records live, relative to the repository root. */
const RECORDS_RELATIVE = "docs/campaign/2026-08-03-do";

/**
 * Walks up from `startDir` looking for `.git` (a directory in an ordinary checkout, a file
 * pointing at `.git/worktrees/<name>` in a worktree — `existsSync` doesn't care which, and
 * finding the WORKTREE's own `.git` is exactly what's wanted here: this campaign's records live
 * IN the worktree, not in the main checkout).
 *
 * Throws rather than falling back to `process.cwd()` or a relative path: a marker that can't be
 * found is a reason to refuse, not a reason to guess and silently write records into whatever
 * directory happened to be current.
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `campaign-freeze: could not locate a repository root walking up from ${startDir} (no .git found). Refusing to guess a records directory — freezeRung's whole point is that records are NOT lost to the wrong location.`,
      );
    }
    dir = parent;
  }
}

/**
 * The records directory, resolved against the repository root — NEVER against `process.cwd()`.
 *
 * A relative `RECORDS_RELATIVE` resolved against cwd would silently create a records tree
 * wherever `freeze.ts` happened to be invoked FROM and still report success: a gate that passes
 * while writing its evidence into the void. `import.meta.dir` is this module's own on-disk
 * location, which is fixed by where the file lives in the repo, not by the caller's shell state —
 * so this is correct however `freezeRung` is invoked (CLI script, `bun test`, a future caller
 * importing it from elsewhere entirely).
 */
export function defaultRecordsDir(): string {
  return join(findRepoRoot(import.meta.dir), RECORDS_RELATIVE);
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
