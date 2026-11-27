# PR-466 (R1228 reopened): detect a slowing BC tier from passing-row durations — pre-commitment r1

lethal-code, 2026-11-27. Written BEFORE any ratio was computed on any store. Part 1 measures; part 2, a detector,
is built only if part 1's separation rule holds.

## The signal

- A mutant can make a passing test SLOWER (more work), but not faster than the same test on the unmutated app, up to
  noise.
- So for passing rows, the duration against the SAME test's baseline duration measures the tier, plus a one-sided
  mutant effect that a median damps.
- **The ratio:** r = d / b for every mutant row with outcome `pass` whose test (codeunit_id, method) has a `pass`
  baseline row (`mutant_code` NULL).
  - d and b are `own_duration_ms` when both are non-NULL (the test's own time, R963); else `duration_ms`. The source
    used is counted.
  - A row is skipped when b < 50 ms (timer noise dominates); the skipped rows are counted.
- **Two references per row:**
  - **REF-OWN:** the baseline of the same `run_id`;
  - **REF-FIRST:** the baseline of the chain's FIRST run in the store (a resume chain's first run).
  - REF-OWN is blind when a resume takes its fresh baseline on an already slow server. REF-FIRST is not.
  - Both are reported.
- **The curve:** the rolling median of r over N = 50 consecutive qualifying rows, in `test_results.id` order.
  - Where `mutant-scored` events exist, row → time via the event of the row's mutant (atMs).

## The data

- **Degraded:** PR-427 `email3` (runs 1 and 2: the resume), with bugs' onset at ≈ 5-6 h into run 1.
- **Unlabelled** (reported, but they count neither for nor against): PR-427 `email`, `edocs`, `edocs-rescore`,
  `queue2`, `subs`.
- **Healthy controls:** every other bcdev store under /coord/handoff with ≥ 500 passing mutant rows, found by the
  listing of 2026-11-27 (PR-67, PR-68, R-882, R-911, PR-347, PR-302bc, PR-309, PR-300, PR-460, PR-327, PR-287, PR-46,
  PR-391, PR-357, PR-396, …).
  - The list is fixed in the analysis output before any ratio is read.
  - These are gate and probe runs of ≤ 3 h on bc1-bc4 and Cronus.

## The candidate detector (fixed now)

- **D:** N = 50; WARN at a rolling median ≥ 2.0; STOP at ≥ 4.0, each held for 3 consecutive windows (150 rows) to
  ignore a lone spike. On REF-FIRST.

## Separation rule: a detector is built only if ALL hold

1. **No false STOP:** no healthy control reaches STOP anywhere.
2. **Few false WARNs:** at most 1 healthy control in 10 reaches WARN, rounded down. Each one is named, with its peak.
3. **email3 reaches STOP**, and reports:
   - when (row, time, hours into run 1);
   - how many mutants were scored between WARN and STOP, and after STOP;
   - set against bugs' 5-6 h onset.
4. **The unlabelled PR-427 runs** are reported with their peaks.
   - A STOP there is a FINDING about that run (to check with bugs), not a false positive.
   - If one reaches STOP, its window is named for bugs to confirm.

- If 1 or 3 fails, the thresholds are NOT tuned on this data. The result is "does not separate", and a new
  pre-commitment would be needed with fresh data.
- If 2 fails alone, WARN is reported, and STOP may still be built as the only action (stated).

## Part 2 (only if part 1 passes; a separate pre-commitment before code)

- **The design:**
  - WARN is a progress event;
  - STOP quarantines: stop scoring, keep the rows before the onset, and resume re-runs the rows after the onset, as
    PR-454 did;
  - REF-FIRST's baseline durations are kept across a resume.
- Red tests in both directions, an Opus review, VERIFY, the gates per selectLegs, and CI.
