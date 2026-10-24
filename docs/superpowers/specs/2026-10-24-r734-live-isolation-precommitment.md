# R734 live proof: pre-commitment (lane bugs, R-731, 2026-10-24)

Committed before any live run. Never edited after; changes go in a dated addendum file.

## What is proven
R734 changes how a batch that fails to compile is scored: the breaking mutants are isolated and scored
`error`, and the rest of the batch is redeployed under the same mutant ids and gets real verdicts. Unit
tests prove it on fakes. This run proves it on a real BC server (bcdev backend) with real alc.

## Setup
- Code: the submitted head of `lethal/r731` (R731 + R732 + R734). Its sha is recorded in the run log.
- Project: `fixtures/sandbox-app` with its test app as published by the setup script, on one of
  `bc1`/`bc2`/`bc3` (bcdev is proven on all three), under a coord lease. Same run flags as
  `itest:bcdev`'s main run, written to a scratch store and a `--out` report.
- **Run A:** the head, unchanged.
- **Run B:** a scratch copy of the same head with a fault injected in the scratch copy only: the emitted
  mutated text of exactly two mutants gets a trailing token that alc rejects. The two mutants, by
  identity key (file sha prefix omitted):
  - F1 `Sandbox Logic|IsOverBudget|lethal.return-value|1` (baseline: killed by OverBudgetDetected)
  - F2 `Sandbox Logic|ClampPercent|lethal.negate-conditional|1` (baseline: survived)
  The fault is applied where every compile of that spec sees it (isolation candidates and deploy alike).
  Nothing in the repo or on master changes.

## Predictions (any miss is a BLOCK)
- P1. Run A: every mutant's verdict and killingTest equal `packages/runner/itest/bcdev.baseline.json`
  (19 entries: 3 killed, 12 survived, 4 no-coverage), matched by identity key.
- P2. Run B: F1 and F2 are `error`, with no killingTest; each note names its own source file and line and
  at least one alc error code (`AL` + 4 digits).
- P3. Run B: each of the other 17 mutants has the same verdict and killingTest as in Run A.
- P4. Run B: exactly one row per mutant (19 rows); exactly one `compile-isolation` warning; the failing
  batch is published once (the redeploy), not twice.
- P5. Neither run reports a corrupt store, a stranded mutant or a quarantine.

## Not claimed
No figure about compile counts or wall time on BC. No claim about al-runner-v3 (covered by its gate and
the unit tests). No claim about k > 2 or the 64-compile cap (unit tests only; R735 is the scale fix).
