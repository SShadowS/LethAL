# PR-151: the split queue hands out units without a window barrier, with a bounded look-ahead

Coord PR-151 (lethal-code, 2026-11-18). Source: PR-149 (`/coord/handoff/PR-149/result.md`). Related: R1092, R912, PR-99, PR-121(a),
PR-150 (TIMING's lane line).

## What is wrong (measured, PR-149 on DO window x4: edge-4ebfe7913, `--workers 3`)
- **The gaps:** 9 synchronised lane gaps, 3,385 s of lane time (about 1,128 s of wall).
- **Where they sit:** on 4 window boundaries. Each window was held open by ONE heavy procedure unit on one lane, while the other
  lanes had nothing left in that window.
  - The worst was `CDOExtensionApp.Table.al`: 35 covered mutants, a covering set of about 1,681 tests, about 1,030 s on lane 0.
- **The cause:** `runMutantsParallel` (orchestrator.ts) cuts the batch into windows (`cutWindows`, `splitWindowCaps`), and runs
  one `runScopeQueue` with one `OrderedCommit` per window. It awaits every lane before the next window starts. That await is the
  barrier.

## What the barrier protects (PR-149 §3), and how the new design keeps each
Revision 2, after the spec-adversary (Opus). The F-numbers are its findings.
1. **The ordered commit.** Results are recorded in manifest order.
   - A latch or throw stop keeps only the finished results before the stopping mutant (`closeWith`).
   - The memory guard's stop records every finished result, with gaps (R962's drain, `drainGuardStop`).
   - `--resume` is keyed by identity (`buildResumeIndex`), not by prefix, so a gap is safe (F5).
   - **Kept:** ONE `OrderedCommit` over the batch, its rules unchanged.
2. **A stop loses little** (R912: "at most one window").
   - **Kept, with a bound of two windows:** a lane may take a unit only while that unit's window is at most ONE past the oldest
     window that still has an unfinished unit (the look-ahead).
   - So the results held back, and the work a stop can discard, span at most two windows. The adversary checked this, a merged unit
     that spans windows included.
