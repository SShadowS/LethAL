# PR-454 (R1227): stop scoring after unanswered lease renews; the report and --resume drop the degraded window — r2

lethal-code, 2026-11-26. Pre-commitment before the build.
- **r1** was 048c49ada.
- **r2** answers its spec-adversary: B1-B3, S1-S6 and the NITs, marked "(B1)" and so on.

Evidence: `/coord/handoff/PR-454/timeline.md`. Codes, times and counts only.

## What happened (R1227, PR-427 on bc4)

- **Renews.** The heartbeat ticks every ttl/3 = 5 s. A renew that gets no answer takes 2 × 30 s, so in an outage
  `lease-renew-unanswered` (R852) repeats about every 61 s.
  - Warnings at 8.917, 8.934 and 8.951 h.
  - Then renews were ANSWERED (no warning) until 11.035 h.
  - Then six more, up to the quarantine at 11.47 h.
- **Verdicts by period** (the review, from events):

  | period | killed | survived | error |
  |---|---|---|---|
  | 8.0-8.916 h | 9 | 0 | 3 |
  | 8.916-8.95 h | none | none | none |
  | 8.95-11.034 h (renews answered) | 44 | 16 | 8 |
  | after 11.034 h | 0 | 0 | 4 |

  - Against al-runner, 22 of the 72 late verdicts are al-runner survivors.
  - In hours 9-10, test-failure call ends rose from 5-18 to 29-37 per hour, and kills got much faster.
  - Calls ending at the 330 s cap were routine from hour 1, so the cap is not the signal.
- **Most suspect verdicts were scored WHILE renews were answered.** This fix covers them only because the stop at the
  first streak ends the session and quarantines the tier. A tier that degrades while still answering renews is NOT
  detected by this item. It is filed as R1228 (below).
- The fix cannot show the tier was healthy at 8.82-8.9 h either: hours 6-8 already show more failure-ended calls.
  This fix makes no claim before the window.

## Part 1: when to stop (S1)

- `LeaseSession` keeps `#lastAnsweredAt` (the injected clock) and `#unansweredStreak`. Any ANSWERED renew (either
  outcome) sets the time and resets the streak. Each `lease-renew-unanswered` warning adds one; a blip adds none.
- **The stop rule: streak ≥ 2 AND ≥ 120 s since the last answered renew.**
  - Counting warnings alone would stop after about 10 s of fast failures (two 503s in a row; R852 recorded such
    bursts).
  - Timeouts reach 120 s at about the 2nd warning, so PR-427 stops at ≈ 8.951 h.
  - Healthy runs reach neither condition: PR-287's only warning was a single one.
  - The table's streak rule (warnings ≤ 125 s apart) agrees with the mechanism's ("no answer in between") only because
    61 s gaps are shorter than an answered tick in between would need. That is stated, not assumed.
  - `RENEW_UNANSWERED_STOP = 2` and `RENEW_UNANSWERED_STOP_MS = 120_000` are named constants, not config fields.
- **At the stop, `noteRenewUnanswered` (B3, S4)** mirrors `noteRefusal` and R508:
  1. it latches `SessionSafety` unsafe, with the reason `lease-renew-unanswered: <n> in a row, no answer for <s> s
     since <ISO>`;
  2. it does NOT call `stop()`. The heartbeat keeps renewing, so the lease does not lapse under the operation still in
     flight;
  3. it tries the store write (Part 2) and NEVER throws. On a failure it warns `degraded-window-store-not-corrected`,
     as `lease-loss-store-not-corrected` does;
  4. it emits `lease-renew-unanswered-stop`, naming the window start, the streak and the elapsed time.
- It does not go through `noteLeaseLost`, and it writes no `lost_batches` row: the lease is not proven lost.
- **Which error wins.** `SessionSafety` keeps the FIRST reason.
  - A later `renewed:false` still runs `noteLeaseLost`: the lost batch, design §6.
  - A later in-flight-unknown still records its stranded op.
  - The degraded window is written either way, and `invalidateLostBatch`'s `earlier` and `late` rules are not changed.
- **The end of the session.** It returns a QUARANTINED report, as today's latched sessions do, so a report is always
  written. Then the CLI exits non-zero with `LeaseRenewUnansweredError`, a typed error that extends `Error` directly,
  after the report is written.
- **The durable quarantine (S5).**
  - `finish()` calls `recordRecycle` with the kind `container-needs-recycle` and the detail "the control app stopped
    answering lease renews (<n> in a row, <s> s); restart the service tier".
  - It does NOT tell the operator to ForceResetLease when `finish()` released the lease cleanly: that text is chosen
    by whether a marker was stranded.
  - Unconditional once the stop fires: the restart is what clears a degraded tier whose renews are answered.

## Part 2: the window in the store, the report and --resume

- **(B1) The window start.** `pulse` reads the run's `MAX(mutants.id)` (0 when there are no rows; never "no window")
  BEFORE each renew call, as `#idAtTickStart`.
  - On the first FAILED tick since the last answered renew (a blip or an unanswered tick), that value becomes
    `#windowAfterId`. An answered renew clears it.
  - So rows recorded while the first stalled renew was waiting (up to 60 s) fall inside the window.
  - **(S6)** At the same moment it keeps `MAX(baseline_snapshots.id)` as `#windowAfterSnapshotId`.
  - `recordMutant` INSERTs one row per verdict, with an autoincrement id. The review checked that no other verdict
    writer updates in place, so id order is recording order.
