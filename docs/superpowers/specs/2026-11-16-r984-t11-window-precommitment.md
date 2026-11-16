# R-984 DO window t11 pre-commitment: head 045a15cc (PR-55's alone confirm), same build edge-847b1fa5a, resume dos3

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master 045a15cc (t10's 4ad78fa6 + PR-55 1040c95b + PR-79 +
PR-82; since 1040c95b no file under `packages/` changed). **al-runner: edge-847b1fa5a, pinned by explicit path in
`/coord/handoff/R-984/v3.do-serve.json` as in t1-t10.** `--resume dos3.sqlite`, `--time-budget 12600` under
`timeout --foreground -k 900 15300`, triage first, run.sh's watchdog, peak RSS from `/usr/bin/time -v` (`t11.run.time.txt`). PR-81
(held errors) is pre-committed only (b02019ba), not in this head.

## Basis: t10 (`/coord/handoff/R-984/result.md`)
Cut short at 7,341 s by an outside memory risk (another lane's unit test; watchdog SIGTERM, R955 clean stop). Baseline reused from
run 10 (284 s); 774 new covered mutants at 9.0 s each; 84 closes (77 refusal, 4 timeout, 3 drift, all three on the red test
Codeunit68859.CreatePDF_WithValidData_ShouldCreatePDF, R1072); 0 differ vs t1-t9 (t9 strict). 8,357 covered mutants remain.

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-t10b.txt` vs `dry-t11.txt`, the latter on 1040c95b)
Identical: 43,518 deployed. The store records run 11 (t10) reusing run 10's batch-0 snapshot (`baseline_snapshot_reuses` 11 -> 10).

## Agreement
Per-pair rule: t11 vs t9 and t10 STRICT (both sides contain PR-51); t11 vs t1-t8 relaxed.

## Predictions
1. **BLOCK line:** 0 differ against t1, t2b, t3, t4, t5, t6, t7, t8 (relaxed), t9 and t10 (strict). In particular **PR-55 moves no
   verdict and no killing test** (orchestrator: it moved nothing on 7 apps).
2. **Mutation set:** 43,518 deployed.
3. **Baseline: REUSED from run 10's snapshot** (t10 stored none of its own; PR-66 lineage), named `resume-baseline-reused`; no
   `resume-baseline-not-reused`, no `snapshot-backend-build-changed`; baseline phase <= 300 s.
4. **PR-55's warning:** `alone-confirm` warnings may appear (one per kill or timeout confirmed alone); their count is reported and
   each confirm's verdict is checked against prediction 1, but the count is not predicted.
5. **Closes in the mutant phase:** 0 by the SetFilter GlobalLanguage 1030 family, 0 GoToKey, 0 whose text is one of PR-74's kept
   forms. The other refusal closes are counted and named by family, not predicted (t10: 77). Each drift-guard fire is named with
   its test (t10: 3, R1072). Every timeout kill carries `stopEvidence: "v3-cpu-stop"`.
6. **Rate:** 3-10 s per new covered mutant (t10 9.0 s), and, if the window runs its full budget, at least 1,000 new covered
   mutants; L4 widened 0, order broken 0. Warm-up wall not predicted (t10 3,712 s).
