> **R-503: itest:hang pre-commitment (written before any live run; r2).** R-503 bounds each
> `GetOperationStatus` poll of the grouped call's watchdog: the poll passes `timeoutMs` and is
> wrapped in `bounded(...)` with the same bound, `min(KEPT_ANSWER_READ_MS 15 000, what is left of
> the call's hard cap)`. A poll that times out counts as a failed poll and polling goes on.
> Prediction: every frozen figure of all three legs is UNCHANGED (`STOP_GRACE_MS` 30 000, budget
> 20 000), because live polls answer well inside the bound.
> ON: 38 mutants, killed 24, survived 9, timeout-killed 5, errors 0, the `EXPECTED_ON` table and
> kill positions unchanged, `warmKills` 4, `groupedCalls` 42, `session-reused` 0,
> [r2] `sessionLiveness` `missing` 0, `manyDistinct` 37, `singleRows` equal to `singleDistinct`,
> not quarantined, [r2] `baselineGreen` true, caveats `stop-hung-sessions` and `session-warm`;
> every timeout row carries "stopped the session" and "StopSession", `op_kind` many.
> SINGLE: the same 38 verdicts, every kill at position 1, 5 timeout-killed, errors 0,
> `stopped-after-completion` 0, `stop-outcome-unconfirmed` 0, `groupedCalls` 0, `warmKills` 0,
> [r2] `baselineGreen` true, caveat `stop-hung-sessions`, `op_kind` not many, equal per mutant to
> `hang.single.baseline.json` (not re-recorded).
> OFF: fewer than 38 mutants, `timeoutKilled` 0, an error noting "could not be confirmed
> complete", a `deadline-exceeded` row and no `timeout` row, quarantined, [r2] `baselineGreen`
> true, not `all-errors`.
> [r2] Every leg: exactly one R447 `hang-refused` row (2 sites in 1 file), named in
> `scoreDescribes`, reliability `narrowed`.
> Every timeout row's `duration_ms` stays in [20 000, 50 000). No baseline file is deleted or
> re-recorded.
>
> [r2] **The trace is the evidence.** The run sets `LETHAL_R289_TRACE` to a new file outside the
> repo. That file holds ZERO `poll-failed` lines and at least one `poll-ok` line. Where the OFF
> leg's store is readable, its `deadline-exceeded` row's `failure_message` reads `polls failed 0`
> (the gate does not assert this; if it cannot be read, the receipt says so). The largest
> `at - sentAt` over the `poll-ok` lines, and their count, are recorded in R503 as measured.
>
> No mutant's `failureNote`, no `killingTestFailure` and no `test_results.failure_message`
> contains "GetOperationStatus gave no answer". [r2] This check is kept but is NOT evidence: the
> poll's error reaches only the trace, so it is empty by construction. No leg's session ends with
> a `ControlDrainTimeoutError`. Any difference, and any `poll-failed` line, is a regression: a
> BLOCK, never a re-record.

To be committed as `docs/superpowers/specs/2026-10-08-r503-hang-poll-bound-precommitment.md`
BEFORE the live run (plan r2 section 6).
