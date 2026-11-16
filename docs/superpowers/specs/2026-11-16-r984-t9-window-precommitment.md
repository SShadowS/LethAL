# R-984 DO window t9 pre-commitment: PR-56 (66 kept refusal classes + drift guard), PR-53, PR-51; first window with the per-pair rule

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master c21bcbed (contains PR-51 dddf01f3, PR-53, PR-56
fae3121f, PR-60, PR-42). **al-runner: edge-847b1fa5a, pinned by explicit path in `/coord/handoff/R-984/v3.do-serve.json` as in t1-t8**
(not `current`, which moved to edge-4ebfe7913 today; the build move is its own window, t10, after PR-65; orchestrator 2026-11-16). R814
still accepts edge-847b1fa5a: its `.gated` and its `gated-builds.jsonl` row are unchanged. `--resume dos3.sqlite`, `--time-budget 12600`
under `timeout --foreground -k 900 15300`, triage first, run.sh's watchdog; peak RSS now from `/usr/bin/time -v` (`t9.run.time.txt`),
placed outside `timeout` so the clean stop still signals LethAL.

## Per-mutant agreement: the per-pair rule (orchestrator ruling after PR-51)
`/coord/handoff/R-998/do/verdict-rule.ts` + `compare.ts`: each window's head is read from its recorded start line in run.log (refused
when missing or ambiguous); a pair where both heads contain PR-51 (dddf01f3) is STRICT; a pair with one side before PR-51 keeps the
timeout relaxation of `2026-11-16-r984-window-agreement-rule.md` with amendment 1 (v3-cpu-stop). `agreement()` takes the policy as a
required argument. 14 tests, red-checked both ways (relaxing every pair turns the post/post test red; making every pair strict turns
the pre/post test red). t9 is the first post-PR-51 window, so every pair with t1-t8 is relaxed.

## Basis: t8 (`/coord/handoff/R-984/result.md`)
67f1ed0e: 1,597 new covered mutants at 6.6 s each; 54 refusal closes (13 by the SetFilter GlobalLanguage 1030 family) + 6 timeouts;
baseline 1,953 s, not reused and NOT named (PR-66, pre-committed b0093b13, not in this head).

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-t8.txt` vs `dry-t9.txt`)
PR-53 moves exactly 3 sites to hang-refused: CDOEMailSignature.Table.al:203, :221, :254 (toggle-blank-string). 43,521 -> **43,518**
deployed (45,024 -> 45,021 sites; hang-refused 737 -> 740). The instrumented tree differs from t8's, so t8's baseline is not reused.

## Predictions
1. **BLOCK line:** 0 differ against t1, t2b, t3, t4, t5, t6, t7 and t8 (every pair relaxed: those windows predate PR-51).
2. **Mutation set:** 43,518 deployed.
3. **Baseline:** not reused; baseline phase 1,600-2,500 s. Whether LethAL names it is NOT predicted (PR-66 is not in this head).
4. **Closes in the mutant phase (PR-56, PR-53):** refusal closes <= 20 (t8: 54); 0 by the SetFilter GlobalLanguage 1030 family (t8: 13);
   0 GoToKey; `serve-drift-after-kept-refusal` fires 0 times. Timeout closes are not predicted.
5. **Rate:** 3-8 s per new covered mutant over the mutant phase (t8 6.6 s), at least 1,200 new covered mutants; warm-up wall <= 2,500 s
   (t8 3,413 s); L4 widened 0, order broken 0.
