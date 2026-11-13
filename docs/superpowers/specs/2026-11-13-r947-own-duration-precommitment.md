# R-947 (R963) pre-commitment: a test row with no duration of its own is unknown, never the call's wall

Written 2026-11-13 by lane preproc, before the build and any measured run. Survey: `/coord/handoff/R-947/survey.md`.

## The change (design C: keep the field names, fix what each reader takes)

`TestVerdict.durationMs` stays the CALL's wall time (the budgets need the round trip). The test's own time is
`measuredDurationMs?`, absent = unknown (R272/R934/R914).
1. al-runner (`al-runner-rows.ts`, `v3RowVerdict`): every branch passes the row's own `durationMs` through as `measuredDurationMs`
   when the row has one; none is invented from the call's wall.
2. R515's confirm-based budget raise takes `measuredDurationMs` only: an unknown own time raises nothing. bcdev, one call per test,
   keeps its measured = wall.
3. R934's per-mutant time (`mutant-scored.durationMs`, the rate and timing lines) and the R914/R940 estimate count own times; a row
   with no own time is charged its call's wall once per call, not once per row.
4. The store gains a nullable `test_results.own_duration_ms` (NULL = unknown); `duration_ms` is documented as the call's wall.

## Expected results

- **Verdicts: none moves anywhere.** Budgets are unchanged except R515's raise, which no longer happens on a batch wall; on the gate
  fixtures (millisecond tests, no hung batch entry) it never fired on one.
- **The v3 gate and the bcdev gates: no figure moves.** They pin verdicts, killing tests and serve counters, not durations.
- **Moved, by design:** `mutant-scored.durationMs` and the per-mutant time in reports and rate lines, for mutants whose rows shared a
  call without own times (each call's wall is no longer charged once per row). Example to check: Password's IsPasswordStrong
  mutants. No committed sample report or snapshot is expected to move; if one does, it is reviewed and named.
