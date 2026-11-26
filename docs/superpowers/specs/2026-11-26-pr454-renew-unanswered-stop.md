# PR-454 (R1227): stop scoring after consecutive unanswered lease renews; --resume refuses the degraded window — r1

lethal-code, 2026-11-26. Pre-commitment before the build. Evidence: `/coord/handoff/PR-454/` (`timeline.md`).

## What happened (R1227, PR-427 on bc4; times from the run's events)

- **The renew timeline.** The heartbeat ticks every ttl/3 = 5 s. A renew that gets no answer takes 2 × 30 s, so in an
  outage `lease-renew-unanswered` (R852: two ticks in a row unanswered) repeats about every 61 s.
  - At 8.917, 8.934 and 8.951 h: three unanswered warnings in a row.
  - Then renews were ANSWERED again (no warning) until 11.035 h, followed by six more up to the quarantine at 11.47 h.
- **The scoring.** It went on throughout: from 8.82 h, 48 killed, 12 error and 16 survived, scored on a degraded tier.
  Against al-runner on the same mutants, 22 of 72 late kills are al-runner survivors, against 7 of 60 before.
- **Today's rule.** `pulse` warns, and "only `renewed:false` is loss" (design §6). Nothing stops the scoring.

## Streaks in other runs (`timeline.md`; consecutive warnings ≤ 125 s apart)

| run | max streak | the tier |
|---|---|---|
| PR-287 riskyall | 1 | healthy; finished |
| PR-67 | 1 | quarantined for another cause |
| PR-68 | 2 | quarantined |
| PR-427 edocs | 3, then 5 | degraded (R1227) |
| PR-200 bc4 T3 / T4 | 13 / 19 | broken by a company Commit (bc4 401s) |

## Part 1: the stop

- **The count.** `LeaseSession` counts consecutive `lease-renew-unanswered` warnings: `#unansweredStreak`.
  - Any ANSWERED renew (either outcome) resets it to 0.
  - A `lease-renew-blip` neither adds nor resets: a blip is two failures in one tick, followed by an answer next tick.
- **N = 2: two unanswered warnings in a row,** that is, at least ≈ 2 minutes in which no renew was answered.
  - Healthy runs above show at most 1. PR-427 would have stopped at 8.934 h, about 1 minute after the first warning,
    instead of scoring for 2.5 h.
  - N is a named constant (`RENEW_UNANSWERED_STOP`), not a config field.
- **At the N-th warning, `LeaseSession` calls `noteRenewUnanswered`.** It does NOT go through `noteLeaseLost`: the
  lease is not proven lost, and design §6's lost-batch semantics stay for `renewed:false`. It:
  1. latches `SessionSafety` unsafe, with the reason `lease-renew-unanswered: <N> in a row since <ISO time>`, so no new
     work starts;
  2. records the degraded window in the store (Part 2), before returning;
  3. emits a NEW warning code, `lease-renew-unanswered-stop`, naming the window, the streak and the rows it marked.
- **How the session ends.** It finishes with a typed error, `LeaseRenewUnansweredError`, which extends `Error`
  directly and is never a subclass of another LethAL error. The report and the exit say that the tier stopped answering
  renews, and that verdicts recorded after the window start are not trusted.
  - The tier is durably quarantined as for a stranded operation, because the doctor found an orphaned run lease that
    only a service-tier restart clears.
  - The existing quarantine path is used; no new one is made.

## Part 2: the degraded window in the store, and --resume

- **The start.** At the FIRST warning of a streak, `LeaseSession` reads the run's highest `mutants.id` (recordMutant
  INSERTs one row per scored verdict with an autoincrement id, so the order of ids is the order of recording) and keeps
  it as `streakStartAfterId`. An answered renew clears it.
- **The record.** At the stop, `store.markDegradedWindow(runId, afterMutantId, note)` writes a row in a new table,
  `degraded_windows (run_id, after_mutant_id, note, recorded_at)`. The first window of a run wins (INSERT OR IGNORE),
  like `markBatchLost`. Then `store.invalidateAfter(runId, afterMutantId, note)` rewrites every row with
  `id > afterMutantId` of that run as `invalidateBatch` does: verdict `error`, the note, kill fields cleared, the
  `INVALIDATION_KEEPS` rows left as they are.
- **Every resume reader** treats a row recorded after the window as invalidated, even one written after the stop by a
  verdict still in flight. This mirrors R513: `EFFECTIVE_VERDICT_SQL` gains the condition "or EXISTS a
  `degraded_windows` row of the run with `m.id > after_mutant_id`".
- **`--resume` says so by name:**
  - the warning `resume-degraded-window`, with the run, the count of rows it will re-score and the window note;
  - those mutants are re-run, never carried.
- **If the store write fails:** the same shape as `LostBatchNotStoredError`, a typed `DegradedWindowNotStoredError`
  naming the run and saying "do not --resume run N". The session never ends silently.
- **Scope.** Only backends that hold a lease (bcdev). al-runner v3 holds none, so nothing changes there.

## Red tests (each must go red with its fix reverted, and green restored)

Both directions of each guard:
1. **Streak:**
   - [unanswered, unanswered] stops at the 2nd;
   - [unanswered, answered, unanswered] does not stop;
   - [blip, unanswered] does not stop;
   - [unanswered, blip, unanswered] stops (the blip does not reset).
2. **The window start is the id at the streak's FIRST warning:**
   - rows recorded between the first warning and the stop are invalidated;
   - rows before it are kept;
   - a row recorded after the stop (in flight) is invalidated by the resume reader, with no rewrite.
3. **Resume:**
   - a store with a degraded window re-runs exactly the rows after it, and emits `resume-degraded-window` with that
     count;
   - a store without one re-runs nothing.
4. **No lease-loss semantics:** the stop does not call `noteLeaseLost`, writes no `lost_batches` row, and
   `renewed:false` still behaves as today.
5. **A failed store write** gives `DegradedWindowNotStoredError` (stub the store).
6. Phase ordering asserted with call counters on the stateful fakes (the timer seam fires ticks), never wall-clock.

## Gates

- legs.ts for the touched files (expected: `orchestrator.ts`, `store.ts` → bcdev, lease, tables, chunked and the v3
  gate).
- `itest:lease` also exercises the heartbeat. A healthy run never streaks, so no frozen figure moves.
- Not pre-committed, and the orchestrator's call: re-scoring PR-427's 72.

## Adding a SessionReport field ripples

If the report gains a field (for example `degradedWindow`), CLAUDE.md's ripple list applies: events, report-fold,
report, schemas, snapshots and the sample reports. Preferred: the warning and the typed error only, with NO new report
field. That decision is left to the review.
