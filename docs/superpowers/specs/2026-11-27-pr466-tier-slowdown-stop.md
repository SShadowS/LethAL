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

## r3 (2026-11-27, approved by the orchestrator; the build is HELD until the load question below is read)

- **Why:** bugs found a confound.
  - A FRESH bc4 ran its baseline 3.87× slower per test than email3's first baseline at server1 load1 ≈ 340, which is
    mostly kraken-alsem's benchmarks, outside our container. BC runs on server1.
  - So part 1's email3 slowdown may be host load, at least partly. R1228 carries bugs' correction (8a4fe76da).
  - server1 keeps NO load history, so the 29 healthy controls cannot be compared with email3's hours after the fact.
- **The change to the design:**
  - At each block's end, the monitor reads the host's `/proc/pressure/cpu` "some avg60" and `/proc/loadavg` load1
    (the container sees the host's values: BC runs on the same host).
    - A read error records `null`, never 0.
  - The block's median, PSI and load1 are kept.
  - The STOP warning and the banner print the 3 blocks' PSI and load1 beside their medians: "… at 4.9× (PSI 72%,
    load1 310) …".
  - Nothing in the STOP rule reads them yet.
- **The load-gate question**, pre-committed now, evaluated later on NEW data only:
  - **Data:**
    - bugs' hourly logs during the narrowed runs (`narrow-*/hourly.tsv`: load and per-mutant cost);
    - the per-block ratio and PSI of every bcdev run recorded from 2026-11-27 on, by an offline script over its
      stores and events plus the hourly logs (the r3 build's own records once it lands);
    - (b)'s runs.
  - **Labels**, set before computing, from evidence other than the ratio:
    - **LOAD-ONLY:** a span on a tier restarted ≤ 1 h before, with PSI avg60 ≥ 50%;
    - **QUIET-DEGRADED:** a span bugs names degraded with PSI avg60 < 20%;
    - **HEALTHY-QUIET:** a fresh tier with PSI < 20%.
  - **The rule:**
    - If any LOAD-ONLY span reaches STOP (3 blocks ≥ 4.0), the STOP needs a load gate. The gate's form is then
      designed with its own pre-commitment, for example no STOP while PSI avg60 ≥ the LOAD-ONLY spans' minimum, or a
      concurrent canary.
    - If no LOAD-ONLY span reaches STOP (with at least 3 such spans of ≥ 150 passing rows each), the STOP stands
      without a gate.
    - If no QUIET-DEGRADED span exists, it is reported that tier state alone was never seen to trip the STOP.
  - **Below the data floor** (fewer than 3 LOAD-ONLY spans): "not enough data", and the build stays held.

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

## r4 (2026-11-28, lethal-code): the STOP rule after R1228 settled; PRE-COMMITTED before any replay of it

**Why.** R1228 is settled as BC tier state, not host load (lethal-bugs, a46c058fb; the orchestrator unblocked PR-466,
`/coord/handoff/PR-466/orchestrator-unblock-2026-11-28.md`).
- DOTests file 2's same passing tests went from 0.44x to 3.3-3.6x their own baseline about 3-4 h into the run, at load
  9.5-31 and 0.01% CPU pressure.
- **r2's STOP at 4.0 would never fire on file 2,** whose blocks peak at 3.3-3.6.
- Part 1's healthy runs reach 3.64 only in short plateaus. So the hold, not the height, has to separate them: bugs' input
  is a median held for at least 1 h.
- The load gate r3 deferred is now the design's own guard, as bugs asks: overnight load bursts of 100-300 would
  otherwise trip it.

**r4 overrides r2/r3's STOP rule (everything else in r2, r2a and r3 stands: the rows, the reference, the window, the
stop mechanism, the events, the texts' shape, the ripple, the arming line):**
- **Block:** 50 passing rows, as before; its median ratio, and the host's `/proc/pressure/cpu` "some avg60" read at the
  block's last row (r3's reading).
- **A block is HOT** when its median is ≥ **2.5** AND its PSI is readable AND below **20%**.
  - An unreadable PSI (`null`) or PSI ≥ 20% makes the block NOT hot. So on a host without PSI the STOP never fires: the
    fail-safe direction (no stop is today's behaviour). The arming line says when PSI was unreadable.
- **STOP** when the current run of consecutive hot blocks has at least **3** blocks AND spans at least **60 minutes** of
  wall clock, from the first row of its first block to the last row of the current block. A block that is not hot
  resets the run.
  - The onset (and so the window) is the first row of the run's first block, as in r2.
- **The baseline's load:** the arming line also prints the PSI read at the baseline's end. A baseline under heavy load
  inflates the denominators and hides a slowdown. That is stated, with no rule.
- **Constants:** `TIER_SLOWDOWN_BLOCK = 50`, `TIER_SLOWDOWN_STOP = 2.5`, `TIER_SLOWDOWN_HOLD = 3`,
  `TIER_SLOWDOWN_HOLD_MS = 3_600_000`, `TIER_SLOWDOWN_MAX_PSI = 20`, `TIER_SLOWDOWN_MIN_REF_MS = 50`.
- **The texts** print the hot run's block medians with their PSI and the run's span in minutes, instead of "3 blocks ≥ 4.0".

**Acceptance, PRE-COMMITTED: an offline replay of exactly this rule, run before any runtime code moves.**
- **Script:** `/coord/handoff/PR-466/replay-r4.ts` over part 1's stores (`stores.txt`), tm7-a and tm7-b, and DOTests file 2
  (`/coord/handoff/PR-427/f2-header`).
- **Wall clock** comes from each row's `mutant-scored` event time.
- **History has no PSI:** every replayed block counts as PSI-readable and below 20%. So the replay can only show the rule
  firing TOO OFTEN, never too rarely: the guard only removes STOPs.
- **A1 (healthy):** NO STOP on any healthy run with event times. At least 20 healthy runs must be evaluable, or "not
  enough data". A healthy run without event times is reported as not evaluable and never counted as a pass.
- **A2 (degraded):** a STOP on email3 (run 1, or its resume) AND on file 2, before each run's end. The onset time is
  reported against bugs' onset (file 2: about 3-4 h in) and part 1's STOP points (email3 3.09 h).
- **A3 (informational):** queue2, email, subs, edocs.
- **The rule:**
  - If A1 and A2 both pass, the build goes ahead with these constants.
  - If either fails, NO runtime build. The result is reported, and any new constants need a new pre-commitment
    evaluated on data recorded after it.
  - The constants are not tuned on this replay.
