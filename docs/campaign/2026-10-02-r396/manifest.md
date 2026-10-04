# R396 campaign manifest: al-runner old vs new defaults on a real app

**Status: (i) and (ii) COMPLETED on 2026-10-04 in the kraken container; per-mutant verdicts IDENTICAL.**
Run (iii) (optional) also completed. Results are in the section "Results, 2026-10-04" below. The
"What happened on 2026-10-02" section is old-machine history only.

The pre-commitment `docs/superpowers/specs/2026-10-02-r396-alrunner-speedup-precommitment.md`
(commit `1527811f`) stays valid as written. It fixes the project, commit, scope, configs, gates and
expectation.

## What happened on 2026-10-02 (old machine)

- **The dry run passed its gate:** 63 deployed mutants for
  `src/Features/Recipients/CDORecipientMgt.Codeunit.al`.
- **Run (i) started** with the OLD defaults (`serverMode: false`, `selectorMode: "static"`) on the
  pinned `al-runner v2.12.0-main.c39ad5de`. Its warning line named all three slow settings, as
  designed.
- **Run (i) was stopped by owner ruling partway through:** about 35 of 63 mutants were scored after
  about 98 minutes, because development moved to another machine. The process tree (`lethal run`
  and its `al-runner.exe` child) was ended. No `lethal run` or `al-runner.exe` process was left.
- **The partial run is NOT a result.** Its report is not committed. Per the pre-commitment, a
  partial run is never compared. Runs (ii) and (iii) never started.
- **Timings do not carry over.** No timing from the old machine is used, because the comparison
  must be made on one machine, with both runs done one after the other.

## 2026-10-03, kraken container: run settings shared by every run

Recorded while run (i) is running, before run (ii) starts. The project is now CDO at `5f2a71d`
(addendum 2 of the pre-commitment, `678754ae`). Every run, (i), (ii) and (iii), uses EXACTLY these
settings, so the comparison is like for like:

