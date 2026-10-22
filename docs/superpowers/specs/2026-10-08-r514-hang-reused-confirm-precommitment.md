> **R-514: live-gate pre-commitment (r2; written before any live run).** R-514 changes one thing,
> and only on a batch whose baseline was REUSED from a stored snapshot (R192,
> `resume-baseline-reused`). A covering run that answers `timeout` at group position 1 is no longer
> scored `timeout-killed` at once. The test is run once more with no mutant active, at
> `max(budget, baselineTimeoutMs)`, and the kill stands only if that run passes in at most HALF the
> budget [r2]. Otherwise the mutant is an `error`, with the new cause `reused-budget-stale` or an
> existing cause [r2]. On such a batch, a timeout at a later position (confirmed by the warm replay)
> uses the same half-budget rule [r2]. A batch whose baseline ran in this session is scored exactly
> as before. [r2] `lethal explain` moves to schema v14 for the new cause value; the gate reads no
> explain output.
>
> No `itest:hang` leg resumes a run: each leg opens its own scratch store and calls `runSession`
> with no `resume`, so `allowReuse` is false, no snapshot is ever reused, `baselineReused` is false
> on every batch, and no confirm is ever added. EVERY frozen figure below is UNCHANGED. The gate is
> a NO-REGRESSION witness only. The evidence for the fix is the unit tests in the plan's "Tests"
> section [r2] and the separate R-514 reuse probe (`2026-10-08-r514-reuse-probe-precommitment.md`).
> Any difference is a regression: a BLOCK, never a re-record. No baseline file is deleted or
> re-recorded.
>
> Not listed: anything about `baseline_snapshots`, `suspect_snapshots`, events or `failure_note`
> text in general. `hang.itest.ts` reads none of them, so no one would check such a bullet.
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
>     `duration_ms` is in [20 000, 20 000 + 30 000).
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
>   - [r2] (M1) `quarantined` undefined.
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
> warning codes the gate collects as diagnostics only. We still expect `force-reset-lease OK` and
> none of those codes, and report it if not, but a deviation there is a finding to investigate, not
> a gate failure.
>
> Before the run, the builder re-reads `packages/runner/itest/hang.itest.ts` (last changed by R499,
> 193257c8; `BUDGET_MS` 20 000, `STOP_GRACE_MS` 30 000, `EXPECTED_WARM_KILLS` 4). Any figure here
> that differs from the gate's constants, or any check here the gate does not assert, makes this a
> stale pre-commitment. Fix it BEFORE the run, never after. [r2] A confirm for fresh baselines is
> NOT part of R-514 (it is filed as its own item). A later change that adds one voids this text,
> because figures that read single rows (`singleRows`/`singleDistinct`) could then move.
