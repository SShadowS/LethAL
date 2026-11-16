# R-984 DO window t10 pre-commitment: same build (edge-847b1fa5a), head 1b6ac882 (PR-66, PR-65, PR-57, PR-72, PR-73)

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master 1b6ac882. **al-runner: edge-847b1fa5a, pinned by
explicit path in `/coord/handoff/R-984/v3.do-serve.json` as in t1-t9.** The build move to edge-4ebfe7913 is NOT this window
(orchestrator 2026-11-16): a v3 verdict is lent only to the same build (R586, `backendBuildRefusal`), so `--resume` would find no run
and DO would restart from zero. The campaign finishes on 847b1fa5a first; one fresh-store window on the then-current build follows as a
per-mutant cross-build comparison, pre-committed on its own with PR-65's predicted moves. PR-74's keep entries are not on master
(4fff6ba0 is its pre-commitment only), so this window has none of them. `--resume dos3.sqlite`, `--time-budget 12600` under
`timeout --foreground -k 900 15300`, triage first, run.sh's watchdog, peak RSS from `/usr/bin/time -v` (`t10.run.time.txt`). It never
runs beside PR-75's BaseApp baseline.

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-t9.txt` vs `dry-t10.txt`)
Identical: 469 files, 45,021 sites, **43,518 deployed**, 740 hang-refused, no per-file line differs. The runner changes since c21bcbed
are PR-66's (the changed-tree resume warning follows recorded reuse lineage; `baseline_snapshot_reuses`) and scripts only. t9 (run 10)
stored a batch-0 baseline snapshot on this build.

## Agreement
Per-pair rule (`2026-11-16-r984-window-agreement-rule.md`, amendment 1, t9's pre-commitment): t10 vs t9 is the first pair with PR-51
on both sides, so it is STRICT; t10 vs t1-t8 stays relaxed.

## Predictions
1. **BLOCK line:** 0 differ against t1, t2b, t3, t4, t5, t6, t7, t8 (relaxed) and t9 (strict).
2. **Mutation set:** 43,518 deployed.
3. **Baseline: REUSED from run 10 (t9's snapshot), and named** (`resume-baseline-reused`); PR-66 records the reuse in
   `baseline_snapshot_reuses`. No `resume-baseline-not-reused` and no `snapshot-backend-build-changed`. Baseline phase <= 300 s.
4. **Closes in the mutant phase:** 0 by the SetFilter GlobalLanguage 1030 family; 0 GoToKey. The count of other refusal closes is not
   predicted (t9: 91, from families met in new code; PR-74's entries are not in). Each `serve-drift-after-kept-refusal` is counted and
   its pair named, not predicted (t9: 1). Timeout closes are not predicted; each must carry `stopEvidence: "v3-cpu-stop"`.
5. **Rate:** 3-9 s per new covered mutant over the mutant phase (t9 7.9 s), at least 1,300 new covered mutants (the reused baseline
   gives the mutant phase about t9's 1,612 s more); L4 widened 0, order broken 0. Warm-up wall not predicted (t9 4,604 s).
