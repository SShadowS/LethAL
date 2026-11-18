# PR-132 (R1113), spec-light: print the recovery steps on a quarantine; tell the user the baseline runs the whole test app

Coord PR-132 (lethal-code, 2026-11-17). Offline only: no bc4 calls. Found by PR-67's DO pilot (R1113): one hanging baseline test,
outside the `--only` scope, quarantined a whole bcdev run, and the message named no next step.

## What is known, and what is not
- **Known:** the hang (`CDO Azure Blob Folder Tests.Uniqueness_ThreeWayCollision_Errors`), the quarantine, and the recovery that
  worked: a service-tier restart, then `lethal force-reset-lease`, then `lethal clear-quarantine`.
- **NOT known:** why the test hung.
  - DO's test app sets `TestHttpRequestPolicy` nowhere.
  - BC's documented default for test codeunits is, to my knowledge, `BlockOutboundRequests`. Under that default a real outbound
    call fails fast; it does not hang. R1113's "real outbound HTTP call" is therefore a hypothesis, not a finding.
  - A pre-run HTTP warning is NOT built here. Measuring the default first, with a probe on bc2 or bc3 under its own lease, is
    the follow-up (noted in R1113).

## The change
1. **On a quarantined bcdev run** (the branch in `cli.ts` that keeps the scratch folder), print the recovery steps from a pure
   function `quarantineRecoverySteps({ server, instance, configPath })`:
   ```
   [lethal] the run is quarantined. To recover:
     1. If the message above says the lease must not be trusted until an NST restart (R658), restart the BC service tier
        of <server> / <instance> first.
     2. lethal force-reset-lease --server <server> --instance <instance> --config <configPath>
     3. lethal clear-quarantine --config <configPath>
     4. Run again. If the test that hung is outside your scope, leave it out with --exclude-test <Codeunit.Method>, or run
        only the covering tests at baseline with --tests-only <glob>. Both can change a verdict; the report flags
        'tests-narrowed'.
   ```
   - The server, instance and config are the run's own (`resourceIdentityFor`, the `--config` path).
   - No new event type and no new report field: it is a console note beside "kept scratch folder", like that line.
2. **The dry run's `tests:` line** gains: "the baseline runs every test in it; one test that hangs quarantines the run
   (R1113): `--tests-only <glob>` narrows the baseline when you know the covering tests". It is printed on bcdev only, where
   the quarantine exists.
3. **The README's recovery block** ("Recovery, when a session died mid-run") adds the restart as its first step, for the R658
   case.

## Predictions (pre-committed)
- **Unit tests, each red when its rule is reverted:**
  - `quarantineRecoverySteps` names the server, the instance and the config in steps 2 and 3, and the restart in step 1;
  - the CLI prints it on a quarantined bcdev run and NOT on a clean one;
  - the dry-run line appears on bcdev and not on al-runner-v3.
- **No gate figure moves:** console text only, with no warning code. VERIFY and CI.
