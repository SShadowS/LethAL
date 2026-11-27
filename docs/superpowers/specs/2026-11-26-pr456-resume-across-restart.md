# PR-456 (R1229): carry decided SURVIVORS across a BC restart that lost the database — design r3 (no build)

lethal-code, 2026-11-26.
- **r1** was 657e6ad70: it carried every verdict on equal apps plus an equal per-batch baseline.
- **r2** (2fd48a4bc, 930aa973a) answers its spec-adversary: BLOCKs 1-2, SHOULDs 3-6, NITs 7-10, marked "(B1)" and so
  on.
- **r3** answers the delta review (D1-D7). Its "r3 changes" section overrides any r2 text it contradicts.

## Probe results so far (lethal-bugs, 2026-11-26, `/coord/handoff/PR-456/probes/result-2026-11-26.md`)

- **(a) PASS on real data.** `test_app_hash` was `package:81bf16f5…` in all five PR-427 stores, across two bc4
  restarts, with the same `.app` files republished each time.
- **(b) FAIL.** `test_app_deps` differed after EVERY restart (63d9c6c0 → 549e8f02 → 0e18165d), with identical
  dependency files.
  - **The cause, read from the source.** `dependencyFingerprint` (`digest-inputs.ts`) hashes RAW served bytes for two
    kinds of line: `P <sha256(System package bytes)>`, and `X <dep> <sha256(zip bytes)>` for every partner
    dependency.
  - Only the test app's hash normalises the served package (`hashPackage` zeroes the NAVX id). So a per-publish or
    per-database stamp in a served package changes the digest although the content is the same.
  - Only the final digest is stored, so which line moved is not known.
  - **Consequence:** R496's check, as built, is NOT restart-stable, so it would refuse every carry. R1229 therefore
    needs, as a PRECONDITION, a content-normalised dependency fingerprint, with `hashPackage`'s rule applied to the P
    and X lines.
  - Next measurement: download the System and partner packages twice across a restart and diff them. The diff names
    the field that moves; normalise only that field, then re-run (b).
  - Normalising more than the measured field would weaken R496 for every run. It is not done blind.
- **(d) not yet measured.** No two stores share a batch hash with a stored baseline on both sides (email2 was paused
  before its snapshot). It runs on the next restart.

## r5 (PR-468's spec review against today's code; overrides r4 and r3 where they differ)

1. **(BLOCK) Strands stay skipped, exactly as today (D1).** "The new branch" item 5 and the red test "a prior strand
   is re-run, not skipped" are VOID.
   - The red test instead: a prior `quarantined:` row outside a degraded window, then a generation and id change →
     still skipped at step 1b'.
2. **The same server only.** The new branch also requires `prior.resourceKey !== null && prior.resourceKey ===
   current.resourceKey`. Otherwise it refuses as today: a run on bc1 is never carried onto bc2 "across a restart".
3. **`known-survivor` does not carry in restart mode.** Only `survived` does. History (`priorSurvivorKeys`) still
   lends as today.
4. **Rows carry their batch.**
   - `batchIndex` is threaded into `MutantVerdictRow` and `CarriedVerdict`.
   - A survivor carries only if `snapshotBatchHash(prior, row.batchIndex)` equals the hash of the snapshot that was
     compared equal. Otherwise it fails loudly (a caller-contract violation), never carries.
5. **The compare site:** inside `scoreBatch`, after `baseline-batch-finished`, the R955 `budget-in-baseline` return,
   the R139 refusal and R738/R740, and BEFORE `input.select(...)`.
   - In restart mode `allowReuse = false`, so every batch has a FRESH baseline to compare.
   - A new store query finds the prior snapshot by (run, batch hash). It follows the PR-66 reuse row, returns the
     payload, and applies the suspect, lost and degraded exclusions.
   - `ScoreBatchInput.select` gets the decision (carry allowed for this batch, or the named reason).
