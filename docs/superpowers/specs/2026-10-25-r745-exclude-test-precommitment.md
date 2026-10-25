# R745: `--exclude-test` live proof on R-740's probe shape: pre-commitment (lane bugs, R-745, 2026-10-25)

Committed before the live run. Never edited after; changes go in a dated addendum file.
Plan: `/coord/handoff/R-745/plan.md`. Probe: `scripts/r740-probe/` (on `lethal/r745`, with an `--exclude-test`
pass-through into step 3's `lethal run`).

## Setup
- Code: the head of `lethal/r745` at the run (sha recorded in the driver log).
- Server: `bc1`, under a lane-bugs coord lease. No `bc-linux-setup.ts` server run (configs by `--write-config-only`).
- Probe apps (id set 2, built offline by `drive.ts --build --server bc1`; `/coord/handoff/R-745/probe-build.md`):
  - L1 R740 Probe Lib 1.0.0.1 `47fb6fdde656e741562d69c22853dec5bcf43dd02a8683e191f00d02f08d0fd2`
  - L2 R740 Probe Lib 1.0.0.2 `2710c5d3f81289616e0b237909cc336ef1a1c8d95b11e944f30ecd28d0881a84`
  - P R740 Probe Target 1.0.0.1 `eec398ab8af61fbd5d4273677d4d7be81f05500839823c530608c72fe8901537`
  - Q R740 Probe Tests 1.0.0.1 `e794e3e056e92bfbfb7c2de3a75acc7d7d5b9ab2552898291e38a654ef8467e8`
- Steps as R-740's README: 1 publish L1, P, Q (read-back must show no prior set-2 rows on bc1; if it does, the run
  stops and a set 3 is built under an addendum); 2 publish L2 through LethAL's altool deployer; 3 `lethal run` with
  `--exclude-test "R740 Tests.TestLib"`; 4 read back, cleanup unpublishes Q, P, L.
- Reference: R-740's run 1 without the flag, `/coord/handoff/R-740/run1/report.json` (bc2), which refused with
  `StaleDependencyMemberError` naming `R740 Tests.TestLib`.

## Predictions (any miss is a BLOCK until explained)
- P1. L2 is accepted through altool.
- P2. The run exits 0; no `StaleDependencyMemberError`.
- P3. `tests-discovered` lists exactly `R740 Tests.TestPlus` and `R740 Tests.TestFails`; `excludedTests` is exactly
  `[{test: "R740 Tests.TestLib", file: "src/Tests.Codeunit.al", reason: "exclude-test"}]`; one warning
  `exclude-test-narrowed-baseline` names `R740 Tests.TestLib`; no baseline or test event names `TestLib`.
- P4. `R740 Tests.TestPlus` passes at baseline; `R740 Tests.TestFails` fails with its genuine failure;
  `unsupportedTests` is exactly {`R740 Tests.TestFails`}.
- P5. Per mutant, verdicts as R-740's measured probe shape: Scale's 2 mutants `no-coverage`; Plus's 3 mutants
  `killed` by `R740 Tests.TestPlus`.
- P6. `validity.caveats` is exactly `["tests-narrowed"]`; reliability reads narrowed; the console banner has a
  `TESTS EXCLUDED` line naming `R740 Tests.TestLib`; score 100.0%.
- P7. Cleanup reads every probe app back absent; no quarantine record is written.

## Not claimed
No wall time. Nothing about al-runner-v3 (refused by name with `--exclude-test`; unit test T6). The grouped
RunMutantMany path has no unit stub; this run exercises whatever grouping the bcdev backend chooses for 5 mutants.
