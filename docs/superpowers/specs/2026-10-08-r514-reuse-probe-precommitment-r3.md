> **R-514 reuse probe: pre-commitment r3 (amends r2 after a BLOCKED first run; written before
> any r3 run).** r2 is `docs/superpowers/specs/2026-10-08-r514-reuse-probe-precommitment.md`.
> Everything in r2 stands UNCHANGED except the three checks rewritten below (P4, M1, M2): the
> method, P1 to P3, P5 to P7, M3, the VOID and BLOCK rules, the 5 000 ms warm-up threshold and the
> 2 000 ms prediction. The script that implements r3 prints `R514 probe r3` as its first line.

## Run 1 (2026-10-08, Cronus28, lease 045): BLOCKED on P4, and stays recorded as a BLOCK

Log: `/coord/handoff/R-514/probe-run1.log`.

- **P4 FAILED.** Its check was "no `test_results` row with a NULL `mutant_row_id` in run 2". It
  found 5. Those 5 rows are R192 reuse's own copies of run 1's baseline: on a reused snapshot,
  `scoreBatch` calls `store.recordTestResult(runId, null, null, ...)` once per saved verdict, with
  the saved duration, and skips the `dispatchUnmutated` loop. Evidence: run 2's first row,
  `Hang Tests.CountUpToReachesTheLimit` at 178 ms, is run 1's baseline row (M3 printed run 1's
  first baseline row as the same test at 178 ms), and the `resume-baseline-reused` warning fired
  exactly once, naming run 1's batch 0. So the check measured the store's bookkeeping, not
  whether BC was called unmutated. It could not tell the fix right from wrong.
- **M1 and M2 were NOT measured.** Both read the first run-2 row per test, which was the copied
  baseline row, not a call made in run 2. M1's "73 ms" and M2's figures are run 1's baseline
  durations minus run 2's medians, i.e. M3 again. M2 for `DrainQueueEmptiesTheQueue` had no
  steady-state rows at all (median `?`), so it printed FAIL with nothing measured.
- **Supporting evidence from run 1 (not re-judged; quoted from the log):**
  - P1 PASS: rejected with `Error: R514 probe: planned stop before the second mutant`.
  - P2 PASS: run 1 mutant rows `[34 lethal.empty-block killed]`.
  - P3 PASS: run 1 snapshots `[0]`, `suspect_snapshots` 0.
  - P5 PASS: 38 mutants, 1 carried (34 `lethal.empty-block`), `baselineGreen` true, errors 0,
    `quarantined` undefined.
  - P6 PASS: killed 24, survived 9, timeout-killed 5; 0 per-mutant differences; 0 with cause
    `reused-budget-stale`/`unstable`/`stranded`.
  - P7 PASS: 5 timeout confirm rows:
    - M0004 line 37: timeout 20 097 ms, confirm `CountUpToReachesTheLimit` pass 90 ms
    - M0008 line 43: timeout 20 081 ms, confirm `CountUpToReachesTheLimit` pass 93 ms
    - M0009 line 44: timeout 20 081 ms, confirm `CountUpToReachesTheLimit` pass 94 ms
    - M0019 line 73: timeout 20 084 ms, confirm `WalkOneRowVisitsExactlyOneRow` pass 84 ms
    - M0035 line 145: timeout 20 086 ms, confirm `SpinUntilReachesTheTarget` pass 102 ms
  - Teardown: `force-reset-lease OK`.

The way forward is this r3 and a FULL re-run (run 1 and run 2 again). Run 1's P5 to P7 are
supporting evidence only; r3's run must pass them again on its own.

## Corrected checks (r3)

**P4 (r3).** Exactly one `resume-baseline-reused` warning, naming run 1's batch 0 (unchanged), AND
no unmutated BC dispatch in run 2 before mutant 2's first covering run. Proven by a dispatch
counter, NOT by store rows or durations.

What counts as unmutated, from the backend API (`packages/runner/src/backend.ts`,
`bcdev-backend.ts`):

- On bcdev, `activate(mutantId)` makes no network call. It only records the pending mutant id
  (`null` = no mutant). The NEXT `run(ref, opts)` or `runMany(opts)` sends that id to RunMutant
  (`pendingMutantId ?? ""`), and RunMutant clears the active mutant after itself.
- So the only calls that dispatch a test to BC are `run` and `runMany`, and a dispatch is
  UNMUTATED iff the last `activate` argument before it was `null`, or there was no `activate` yet.
- Run 2's backend is a subclass that mirrors the last `activate` argument and appends it to an
  ordered log on every `run` and `runMany` call (before calling the real method; a retried `run`
  is logged twice, which is the strict direction). P4 passes iff the log has a mutated entry and
  ZERO `null` entries come before the first one. The first mutated dispatch is mutant 2's first
  covering run: mutant 1 is carried and never activated.

Why it cannot be fooled:

- **The R514 confirms** are real unmutated dispatches (`activate(null)` then `run`). They are
  logged as `null`, but each follows a mutant's covering timeout, so it sits AFTER the first
  mutated entry and does not count toward P4. The script prints the total of unmutated dispatches
  as context; it is not checked.
- **ClearActive / `activate(null)` alone** (the baseline phase's `activateOnce(null)`, the
  teardown deactivate) dispatches nothing on bcdev, so the counter does not log it. If one were
  followed by a `run` before the first mutant, that `run` WOULD be logged as unmutated and P4
  fails, which is exactly the case P4 exists to catch.
- **R192's copied baseline rows** are written to the store without a dispatch, so they never
  reach the counter.

**M1 (r3).** Run 2's FIRST `test_results` row with a non-null `mutant_code` (the first real call
after the publish): its `duration_ms` minus the median `duration_ms` of the same test's LATER rows
(higher row id) in run 2 with a non-null `mutant_code` and outcome `pass`. No steady-state rows:
FAIL, as in r2.

**M2 (r3).** The same "first mutant-covered row minus the median of that test's later
mutant-covered `pass` rows", computed per test whose first mutant-covered row exists. A test with
NO mutant-covered row in run 2 is SKIPPED and NAMED in the output, not a FAIL. A test whose first
mutant-covered row has no LATER mutant-covered `pass` row to compare against is also SKIPPED and
NAMED (with its first row's outcome and duration): it has no steady state, so there is nothing to
measure. Run 1's `DrainQueueEmptiesTheQueue` is the expected case: its covering mutants (lines
101 to 107) are all killed, so its mutant-covered rows are all `fail`.

Prediction (unchanged): M1 at most 2 000 ms; every measured M2 at most 2 000 ms. What each band
changes is r2's "What result changes the plan", unchanged (above 5 000 ms: add the warm-up before
R514 closes; above 2 000 ms and at most 5 000 ms: record it and file a re-measure item).

**Orchestrator ruling on the M2 skip (added before any r3 run).** The skip rule above is accepted:
a test with nothing to compare is skipped and named, never a FAIL. But I1 must still be ANSWERED.
M1 must be measured, and at least 3 of the 5 tests must yield a measured M2. If fewer do, the
first-call cost is unanswered and the probe is a BLOCK on I1 (not a pass), to be re-planned with a
fixture or ordering that gives each test a steady state.
