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

## Amendment 1 (orchestrator ruling after t7, 2026-11-16)

Condition (b) becomes: **each side either reproduced its kill (`killReproduced` true) or carries PR-43's `stopEvidence:
"v3-cpu-stop"`**. PR-43 (master e71c6077) proves a v3 CPU-time stop instead of reproducing it, so a t7-or-later timeout kill
carries no `killReproduced`. Any other stop evidence does not count. Tests: two more cases in `verdict-rule.test.ts` (11 in all);
red-checked both ways (without the amendment the CPU-stop case fails; accepting any `stopEvidence` makes the other-evidence case fail).

**t7 under the amended rule:** vs t5, 27,014 same, 1 under the timeout rule (CDOMailMessageBuilder:137: timeout-killed both sides,
t7's by v3-cpu-stop), 0 differ; vs t1, t2b, t3, t4 and t6: 0 differ. Before the amendment that row read "differ" only on (b).

## Amendment 2 (orchestrator ruling 2026-11-17, PR-108's walk cap; committed before the first PR-108 window)

PR-108 (R1057, spec `2026-11-17-pr108-walk-cap-and-budget.md` addendum 1, M3) stops PR-51's held-timeout walk after 3 hangs. A
mutant whose later covering test would have failed then reads `timeout-killed` instead of `killed`, and its `failureNote` says
`the walk stopped after <n> timeouts (PR-108, R1057's cap); <k> covering test(s) after them were not run`.

**The clause.** For a pair where EXACTLY ONE window's recorded head contains PR-108 (its merge sha, `PR108` in
`verdict-rule.ts`, set when it lands): `killed` on the side without PR-108 and `timeout-killed` on the PR-108 side agree
(`same-walk-cap`, killing test exempt) when the PR-108 side's stored row carries that note with n >= 3. The note is read from the
row (`failureNote` of the `mutant-scored` event), never inferred. The reverse direction, a pair where both or neither heads contain
PR-108, and every other move stay as before (strict, or the PR-51 timeout rule where it applies). `compare.ts` lists such rows as
`WALK-CAP` and counts them apart, never silently.

**Expected use: none.** PR-108's pre-commitment predicts 0 such moves on t9-t14's mutants; the clause is a guard.

**Tests:** `verdict-rule.test.ts`, 7 more cases (21 in all), on a strict PR-51 pair so the timeout rule cannot be what lets a row
agree. Red-checked three ways: the clause disabled (2 fail), the note ignored (1 fail: the no-note, 2-hang and other-note cases),
the PR-108 side swapped (3 fail); restored green. With `PR108` unset, t12 vs t13 still reads 27,317 same, 0 under the walk cap,
0 differ.
