> **R-508: live-gate pre-commitment (r2; written before any live run).** R-508 makes a lease
> lost mid-batch discard that batch's verdicts in the results STORE. It uses
> `store.invalidateBatch`, the same rewrite the attestation gate already uses, and it removes the
> batch's R192 baseline snapshot through a new lease-only `dropBaselineSnapshot` [r2]. The write
> happens twice. First, synchronously, at the moment of loss (`LeaseSession.noteLeaseLost` →
> `onLost`) [r2]. Second, in the teardown `finally` of `runSession` and `runNamedMutants`: the
> event is emitted first, then the write, before a late refusal can throw [r2]. A failed second
> write throws `LostBatchNotStoredError` [r2]. The attestation gate's path is unchanged [r2].
> There is no schema change, no migration and no `IDENTITY_SCHEME` change.
>
> No gate leg loses a lease or resumes a run, so the new code never fires live. EVERY frozen
> figure below is therefore UNCHANGED. The gate is a NO-REGRESSION witness only; the unit tests
> in the plan's "Tests" section are the evidence for the fix. Any difference is a regression: a
> BLOCK, never a re-record. No baseline file is deleted or re-recorded.
>
> [r2] (M3) r1's "in every leg" bullets (no lease-lost `batch-invalidated`, no lease-lost
> `failure_note`, snapshots untouched) are DROPPED. `hang.itest.ts` does not read events,
> `failure_note` or `baseline_snapshots`, so no one would have checked them.
>
> **`itest:hang` (Cronus28, REQUIRED).** These are the checks the gate itself asserts.
>
> - **ON:**
>   - 38 mutants: killed 24, survived 9, timeout-killed 5, errors 0.
>   - The `EXPECTED_ON` table and the kill positions are unchanged.
>   - `warmKills` 4, `groupedCalls` 42, `session-reused` 0.
>   - `sessionLiveness`: `missing` 0, `manyDistinct` 37, and `singleRows` equal to `singleDistinct`.
>   - Not quarantined, and `baselineGreen` true.
>   - Caveats `stop-hung-sessions` and `session-warm`.
>   - Every timeout row carries "stopped the session" and "StopSession", with `op_kind` many.
> - **SINGLE:**
>   - The same 38 verdicts, with every kill at position 1.
>   - 5 timeout-killed, errors 0.
>   - `stopped-after-completion` 0 and `stop-outcome-unconfirmed` 0.
>   - `groupedCalls` 0 and `warmKills` 0.
>   - `baselineGreen` true, and caveat `stop-hung-sessions`.
>   - `op_kind` is not many.
>   - Equal per mutant to `hang.single.baseline.json`.
> - **OFF:**
>   - Fewer than 38 mutants, and `timeoutKilled` 0.
>   - An error noting "could not be confirmed complete".
>   - A `deadline-exceeded` row and no `timeout` row.
>   - Quarantined, with `baselineGreen` true, and not `all-errors`.
> - **Every leg:**
>   - Exactly one R447 `hang-refused` row (2 sites in 1 file), named in `scoreDescribes`, with
>     reliability `narrowed`.
>   - Every timeout row's `duration_ms` is in [20 000, 50 000).
>   - Teardown prints `force-reset-lease OK`, not `teardown FAILED`.
>   - No leg emits `lease-renew-unanswered`, `lease-release-failed`, `lease-marker-read-failed`,
>     `lease-reconcile-failed`, `lease-poll-failed` or `lease-ownership-unconfirmed`.
>
> These figures are copied from the R-506 pre-commitment
> (`docs/superpowers/specs/2026-10-08-r506-body-bound-precommitment.md`, itest:hang paragraph).
> Before the run, the builder re-reads `packages/runner/itest/hang.itest.ts`. Any figure here that
> differs from the gate's constants, or any check here the gate does not assert, makes this a
> stale pre-commitment. Fix it BEFORE the run, never after.
