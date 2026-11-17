# PR-108 pre-commitment: a 3-hang cap on PR-51's held-timeout walk (R1057 re-opened), and the clock budget inside a walk (R1014)

Coord PR-108 (lethal-code, 2026-11-17). Analysis: `/coord/handoff/PR-108/analysis.md` (DO t13). Orchestrator rulings
(2026-11-17):
- (1) the in-walk budget check: go;
- (2) re-open R1057's cap at N = 3 hangs per mutant, counted in the fixed covering order;
- (3) the EOS static rule becomes its own task, PR-109.

## What t13 showed
- **The timeout closes.** 19 of t13's 28 timeout closes are one mutant, M36641 (`remove-not` in `ReadAsText`). It hung in 19
  of its 22 covering tests, at about 104 s each: the 60 s stop plus a restart. That is 1,981 s in all.
- **Why it walked on.** PR-51 holds the first timeout and walks on, only to find a later FAIL (which would give `killed`).
  None failed.
- **R1057's trigger.** R1057 ruled "full walk, no cap; bring the cap back if a window shows the walk above 5 %". t13's walk
  excess is about 1,870 s, 14.3% of the 13,108 s mutant phase.
- **The overrun.** Nothing checks the clock budget inside a mutant's walk. 785 s of that walk ran after `--time-budget 12600`
  was spent, which is the 797 s overrun (R1014's "Limits, kept").

## Change 1: the walk cap (orchestrator.ts, PR-51's hold/note in the covering loop)
- **The rule.** A mutant's walk counts the covering steps whose outcome is `timeout` while not replaying: the held one plus
  the noted ones. The 3rd such hang ENDS the walk. No further covering step is fed, and the walk proceeds exactly as when the
  walk ends naturally:
  - with no later confirmed fail, the held step is replayed through the cold timeout path (its confirm, its reproduction or
    PR-43's skip), then timeout-killed;
  - if its reproduction fails, the noted steps are replayed as today.
- **Deterministic.** Steps come in the fixed covering order (R197's ledger order, `orderCoveringTests`), so the cap's cut point
  depends only on the covering set and the ledger.
- **Recorded.** A capped walk carries a note on its `failureNote`: `the walk stopped after 3 timeouts (PR-108, R1057's cap);
  <k> covering test(s) after them were not run`.
- **What it can move (documented in R1057 and the code).** Beyond 3 hangs, a mutant whose later covering test FAILS reads
  timeout-killed instead of killed. It is still a kill for the mutation score; only the class label differs, which was
  R1057's subject.
- **Not changed:**
  - fewer than 3 hangs walk fully, as today;
  - the replay;
  - R895/R897 routing;
  - PR-55's alone confirm;
  - PR-43's skip;
  - every non-v3 backend's walk: the hold applies wherever PR-51 does, so the cap does too.

## Change 2: the clock budget inside a walk (R1014)
- **The check.** In `feed()`, before each `walker.next()` and only while not replaying, the session's budget is checked (the
  same `budgetSpent` clock test as the per-mutant check).
- **On a spent budget:**
  - the walk ends;
  - the mutant is left UNSCORED and UNRECORDED: no `record()`, no `commitRecord`, no sink finish;
  - it is counted among the mutants left out (`reachBudget` / `time-budget-reached` `unscheduledCount`), so `--resume` scores
    it;
  - the loop exits by the signal path's route (sequential `budgetSpent(at)`, a lane through `sink.memoryStop`).
- **The held step is never replayed on a budget cut.** A partial walk must never be recorded.
- **The cost.** A resumed run re-walks that mutant from its first step, paying its hangs again. With change 1, that is at
  most 3.

## Predictions (pre-committed)
- **Class moves against t1-t13: 0.** In every window t1-t14, no `mutant-scored` event is `killed` with PR-51's "the timeout
  of ... was not scored: ... failed under the mutant" note. So no mutant of those windows reached a kill after a held
  timeout. Windows t9-t14 had 2-3 timeout-killed walks each ("after the timeout: ...").
  - The cap moves no verdict and no `killingTest` there; only the walk's length.
- **The saving per window** is the sum over timeout-killed walks of max(0, hangs - 3) x the hang cost (about 104 s on t13). On
  t13 that is M36641's 16 hangs, about 1,660 s. The next DO window's TIMING section should show its live timeout restarts
  bounded by 3 per mutant.
- **Gates:**
  - `itest:alrunner-v3` passes unchanged: its timeout legs have fewer than 3 hangs per mutant;
  - `itest:hang` passes unchanged on its proven server: the hang fixture's mutants each have at most 2 timing-out covering
    tests (checked by the build before it runs). If a hang-gate mutant has 3 or more, its expected class is restated in an
    addendum BEFORE the gate runs.
- **Unit tests (call counters on stateful fakes, never wall-clock), each red when its rule is reverted:**
  - 4 covering tests that all time out give exactly 3 hang steps and the replay, timeout-killed, with the cap note;
  - 2 hangs then a fail give killed, with the cap not reached;
  - 3 hangs then a later fail give timeout-killed (the documented move), and no 4th step is fed;
  - the cap counts only non-replay timeouts;
  - a clock budget spent after the 2nd step of a walk gives no further step, no stored mutant, the mutant in
    `unscheduledCount`, and no replay;
  - the other direction: with the budget not spent, the same walk completes with today's verdict;
  - the budget check on a lane uses the sink's stop.