- **The store write:**
  - `markDegradedWindow(runId, afterMutantId, afterSnapshotId, note)` writes a new table, `degraded_windows`. The first
    window of a run wins.
  - `invalidateAfter(runId, afterMutantId, note)` rewrites rows with `id > afterMutantId` as `invalidateBatch` does:
    `error`, the note, kill fields cleared, `INVALIDATION_KEEPS` rows left alone.
  - **(S6)** It marks every baseline snapshot with `id > afterSnapshotId` suspect (R512's `markSnapshotSuspect`), so
    `findBaselineSnapshot` never lends one.
- **(B3, S3) The second chance.** The session's teardown runs the same write again. That catches a row recorded after
  the stop by the operation still in flight, and a write that failed in `pulse`.
  - If THAT write fails, it throws `DegradedWindowNotStoredError`, naming the run: "do not --resume run N".
  - So the raw rows are rewritten, not only re-read, and an older client resuming this store sees `error` too.
- **Readers.**
  - `EFFECTIVE_VERDICT_SQL` (R513's predicate) gains "or EXISTS a `degraded_windows` row of the run with
    `m.id > after_mutant_id`". That covers `findResumableRun` and its four siblings, and `mutantVerdicts` (so
    `--resume-run` too).
  - **(S3)** `mutantVerdicts` takes the window's note when `lost_note` is NULL (`COALESCE`), so no window row reads
    `error` with a NULL note.
- **(S2) A stranded row inside the window is NOT a stranded key.** `buildResumeIndex` leaves it out of
  `strandedKeys`, and `--resume` re-runs it once.
  - The mutant in flight when the tier stopped answering is the likeliest to strand: M0164 survived on al-runner in
    3.4 s.
- **The --resume warning.** `resume-degraded-window` names the run and the number of mutants it will actually re-run
  from the window. That count overlaps `resume-reusing-run`'s "N prior error verdict(s) will be re-executed", and the
  text says so.
- **(B2) The report is corrected the way a lost batch is.**
  - A new event, `degraded-window { afterSeq, reason }`, is emitted at the stop. `afterSeq` is the `seq` of the last
    `mutant-scored` event at the window start: `record()` inserts and emits synchronously, so seq order matches id
    order.
  - `report-fold.ts` folds it in the same second pass as `applyBatchInvalidations`. Every outcome with a `mutant-scored`
    seq greater than `afterSeq` becomes `error`, with the note. Errors that already have a cause, and known survivors,
    are kept.
  - No new SessionReport field. The ripple is `events.ts`, `report-fold.ts` and the stream schema
    (`generate-schemas.ts`, `schemas.test.ts`).
  - `QUARANTINE_INTERPRETATION` (`report.ts`, also used by explain) is made reason-dependent. For this stop it says the
    tier stopped answering renews, and that verdicts from the window are dropped and re-run on --resume.
- **Scope.** Only backends that hold a lease (bcdev). al-runner v3 holds none.

## Red tests (each red with its fix reverted, and green restored)

All are driven through the REAL `pulse`, via the timer seam and a scripted renew fake, never by injecting warning
events (the r1 NIT). Phase order is asserted with call counters, never wall-clock.
1. **Stop rule:**
   - two timeouts in a row (≥ 120 s) stop;
   - an answered renew between them does not stop;
   - fast failures for 10 s do NOT stop (S1);
   - a single unanswered tick does not stop.
2. **Window start (B1):**
   - rows recorded during the first stalled tick are invalidated;
   - rows after a blip that begins the streak are invalidated;
   - rows before it are kept;
   - a run with no rows gives afterId 0.
3. **(B2)** The report fold turns a window outcome into `error`, and leaves a pre-window kill as a kill.
4. **(B3)** A store write that throws inside `pulse` does not reject (no unhandled rejection). The teardown retries,
   and throws `DegradedWindowNotStoredError` when that write fails too.
5. **The teardown** rewrites a row recorded after the stop by the operation still in flight.
6. **Resume:**
   - exactly the window's rows are re-run, and `resume-degraded-window` gives their count;
   - with no window, nothing more is re-run;
   - a stranded row in the window is re-run, not skipped (S2);
   - `findResumableRun` does not pick a run whose only carryable rows are inside the window.
7. **No lease-loss semantics:** no `noteLeaseLost`, no `lost_batches` row, and `renewed:false` unchanged.
8. **(S6)** A snapshot recorded after the window start is never lent.
9. **(S5)** The recycle record names the renew stop, and recommends no ForceResetLease after a clean release.

## Gates

- legs.ts for the touched files. Expected: bcdev, lease, tables and chunked, plus the v3 gate.
- A gate already fails on any `lease-renew-unanswered`, so no frozen figure can move.

## Filed alongside

- **R1228:** a BC tier that degrades while lease renews stay answered goes undetected. PR-427 scored 44 kills that
  way, at 8.95-11.03 h. Signals in the data: test-failure call ends rose about 2-6×, kills ran faster, and survivors
  ran shorter.
- Re-scoring PR-427's 72 is the orchestrator's call, not pre-committed here.
