# R396 campaign manifest: al-runner old vs new defaults on a real app

**Status: NO RUN COMPLETED. Both runs are redone on the new machine.**

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
