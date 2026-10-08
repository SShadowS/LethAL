> **R-504: itest:hang pre-commitment (written before any live run; r2).** R-504 keeps the lease
> client's abort timer (`postLeaseAction`, `cfg.timeoutMs ?? 30 000`) armed through the response
> BODY read, not only until the headers, and races the whole call with `bounded(...)` at the same
> bound. A timed-out lease call throws `LeaseUnavailableError`, which every caller already handles.
> [r2] It also stops `LeaseSession.pulse` from retrying a renew, or latching lease loss on a
> `renewed:false`, once `stop()` has run.
> The gate leases through `LeaseClient` (acquire, heartbeat, BeginPublish/EndPublish,
> GetOperationStatus, ReleaseLease, the OFF leg's reconcile, and the teardown's ForceResetLease).
> Prediction: every frozen figure of all three legs is UNCHANGED (`STOP_GRACE_MS` 30 000, budget
> 20 000), because live lease answers arrive well inside 30 s.
> [r2] No leg stalls a lease body live, so this run is a NO-REGRESSION witness only: it shows the
> bound cuts no live answer and the `pulse` guards move no figure. The fix itself is evidenced by
> the unit tests (plan section 4), not by this gate.
> ON: 38 mutants, killed 24, survived 9, timeout-killed 5, errors 0, the `EXPECTED_ON` table and
> kill positions unchanged, `warmKills` 4, `groupedCalls` 42, `session-reused` 0,
> `sessionLiveness` `missing` 0, `manyDistinct` 37, `singleRows` equal to `singleDistinct`, not
> quarantined, `baselineGreen` true, caveats `stop-hung-sessions` and `session-warm`; every timeout
> row carries "stopped the session" and "StopSession", `op_kind` many.
> SINGLE: the same 38 verdicts, every kill at position 1, 5 timeout-killed, errors 0,
> `stopped-after-completion` 0, `stop-outcome-unconfirmed` 0, `groupedCalls` 0, `warmKills` 0,
> `baselineGreen` true, caveat `stop-hung-sessions`, `op_kind` not many, equal per mutant to
> `hang.single.baseline.json` (not re-recorded).
> OFF: fewer than 38 mutants, `timeoutKilled` 0, an error noting "could not be confirmed
> complete", a `deadline-exceeded` row and no `timeout` row, quarantined, `baselineGreen` true, not
> `all-errors`.
> Every leg: exactly one R447 `hang-refused` row (2 sites in 1 file), named in `scoreDescribes`,
> reliability `narrowed`.
> Every timeout row's `duration_ms` stays in [20 000, 50 000). No baseline file is deleted or
> re-recorded.
> Teardown prints `force-reset-lease OK`, not `teardown FAILED`.
> No leg emits a `lease-renew-unanswered`, `lease-release-failed`, `lease-marker-read-failed`,
> `lease-reconcile-failed`, `lease-poll-failed` or [r2] `lease-ownership-unconfirmed` warning whose
> text contains "not read within" or "gave no answer within" (the builder reads the legs' collected
> warnings; the gate does not assert this). No leg's session ends with a `LeaseUnavailableError`
> naming either phrase.
> Any difference is a regression: a BLOCK, never a re-record.

To be committed as `docs/superpowers/specs/2026-10-08-r504-hang-lease-body-bound-precommitment.md`
BEFORE the live run (plan r2 section 5).
