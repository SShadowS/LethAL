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

## Addendum 1 (2026-11-17, after spec-adversary r1; this text overrides the sections above where they differ)
The spec-adversary found no way for the cap or the budget cut to make a false kill. It found four medium issues, all fixed
here.

**M2 fixed by design: the cap is PROVISIONAL.** The cap must never lower the score. As first written, it could turn
`killed` into `error`, or `timeout-killed` into `error`. That happens when the held hang's cold confirm fails
(`timeout-unconfirmed`, `confirm-stopped`, `unstable`, `session-reused`, stranded), or when none of the first three hangs
reproduces. So:
- **At the 3rd non-replay hang,** the 3rd is pushed into `noted` (L4). Feeding of new covering steps PAUSES; the walker is
  NOT returned. The held step, and if needed the noted ones, are replayed through today's after-walk path.
- **If that ends `timeout-killed`,** the walk is done and capped: the cap note is recorded and no further covering step runs.
- **Otherwise,** the walk RESUMES from the next un-fed covering step under today's rules: the remaining steps are fed, held and
  noted logic applies to later hangs with no second cap, and today's after-walk logic decides as it does now.

So the only class moves the cap can cause are:
1. `killed` -> `timeout-killed`: a later fail beyond the 3rd hang is not reached.
2. A terminal answer past the 3rd hang (stranded, result-lost, deadline-exceeded, transport error, R688 abort, in-flight
   latch) is not reached. Its `error` becomes the held replay's `timeout-killed`, with the same evidence a single-test
   mutant gets. Its side effects (`stopAfterRecord`, the latch quarantine) do not happen on that mutant.
3. Note only: R688's "blanked" note goes when the blanked codeunit lies past the cap.

`timeout-killed` is a kill, so the mutation score never falls.

**M1: the budget cut's exit.**
- `feed` sets a local `budgetCut` flag and returns.
- Right after the `for await` loop, BEFORE the after-walk code (`const h = held ?? ...`), a set flag leads to:
  1. `walker.return()`;
  2. `budgetSpent(at)` when sequential, or `sink.memoryStop(...)` on a lane;
  3. `break` out of the mutant loop.
- That skips the held replay, R577 I4, R198's coverage check, every note and `commitRecord`. No row is stored.
- The cut is checked only while not replaying and not in a resumed replay.
- **Extra test:** a walk with NO held step, cut by the budget, gives no stored row and no `group-coverage-incomplete`.

**L1: the memory guard.** `TimeBudget.exhausted` is also true after a memory-guard stop. The in-walk cut fires only on the
CLOCK budget and on signals, never on a memory stop (R948/R1014: the mutant in flight keeps its verdict on a memory stop).

**M3: the evidence and the window comparison.**
- **The 0-moves prediction rests on t9-t14,** the windows whose heads contain PR-51; t1-t8 cannot show PR-51's notes. Across
  t9-t14:
  - `killed` with "was not scored": 0;
  - `error` with "was held earlier in this walk": 0;
  - `timeout-killed` whose killer is not the held test: 0;
  - an `error` carrying "after the timeout:": 0.

  Every one of the 13 "after the timeout:" walks was killed by its held test. So no mutant of t9-t14 moves under the cap.
- **The window comparison.** R-998's comparison rule must relax `killed` <-> `timeout-killed` for a pair where exactly one head
  contains PR-108 and the PR-108 side carries the cap note. Every other move stays strict. That rule is lethal-bugs' tool
  (`/coord/handoff/R-998/do/verdict-rule.ts`), so the change goes to lethal-bugs as a request, with this clause.

