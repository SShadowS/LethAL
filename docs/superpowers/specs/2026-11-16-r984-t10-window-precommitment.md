# R-984 DO window t10 pre-commitment: same build (edge-847b1fa5a), head 1b6ac882 (PR-66, PR-65, PR-57, PR-72, PR-73)

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master 1b6ac882. **al-runner: edge-847b1fa5a, pinned by
explicit path in `/coord/handoff/R-984/v3.do-serve.json` as in t1-t9.** The build move to edge-4ebfe7913 is NOT this window
(orchestrator 2026-11-16): a v3 verdict is lent only to the same build (R586, `backendBuildRefusal`), so `--resume` would find no run
and DO would restart from zero. The campaign finishes on 847b1fa5a first; one fresh-store window on the then-current build follows as a
per-mutant cross-build comparison, pre-committed on its own with PR-65's predicted moves. PR-74's keep entries are not on master
(4fff6ba0 is its pre-commitment only), so this window has none of them. `--resume dos3.sqlite`, `--time-budget 12600` under
`timeout --foreground -k 900 15300`, triage first, run.sh's watchdog, peak RSS from `/usr/bin/time -v` (`t10.run.time.txt`). It never
runs beside PR-75's BaseApp baseline.

**Amendment 1 (2026-11-16, before the window starts; orchestrator): head 4ad78fa6, which adds PR-74's keep entries** (merge 4ad78fa6;
`al-runner-server.ts`, family `t9-refusals`, pinned by `al-runner-serve-pr74.test.ts`). The sentence above that PR-74 is not in is
superseded. The rest of 1b6ac882..4ad78fa6 is PR-70 (CI templates and docs) and roadmap files. Where this amendment and the
predictions below disagree, the amendment wins.
- **Dry run on 4ad78fa6** (`t6prep/dry-t10b.txt`): identical to `dry-t10.txt` (apart from the contract-probe line): 43,518 deployed.
  So prediction 3 (baseline reused from run 10, named) stands: the keep list is not part of the tree hash, the test-app hash or the
  recorded runner build.
- **Prediction 4, amended:** closes whose refusal text is one of PR-74's kept forms (SetFilter `value expected after ..`/`@`;
  RecordRef.Duplicate / ClearMarks; Evaluate of `>100`/`>1000`/`<1000` into Decimal; Report.SaveAs parameters string without the
  XML declaration; ZipArchive Central Directory corrupt; JsonTextWriter.WriteEndObject `No token to close` and WriteStartObject in
  state Object at the four named paths; Boolean false to BigInteger): **0**. In t9 these forms closed at most 45 of the 91. Closes in
  the same families but in a form PR-74 did not keep (Report.RunRequestPage, JsonTextWriter.WritePropertyName / WriteEndArray,
  another SetFilter operator or JSON path) are counted and named, not predicted. The total refusal-close count is still not
  predicted (new code meets new families), but it is predicted to be **below t9's 91**.

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
