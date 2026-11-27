# PR-466 part 2 (R1228): the tier-slowdown STOP — design r2

lethal-code, 2026-11-27.
- **r1** was 1d89e221d. **r2** answers its spec-adversary: B1, S1-S6, N1-N3 and the test-plan gaps.
- **The orchestrator's ruling (principle 1):** build the first-cut STOP that part 1 permits.
  - No WARN level.
  - The store stays resumable; no restart is implied.
- **Part 1:** `2026-11-27-pr466-passing-row-slowdown.md` and `/coord/handoff/PR-466/findings.md`.
  - The STOP at 4.0 never fires on 29 healthy controls, and stops email3 at 3.09 h and queue2 at 4.38 h.
  - The margin is THIN: the healthy max block is 3.64 (on REF-OWN) against 4.0.
  - (b) (`2026-11-27-pr466b-self-referenced-ratio.md`) may replace it.

## The signal (part 1's D, without WARN)

- **Rows:** in `runSession`'s mutant loop ONLY (S6: not `runNamedMutants`, not the verify probes), every `test_results`
  row recorded in `record()` that has a mutant code, outcome `pass` and an `ownDurationMs`.
  - Unmutated confirmation rows, baseline rows, carried and skipped rows never feed it.
  - bcdev sessions only. al-runner sessions construct no monitor.
- **The reference** per test (codeunit id + method): this run's passing baseline own duration (the median if there are
  several).
  - On `--resume`, the SMALLER of that and the prior run's (`priorRunId`) passing baseline own duration. The prior
    side applies ONLY when both runs have the same non-null test-app hash, and leaves out the prior run's baseline
    rows from snapshots inside the prior's degraded window (S4).
  - **Measured (S4):** every healthy store of part 1 holds one run, so there min = own and the healthy max stays 3.64.
    The prior side was exercised only on email3 (two runs). That is stated.
  - **LIMIT (one level):** a resume of a resume sees only its direct prior.
  - **LIMIT (bugs, 2026-11-27):** a brand-new run (not a resume) started on an already slow tier has only its own
    slow baseline and cannot see the slowdown. The slow state is the server's; a per-server reference that outlives
    runs is not built here (R1228 records it).
  - A row with no reference, or a reference below 50 ms, is skipped and counted.
- r = own duration / reference. Blocks of 50 in recording order, no overlap.
- **STOP:** 3 consecutive blocks with medians ≥ 4.0. The onset is the first row of the first of those blocks.
- **Recording order is safe** (the review checked it): `record()` inserts the mutant row, emits `mutant-scored`
  (synchronous seq), then writes that mutant's test rows, with no `await` between. So a mutant's rows are contiguous,
  even under parallel workers, and row id, scored seq and test-row order agree.

## The window