3. **The time budget.** R1014 already checks it before every mutant in every lane (`runMutantsOnBackend`, `sink.memoryStop`), and the
   window edge adds one check today (F5).
   - **Kept, at the unit edge too:** before a lane takes a unit, the budget is checked.
   - **When it is spent and a unit is still untaken,** the lane closes the commit the guard's way (F1): `memoryStop(<that unit's first
     mutant>, "the time budget was used up")`. That sets `stoppedByGuard`, so the R962 drain records every finished result.
   - **The count:** after the queue, the orchestrator counts the batch's covered mutants that were not recorded (`commit.unrecorded`)
     for `reachBudget`, as the guard branch does today.
   - **Why this is needed:** without it, a lane that ends between units leaves the commit unclosed, `conclude()` throws R766 ("never
     finished or recorded"), and `reachBudget` is never called (F1's sequence: one lane, the budget spent between two units).

## The change (split path only; `pace` and the plain path are unchanged)
- **One queue per batch.**
  - **Units:** procedure scopes (`procedureScopeOf`) over ALL the batch's covered mutants, in manifest order of each unit's first
    mutant. A unit keeps its mutants in manifest order.
  - **Each unit's window index:** the window (`cutWindows` with `splitWindowCaps`, unchanged) of its FIRST mutant.
  - A procedure whose mutants fell into two windows was two units on possibly two lanes. It is now one unit on one lane, which fits
    R197's per-procedure ledger better, not worse.
- **One `OrderedCommit` over the batch's mutants.** Uncovered mutants are `markDone` up front, as now per window.
- **`take()` with the look-ahead:**
  - the next untaken unit is handed out if its window index ≤ (the window index of the oldest unit not yet ENDED) + 1;
  - otherwise the lane WAITS (it does not end) until something wakes it, then asks again;
  - a lane ends only when no unit is left untaken, the commit is closed, the session is unsafe, or the budget is spent (F1's close
    first).
- **What wakes a waiting lane (F2):**
  - a unit ENDING in any way, signalled from a `finally` around `runUnit` (a return or a throw); a unit that ended by a throw counts
    as ended for the bound;
  - the commit closing.

  On every wake, the lane re-checks `commit.closed`, `isUnsafe` and the budget before it tests the bound. Without this, a throwing
  lane leaves a waiter asleep, and `allSettled` never resolves: a hang instead of `ParallelStopError`.
- **Lane launching** (`tryLaunch`, PR-98/PR-140's gate): it runs once per batch instead of once per window, and is asked again after
  every unit and gate event, as today.
  - **One change (F6):** it launches a lane only while a unit can be TAKEN now (inside the bound). Otherwise a new lane waits before
    its first request while holding its PR-99 reservation.
  - Waiting lanes stay active and charged, so PR-140's idle close does not fire inside a batch. Nothing waits on it, so there is no
    deadlock (adversary, checked).
- **The prefetch:** under the split, each lane already prefetches exactly its unit (PR-99), and `prepareBatch` runs once per batch.
  No change.
- **Not in this change:** heavy units first.
  - PR-121's spec-adversary (M1) dropped longest-first because it held store rows back.
  - With the look-ahead, the other lanes run past a heavy unit instead of waiting for it, which removes the barrier gaps PR-149
    measured.
  - The floor stays: a heavy unit that is LAST in the batch still ends the phase on one lane. That is stated as a limit.

## Predictions (pre-committed; measured on a DO slice, fresh stores)
- **The slice:** `--only` the 4 files whose units held x4's windows: `CDOContiniaPerformanceMgt.Codeunit.al`,
  `CDOExtensionApp.Table.al`, `CDOFunctions.Codeunit.al` and `CDOSetupManagement.Codeunit.al`.
  - Plus no budget: the run completes.
  - `--workers 3`, `--peak 18 baseapp`, edge-4ebfe7913, R-984's config `v3.do-serve-xb.json`, fresh stores.
- **Arm A:** master at the sha this branch is cut from (named in the result). **Arm B:** this branch.
- **P1, verdicts:** per mutant (full site key: file, line, operator, startIndex, endIndex, from each `report.json`), the verdicts are
  identical.
- **P2, killingTest:** identical, with no exception (F3). R197's ledger is one map per session, by procedure, and under the barrier
  a procedure's second part ran after its first. So no difference is expected, and any difference is a BLOCK to investigate.
- **Arm A must exercise the barrier:** its summed "waiting at window boundaries" (PR-150's TIMING lane line) is at least 300
  lane-seconds. Otherwise P3-P4 are inconclusive, and that is said (F4).
- **P3, the barrier time:** arm B's summed boundary waits are at most half of arm A's.
  - Not "about 0": the look-ahead lets the other lanes run only one window past a heavy unit, so they can still wait when the
    heavy unit outlasts that window (F4).
- **P4, the time:** arm B's mutants phase is shorter than arm A's.
- **If P1 or P2 breaks:** a BLOCK; the window boundary must not change a verdict or a killing test.

## Tests (red both ways)
1. **No barrier:**
   - setup: two windows, lane 0 holds a slow unit of window 0 and lane 1 finishes its unit early;
   - lane 1 takes window 1's unit while lane 0 is still busy.
   - Red with the per-window queue.
2. **The look-ahead bound:** with a slow unit in window 0, no lane takes a unit of window 2 until window 0's units are all finished.
   The waiting lane continues when they are.
   - Red without the bound.
3. **The commit order:** results are recorded in manifest order across windows, whatever order the lanes finish in.
   - On a stop in window 1, nothing after the stopping mutant is recorded, and a finished window-0 result before it is.
4. **The budget at the unit edge:**
   - once the budget is spent, no unit is taken;
   - the units in flight finish and are recorded;
   - the never-taken covered mutants go to `reachBudget` with the right count.
5. **A lane that waits is not ended:** with the look-ahead blocked, the lane resumes (it is not counted as drained).
6. **The paced and plain paths are unchanged:** the existing parallel-queue tests pass as they are.
7. **F1:** one lane, the budget spent between two units. No throw; the first unit is recorded; the second unit's covered mutants are
   counted in `reachBudget`.
8. **F2:** a lane throws while another waits on the look-ahead, and the session ends with `ParallelStopError`, not a hang. The same
   with the unsafe latch.
9. **F6:** no lane is launched while the next unit is beyond the bound.

Each is red against the version without its fix.
