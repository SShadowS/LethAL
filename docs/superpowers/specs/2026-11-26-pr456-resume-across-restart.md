# PR-456 (R1229): carry decided SURVIVORS across a BC restart that lost the database — design r2 (no build)

lethal-code, 2026-11-26.
- **r1** was 657e6ad70: it carried every verdict on equal apps plus an equal per-batch baseline.
- **r2** answers its spec-adversary: BLOCKs 1-2, SHOULDs 3-6, NITs 7-10, marked "(B1)" and so on.
- **The orchestrator's condition:** carry only if the re-setup uses the same app hashes AND the fresh baseline equals
  the stored one per test; degraded-window verdicts never carry.
- **Prior rulings:** R959 (the refusal stays: an app check cannot see company data) and R969 (a database id survives a
  lease reset).

## Why survivors only (B1, B2)

Carrying a KILL across a lost database opens two false-kill doors that no baseline compare can close.
- **(B1) An undetected degraded tier (R1228).** A tier that degrades while lease renews are still answered writes no
  degraded window.
  - Its kills reproduce on the same sick tier (R577), so they are stored `killed`.
  - After a restart, the fresh baseline runs on a healthy server and matches the stored one, because both baselines
    sit outside the sick period.
  - The suspect kills would carry, and the restart is correlated with the degradation.
- **(B2) Data the tests do not observe.** Coverage on bcdev is per procedure. A data value that decides a branch
  inside a procedure, or makes a mutant equivalent for one value and not another, leaves the unmutated tests and
  their procedure coverage identical. Writes left over since setup differ from a fresh restore, too.
  - A kill made on the old data can be a mutant the suite does not catch on the current server.
- **For SURVIVORS the same shapes can only hide a kill:** the safe direction (owner principle 1: a wrong kill is the
  error this project exists to prevent).
  - It costs most to redo: a survivor took 650-1,200 s in PR-427, and a kill takes seconds once its killer runs first.
  - There is a precedent: `priorSurvivorKeys` (`--skip-known-survivors`) already lends survivors across ANY server
    generation, on test-app identity plus R496 plus R644.
- **So a kill is RE-RUN, and the prior killing test is seeded FIRST** in R197's kill ledger, as an ordering hint
  only: R1179 already seeds from carried kills. A hint never moves a verdict.
  - `timeout-killed` is also re-run.

## The new branch

When the generation AND the database id both changed, the resume no longer throws at once. (NIT8) A database id
MISSING on either side still refuses, as today.

1. **(S3) Apps: the EXISTING checks, unchanged.**
   - `assertSameTestApp` (R247/R495/R601);
   - R496's `test_app_deps` fingerprint from the server's bytes (Microsoft apps, System, LethAL Control);
   - the run's `generation_source_sha256` (R391) and each batch's hash.
   - No new app fields. The platform build is not recorded, and System's bytes stand in for it.
   - Whether these still match after a re-setup is UNMEASURED (S4): probe it before any build.
2. **The baseline, per batch.** After batch b's FRESH baseline and before any of b's mutants is scheduled, it is
   compared with the prior run's snapshot for b.
   - **(S5) The prior snapshot is found by batch hash among the prior run's own snapshots and its PR-66 reuse row,**
     never by index: R90 can re-plan batches.
     - It gets the same exclusions as `findBaselineSnapshot`: suspect (R512), lost (R513), degraded
       (`after_snapshot_id`).
     - A closed-world prior's `|pending` suffix is stripped before comparing.
   - **Equal means:**
     - the same test methods;
     - the same verdict per method;
     - the same start WorkDate (R1131);
     - (S6) the same stored `CoverageMap`, EXACTLY (every entry, object-level entries, `overloadIndex` and
       `namingGaps`).
   - **Any difference, and none of b's survivors carry** (`resume-restart-baseline-differs`, the batch, the count).
   - **(S5) Each of these re-runs batch b, by name:**
     - no snapshot;
     - a fresh baseline that did not complete (an R955 budget, a stop);
     - a snapshot reused this generation instead of a fresh baseline;
     - hub mode (no WorkDate in its baseline);
     - `isolatesTests`, `isolationAuto` or `baselineBatchingKnobOff` batches;
     - a stored baseline with a stopped test.
