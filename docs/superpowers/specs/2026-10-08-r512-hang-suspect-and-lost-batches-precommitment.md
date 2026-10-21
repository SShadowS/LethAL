> **R-512: live-gate pre-commitment (r2; written before any live run).** R-512 changes two things.
> (1) R512 [r2]: on the first run in a batch that answers `observedAny: false` before any clean
> attestation, the baseline snapshot in use (this run's own, or the one it reused) is marked in a new
> `suspect_snapshots` table. The mark is cleared on the batch's first clean attestation, and
> `findBaselineSnapshot` never lends a marked snapshot. The attestation gate itself is unchanged.
> (2) R513: a new `lost_batches` table, written first by `onLost` and again by
> `invalidateLostBatch`. `mutantVerdicts`, `findResumableRun` and its three siblings read a lost
> batch's rows as `invalidateBatch` would have left them, and `findBaselineSnapshot` skips a lost
> batch's snapshot. Both tables are created by `CREATE TABLE IF NOT EXISTS`. There is no `migrate()`
> step and no `IDENTITY_SCHEME` change.
>
> No gate leg resumes a run or loses a lease, so no leg reads a mark or a lost-batch row. [r2] A leg
> may WRITE and then clear a suspect mark in its scratch store, if a covered run answers
> `observedAny: false` before the first clean attestation. No asserted figure depends on that. EVERY
> frozen figure below is UNCHANGED. The gate is a NO-REGRESSION witness only; the unit
> tests in the plan's "Tests" section are the evidence for the fix. Any difference is a regression:
> a BLOCK, never a re-record. No baseline file is deleted or re-recorded.
>
> Not listed: anything about `baseline_snapshots`, `lost_batches`, `suspect_snapshots`, events or
> `failure_note` text in general. `hang.itest.ts` reads none of them, so no one would check such a bullet.
>
> **`itest:hang` (Cronus28, REQUIRED).** Only checks `hang.itest.ts` itself asserts:
>
> - **ON** (`assertOnLeg`):
>   - Exactly one R447 `hang-refused` row (2 sites in 1 file), named in `scoreDescribes`
>     ("; 2 hang-refused site(s) in 1 file(s) not mutated"), reliability `narrowed`.
>   - `baselineGreen` true; 38 mutants (`EXPECTED_ON.length`); `counts.errors` 0.
>   - Every `EXPECTED_ON` verdict and kill position, per mutant (killed 24, survived 9,
>     timeout-killed 5).
>   - Exactly 5 `timeout-killed`, one of them `lethal.void-method-call` at line 145.
>   - Every timeout row's message matches "stopped the session" and "StopSession", and its
>     `duration_ms` is in [20 000, 20 000 + STOP_GRACE_MS).
>   - Caveats include `stop-hung-sessions` and `session-warm`; `quarantined` undefined.
>   - `warmKills` 4; `groupedCalls` = scored + 4 (42).
>   - No `session-reused` cause; `sessionLiveness`: `missing` 0, `answered` > 0, `manyDistinct` =
>     `groupedCalls` − 5 (37), `singleRows` = `singleDistinct`.
>   - Every timeout row has `op_kind` many.
> - **SINGLE** (`assertSingleLeg`):
>   - The same `hang-refused` row; `baselineGreen` true; 38 mutants; `counts.errors` 0.
>   - No `stopped-after-completion` and no `stop-outcome-unconfirmed` cause.
>   - Every `EXPECTED_ON` verdict, with every kill at position 1.
>   - Exactly 5 `timeout-killed`, each with BC's stop wording and a duration in the same window,
>     and `op_kind` not many.
>   - `groupedCalls` 0, `warmKills` 0, caveat `stop-hung-sessions`.
>   - Equal per mutant to `hang.single.baseline.json`.
> - **OFF** (`assertOffLeg`):
>   - The same `hang-refused` row; `baselineGreen` true; not `all-errors`.
>   - Fewer than 38 mutants; `counts.timeoutKilled` 0.
>   - At least one `error`, one noting "could not be confirmed complete".
>   - A `deadline-exceeded` test row and no `timeout` row.
>   - Quarantined.
>
> Printed but NOT asserted (the person running the gate reads them; they are not pass criteria of
> the gate itself): the teardown line `force-reset-lease OK` (not `teardown FAILED`), and the lease
> warning codes (`lease-renew-unanswered`, `lease-release-failed`, `lease-marker-read-failed`,
> `lease-reconcile-failed`, `lease-poll-failed`, `lease-ownership-unconfirmed`), which the gate
> collects as diagnostics only. We still expect `force-reset-lease OK` and none of those codes, and
> report it if not, but a deviation there is a finding to investigate, not a gate failure.
>
> Before the run, the builder re-reads `packages/runner/itest/hang.itest.ts` (last changed by R499,
> 193257c8). Any figure here that differs from the gate's constants, or any check here the gate does
> not assert, makes this a stale pre-commitment. Fix it BEFORE the run, never after.