6. **Equal, made exact:**
   - the batch-level `commonWorkDate` is present on both sides and equal;
   - per test, a WorkDate missing on BOTH sides for a `skip` is equal, and a one-sided absence differs;
   - coverage is compared as the whole stored `CoverageMap` (entries as a SET, plus granularity, `overloadIndex`
     and `namingGaps`).
   - **Before the live leg,** the build's OWN compare function is run over the two stores of probe (d) (email3 run 1
     against bugs' after-restart run) and must say EQUAL.
7. **The offline prediction, now from an INDEPENDENT oracle** (`/coord/handoff/PR-468/split.ts`, counts only):
   - **The oracle's rules:** R646 as documented (a non-empty faced set containing every covering test, the
     baseline's refused skips left out); identity by (ast_hash, codeunit, procedure, operator, identity_ordinal); a
     kill is seedable when the killer METHOD matches exactly one covering test, it reproduced, and it has no
     ledger-order note.
   - **On email3 run 1: 300 of 300 survivors CARRY; 302 of 302 kills are SEEDABLE.** Re-run: 256 errors. The 1,015
     no-coverage are recorded as no-coverage, 0 executed.
   - **The build's check:** an offline harness runs the BUILT decision code (the resume index plus the restart
     branch) over a read-only copy of email3's store, with the batch declared equal and the apps declared matching.
     It must give carried = 300 and seeded = 302. Each difference is explained by name before merge, or it is a
     BLOCK.
   - The repo fixture tests use invented shapes, one case per filter: R646, refused tests, the batch gate,
     `known-survivor`, degraded or lost rows, and a slowdown-note window.
