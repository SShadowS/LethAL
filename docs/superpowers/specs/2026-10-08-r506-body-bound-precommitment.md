> **R-506: live-gate pre-commitment (r2; written before any live run).** R-506 keeps the abort
> timer armed through the response BODY, and races the whole call with `bounded`, at the
> `HarnessVerifier` HarnessInfo and BC API list reads, the `DeploymentVerifier` RegisteredArtifact
> read, the permission canary, and `fetchPublishedAppPackage`. It deletes the `{}` default at the
> deployment check, and [r2] deletes the unused `postOData`/`MutationControlClient` outright. An
> unread or unparseable body now THROWS a typed error ([r2] `BcAnswerUnreadError` on the harness and
> deployment reads, never a `HarnessVerificationError`, so no control-app republish). The lease
> client moves onto the same shared helper, with `bounded`'s timeout told apart by identity.
> R507: on the lease path a refused redirect to BC's unfiltered `extensions` list propagates as
> `UnfilteredExtensionsQueryError` (latching the session and surfacing at teardown) instead of a
> `LeaseUnavailableError` labelled "unreachable"; any other refused redirect is relabelled
> "answered with a redirect that was not followed".
>
> Live answers from these calls arrive well inside their bounds (30 s; 120 s for the canary), and
> no gate leg stalls a body or meets a redirect, so EVERY frozen figure below is UNCHANGED. Each
> gate is a NO-REGRESSION witness only; the fix itself is evidenced by the unit tests (plan
> section 6). Any difference is a regression: a BLOCK, never a re-record. No baseline file is
> deleted or re-recorded.
>
> **In every gate:** the gate prints PASS; no session ends with a `BcAnswerUnreadError` or an
> `UnfilteredExtensionsQueryError`, and [r2] (M8) none ends with a `LeaseUnavailableError` naming
> any of the phrases below (the hang OFF leg's designed failure is not one); no warning or error text anywhere in
> the log contains "body not read within", "gave no answer within", "could not be read or parsed",
> "answered with a redirect that was not followed" or "refused unfiltered extensions query on the
> lease path" (the builder greps the gate's log; the gates do not assert this). Deployment
> verification reads `accepted` on every deploy (no `DeploymentError`, no `indeterminate`).
>
> **`itest:hang` (Cronus28, REQUIRED).** ON: 38 mutants, killed 24, survived 9, timeout-killed 5,
> errors 0, the `EXPECTED_ON` table and kill positions unchanged, `warmKills` 4, `groupedCalls` 42,
> `session-reused` 0, `sessionLiveness` `missing` 0, `manyDistinct` 37, `singleRows` equal to
> `singleDistinct`, not quarantined, `baselineGreen` true, caveats `stop-hung-sessions` and
> `session-warm`; every timeout row carries "stopped the session" and "StopSession", `op_kind`
> many. SINGLE: the same 38 verdicts, every kill at position 1, 5 timeout-killed, errors 0,
> `stopped-after-completion` 0, `stop-outcome-unconfirmed` 0, `groupedCalls` 0, `warmKills` 0,
> `baselineGreen` true, caveat `stop-hung-sessions`, `op_kind` not many, equal per mutant to
> `hang.single.baseline.json`. OFF: fewer than 38 mutants, `timeoutKilled` 0, an error noting
> "could not be confirmed complete", a `deadline-exceeded` row and no `timeout` row, quarantined,
> `baselineGreen` true, not `all-errors`. Every leg: exactly one R447 `hang-refused` row (2 sites
> in 1 file), named in `scoreDescribes`, reliability `narrowed`. Every timeout row's
> `duration_ms` in [20 000, 50 000). Teardown prints `force-reset-lease OK`, not `teardown FAILED`.
> No leg emits `lease-renew-unanswered`, `lease-release-failed`, `lease-marker-read-failed`,
> `lease-reconcile-failed`, `lease-poll-failed` or `lease-ownership-unconfirmed` with any of the
> phrases above.
>
> **`itest:bcdev` (Cronus28, recommended).** killed 3 / survived 12 / no-coverage 4 over 19, every
> per-mutant verdict equal to its committed baseline; `groupedCalls` 15; `warmKills` 0 with every
> kill at `killPosition` 1; zero `session-reused`; the store-level session-id liveness check
> passes; `assertionScreen.discrimination` `vacuous`.
>
> **`itest:tables` (Cronus284, optional).** killed 310 / survived 70 / no-coverage 22, every
> per-mutant verdict equal to its committed baseline; `untargetedTriggerCount` 0; `groupedCalls`
> 395 (380 + 15); `warmKills` 15; the `declarativeSites`, `platformArtifactKills`, assertion-screen
> twin-pair and filter-literal checks exactly as the gate's `EXPECTED` constants state; the named
> `Data Tests.PageActionComputesNonZero` handling exactly as the gate asserts it.
>
> **`itest:chunked` (Cronus284, optional).** Both legs killed 17 / survived 7 / no-coverage 2 with
> every verdict AND `killingTest` identical; control `warmKills` 9 / `groupedCalls` 33 with kill
> positions {1: 8, 2: 3, 3: 3, 4: 2, 5: 1}; chunked leg `warmKills` 5 / `groupedCalls` 57, the four
> named warm→cold kills and the five chunk replays exactly as the gate's `CHUNKED` constant states.
>
> **Not run:** `itest:alrunner` (no changed site is on the al-runner path), `itest:envtool`
> (host-only; the republish decision is unit-tested), `itest:lease` / `itest:testapp` (optional,
> no frozen figures; if run, every probe PASSES). [r2] Optional, and not a gate: `lethal doctor
> --config <the sandbox-app config>` against Cronus28, the only live witness for the HarnessInfo
> and API-list reads through doctor; if run, every check reads as it did before the change (no
> check newly failing, none with any phrase above).

To be committed as `docs/superpowers/specs/2026-10-<dd>-r506-body-bound-precommitment.md` BEFORE
the first live run (plan section 7). Read the build line each gate prints first.
