# PR-281 pre-commitment: hand out the costliest procedure scopes first (v3 parallel queue)

Coord PR-281 (lethal-code, 2026-11-21). From PR-274 (`/coord/handoff/PR-274/result.md`).
- **The idle tail:** at 6-8 lanes most lanes idle for their last 400-1,060 s while one lane finishes, so 8 lanes beat 6 by
  only 10% on a 22-file DO slice.
- **The cause:** `runScopeQueue` hands out procedure scopes strictly in manifest order (`nextUnit++`).

## The premise, measured before writing this
- **The source:** PR-273's per-mutant model on perf10c, restricted to PR-274's slice files and grouped by procedure scope.
- **The scopes:** 212 scopes, 8,408 lane-s at perf10c's scale (about 1.3-1.6× that at PR-274's speeds).
- **The largest four are 913, 783, 635 and 634 lane-s** (10.9%, 9.3%, 7.6%, 7.5%). Two of them sit late in manifest order:
  scope #117 and #161 of 212.
- **So the "floor" PR-274 saw is several large scopes reaching lanes late,** not one indivisible chain.
  - At 8 lanes, the wall should approach the larger of the biggest scope (about 913 × 1.5 ≈ 1,400 s) and the total ÷ 8
    (about 1,700 s).
  - PR-274's W8a took 2,547 s.

## What is built
1. **A pure function in `parallel-queue.ts`:**
   `orderUnitsCostliestFirst(units, windowOf, costOf): units`.
   - It stable-sorts by window ascending, then estimated cost descending, then the original index.
   - Windows stay non-decreasing in unit order, which PR-151's look-ahead bound needs.
   - A unit's mutants keep their order.
2. **`runMutantsParallel` (orchestrator) applies it ONLY under the split prefetch** (the path every v3 owner takes, since it
   has `prepareBatch`), to the one group's units before `runScopeQueue`.
   - The non-split paths (R785 pacing, one group per window) are unchanged. There, lane 0's first finished unit sets the
     pace, and a costliest-first unit would delay the extra lanes (review finding 4).
   - A unit's window is its first mutant's window, as the look-ahead already uses.
   - A unit's cost is the sum of `mutantCost(...).ms` over its covered mutants, from the same `CostModel` that `cutWindows`
     uses (`costModelOf`): the covering tests' baseline durations, or whole-codeunit totals where the codeunit runs whole.
   - R987's per-call readings (PR-246) are MEMORY bytes, not time, so they are not used here.