**M4: the order limit, stated.** The covering order (R197's ledger) is fixed within one uninterrupted run. Verdicts carried by
`--resume` do not enter the ledger, and v3 request packing can change which tests hang. So for a mutant with 3 or more hangs,
the class (killed vs timeout-killed) can depend on order across a budget cut and `--resume`. This is recorded in R1057.
Seeding the ledger from carried kills is out of scope.

**L2-L5:**
- The note's `<k>` counts the refs in the ordered covering list after the 3rd hang's ref, excluding codeunits in `skip`.
- The cap note is appended where `heldNote` is (after any `STRANDED_NOTE_PREFIX`).
- A test pins that a 3rd hang which alone reproduces gives timeout-killed by the 3rd.
- The cap applies on bcdev too: it moves from "Not changed" to the changes.

**Tests added to the predictions** (each red when its rule is reverted):
- held hang, confirm fails, a later test fails: `killed` (the walk resumed), with no cap note;
- none of the first three hangs reproduces, the 4th reproduces: `timeout-killed` by the 4th (the walk resumed);
- the budget cut with no held step: no row, no R198 error;
- a memory-guard stop mid-walk: the walk continues and its verdict is recorded.

**Gates, checked by the adversary:**
- `itest:hang`: at most 2 hangs per mutant (`heldSecondHangs` = 2), so the cap is never reached.
- `itest:alrunner-v3`: no `timeout-killed` in its baselines (R164).

Both pass unchanged.

## Addendum 2 (2026-11-17, orchestrator ruling after the Opus build review of 28bf931b; this text overrides Addendum 1's cap)
**The provisional cap is withdrawn; the cap is SIMPLE.** The build review found that the provisional resume interacts with the
walk:
- **H1, earlier calls:** the replay sends the held step's unmutated confirm earlier than today. An infrastructure failure on it
  turns today's later `killed` into `error`, and a stranded confirm quarantines the session.
- **M1, an unlisted move:** an `error` can become `timeout-killed`, with no note.
- **M2, routing:** the resume rewinds v3's cut state, so later calls route differently.
- **M3, other mutants:** the early `noteMeasured` raises other mutants' budgets.

Each fix adds state to the verdict path. The orchestrator chose option B.

**The rule.** The 3rd non-replay hang of a walk ENDS the walk exactly as a natural walk end does: no further covering step is
fed, and today's after-walk code runs unchanged. That code replays the held step, then the noted ones while the verdict is
`survived`. There is no pause, no resume, no state capture and no re-activation.

**The moves it can cause** (the safe direction: a lost kill, never a false one):
1. `killed` -> `timeout-killed`: a later fail beyond the 3rd hang is not reached.
2. `killed` -> `error`: the held confirm fails (`timeout-unconfirmed`, `confirm-stopped`, `unstable`, `session-reused`,
   stranded), or none of the 3 hangs reproduces, while a later fail exists beyond the cap.
3. `timeout-killed` -> `error`: only a 4th or later hang reproduces.
4. A terminal answer past the 3rd hang is not reached, so its `error` becomes the held replay's verdict.
5. Note only: R688's "blanked" note goes when the blanked codeunit lies past the cap.

**Making a lost kill visible (orchestrator conditions 1 and 3):**
- **The note.** Every capped walk carries the cap note on its `failureNote` (stored, and on `mutant-scored`): `the walk stopped
  after 3 timeouts (PR-108, R1057's cap); <k> covering test(s) after them were not run`.
  - `<k>` counts the ordered covering refs after the 3rd hang, excluding codeunits in `skip`.
  - It is emitted even when k = 0, so every capped walk is identifiable.
  - A ref missing from the ordered list THROWS, never giving a silent k.
- **The warning.** Each capped walk also emits one warning, `held-walk-capped`, naming the mutant, its verdict and k. A capped
  `error` is therefore listed by name.
- **The count.** PR-100's TIMING section gains a line: `capped walks: <n> (<verdict> <count>, ...)`.
- **Why not the report.** The report JSON carries no general warning list, and a new Caveat would ripple through the report
  schema and the sample reports. So the count is in the run's output and events, which `explain --events` also reads.
- **The comparison.** lethal-bugs' comparison relaxes only `killed` (other head) <-> `timeout-killed` (PR-108 head, cap note).
  Moves 2-4 stay STRICT: a BLOCK to look at.

**Prediction (condition 2).** t9-t14's 13 timeout walks show 0 moves of any kind under the cap. Each was `timeout-killed` by
its held test (its first hang), and the held step reproduced. A walk ended at its 3rd hang therefore replays the same held step,
with the same evidence and verdict.

**The budget cut** stays exactly as built (Addendum 1, M1 and L1).

**Tests (replacing Addendum 1's cap tests):**
- 4 hangs of 5 tests: the walk ends at the 3rd, the held step is replayed, timeout-killed with the cap note and k = 2, and T4/T5
  are never run;
- 2 hangs then a fail: killed, no cap;
- 3 hangs then a later fail: timeout-killed (move 1), T4 never fed;
- the held confirm fails at the cap: `error` (move 2), named in the `held-walk-capped` warning;
- the 3rd hang alone reproduces: timeout-killed by the 3rd;
- replay timeouts are not counted;
- k = 0 still carries the note;
- a missing ref throws;
- the TIMING line counts capped walks by verdict.

Each test is red when its rule is reverted.
