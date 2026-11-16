# R-984 DO windows: the per-mutant agreement rule from t7 on

Lane lethal-bugs, 2026-11-16, committed before window t7 (orchestrator ruling on t6's BLOCK). Applies to every DO window's BLOCK
line from t7 on, and re-scores t6.

**The rule** (`/coord/handoff/R-998/do/verdict-rule.ts`, used by `/coord/handoff/R-998/do/compare.ts`; tests in
`verdict-rule.test.ts`, 9 cases, each condition red-checked): two windows agree on a mutant, joined by site (file, offsets, operator,
mutated text), when it has the same verdict and the same killing test. One relaxation only: killed and timeout-killed count as the same
verdict, with the killing test exempt, when ALL of:
- (a) at least one side is timeout-killed;
- (b) both sides reproduced their kill (`killReproduced` true);
- (c) the covering-test set is identical in both windows (as a set).

Everything else stays strict, including survived against either kind of kill, error, and no-coverage. Rows that agree only under the
relaxation are counted and listed apart (`TIMEOUT-RULE`), never folded into "same". Why: [[R1057]] (a mutant with a second
killing test, one of which hangs, is met in a different order per window).

**t6 under the rule:** vs t5, 27,014 same, 2 under the timeout rule (CDOEMailHandler:462, CDOMailMessageBuilder:137), 0 differ; vs t1,
t2b, t3 and t4: 0 under the rule, 0 differ. So t6's BLOCK clears on (1); its slowdown is explained separately (codeunit 68984's
baseline-refused GoToKey test sent in every mutant request, PR-47).
