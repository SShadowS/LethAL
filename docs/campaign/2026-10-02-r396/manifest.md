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
