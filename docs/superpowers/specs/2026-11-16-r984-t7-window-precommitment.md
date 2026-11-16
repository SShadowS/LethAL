# R-984 DO window t7 pre-commitment: PR-47 (GoToKey kept), PR-43 (CPU-time stop), L5's first real measurement

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master 958ead14 (PR-47 merged; contains PR-43 e71c6077 and
everything t6 had). Config as t1-t6: `/coord/handoff/R-984/v3.do-serve.json` (edge-847b1fa5a), `--resume dos3.sqlite`,
`--time-budget 12600` under `timeout --foreground -k 900 15300`, triage first, run.sh's watchdog (inactive file cache counted free).
Per-mutant agreement: `/coord/handoff/R-998/do/verdict-rule.ts` as pre-committed in
`2026-11-16-r984-window-agreement-rule.md` (master bdfe1117).

## Basis
t6 (`/coord/handoff/R-984/result.md`): 159 new covered mutants in a 10,343 s mutant phase (~65 s each), because codeunit 68984's
baseline-refused GoToKey test rode in every mutant request of three new files: 63 closes, each a ~37 s warm-up (lethal-code's
analysis; PR-47 keeps that refusal on the daemon). Its BLOCK cleared under the agreement rule. t5: 8.3 s per new covered mutant.

## Measured before the window: L5 can reuse t6's baseline
- A `--dry-run` at 958ead14 equals t6's head (da597fdb) file by file: 43,526 deployed mutants
  (`/coord/handoff/R-984/t6prep/dry-958ead14.txt`).
- The generation-side changes since t6 (PR-45) cannot move the hashed tree: `hashAlTree` hashes `.al` files only, and the new
  `nonDebuggable` flag is in the manifest; DO has no object header glued to a quoted name (the other change).
- t6's stored snapshot (dos3 run 7, batch hash 46f5091c...) carries backend state (PR-21).

## Predictions
1. **BLOCK line:** under the agreement rule, 0 differ against t1, t2b, t3, t4, t5 and t6. Rows agreeing only by the timeout rule
   are listed, not counted as differences.
2. **Mutation set:** 43,526 deployed.
3. **Baseline (L5, first real measurement):** t6's baseline is reused (LethAL says so) and the baseline phase takes at most 300 s
   (t6: 2,191 s). A named non-reuse is a miss of this prediction, an unnamed one a miss twice over; neither is a BLOCK.
4. **Closes in the mutant phase:** 0 by the GoToKey family (lethal-code's prediction for PR-47; t6: 63); 0 by stale buffer, caption,
   ZipArchive.Dispose, FormatRegion. Refusal closes <= 50 (t6: 96, of which 63 GoToKey).
5. **Rate:** 6-14 s per new covered mutant over the mutant phase (t6 ~65 s, t5 8.3 s), so at least 700 new covered mutants. Warm-up
   wall <= 4,500 s. L4: widened 0, order broken 0.
6. **PR-43** (a provable CPU-time stop skips R577's reproduction) shows live for the first time: reported as observed, not predicted.