- `--selector-id 6175460 --control-id 6175459 --table-id 6175458` (restart step 3 below). Run (i)'s
  first attempt passed no ids and was refused before measuring anything (`selector id out of
  range`: the default 79199 is outside CDO's idRanges 6175271-6175468); it was restarted with these
  ids. In `5f2a71d` no codeunit or table uses them (page 6175460 exists; AL numbers each object type
  separately).
- `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al` (relative to `Cloud`) and
  `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al` (relative to `Test`).
- packagesDir `/work/lethal-wt/cdo-r396/Test/.alpackages` (the 17 packages pinned in addendum 2),
  al-runner `/opt/al-runner/c39ad5de/al-runner`.
- The configs differ ONLY in the keys the pre-commitment names: (i) `serverMode: false`,
  `selectorMode: "static"`; (ii) neither key (the defaults); (iii) as (ii) plus
  `coverage: "al-runner"`.

## To redo on the new machine (all from the pre-commitment)

1. **Make the scratch copy.** Copy `Cloud` and `Test` of Continia Document Output at commit
   `166e2fd6`. Delete ONLY CDO's own compiled `.app` from the copy's `Test/.alpackages`. Without
   that, al-runner refuses with `FATAL: duplicate app id f4b69b55… loaded at two different
   versions`. Prove that no `.al` file changed with a sha256 listing.
2. **Use the pinned al-runner build:** `v2.12.0-main.c39ad5de`, or record the build used if the new
   machine has another. A different build is a deviation from the pre-commitment, to be stated
   before the run.
3. **Pass the selector ids.** The old machine's run used `--selector-id 6175460 --control-id 6175459
   --table-id 6175458`, chosen outside CDO's id ranges.
4. **Set the scope:** `--only src/Features/Recipients/CDORecipientMgt.Codeunit.al --tests-only
   src/Features/Recipients/CDORecipientMgtTests.Codeunit.al`.
5. **Run (i) OLD, then (ii) NEW, then optionally (iii)** NEW plus `coverage: "al-runner"`. Run them
   one at a time, with the machine load recorded before each.
6. **Run the checks in the pre-commitment:**
   - the gates;
   - `bun scripts/report-diff.ts` on (i) against (ii), which must print IDENTICAL;
   - each mutant ran the SAME test set in (i) and (ii);
   - compile counts from al-runner's stderr.
7. **Redact each report** with `bun scripts/redact-campaign-report.ts`, then `--check`, before
   committing.

## Known risk, from the estimate (not measured)

The `--server` path may send the whole test directory per mutant (`ensureServerSuite`), so the
expected speed-up on CDO is about 1.2x to 4x, not the fixture's 5.7x. The pre-commitment states this
as a hypothesis for run (ii) to settle.

## Results, 2026-10-04 (kraken container)

**Read this first.** These figures describe Continia Document Output at `5f2a71d` (2026-07-07, app
28.4), not the current product. They are a new baseline from the kraken container (32 cores) and
are not comparable with any old-machine figure.

**Setup, the same in all three runs**
- LethAL code: `678754ae`. No code changed between the runs; later branch commits were docs only.
- al-runner `v2.12.0-main.c39ad5de` in every run (its own banner: BC 28.5.54151.55132).
- Selector ids 6175460 / 6175459 / 6175458 in every run.
- Gates: all four PASS in every run. Build line OK; 63 mutants deployed from 65 sites, in 1 of 554
  files; baseline 21 of 21 tests green; `coverageMode` none in (i) and (ii), al-runner in (iii).
- Start deviations (recorded above): run (i) attempt 1 was refused on the default selector id. The
  offline `alc` compile of `Cloud` fails on the `app.json` logo backslash (R422), but al-runner
  deployed the UNPATCHED copy fine (deploy took 0.4 s), so no patch was made.

**Verdicts (checked first)**
- (i) OLD defaults: killed 51 / survived 12 / no-coverage 0 / error 0. Score 81.0%.
- (ii) NEW defaults: the same counts.
- `bun scripts/report-diff.ts` on (i) against (ii): 63 against 63 mutants, 0 differences,
  IDENTICAL. Also identical per mutant: the covering-test set (all 21 tests, for all 63 mutants),
  `killingTest` (0 differ) and the runner (fenced). No timeout or deadline fired in either run.
- So R-387's claim that verdicts do not move holds on this app.

**Timings.** They carry machine-load noise: other sessions ran test suites on the same 32 cores.
The 1-minute load average, noted every 10 minutes, ranged 0.9 to 11.6 in (i), 2.3 to 10.1 in (ii)
and 1.9 to 4.7 in (iii).

| Run | Total (report) | Shell wall | Baseline | Mutants phase |
|---|---|---|---|---|
| (i) OLD | 9828.3 s | 9982 s | 285.0 s | 9048.9 s |
| (ii) NEW | 3460.9 s | 3512 s | 114.0 s | 12767.6 s (sum of concurrent per-mutant time) |
| (iii) NEW + coverage | 3709.2 s | 3745 s | 129.9 s | 4518.0 s (59 mutants run) |

Wall-time speed-up, (i) to (ii): **2.84x**. The ratio carries the load noise; treat it as a rough
figure, not a precise one.

**Per mutant.** (i): mean 143.6 s, median 101.6 s, p95 273.0 s, max 283.5 s. In (ii) the per-mutant
durations OVERLAP: they sum to 12767.6 s, more than the 3460.9 s total, and overhead shows 0.0. So
(ii)'s mean 202.7 s, median 58.5 s, p95 647.8 s and max 689.0 s are NOT comparable with (i). Only
the wall totals compare.

**Hypothesis: UNDETERMINED.** The pre-commitment said that if NEW per-mutant time is near the
whole-suite time, the `--server` path sends the whole test directory. That cannot be read from
these reports, because the per-mutant times overlap. It is neither confirmed nor refuted.

**Compile count and compile time: NOT MEASURED.** LethAL consumes al-runner's stderr (the
`[layered] WROTE` and `cache HIT` lines), so it never reaches the run log. `~/.cache/al-runner` is
shared by every session on the machine, so cache file counts cannot be attributed to one run. This
was not a checked gate (the pre-commitment says so). Run (ii) was deliberately not changed to
capture it: a separate cache would have made (ii) cold, unlike (i).

**Run (iii), coverage on (optional, pre-committed in `1527811f` as R394 sizing)**
- `report-diff` of (ii) against (iii): 4 differences, all `survived` to `no-coverage`
  (`coverageFiltered` false to true). All four are in procedure `ShowRecipientsSetup`, the one
  procedure with 4 survivors and 0 kills: the narrowed tests never reach it.
- Killed 51 to 51 and `killingTest` identical for all 51. The pre-committed check (coverage never
  changes a killed mutant) PASSES.
- (iii): killed 51 / survived 8 / no-coverage 4. Score 86.4%. 59 mutants were executed.
- Coverage narrowed each mutant's tests to 0, 5, 10 or 15 of the 21.
- For R394: on this scope coverage reclassified 4 of 12 survivors (33%) and skipped 4 of 63
  mutants. Wall time was 3709.2 s against 3460.9 s for (ii): no saving here (within load noise).
- The multi-object guard did not refuse coverage (`coverageMode` al-runner was recorded).

**Committed files** (each redacted with `bun scripts/redact-campaign-report.ts`, and each passed
`--check`):
- `run-i-old.report.json`
- `run-ii-new.report.json`
- `run-iii-cov.report.json`

The run logs are not committed: they hold paths and test output.

Machine: kraken container, 32 cores.
