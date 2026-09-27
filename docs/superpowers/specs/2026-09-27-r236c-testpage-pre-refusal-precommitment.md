# Pre-commitment: R-236c TestPage pre-refusal on the live gates

Written and committed before any live run of the R-236c build (a4a151f). Nothing above
OUTCOME changes after a run.

## Container and protocol
`itest:tables` and `itest:chunked` run on Cronus284 (control app 1.0.0.20, sandbox-data pair
resident), under a coord lease; before them, Cronus284's orphaned probe lease (holder
SShadowS-PC:160544, pid confirmed gone) is cleared with `lethal force-reset-lease`, epoch
before/after recorded. `itest:bcdev` runs on Cronus28 (control app 1.0.0.20) under a coord lease
when free.

`itest:tables` cannot pass end to end at HEAD: `EXPECTED` holds 397 sites while GH-24's arm
generates 407 (docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md, section 5 and
OUTCOME). So it runs as GH-24's protocol RUN 1: `EXPECTED` set to section 5's figures in the
working tree only (407 sites, 301 / 68 / 18, score 301 / 369, groupedCalls 382, warmKills 13), the
committed `tables.baseline.json` KEPT. The edit is a patch in the scratchpad, reverted with
`git apply -R`, never committed.

## Predictions (every one BLOCKING)
1. `itest:tables` run 1: `assertVerdictTable` passes in full: `unsupportedTests` empty;
   `testPageRefused.tests` exactly `["Data Tests.PageActionComputesNonZero"]`; caveat
   `tests-testpage-refused` present and `tests-testpage-unsupported` absent;
   `baselineTests.failing` 0; `baselineGreen` false; counts 301 / 68 / 18; no quarantine; no
   `TestPageScanError`; `assertSessionLiveness` passes. The run then stops in
   `assertMatchesBaseline` with EXACTLY ten "present in after but missing from before"
   differences, all `Data Reach Ops`, and ZERO differences of any kind on the 377 existing mutants
   (verdict, killingTest, coverageFiltered, errorClass). The four `Data Value Card` /
   `Data Value Source` mutants stay `no-coverage`.
2. In that run's store, `Data Tests.PageActionComputesNonZero` has one `test_results` row per
   session, outcome `skip`, message starting "not run: LethAL refused this test before sending it".
3. `itest:bcdev`: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, `vacuous`; no `testPageRefused`.
4. `itest:chunked`: PASS, both legs 17 / 7 / 2 with identical verdicts and killingTest, control
   warmKills 9 / groupedCalls 33, chunked 5 / 57; its reports carry
   `testPageRefused.tests == ["Data Tests.PageActionComputesNonZero"]`.

A verdict or field difference on any existing mutant, a count other than predicted, a
`TestPageScanError`, or a `tests-testpage-unsupported` caveat on a sandbox-data run is a BLOCK,
filed before anything else moves.

## OUTCOME
(Filled in after the runs.)