- **The mark**, taken when the FIRST row of each block is fed (after that row's `record()`):
  - afterMutantId = that row's mutant row id − 1;
  - afterSeq = that mutant's `mutant-scored` seq − 1;
  - afterSnapshotId = `store.windowMark(runId).snapshotId` at that moment (S1, so a baseline snapshot recorded
    from the onset on is never lent to `--resume`).
  - That is the ONLY form. A mark "before the insert" is not reachable.
- **At the STOP** the window is the mark of the first of the 3 blocks. It contains exactly the onset mutant onward
  in the store (`m.id > afterMutantId`) and in the fold (`seq > afterSeq`).

## B1: the EARLIER window wins (a change to R1227's code too)

- **Store:** `markDegradedWindow` keeps, per run, the window with the SMALLER `after_mutant_id`, together with its
  `after_snapshot_id` and note (`ON CONFLICT(run_id) DO UPDATE … WHERE excluded.after_mutant_id <
  degraded_windows.after_mutant_id`). It returns the stored window.
- **Fold:** `applyDegradedWindows` uses the window with the smallest `afterSeq` over all `degraded-window` events.
- **Warnings name the STORED window:**
  - the renew stop's `lease-renew-unanswered-stop` warning;
  - the slowdown's warning.
  - Each says when another window was earlier.
- **So in either order,** a renew mark earlier than the slowdown onset still drops everything from the renew mark.

## What the STOP does (S2, S3): a spent budget, not a quarantine

- **The stop mechanism:** `TimeBudget.stopForTierSlowdown(info)`, like PR-250's `stopForChurn`.
  - It spends the budget: no new mutant is scheduled, and the work in flight finishes.
  - It is NOT `signalled` and does NOT latch `SessionSafety`.
  - So there is no `quarantined` event, no exit 3, no R53 recovery steps, and a later real quarantine (in-flight
    timeout, in-flight-unknown, a stranded marker) keeps its own reason and interpretation.
  - In-flight rows recorded after the onset fall inside the window.
- **The window is written at once** (`markDegradedWindow`, synchronous, never throwing; a failure warns
  `degraded-window-store-not-corrected`).
  - It is written AGAIN at teardown (S1): `correctStoreAtEnd`/`invalidateDegradedWindow` reads the monitor's window
    as well as the lease session's, so a row recorded by an in-flight worker after the stop reads `error` in the raw
    `mutants` table too.
- **Events:**
  - `degraded-window` (afterSeq, reason);
  - `warning` code `tier-slowdown-stop`;
  - the existing `time-budget-reached` event, with a new optional `stoppedByTierSlowdown: { medians: number[];
    afterMutantId: number; afterSeq: number }`, as PR-250 added `stoppedByDaemonChurn`.
  - It ripples per CLAUDE.md: events.ts, report-fold.ts, report.ts (type, builder, banner), `generate-schemas.ts`,
    `schemas.test.ts`, and the report-equality snapshot only if it moves. It is optional and nested, so committed
    sample reports stay valid. A test proves that.
- **Exit code:** `TIME_BUDGET_EXIT_CODE`, whose help text already says "the report is partial, run --resume to
  continue".
- **The warning:**
  > [lethal] tier-slowdown-stop: the BC tier slowed down: passing tests ran at 4.9×, 7.1× and 4.5× their baseline own
  > duration over the last 150 passing rows (blocks of 50; threshold 4.0, a FIRST CUT, R1228). The session stops
  > scheduling. Mutant rows after row X (events after Y) are dropped from the report and re-run by --resume.
  > Whether the tier needs a restart is not measured.
- **The report banner** (like the churn one): "STOPPED BY THE TIER-SLOWDOWN STOP: …" with the medians, the window and
  "first cut".
  - **N2:** it says nothing about verdicts BEFORE the onset (the ratios rose for hours before the STOP in part 1).
    Kill confirmation guards those, not this window.
- **Resume:** `resume-degraded-window` reads the stored note, not a fixed "stopped answering lease renews".
  - The renew-only texts are reworded to a neutral form that quotes the note: `DegradedWindowNotStoredError`, the
    `onDegraded` store warning, and `degradedWindowNote`'s "once the service tier is restarted".
  - **N1:** a stranded row inside a slowdown window is re-run once on resume, as for the renew window. A genuine hang
    strands again. Safe; stated in R1228.
- **Arming (S5):** at session end, one console line (not an event: no warning set moves):
  `[lethal] tier-slowdown monitor: fed N passing rows, skipped K (no reference R, under 50 ms S); armed|not armed (< 150 fed)`.

## r2a (the delta review of r2; these override anything above)

1. **A slowdown stop never finishes the run (BLOCK).**
   - The `finishRun` guard (orchestrator.ts ≈ 10376, `timeBudget?.reached === undefined`) also requires that there
     was no slowdown stop.
   - At the PR-277 emit (≈ 10422-10439), a slowdown with `reached` unset emits `time-budget-reached` with
     `stoppedByTierSlowdown`, `unscheduledCount: 0`, and NO `afterMainPass`. So the "STOPPED BY SIGNAL … nothing to
     resume" text never appears.
   - **Test:** the stop fires on the final row of the last batch → the run stays unfinished, `findResumableRun`
     returns it, and the exit code is `TIME_BUDGET_EXIT_CODE`.
2. **Ripple, added:**
   - `progress-renderer.ts` (≈ 168-187);
   - report.ts's generic "TIME BUDGET REACHED" line (≈ 4744): its condition excludes the slowdown, as it does churn;
   - report.ts's `afterMainPass` `by` chain (≈ 4686);
   - `CAVEAT_INTERPRETATIONS["time-budget-reached"]` (≈ 750) gains ONE sentence for the slowdown stop: the window's
     rows ARE in the report, as `error`, and are re-run by `--resume`. No new Caveat, so no count moves.
   - **Test:** the slowdown's banner and its progress render contain neither "TIME BUDGET" nor "--time-budget".
3. **The clock cut:**
   - The new field joins `remainingMs` (`TimeBudget.slowdown`, set by `stopForTierSlowdown`, NOT `signalled`). That
     one place makes `exhausted` stop every scheduler.
   - `clockSpent` (≈ 13975, R1014) EXCLUDES it, as it does churn, so an in-flight lane's walk finishes and its rows
     land inside the window.
   - `stopNameOf` (withheld-recheck.ts ≈ 364) names it ("tier slowdown").
4. **The snapshot bound per column:**
   - `markDegradedWindow` keeps `after_mutant_id = MIN(old, new)` and `after_snapshot_id = MIN(old, new)`
     independently.
   - On a tie of `after_mutant_id` the RENEW note wins; otherwise the note goes with the smaller mutant id.
   - The fold, on an equal `afterSeq`, picks the same note.
   - The doc comment's "first wins" is reworded.
   - **Test:** the tie case (renew (M0, S0) against slowdown (M0, S0+1), the slowdown written first) → the stored
     window is (M0, S0).
5. **NIT 5:** a resume whose every scored row lands in the window exits `NOTHING_SCORED_EXIT_CODE` (all-errors).
   Pinned by a test, and the banner says so.
6. **NIT 6:** the banner gives the window's row count apart from the left-out count.

## Constants (exported)

- `TIER_SLOWDOWN_BLOCK = 50`, `TIER_SLOWDOWN_STOP = 4.0`, `TIER_SLOWDOWN_HOLD = 3`, `TIER_SLOWDOWN_MIN_REF_MS = 50`.

## Tests (red both ways; the review's gaps included)

1. **HOLD:** the 3rd consecutive block ≥ 4.0 stops; the 2nd does not; a block below 4.0 resets the streak.
2. **Healthy-like streams never stop:** 3.9 throughout; alternating blocks of 3.6 and 1.0.
3. **The boundary through the REAL `record()` path,** 2 workers, with a block boundary that splits one mutant's rows.
   - The store's in-window mutant set equals the fold's dropped set, and both start at the onset mutant.
   - Red for an off-by-one in either direction.
4. **The reference:** a resume with a slow own baseline stops against the prior's faster one. It is red for
   "own only" AND for "max".
   - A prior run with a different test-app hash is ignored.
5. **Non-feeding rows:** non-pass rows, rows without a mutant code, a missing or sub-50 ms reference (counted), and
   rows from `runNamedMutants` never move a block.
6. **B1 order:** a renew tick fails (mark M0), then the slowdown stops (onset O > M0), then the renew stop fires.
   - The store and the fold drop from M0. The renew warning names M0.
   - The reverse order also drops from the earlier one.
7. **Teardown second write:** a row an in-flight worker records after the stop is `error` in the raw `mutants`
   table.
8. **No quarantine:**
   - the exit code is `TIME_BUDGET_EXIT_CODE`;
   - there is no `quarantined` event, and no R53 recovery steps are printed;
   - a later in-flight-unknown or in-flight quarantine still latches and shows `QUARANTINE_INTERPRETATION`.
9. **Texts:**
   - the warning names the ratios, the window and "FIRST CUT", and gives no restart instruction;
   - the banner;
   - the resume message quotes the stored note;
   - the arming line's not-armed case.
10. **al-runner sessions** construct no monitor.

## Gates

- Per `legs.ts` for the touched files. The frozen BC gates should not move.
- Any `tier-slowdown-stop` in a gate is a BLOCK, to be investigated (N3: not pre-measured on the latest gate stores).
- The `time-budget-reached` type change: gates that pin event sets are checked by the scan.