3. **What carries:** a `survived` row of a matching batch, through R646 as today. A survivor with an empty faced list,
   or a covering test it never faced, is re-run.
4. **What never carries:**
   - kills and `timeout-killed` (re-run, with the killer as a hint);
   - degraded-window, lost-batch and unattested rows;
   - errors;
   - no-coverage (R621).
5. **(NIT7) Strands.** A strand measured BEFORE the restart is re-run once, not skipped: the strand may have been the
   old tier's.
   - Today `strandedSkip` is recorded at step 1b', before the deploy. Across a lost database that skip is withheld
     until batch b's decision.
6. **(NIT9) Reporting.**
   - `resume-across-restart` is emitted AFTER the batch decisions (R969's rule: never claim a carry that did not
     happen). It names both generations and ids, and per batch `carried N survivors` or `re-run (why)`.
   - `resume-resolved.carryableCount` overstates it, and the text says so.
   - It is an EVENT only: no `SessionReport` field, so no regeneration of the sample reports.
7. **(NIT10) R959.** Its ruling is superseded in R959's own file when this lands: "carrying SURVIVORS across a lost
   database is allowed on equal apps plus an equal per-batch baseline; kills are re-run". Its reason (an app check
   cannot see company data) still holds for kills.

## (S4) Unmeasured premises: probe BEFORE any build

- **(a)** Does republishing the SAME `.app` on Linux BC give the same served-package hash (`hashPackage` zeroes only
  the NAVX id)?
- **(b)** Do the Microsoft and System bytes hash the same after `bc-linux-setup.ts` re-runs? That decides whether R496
  matches.
- **(c) Yield.** How many survivors of the about 2,800 voided PR-427 verdicts sit in batches with a usable prior
  snapshot? Their redo time against the kills' (counts and durations only).
- If (a) or (b) fails, nothing ever carries, and R1229 needs another basis. If (c) is small, the item is not worth
  building (principle 13).
- **(c) MEASURED (PR-427's stores, counts and summed `duration_ms` only):** each run is one batch with one stored
  snapshot. Survivors hold most of the redo time:

  | run | survivors | kills |
  |---|---|---|
  | edocs | 21, 110 min | 75, 32 min |
  | queue2 | 460, 257 min | 354, 22 min |
  | subs | 362, 229 min | 197, 22 min |
  | email | 248, 92 min | 264, 9 min |

  - So carrying survivors only keeps about 90% of the time a full carry would save, while kills stay re-run.
  - Errors are left aside: edocs' 36 errors cost 433 min, mostly at the 330 s cap, and are re-run in any case.
- (a) and (b) need a leased bc server and a real restart (a kraken operation). They are the first step of the build
  task.

## Red tests (for the build)

Both directions:
- **Generation + id changed:**
  - same apps and same baseline → survivors carried, kills re-run with the killer first;
  - one verdict, coverage entry or WorkDate differs → that batch re-run;
  - an app fingerprint differs → refused;
  - a missing id → refused.
- **Never carried:** degraded, lost or unattested rows, and errors, even when everything matches.
- **Each "re-run by name" case** of item 2.
- **Strands:** a prior strand is re-run, not skipped.
- **Ordering:** nothing of batch b is scheduled before its decision (a call counter).
- **R969 unchanged:** the same id carries as today.

## Gates (for the build)

- legs.ts for orchestrator.ts, resume.ts and store.ts.
- **A live leg:** restart a bc server mid-run, re-run `bc-linux-setup.ts`, then `--resume-run`. Per mutant against
  an uninterrupted run: carried survivors equal, kills re-scored equal. R1012's refusing leg is kept for a changed app.
