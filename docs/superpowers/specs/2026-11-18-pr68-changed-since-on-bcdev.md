# PR-68 pre-commitment (measure only): `--changed-since` on bcdev against a real DO change (R227's bcdev half)

Coord PR-68 (lethal-code, 2026-11-18). PR-112 measured `--changed-since` on al-runner v3 with three real DO pull requests (R227).
This task measures the bcdev half on `bc4` (BC 29 W1), where Continia Document Output 30 is installed (PR-67).

## Source: a real pull request, ported onto the installed DO 30
- **Why a port.** `/work/src/DO` (DO 30, the build on bc4) is shallow: one commit, no history. `/work/src/do-lethal` has history,
  but it is DO 28.4, with another file layout and another dependency set; publishing it over DO 30 would be a downgrade with a
  schema change. None of its pull requests apply to DO 30 by path.
- **The port.** Each file a do-lethal pull request changed is mapped to the DO 30 file that declares the same object (type and
  id). If the pull request's diff reverse-applies to that DO 30 file, DO 30 already holds the change unaltered.
  - **The range:** 14cc704 (one of PR-112's three). 5 of its 6 `.al` files reverse-apply; the 6th
    (`CDOeDocumentsDispatcher.Codeunit.al`) does not, since DO 30 changed it since, and it is left out.
  - **The private repository:** `/coord/handoff/PR-68/do-git`, a copy of PR-67's `do-app` (the tree installed on bc4) with two
    commits:
    - the base: DO 30 with those 5 changes reversed;
    - the head: the changes applied again.
  - **The check:** the head tree is byte-identical to `do-app` (`diff -r`), so the run publishes exactly the installed DO.
  - **The tool:** `/coord/handoff/PR-68/port.ts`. Nothing from DO is committed.
- **Sizes** (dry run, all operators):
  - changed: 80 mutants in 4 files (the change to `CDOSubscribers.Codeunit.al` is a pure deletion, so it adds no line);
  - full (`--only` the 5 files): 1,324 mutants.

## The runs (bc4, bcdev, one lease per run, from the task worktree, `--stop-hung-sessions`)
- **First, the v3 hang check** on the exact full scope (the rule since PR-34 stranded bc2): local v3, with the same test app and the same
  `--tests-only`. It must show 0 timeout-killed before any bcdev run; otherwise the hanging procedures are excluded from both
  arms, by name, before leasing.
- **Changed:** `lethal run --changed-since HEAD^` at the head.
- **Full:** `lethal run --only <each of the 5 files>` at the head, with `--allow-large-run`.
- **The same in both arms:**
  - the config: PR-67's `lethal.config.bc4.json`;
  - the test app: PR-67's `do-test-new`, as installed;
  - `--tests-only`: the test files that cover the 5 files in the v3 full run's coverage, fixed before the bcdev runs and recorded.
    Running the whole suite of 1,979 tests is avoided because one unrelated test hangs bc4's baseline (R1113).
  - fresh stores.
- **Restore after the last run:** DO is rebuilt at a version above the one the run prints, and published as an upgrade (README,
  "Restoring your app after a run").

## What is measured (the same checks as PR-112, by `check.ts`)
- **The cost:** wall time and deployed mutants, changed against full.
- **The selection:** every changed-run mutant is in the full run at the same file, line and operator. A full-run mutant is in the
  changed run if and only if its span shares a line with `git diff -U0 HEAD^ HEAD` (recomputed independently).
- **The verdicts:** per (file, line, operator), the verdict, `killingTest` and note fields of the shared mutants.

## Predictions (pre-committed)
- **P1, selection:** exact. 0 mutants are kept that touch no changed line, and 0 are dropped that touch one.
- **P2, verdicts:** identical on the shared mutants.
  - A difference is re-run singly on bcdev before it is called a defect, since a BC verdict can depend on test timing.
  - If it reproduces, a roadmap item is filed with the mutant ids, and R227 stays open.
- **P3, cost:** the changed run deploys a strict subset (80 of 1,324). Its wall time falls less than its mutant share, since the
  publish and the baseline are fixed costs.
- **If all hold:** R227's bcdev half is recorded as measured, and the roadmap item stays closed.

## Amendment 1 (2026-11-18, before any scored run): the hang-capable baseline, and a 4-file test set
- **What happened:** two baseline attempts on bc4 were quarantined by a DO test that never answered. Neither was in the scope:
  - the full arm (first try) on `CDO ABS Auth Settings Tests` (Azure);
  - the changed arm (second try, after the restart and with the Azure files out) on `StaleExpiryUpgrade_ClearsOnlyTheCurrentCompany`.
  - Each quarantine costs an owner restart (sql then bc) and a full republish.
  - The first changed arm (`changed-v1`, 105 files, 1,839 tests) completed. It is kept as a reference and is not one of the scored
    arms.
- **The test set for both arms:** the 4 test files that declare a test covering or killing any changed mutant in BC's own
  `changed-v1` report (`/coord/handoff/PR-68/tests-only-v3.txt`):
  - `CDODuplicateEDocSendGuardTests`;
  - `CDOSendonPostingTests`;
  - `CDOServicePostingTests`;
  - `CDOFunctionsTests`.
  - Fixed before both arms run. Both arms use the same set, so P1-P3 compare like with like.
  - Full-arm mutants covered only by other files read as no-coverage or survived in the full arm, the same in both arms where
    they are shared.
- **P1-P3 unchanged.** The v3 hang check of the full scope stands (`v3full`).