8. **The caveat `resumed-across-restart`, the full ripple:**
   - a fold accumulator and a `buildReport` input, DERIVED from carried-across-restart rows, not from the warning code;
   - `EXPLAIN_SCHEMA_VERSION` 35 → 36, keeping the frozen `schemas/explain-v35.schema.json`, adding v36, a row in
     `schemas/README.md`, and the history in `explain.ts`;
   - the pinned caveat enum in `schemas.test.ts`;
   - `generate-schemas` (report-v3);
   - `CAVEAT_INTERPRETATIONS`, with the counts in `interpretation.test.ts` (39 → 40) and `report.test.ts`;
   - `docs/using-lethal-from-an-agent.md` (the caveat list, and R680/R969's "a different id refuses" paragraph).
9. **The label survives a later resume.** A run that carried across a restart records a flag on its run row. A
   resume of THAT run sets the caveat too.
10. **The refusal side, updated:**
    - R680's tests in `orchestrator.test.ts`, the `ServerGenerationChangedError` text and `resume-reusing-run`'s
      restart-mode wording;
    - a superseded note in R1012 and R959;
    - CHANGELOG.
    - A re-run kill that is seeded and then killed live counts once in R197's ledger: the seed is skipped when the
      same kill is recorded live.

## r4: the build pre-commitment (PR-468, 2026-11-27)

- **The GO conditions now hold:**
  - **(a) PASS** across three restarts.
  - **(b) passes on master** since PR-457 (ed39f0203): System is hashed by CONTENT (`P content c1:`). On the
    2026-11-27 restart, 21 of 22 packages were byte-equal and System was content-equal (486/486). The partner `X`
    lines still hash bytes, and they were byte-equal.
    - A prior run recorded by a client BEFORE PR-457 has the raw-bytes `P` line, so its `test_app_deps` differs and
      the resume REFUSES as today, by name. That is fail-closed and stated, not migrated.
  - **(d) PASS:** batch 16cdc30fedce, 667/667 tests equal on outcome, WorkDate and coverage across the restart
    (`/coord/handoff/PR-456/probes/result-2026-11-27.md`, compare v2).
  - **(c)** was measured in r2.
- **Since r3:** R1228's slowdown STOP (PR-466, held) writes the SAME `degraded_windows` row. So "never carry from a
  degraded window" covers a slowdown window with no extra code. A test pins it with a window whose note is a
  slowdown's.
- **Verdict evidence (bugs, Email scope):** 766 of 766 covered verdicts equal across restarts #1-#3. The one
  difference was a confirm budget error that re-scored killed, by the same killer.
- **The build is r3 exactly:** items 1-4, 6 and 7, with r3's D1-D7. Item 5 is deleted; strands stay skipped.
- **The offline prediction (pre-committed) on PR-427-shaped data:** email3 run 1 (`/coord/handoff/PR-427/email3`):
  one batch (16cdc30fedce) whose baseline probe (d) found equal.
  - It has 300 survived, 302 killed (all with a killing test), 256 error, 1,015 no-coverage, 0 strands and 1
    snapshot.
  - **A resume across a lost database, with equal apps** (in a fixture, the apps check is satisfied), must carry
    EXACTLY the survivors that pass R646 (a non-empty faced list covering every covering test). That is ≤ 300; the
    exact count is the R646 predicate over the stored rows, computed by the test's oracle, not by the code under
    test.
  - It must re-run all 302 kills, each with its stored killer seeded first, plus all 256 errors and all 1,015
    no-coverage.
  - Any other split is a BLOCK.
  - The fixture is built from the store's COUNTS and shapes (invented ids and names). No DO text enters the repo.
- **The live end-to-end leg:** a scoped bcdev run on a leased bc server, then a restart, then
  `bc-linux-setup.ts`, then `--resume-run`.
  - The restart is the OWNER's (a kraken ask, `--kind bc-restart`).
  - Its pre-commitment names at least one carried survivor and at least one re-run kill by mutant id, read from that
    run's own store BEFORE the restart (D5).

## r3 changes (delta review)

- **(D1, BLOCK) Item 5 is DELETED. Strand skipping stays exactly as it is today.**
  - A healthy-tier strand is a real measurement of a mutant that hangs. Re-running it after the restart it causes
    would bring back R53/R201's endless resume: it hangs, the tier is restarted, the database id changes, it is
    re-run, it hangs again.
  - A strand skip is already fail-closed: `error`, nothing scored, nothing carried.
  - `--retry-stranded` stays the opt-in, and R1227 already re-runs strands inside a degraded window.
  - Red test: a prior `quarantined:` row outside a degraded window, then a generation and id change, is still skipped.
- **(D2) The yield in S4(c) is a CEILING.** Each PR-427 run was one batch, so its carry is all or nothing.
  - **New probe (d), a GO condition next to (a) and (b):** for batch hashes that have snapshots in two server
    generations (PR-427's voided runs and their redos), count how many pass item 2's exact rule. Counts only.
  - PR-427's coverage mode was checked: `fenced` in all four runs, not hub mode, so the table applies.
- **(D3) The label reaches the report reader: a new caveat, `resumed-across-restart`,** set when any batch carried
  across a lost database.
  - It says: the survivors were measured on the earlier database; equality was checked on the unmutated baseline
    only; kills were re-run.
  - It corrects the `resumed` caveat's claim that the exposure is "the same as every run's".
  - It needs `CAVEAT_INTERPRETATIONS`, the counts in `interpretation.test.ts` and `report.test.ts`, and the schema
    enum. No new `SessionReport` field, no sample regeneration.
- **(D4) `resume-across-restart` is emitted ONCE PER BATCH, at that batch's decision,** like `resume-baseline-reused`.
  A run stopped mid-way still names each batch that carried.
- **(D5) The live leg cannot pass empty.** Its pre-commitment names at least one carried survivor and at least one
  re-run kill, by mutant id. It allows differences in `killingTest` alone, because seeding the prior killers gives an
  order no other run used (R197's allowance).
- **(D6) The re-run kills are seeded only through `isSeedableCarriedKill` and `carriedKillerRef`.** A
  `[ledger-order-survived]` kill is not seeded, as R1179 already does. A seeded killer moves no verdict: R577
  reproduction, and R1174's re-walk on bcdev.
- **(D7) Clarifications:**
  - item 3 carries `survived` only; `known-survivor` stays as today's R644 path;
  - "exactly equal" compares coverage entries as SETS, not in array order;
  - under `coverageMode: "none"` the coverage compare is empty against empty, which is safe because only survivors
    carry. It is stated, not left implicit.
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
