# PR-66 pre-commitment: the "another instrumented tree" resume warning follows the snapshot the resumed run used

Status: pre-commitment (coord PR-66, lethal-code, 2026-11-16), before the build. Bug in PR-47's case (a) (addendum 2 of
`2026-11-16-pr47-t6-gotokey-keep-and-resume-warnings.md`). Evidence: DO window t8 (`/coord/handoff/R-984/t8.run.stderr.txt`,
`dos3.sqlite`).

## The cause, measured

`dos3.sqlite`'s `baseline_snapshots` hold batch 0 for runs 1-4, 6, 7 and 9, but **not run 8**. t7 (run 8) reused run 7's
snapshot and stored none of its own. t8 (run 9) resumed run 8 on a changed tree. Case (a) asks `snapshotBatchHash(8, 0)`, which
returns null, so no warning was emitted. The case addendum 2 was meant to name is exactly a resumed run that reused a baseline.

## The change

`snapshotBatchHash` (or a sibling the warning uses) returns the batch hash of the latest snapshot for this batch index **at or
before** the resumed run, with the same exclusions `findBaselineSnapshot` applies (suspect snapshots, lost batches). That is the
snapshot the resumed run itself ran on, or reused. The warning's text names that snapshot's run: "run N stored batch B's baseline
for another instrumented tree (the emitted AL changed)", where N is the snapshot's run and the resumed run is named beside it.
Every other path is unchanged: lend/RL's warning set is still not touched (its miss is a new server generation, same tree).

## Predictions
1. Unit tests, red both ways:
   - a resume of a run that reused an earlier run's snapshot, onto a changed tree, warns and names both runs;
   - the same resume onto the SAME tree does not warn;
   - a suspect snapshot is not used.
2. `itest:lend` is not on the path (no gate's warning set moves); `itest:alrunner-v3` passes.
3. DO's next window that changes the tree names the non-reuse.
