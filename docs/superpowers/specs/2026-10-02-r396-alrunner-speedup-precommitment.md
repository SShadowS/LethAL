# R396 pre-commitment: the R-387 al-runner speed-up on a real app

Committed before any measured run. Task: `H:/lethal-coord/tasks/R-396/task.md`. Roadmap:
`docs/roadmap/R396.md`.

## What is fixed before the runs

| Item | Value |
| --- | --- |
| Project | Continia Document Output, `U:/Git/do-lethal-53470`, commit `166e2fd6` (detached, clean). App `Cloud` (572 `.al` files, version 29.0.0.0), tests `Test`. |
| Working copy | A scratch copy of `Cloud` and `Test`, made fresh before run (i). The ONE change: CDO's own compiled `.app` is deleted from the copy's `Test/.alpackages`, because otherwise al-runner refuses to start with `FATAL: duplicate app id f4b69b55… loaded at two different versions`. No source file is changed. All three runs use the SAME copy. |
| al-runner | The pinned build `H:/al-runner-builds/c39ad5de/al-runner.exe`. Each run's log starts with its `--version`, which must print `al-runner v2.12.0-main.c39ad5de`. |
| packagesDir | The copy's `Test/.alpackages`. |
| Scope | `--only src/Features/Recipients/CDORecipientMgt.Codeunit.al --tests-only <RecipientMgtTests>`, identical in every run. |
| Run (i), OLD | `alRunner: { alRunnerPath, packagesDir, serverMode: false, selectorMode: "static" }` |
| Run (ii), NEW | `alRunner: { alRunnerPath, packagesDir }`, the R-387 defaults |
| Run (iii), optional | NEW plus `coverage: "al-runner"`, for R394 sizing only |
| Order | (i), then (ii), then (iii), one at a time on this machine. |

**Why this scope.** The whole app is 41,352 deployed mutants, which is not feasible. That is an
estimate: about 36 days on the new path and years on the old one (see "Estimates"). I chose
`CDORecipientMgt` over the other two candidates for three reasons:

- its test codeunit has 21 tests, all green in a whole-suite al-runner probe;
- it opens no `TestPage`;
- its old-path cost has the smallest estimated range, 1.6 to 5.3 h.

`--tests-only` can change a verdict. But the narrowing is identical across the runs, so per-mutant
comparison between them stays valid. Each report flags itself `tests-narrowed`.

The exact `--tests-only` value is the qualified name of the RecipientMgtTests codeunit, copied from
the dry-run listing. It is written into the run log, and it is the same string in every run.

## Gates (each run, before any number is read)

1. **Cardinality:** exactly **63** deployed mutants in the report. That number comes from the
   offline dry run's per-file `deployed=` count for this file, re-read with `--only` immediately
   before run (i). A different count stops the campaign before run (ii), and the dry-run number is
   recorded beside the report's.
2. **Baseline green:** all 21 tests in the narrowed set are green at baseline in every run (no
   `baseline-red` caveat).
3. **Coverage mode:** `coverageMode: "none"` in runs (i) and (ii). In run (iii) it is
   `"al-runner"`; R383 measured that the multi-object guard refuses 0 CDO files.
4. **Build:** the `--version` line equals `al-runner v2.12.0-main.c39ad5de` in every run.

## The expectation

**(i) against (ii): per-mutant verdicts IDENTICAL.** `bun scripts/report-diff.ts old.json new.json`
must print IDENTICAL and exit 0. Any difference is a FINDING: it is reported, never explained away,
and the R-387 claim "verdicts do not move" is then false on a real app.

**(ii) against (iii):** no verdict expectation is pre-committed. Coverage is expected to move
unreached mutants from `survived` to `no-coverage`, and the size of that move is the R394 number
being measured. Coverage must never turn a `killed` mutant into anything else. Run (iii) tests that
against (ii): a killed mutant that changes is a finding.

## What is measured (and how)

- **Wall time per run:** `SessionReport.timings.totalMs`, plus the shell's own wall clock around
  the command.
- **Phase times:** `timings.deployMs`, `timings.baselineMs` and `timings.mutantsMs`.
- **Per mutant:** `timings.perMutant`, with its count, mean, median, p95 and max.
- **Compile count and compile time.** The report carries neither, so they are read from al-runner's
  stderr, captured to the run log: a `[layered] WROTE … (<ms>)` line is a compile, and `cache HIT`
  is a reuse.
  - **Expected by construction:** about one compile per mutant on the static selector, and one per
    session on the resource selector.
  - **This is NOT a machine-checked gate.** The tool cannot derive it from the report, and it is
    named here so that a clean exit is not read as "every expectation passed".

## Estimates, stated now, not gates

These are from cheap probes on the copy, not from full runs.

| Run | Estimate | Why |
| --- | --- | --- |
| OLD | 1.6 to 5.3 h | About 91 s per mutant (one invocation after a source edit), plus about 10.5 s for each further test the mutant runs. A survivor runs all 21. |
| NEW | about 1.3 h | About 75 s per mutant. |

**Hypothesis behind the NEW estimate:** the `--server` path sends the whole test directory per
mutant (`ensureServerSuite` sends `[activeDir, testDir]`), so `--tests-only` would not shrink a
mutant's run there.

**The expected speed-up is therefore only about 1.2x to 4x, not the fixture's 5.7x.** If the
measured NEW per-mutant time is near the whole-suite time (tens of seconds) rather than near the
21-test time, that confirms the hypothesis. It then gets filed as a roadmap item after the run,
with the measured numbers. If it is not confirmed, that is recorded as a negative result (Rule 5).

## Stop rules

- **Run (i) runs longer than 10 h:** it is stopped. A partial run is NOT compared. The result is
  recorded as "old path did not complete within 10 h on this scope", with the verdicts recorded so
  far, and the campaign ends there.
- **A gate fails:** the campaign stops, and the failing run's report and log are kept as evidence.
- **al-runner FATALs or quarantines a mutant:** the run is recorded as is. A resumed run is NOT
  used for the comparison.

## Reporting

- **Committed:** the reports go under `docs/campaign/2026-10-02-r396/`, together with a
  `manifest.md` naming every row of the table above. Each report is first passed through
  `bun scripts/redact-campaign-report.ts <report.json>` and then `--check`; this repo is public.
- **Not committed:** the run logs (al-runner stderr) hold source paths only and are kept in the
  scratch folder `C:/Users/SShadowS/AppData/Local/Temp/claude/r396/`. Only the compile counts taken
  from them are written into the manifest.
- **R396.md** gets the numbers and closes as `done (<commit>)` once (i) and (ii) have run, whatever
  the result. A FINDING is filed as its own item.
