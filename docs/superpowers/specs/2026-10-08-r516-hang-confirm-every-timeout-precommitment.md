> **R-516 + R-515: `itest:hang` pre-commitment (r2; written before any live run).** [r2] Revised
> for the plan-r1 review: M1 (the exact row query, a per-mutant count of exactly 1, and a negative
> check on line 145). Scope: bcdev only; nothing here is about al-runner `--server`.
>
> What changes on this gate: every covering run that answers `timeout` at group position 1 is now
> confirmed by ONE unmutated `RunMutant` call of the same test, at `max(budget, baselineTimeoutMs)`
> = max(20 000, 120 000) = 120 000 ms, before it is scored. The kill stands only if that call passes
> in at most HALF the budget (10 000 ms). A warm replay (position > 1) also uses the half-budget
> rule now. R515's re-budget fires only after a passing confirm, and on this fixture it never raises
> a budget (each confirm is far below 10 000 ms, so `2 x c` < the 20 000 floor). The al-runner
> one-shot limit change does not touch bcdev. No leg resumes, so `reused-budget-stale` cannot occur.
>
> Expected, from the R514 probe r3 (Cronus28, the same five tests, the same confirm call): the
> confirms take 106 to 437 ms. Any confirm over 10 000 ms is a FAILURE of this pre-commitment (it
> would turn a kill into `timeout-unconfirmed`), never a re-record.
>
> Any difference below is a regression: a BLOCK. No baseline file is deleted or re-recorded.
>
> **ON** (`assertOnLeg`, grouped):
> - Exactly one R447 `hang-refused` row (2 sites, 1 file), named in `scoreDescribes`, reliability
>   `narrowed`.
> - `baselineGreen` true; 38 mutants; `counts.errors` 0 (so no `timeout-unconfirmed`,
>   `warm-timeout-unconfirmed` or `reused-budget-stale`).
> - Every `EXPECTED_ON` verdict and kill position, per mutant: killed 24, survived 9,
>   timeout-killed 5.
> - The 5 `timeout-killed`: lines 37, 43, 44, 73 at `killPosition` 1 and line 145
>   (`lethal.void-method-call`) at `killPosition` 2.
> - Each timeout row (`mutant_code` = the mutant, outcome `timeout`): BC's "stopped the session" and
>   "StopSession" words, `duration_ms` in [20 000, 50 000), `op_kind` many.
> - Caveats include `stop-hung-sessions` and `session-warm`; `quarantined` undefined.
> - `warmKills` 4; `groupedCalls` 42 (= 24 + 9 + 5 + 4: the confirms are single calls and add none).
> - No `session-reused` cause; `sessionLiveness.missing` 0, `answered` > 0, `manyDistinct` 37
>   (= 42 − 5), `singleRows` = `singleDistinct`.
> - NEW, not asserted by the gate today (see "Gate change" below): exactly 4 confirm rows for the
>   position-1 timeouts, one per mutant at lines 37, 43, 44, 73 (`mutant_code` NULL, `op_kind`
>   NULL, outcome `pass`, the mutant's killing test, `duration_ms` <= 10 000), and [r2] 0 such rows
>   for line 145. They raise `answered`,
>   `singleRows` and `singleDistinct` by 4 each against the same build without this change. Line
>   145's replay is unchanged: the same 2-method `RunMutantMany` replay, entry 2 passing in <=
>   10 000 ms.
>
> **SINGLE** (`assertSingleLeg`, `--no-group-runs`):
> - The same `hang-refused` row; `baselineGreen` true; 38 mutants; `counts.errors` 0.
> - No `stopped-after-completion`, no `stop-outcome-unconfirmed`.
> - Every `EXPECTED_ON` verdict, every kill at `killPosition` 1.
> - Exactly 5 `timeout-killed`, each with BC's stop words, `duration_ms` in [20 000, 50 000),
>   `op_kind` not many.
> - `groupedCalls` 0, `warmKills` 0, caveat `stop-hung-sessions`, `quarantined` undefined.
> - Equal per mutant (verdict, killingTest) to `hang.single.baseline.json`.
> - NEW, not asserted today: exactly 5 confirm rows, one per timeout-killed mutant (lines 37, 43, 44,
>   73 and 145), outcome `pass`, `duration_ms` <= 10 000; `answered`, `singleRows`,
>   `singleDistinct` each +5.
>
> **OFF** (`assertOffLeg`): unchanged. No stop flag, so no covering run answers `timeout` and no
> confirm is added. The same `hang-refused` row; `baselineGreen` true; not `all-errors`; fewer than
> 38 mutants; `counts.timeoutKilled` 0; at least one `error` noting "could not be confirmed
> complete"; a `deadline-exceeded` row and no `timeout` row; quarantined.
>
> **Gate change (pre-committed here, part of this build).** `hang.itest.ts` gains one check on the
> ON and SINGLE legs, so the new confirm is witnessed live (R514 had no fresh-batch witness): the
> query also reads `mutant_row_id` and `method` (`test_results` columns). [r2] (M1) A cold confirm
> row is exactly `mutant_code IS NULL AND op_kind IS NULL` (never "op_kind not many": SQL compares
> NULL as unknown). For every `timeout-killed` mutant at `killPosition` 1, taking `mutant_row_id`
> from its own timeout row, the COUNT of such rows with that `mutant_row_id` is exactly 1, and that
> row has `method` = the killing test, outcome `pass` and `2 x duration_ms <= BUDGET_MS`. Negative
> check, ON leg: line 145's mutant (`killPosition` 2) has exactly 0 such rows (its confirmation is
> the unchanged `op_kind` many replay). Expected totals: ON 4, SINGLE 5, pinned as numbers
> (`EXPECTED_COLD_CONFIRMS_ON = 4`, `_SINGLE = 5`), never read back from the report. Red-check offline is not possible (live gate); the builder states the query against a
> scratch store from a unit run that the row shape matches.
>
> Printed, not asserted: teardown `force-reset-lease OK`; lease warning codes as diagnostics.
>
> Before the run the builder re-reads `hang.itest.ts` (`BUDGET_MS` 20 000, `STOP_GRACE_MS` 30 000,
> `EXPECTED_WARM_KILLS` 4). Any figure here that differs from the gate's constants makes this text
> stale: fix it BEFORE the run, never after.
