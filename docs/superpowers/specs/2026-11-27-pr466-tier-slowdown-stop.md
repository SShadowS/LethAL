# PR-466 part 2 (R1228): the tier-slowdown STOP — design r1

lethal-code, 2026-11-27. The orchestrator's ruling (principle 1): build the STOP that part 1 permits.
- No WARN level (part 1's rule 2 failed).
- The STOP keeps the store resumable, and no restart is implied.
- Part 1: `2026-11-27-pr466-passing-row-slowdown.md` and `/coord/handoff/PR-466/findings.md`.
  - Healthy controls never STOP; email3 STOPs at 3.09 h and queue2 at 4.38 h.
  - The margin is thin: the healthy max block is 3.64 against 4.0. The threshold is a FIRST CUT, and (b)
    (`2026-11-27-pr466b-self-referenced-ratio.md`) may replace it.

## What it measures (exactly part 1's D, without WARN)

- **The rows:** every mutant `test_results` row the session records with outcome `pass` and a measured own duration
  (`ownDurationMs`), at the recording site in the mutant loop (orchestrator.ts `args.store.recordTestResult(...,
  t.ownDurationMs)` for rows with a mutant code).
  - Unmutated confirmation rows (no mutant code), baseline rows, carried and skipped rows never feed it.
- **The reference** per test (codeunit id + method) is the SMALLER of:
  - this run's passing baseline own duration;
  - on `--resume`, the prior run's (`priorRunId`) passing baseline own duration.
  - When a test has several of one kind, their median.
  - A row whose reference is missing, or below 50 ms, is skipped and counted.
  - **LIMIT, stated in the code and in R1228:** one level. A resume of a resume compares against its direct prior run
    only, because no run records the run it resumed.
- **Ratio** r = own duration / reference.
- **Blocks** of 50 consecutive ratios, in recording order across the session, with no overlap.
  - **STOP:** 3 consecutive blocks whose medians are each ≥ 4.0.
- **The onset** is the first row of the first of those 3 blocks.
- **Parallel workers:** rows from different lanes interleave in recording order, as in the store's id order, which is
  what part 1 measured.

## What the STOP does (PR-454's mechanism, reused)

- **One new latch:** `safety.latchUnsafe("tier-slowdown: …")`, with an exported `TIER_SLOWDOWN_REASON_PREFIX =
  "tier-slowdown:"`.
  - The session stops scheduling new mutants, exactly as for the renew stop.
  - The lease heartbeat is untouched.
- **The window:** `store.markDegradedWindow(runId, afterMutantId, afterSnapshotId, note)` at once, synchronous, never
  throwing; a failure warns `degraded-window-store-not-corrected`. The teardown writes again, as for the renew
  stop.
  - The window MUST contain the onset row's mutant both in the store (`m.id > afterMutantId`) and in the report fold
    (`mutant-scored` seq > `afterSeq`).
  - So the mark is taken for the block's first row BEFORE that mutant's row is inserted and before its
    `mutant-scored` event (or, equivalently, afterMutantId = that mutant's row id − 1, with afterSeq the scored seq
    before its event). A test proves both.
- **Events:**
  - `degraded-window` (afterSeq, reason) — no new event type;
  - `warning` code **`tier-slowdown-stop`**.
- **The message** names the measured ratio (the 3 block medians), the window (rows after X, events after Y, the
  onset's wall time) and that the threshold is first-cut. It implies NO restart:
  > [lethal] the BC tier slowed down: passing tests ran at 4.9×, 7.1× and 4.5× their baseline own duration over the
  > last 150 passing rows (blocks of 50; threshold 4.0, a FIRST CUT, R1228). The session stops scoring. Mutant rows
  > recorded after row X (after event Y, from <iso>) are dropped from the report and re-run by --resume. Whether the
  > tier needs a restart is not measured.
- **The report:** `quarantineInterpretationFor(reason)` gets a branch for the new prefix, with
  `TIER_SLOWDOWN_INTERPRETATION`: what was measured, that rows from the onset read as `error` and are re-run by
  `--resume`, and that the threshold is first-cut.
  - No new `SessionReport` field, no new caveat.
- **Resume:** the existing `resume-degraded-window` path re-runs the window's rows. Its message now reads the window's
  stored NOTE (`degraded_windows.note`) instead of hard-coding "stopped answering lease renews". The renew stop's
  wording is unchanged in effect.
- **Only the first stop counts:** if the renew stop or any other latch fired first, the slowdown monitor stops
  feeding. If the slowdown fired first, a later renew stop adds no second window: `INSERT OR IGNORE` on
  (run_id), as today.

## Where it lives

- A small class `TierSlowdownMonitor` in orchestrator.ts (or a new `tier-slowdown.ts`). It holds:
  - the reference map;
  - the current block;
  - the streak of blocks ≥ 4.0;
  - the onset mark of each of the last 3 blocks;
  - the skipped counts.
- `feed(row)` returns nothing. On the stop it calls injected `onStop(window, note, medians)`.
- **Constants exported:** `TIER_SLOWDOWN_BLOCK = 50`, `TIER_SLOWDOWN_STOP = 4.0`, `TIER_SLOWDOWN_HOLD = 3`,
  `TIER_SLOWDOWN_MIN_REF_MS = 50`.
- Every bcdev session gets one. al-runner sessions get none: their durations are not a BC tier's.

## Tests (red both ways)

1. **A stop fires on the 3rd consecutive block ≥ 4.0**, not on the 2nd, and not when a block below 4.0 interrupts the
   streak: red if HOLD or the reset is broken.
2. **A healthy-like stream never fires:** 3 blocks at 3.9, or many blocks with alternating 3.6 and 1.0.
3. **Exactly the onset block's first mutant onward is in the window:** in the store and in the report fold (a
   `degraded-window` event with afterSeq before that mutant's `mutant-scored`). Red if the window is off by one in
   either direction.
4. **The reference is the smaller of own and prior** on resume: a resume with a slow own baseline still fires against
   the prior run's faster one. Red if only the own baseline is used.
5. **Rows that must not feed:** non-pass rows, confirmation rows without a mutant code, and references below 50 ms
   (counted) never move a block.
6. **First latch wins:** a renew stop before → no slowdown window; slowdown first → a later renew stop writes no
   second window.
7. **The message and interpretation:**
   - the warning text names the ratios, the window and "FIRST CUT", and contains no "restart" instruction;
   - `quarantineInterpretationFor("tier-slowdown: …")` returns the new interpretation;
   - the resume message uses the stored note.
8. **al-runner sessions** construct no monitor.

## Gates

- Per `legs.ts` for the touched files. The frozen BC gates should not move: their runs are short and healthy (part 1's
  healthy controls include gate stores).
- Any `tier-slowdown-stop` in a gate is a BLOCK, to investigate.
