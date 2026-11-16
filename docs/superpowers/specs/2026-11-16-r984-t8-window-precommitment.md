# R-984 DO window t8 pre-commitment: PR-44 + PR-48 move DO's mutation set; PR-42, PR-49, PR-50 ride along

Lane lethal-bugs, 2026-11-16, committed before the window starts. Head: master 67f1ed0e (no code change since 65090565, where the dry
run below was taken). Config as t1-t7 (`/coord/handoff/R-984/v3.do-serve.json`, edge-847b1fa5a), `--resume dos3.sqlite`,
`--time-budget 12600` under `timeout --foreground -k 900 15300`, triage first, run.sh's watchdog. Per-mutant agreement:
`/coord/handoff/R-998/do/verdict-rule.ts` as in `2026-11-16-r984-window-agreement-rule.md` with its amendment 1. PR-53 (the SetFilter
GlobalLanguage 1030 refusal on the daemon) is not in this head; if it lands mid-window it shows in t9.

## Basis: t7 (`/coord/handoff/R-984/result.md`)
958ead14: L5 reused t6's baseline (307.5 s); 1,114 new covered mutants at 11.0 s each; 68 refusal closes (35 by one baseline-refused
SetFilter GlobalLanguage 1030 test riding in mutant requests) + 13 timeouts; 6 timeout kills, all `v3-cpu-stop` (PR-43).

## Measured before the window (`/coord/handoff/R-984/t6prep/dry-958ead14.txt` vs `dry-t8.txt`)
DO's mutation set moves exactly as PR-44 and PR-48 announced: 43,526 -> **43,521** deployed (45,029 -> 45,024 sites; hang-refused
732 -> 737). Removed: CDOeDocsSendCodeMigration:285 remove-assignment (PR-48), CDOeDocumentsDispatcher:650,
CDOMailMessageBuilder:137, CDOEMailSignature:199, CDOEMailSignature:247, CDOEMailManagement:511 (toggle-blank-string, PR-44).
Given back: CDOEMailTemplateManagement:104 empty-block (PR-48). So the instrumented tree differs from t7's.

## Predictions
1. **BLOCK line:** under the amended agreement rule, 0 differ against t1, t2b, t3, t4, t5, t6 and t7. The 6 removed mutants are
   absent, not different.
2. **Mutation set:** 43,521 deployed.
3. **Baseline:** NOT reused, and LethAL names it (PR-47's line: another instrumented tree). Baseline phase 1,600-2,500 s.
4. **Closes:** 0 GoToKey; 0 timeouts at the 6 removed sites (they are not mutated). The SetFilter 1030 family is NOT predicted
   (PR-53 is not in the head); its count is reported.
5. **Rate:** 6-14 s per new covered mutant over the mutant phase, at least 700 new covered mutants; L4 widened 0, order broken 0.
