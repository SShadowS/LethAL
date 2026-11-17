# PR-112 pre-commitment (measure only): `--changed-since` on al-runner v3 against real DO pull requests (R227's v3 half)

Coord PR-112 (lethal-code, 2026-11-17). R227 landed `--lines` and `--changed-since`. Its "Not measured live yet" is the open
part: no run has exercised the flag on a real change. This task measures it on v3, offline. The bcdev half is PR-68, which waits
on PR-67's bc4.

## Source
- **The repository.** `/work/src/do-lethal` is DO's own repository (679 commits, not shallow; pinned at 5f2a71d), read-only, no
  fetch. `/work/src/DO` and `/work/src/DC` are shallow (1 commit), so they hold no history to take ranges from.
- **The private clone.** A local clone (`git clone --no-hardlinks`, which reads only the local repository) goes in
  `/coord/handoff/PR-112/do-git`. All checkouts are made there. Nothing from it is committed.
- **The ranges.** 2 or 3 "Merged PR" commits from do-lethal's main line, each a squashed pull request changing 2-8 `.al`
  files under `Cloud/`. The candidates, newest first: 5f2a71d (5 files), 735fb42 (5), 14cc704 (6), 9d4491a (2).
  - A candidate is used only if, checked out at the commit, `Cloud` and the test project compile on the pinned v3 build with
    R-942's symbols. Otherwise the next candidate is tried.
  - Which were used, and why any were skipped, is recorded.

## The runs (per range; local v3, fresh stores, `--workers 1`, through heavy-slot)
- **Changed:** `lethal run --changed-since <commit>^` at `<commit>`.
- **Full:** `lethal run --only <each .al file the commit changed>` at the same commit.

Both use the same config (`/coord/handoff/PR-67/v3.json` or R-984's `v3.do-serve.json`), the same flags, and the same test
project.

## What is measured
- **Wall time** and the mutants deployed, changed against full.
- **The selection, per mutant:**
  - every mutant of the changed run is in the full run, at the same file, line and operator;
  - every full-run mutant whose span shares a line with the diff's ranges is in the changed run;
  - every one that does not share a line is not.

  The check uses the diff of `git merge-base <commit>^ <commit>` against `<commit>` (the flag's own definition), recomputed
  independently from `git diff -U0`.
- **The verdicts.** Each changed-run mutant's verdict, `killingTest` and note set equal the full run's (`scripts/report-diff.ts`,
  restricted to the changed set).

## Predictions (pre-committed)
- **P1, selection.** The selection is exact: 0 mutants kept that touch no changed line, and 0 dropped that touch one.
- **P2, verdicts.** The kept mutants' verdicts are identical to the full run's (R227's post-dedup argument).
- **P3, cost.** The changed run deploys a strict subset, and its wall time falls roughly with the mutant count, plus the fixed
  baseline.
- **If P1 or P2 breaks,** a roadmap item is filed with the mutant ids, and R227 stays open.
- **If all hold,** R227's "not measured live" becomes "measured on v3 (PR-112)", and the bcdev half stays open for PR-68.
