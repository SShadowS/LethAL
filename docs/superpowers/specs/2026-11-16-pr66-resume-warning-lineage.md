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

## Addendum 1 (2026-11-16, after the Opus build review, before any gate)

**"The latest snapshot at or before the resumed run" is a guess, and it can be wrong.** A run stores no snapshot for other reasons
too: an aborted or partial baseline, a stopped test, isolation, or a snapshot dropped on a lost lease. The guess also ignores the
filters `findBaselineSnapshot` applies (scheme, coverage mode, test app, dependencies, generation). Resuming such a run with
nothing changed would warn, falsely, that the tree changed and that the run reused an earlier snapshot.

**The change now records the lineage.** When a batch's baseline is reused, the store records it in a new table
`baseline_snapshot_reuses(run_id, batch_index, from_run_id, from_batch_index)`. The warning compares with the resumed run's own
snapshot, else with the snapshot it recorded reusing (suspect and lost excluded), else nothing, which stays silent. No guessing
by run order.

A store written before this change holds no reuse rows. So t8's exact case (run 8 reused run 7, recorded nowhere) stays silent in
that store; the warning names it from the next window on.

**Predictions, replacing 1:** red both ways:
- a resumed run that recorded a reuse, onto a changed tree, warns and names both runs;
- a resumed run that stored nothing and reused nothing (an aborted baseline), with an earlier run on another tree, is silent;
- the same tree reaching the branch (findBaselineSnapshot misses on another filter) is silent;
- suspect and lost snapshots are not followed.