3. **Two side effects the order would otherwise have** (from the Opus spec review, `/coord/handoff/PR-281/spec-review.md`):
   - **a. The daemon-churn guard counts from a lane's last FINISHED mutant,** not from the last COMMITTED record.
     - Today `DaemonChurnGuard.see` (`mutant-windows.ts`) counts a lane's daemon closes since the last `mutant-scored` event.
       That event comes from `OrderedCommit`'s manifest-ordered flush.
     - With small manifest-early units run last, records are held back for most of a window. A lane on a large scope could
       then reach 10 closes "with no mutant scored anywhere" while hundreds of mutants had finished, and stop the session for
       churn falsely.
     - So the count resets when a lane finishes a mutant (`LaneSink.finish`, or wherever the lane's mutant completes), and the
       warning text says "finished". The guard still stops a session whose lanes close daemons without finishing anything.
     - Red test: a stateful fake in which records are held back behind an unfinished manifest-first mutant, while a lane
       finishes mutants between closes. Today's code stops; the fix does not.
   - **b. The session-first warm-up's mode comes from the manifest-first COVERED mutant of the batch,** not from lane 0's
     first unit.
     - `warmSessionFirst` (`al-runner-v3-backend.ts`) reads the mode from the smallest call id in lane 0's first unit.
     - The one-shot fallback (R960, R786) exists only while `warmups === 1`, so a different first unit could flip a refusal
       outcome. Because baseline durations vary, it could also flip between runs, which is R197's lesson.
     - The mode is therefore fixed from the batch's plans (`prepareBatch` has `batchPlans`), whatever unit lane 0 takes first.
     - Red test: the costliest unit, in mode B, is taken first, and the warm-up still runs in the manifest-first mutant's
       mode A.
4. **The A/B knob:** `LETHAL_V3_UNIT_ORDER=manifest` restores today's order.
   - Unset or empty means costliest-first, the new default. Any other value is refused by name at startup.
   - When set, the v3 details line says so.
5. **Docs:** PR-274's findings go into a measurement note (`docs/measurements/2026-11-21-pr274-workers.md`):
   - the lane rule;
   - the peak rule 4 + 3n was too generous (26 GiB never fit 8 lanes on server1);
   - the per-scope premise above.

## Why no verdict or `killingTest` can move (the invariants)
- **R197's kill ledger is keyed by procedure scope,** and a scope is one unit, run in manifest order on one lane. Reordering
  WHOLE units changes no scope's internal order, so no mutant reads a different ledger.
- **`OrderedCommit` records in manifest order** whatever the finishing order, so the records, events and store rows are
  unchanged.
- **The queue already gives no lane-assignment guarantee** ("which lane takes which scope is timing; the verdicts are not").
- **What changes:** only WHEN a unit starts, plus side effects 3a and 3b, which are fixed so the order cannot reach them.
- **Stops (corrected after the review):**
  - Error stops (`closeWith`) keep the manifest-ordered prefix, as today.
  - Budget, memory and signal stops record every finished mutant (`drainGuardStop`, R962) and leave out the unstarted ones,
    as today. Which mutants are finished at such a stop now depends on the new order: large scopes are further along, small
    manifest-early ones less.
  - Neither kind changes a verdict. The look-ahead already lets two windows run at once, so "a stop loses at most one window"
    was never exact and is not claimed.
- **Out of scope:**
  - **Splitting a scope across lanes.** It would change the ledger's order inside the scope, so `killingTest` could move.
    Recorded as measured reasoning, not built.
  - **Raising `MAX_V3_WORKERS` past 8.** It is decided after the A/B, and only if lanes stay busy to the end at 8.

## Tests (red-checked both ways; order asserted by call counters on stateful fakes, never timing)
- **The pure function:**
  - within a window, cost descending;
  - windows never decrease;
  - ties keep the original order;
  - a unit's mutants keep their order.
- **`runMutantsParallel` under the split,** with a fake owner and 2 lanes: the costliest unit, which comes LAST in manifest
  order, is the first `runUnit` call (a call counter). The records still commit in manifest order.
- **Knob `manifest`:** the first `runUnit` is the manifest-first unit (today's behaviour).
- **Bad knob value:** refused by name.

## Gates
- VERIFY.
- The full v3 gate. The default changes the order on every v3 run with N > 1, so the gate's legs that run lanes must pass with
  verdicts unchanged.
- CI green.

## The A/B (pre-committed): PR-274's slice, 8 lanes, `--peak 22`
- **Arms:** A = `LETHAL_V3_UNIT_ORDER=manifest`, B = default. Order A, B, A, B, interleaved.
- **Unchanged from PR-274:** the same head for all four, the same config (main-ccd0f823d by path) and `slice.txt`. A fresh store
  per arm; `--profile slim`; no budget or pinning.
- **Recorded,** with PR-274 amendment 1's rules: host load and CPU pressure throughout; the memory gate; COMPLETE.
- **V (BLOCK):** every arm scores all 3,597 mutants, with identical verdicts and identical `killingTest` per mutant. No arm
  may show `al-runner-v3-daemon-churn`, and every arm's session-first warm-up runs in the same mode.
- **The prediction:** B's mean mutant-phase wall ≤ 0.85 × A's mean, and the mean idle tail ("after its last request" summed
  over lanes) is lower in B than in A.
  - A miss is reported with its cause: the tail still set by one scope means the largest scope is the floor; equal tails
    mean the cost estimate ranks badly.
  - If a pair (A1/A2 or B1/B2) spreads more than 15%, the result is flagged load-dominated and given as a range.
