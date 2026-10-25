# R759: `lethal verify` honours the source run's recorded narrowing: live pre-commitment (lane bugs, R-759b, 2026-10-25)

Committed before the live run. Never edited after; changes go in a dated addendum file.
Plan: `/coord/handoff/R-759b/plan.md`. Branch `lethal/r759` (from `lethal/r745`).

## Setup
- Code: the head of `lethal/r759` at the run (sha in the driver log). Contrast build: `/work/lethal-wt/r745`
  (`lethal/r745`, which records no narrowing in the store and whose verify treats a left-out test as new).
- Server: bc1 (or bc3 if bc1 is unavailable; same predictions), under a lane-bugs lease. No `bc-linux-setup.ts`
  server run (R-689b freeze); configs by `--write-config-only`. The server's control version is recorded from
  `lethal doctor` first (1.0.0.23 or 1.0.0.24; both are accepted).
- Probe: `scripts/r740-probe/` at id SET 1, built offline (`/coord/handoff/R-759b/probe-build.md`):
  L1 R740 Probe Lib 1.0.0.1 `c24fb61a8a85cb988e2279328824df12fbd21914cf669e4b641526a7e796c8b7`;
  L2 R740 Probe Lib 1.0.0.2 `e0f9c725c7bf04e15c04a743237e107edb57a082d035b8ff9a077c1f65df62ee`;
  P R740 Probe Target 1.0.0.1 `d86ca85da6aa9010b9991561e35895852a895d44a24a724520c3101ce68dd09a`;
  Q R740 Probe Tests 1.0.0.1 `3656bbcd178a3a940e9a3cfa9963246dcd231b95c45908181a923ff7df277357`.
- Sequence (not `--all`, so the instrumented target stays published for verify): step 1 (read-back must show only
  1.0.0.1 rows of set 1, else stop and mint a set 3 under an addendum), step 2, step 3 with
  `--exclude-test "R740 Tests.TestLib"`; V1 = the R759 build's `lethal verify --db <step 3's store> --artifact <its
  artifact id> --tests scripts/r740-probe/tests --survivors <Scale's two mutant codes> --config
  fixtures/sandbox-app/lethal.config.<server>.json`; V0 = the same command from the R745 build on the same store; then
  step 4 and cleanup.

## Predictions (any miss is a BLOCK until explained)
- P1-P7: step 3's run as R-745's live proof (pre-commitment 569960e2 with addendum 1 b39ee555's corrected P6: caveats =
  `baseline-red`, `session-warm`, `kills-without-assertion` plus `tests-narrowed`).
- P7b. The run's store row records `test_narrowing` = `{"testsOnly":[],"excludeTests":["93840::TestLib"]}`.
- P8 (V1): exit 6; `refused.reason` = `no-tests-to-run`, its detail naming both Scale mutants; `excludedTests` =
  `[{"test":"R740 Tests.TestLib","reason":"exclude-test"}]`; `newTests` = []; `results` = []; all counts 0; no
  `verifyRunId`, no test-app compile or publish; stderr names TestLib. (TestPlus and TestFails have baseline rows, so
  they are not new; TestLib is left out; Scale's two no-coverage mutants have no covering tests.)
- P9 (V0, the R745 build): TestLib is planned as a new test; the test app's compile against L2 fails because the
  library member is gone: exit 6, `test-app-compile-failed`, no `excludedTests` field.
- P10: step 4's read-back is unchanged by verify (verify published nothing); cleanup reads every probe app back
  absent; no quarantine record.

## Not claimed
The probe's test app cannot compile against L2, so verify never reaches test execution here: "verify leaves TestLib out
and names it" is shown through a pre-compile refusal, with V0 as the contrast. Execution-side exclusion is covered by
unit tests T1/T2/T5.
