> **R-499: itest:hang pre-commitment (written before any live run).** R-499 adds a bounded drain
> (`CONTROL_DRAIN_MS` 5 000) of in-flight control requests at the exit of `run`,
> `runWithCoverage` and `runMany` before a scored result is returned, and once more at session
> teardown. It throws if the bound expires. Prediction: every frozen figure of all three legs is
> UNCHANGED (`STOP_GRACE_MS` 30 000, budget 20 000).
> ON: 38 mutants, killed 24, survived 9, timeout-killed 5, errors 0, the `EXPECTED_ON` table and
> kill positions unchanged, `warmKills` 4, `groupedCalls` 42, `session-reused` 0, `manyDistinct`
> 37, not quarantined. SINGLE: the same 38 verdicts, every kill at position 1, 5 timeout-killed,
> errors 0, `stopped-after-completion` 0, `stop-outcome-unconfirmed` 0, `groupedCalls` 0,
> `warmKills` 0, equal per mutant to `hang.single.baseline.json` (not re-recorded). OFF:
> `timeoutKilled` 0, quarantined, a `deadline-exceeded` row and no `timeout` row. Every timeout
> row's `duration_ms` stays in [20 000, 50 000). No mutant's `failureNote`, no
> `killingTestFailure` and no `test_results.failure_message` contains "R499". No leg's session
> ends with an R499 expiry error (`ControlDrainTimeoutError`). No baseline file is deleted or
> re-recorded. Any difference is a regression: a BLOCK, never a re-record.

To be committed as `docs/superpowers/specs/2026-10-08-r499-hang-drain-precommitment.md` BEFORE the
live run (plan r3 section 4). Built at `lethal/r499` 193257c8 (code) / 96e9f7fd (docs).
Amendment from the orchestrator applied: the expiry throws the typed `ControlDrainTimeoutError`
(extends Error directly), and its message still begins "R499:", so the "contains R499" checks above
still catch it.
