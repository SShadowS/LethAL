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

## Addendum 2026-10-03: the runs move to the kraken container

Written before any measured run. No run completed on the old machine (see
`docs/campaign/2026-10-02-r396/manifest.md`); both runs are redone, from the start, inside the
kraken container (Linux). What changes, and what does not:

- **Timings are a new baseline.** Every time measured in the container stands alone. It is NOT
  compared with the estimates above (1.6 to 5.3 h OLD, about 1.3 h NEW, 91 s and 75 s per
  mutant), which came from probes on the old Windows machine. Those estimates stay as written, as
  a record of what was expected there; they are not a gate and not a reference for the new
  numbers. The only timing comparison this campaign makes is between runs (i), (ii) and (iii),
  all on the same machine.
- **al-runner:** the same pinned source build, `c39ad5de`, now the Linux binary
  `/opt/al-runner/c39ad5de/al-runner`. Each run's log still starts with its `--version`, which
  must print `al-runner v2.12.0-main.c39ad5de`.
- **Project:** the same Continia Document Output commit, `166e2fd6`, read from a checkout under
  `/work/src` once the owner has placed it there. The working copy is made from it exactly as
  above (the one change is deleting CDO's own `.app` from `Test/.alpackages`).
- **Scratch:** the run logs go to the session's scratch folder in the container instead of
  `C:/Users/SShadowS/AppData/Local/Temp/claude/r396/`. They are still not committed.
- **Unchanged:** the scope, the three configs, the gates, the verdict expectation (per-mutant
  IDENTICAL between (i) and (ii)), the stop rules and the reporting rules.

## Addendum 2, 2026-10-03: the project is CDO at 5f2a71d, not 166e2fd6

Written before any measured run. Commit `166e2fd6` is not available in the container. The owner
provided a different copy on purpose, and the orchestrator ruled (2026-10-03) to pin it instead of
asking for `166e2fd6`. The verdict expectation ((i) against (ii): per-mutant IDENTICAL) does not
depend on which commit is measured, because both runs measure the same tree.

**What the figures describe.** Every figure from these runs describes Continia Document Output at
`5f2a71d36215a83fa4a554de90637f151521feb5` (2026-07-07, app version 28.4.0.0), NOT the current
product and NOT `166e2fd6`. They are a new baseline on the kraken container. The result says this
again.

**Where the re-derived numbers come from.** Only from the OFFLINE dry run (`lethal run --dry-run`),
which lists and counts mutants and runs no test. Nothing from a timed or scored run feeds back into
this addendum.

| Item | Was (166e2fd6) | Now (5f2a71d) |
| --- | --- | --- |
| Source | `U:/Git/do-lethal-53470` | `/work/src/do-lethal`, branch `lethal/campaign-2026-08-03`; working copy = a detached git worktree at `/work/lethal-wt/cdo-r396`, clean. No source file is changed. |
| App | `Cloud`, 572 `.al`, 29.0.0.0 | `Cloud`, 554 `.al` (417 outside `.dependencies`, 137 under `Cloud/.dependencies/`, git-tracked and inside LethAL's and alc's scope), 28.4.0.0 |
| Scope `--only` | `src/Features/Recipients/CDORecipientMgt.Codeunit.al` | `.dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al` (relative to `Cloud`; codeunit 6175295 "CDO Recipient Mgt.") |
| Cardinality gate | 63 deployed | **63 deployed** (65 raw sites, 1 batch, nothing in `notInstrumented`), from the dry run on 5f2a71d. The gate still re-reads it with `--only` immediately before run (i). |
| `--tests-only` | "the qualified name, copied from the dry-run listing" | Correction: `--tests-only` takes a path GLOB matched against the test file, and the dry run lists no tests. The value is `Src/Recipients/CDORecipientMgtTests.Codeunit.al` (relative to `Test`; it holds only codeunit 68933 "CDO Recipient Mgt. Tests", 21 `[Test]` procedures). Same string in every run. |
| packagesDir | the copy's `Test/.alpackages` minus CDO's own `.app` | `/work/lethal-wt/cdo-r396/Test/.alpackages`, the 17 packages below |
| al-runner | (addendum 1) | `/opt/al-runner/c39ad5de/al-runner --version` prints `al-runner v2.12.0-main.c39ad5de` (checked). |

**Packages, pinned.** The copy has no `.alpackages`. These 17 were downloaded from Cronus28's dev
endpoint (under coord leases 002 and 003, released) with the bc-dev package download. The Continia
apps resolve at 28.5 (Core Internal Activation at 28.0) while CDO declares 28.4.0.0 as the
minimum; alc accepts that without a warning. **CDO's own app on Cronus28
(`Continia Document Output_28.4.20697.40267`, an earlier LethAL-instrumented publish) is
deliberately NOT in packagesDir**, as the original pre-commitment requires.

| Package file | sha256 |
| --- | --- |
| `Continia Software_Continia Connector App_28.5.0.336834.app` | `82487ec6ad0f2e5b105aecdd4b09060898e69f49a7cc6ada06d88664fd8b3966` |
| `Continia Software_Continia Core Internal Activation App_28.0.0.218906.app` | `c57fb082a313d61c8e7b1b6811c9e220dd54af9916e7d9999ad5ea270f60d3b8` |
| `Continia Software_Continia Core_28.5.0.336883.app` | `8b09259ac3d5d7fb407c4aa64e4df2311293879b6cffa37abea414eaebafa52d` |
| `Continia Software_Continia Delivery Network_28.5.0.336910.app` | `922e59ea6d22746714a032fe548d9dd8520757f6f6d5c560f1c1b5622f34cf6f` |
| `Continia Software_Continia System Application_28.5.0.336834.app` | `5eee39f7f79dd7242e632c9bb3a8872870105618ac997f95fc2990ea6a0af7d4` |
| `Microsoft_Any_28.4.53241.53758.app` | `e08ef542779c8758a6c1780bc25cb804ae833d6967c77fc430b25d2729b2fe22` |
| `Microsoft_Application Test Library_28.4.53241.53758.app` | `cd619b16b502051041123a62f5c70629b98012f609328f2f1ff217f97b89ca6c` |
| `Microsoft_Application_28.4.53241.53758.app` | `6e80099c53b4395f0fe22c62dd03ae8acd0daea9c055160047efa43b43261470` |
| `Microsoft_Base Application_28.4.53241.53758.app` | `6859ff17baadb5d013927bf8eca849b8f60ca2d29fc8e7e75c4236d8a02817fd` |
| `Microsoft_Business Foundation_28.4.53241.53758.app` | `a5c6ad808ea9a7b5360e80605e459ffadd0d9c52b4b27c5e393abe1fc0ab9ad1` |
| `Microsoft_Library Assert_28.4.53241.53758.app` | `a6fe0dc8a0bedcf187752f47e049a5e15ec10dac5e543bbec8d1e278f10f6f43` |
| `Microsoft_Permissions Mock_28.4.53241.53758.app` | `40bc1261bb8edbdaa48818ce358634d3807199febb409c4d8a048c5f93e7585b` |
| `Microsoft_System Application Test Library_28.4.53241.53758.app` | `34b73dfd9e534cc3e73e53ee44af7e7bc4a4b3b3faa012554606543f8c096bed` |
| `Microsoft_System Application_28.4.53241.53758.app` | `a12a1cf3436d77938a5f6b15e8164a30a254bb268b762061be0da7e801ef3ec1` |
| `Microsoft_System_28.0.53667.0.app` | `ffa9cff0c111f5f469a5cb3dbe8e8bd22952c2c94281372c566458f09d8fb99c` |
| `Microsoft_Test Runner_28.4.53241.53758.app` | `0304659173ce0dcbc95792815a61a97a5dc1c31382f1059ef8daeb6ed2bcf29c` |
| `Microsoft_Tests-TestLibraries_28.4.53241.53758.app` | `4a928583106125a80db7bf48ccd23df4665b2806412e054b28313c6a6a838d9b` |

**Offline compile check (alc 18.0.41.45789, Linux; not a measurement).** `Test` compiles against
these 17 plus a `Cloud` build: exit 0, 0 errors. `Cloud` compiles with 0 errors ONLY on a scratch
copy whose `app.json` logo path uses `/` instead of `\` (`"Images\\Logo.png"`, which the Linux alc
reads literally: `AL1001`). That is a Windows-path problem of the Linux alc, not a symbol problem,
and the working copy is NOT patched. If a measured run fails on it, that is the "a gate fails" stop
rule: the run stops and the orchestrator is told before anything is patched.

**Unchanged:** the three configs (with the paths above), the four gates (cardinality now 63 from
5f2a71d), the verdict expectation, the stop rules and the reporting rules. The "Why this scope"
reasons and the estimates above were measured on `166e2fd6` on the old machine; they are history,
not a reference for these runs.
