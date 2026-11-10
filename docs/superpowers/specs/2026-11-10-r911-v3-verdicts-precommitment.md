# R-911 pre-commitment: v3 kills shown on BC `no-coverage` rows (`--v3-verdicts`)

Committed before any live run, 2026-11-10. Coord task R-911 (owner's ruling on R908, step 4). Plan, reviews and rulings: `/coord/handoff/R-911/plan.md`.
Evidence goes to `/coord/handoff/R-911/`. No source text from BC.History is committed: app, test and procedure names and counts only.

## Setup

- **LethAL:** branch `lethal/r911` at the commit the proof runs on, recorded in each run's first line. It is built on `lethal/r907`.
- **Apps:** BC.History PaymentPractices and VAT Group Management, each with its test app, from ONE scratch tree per app, used by both runs.
  - **Amendment 1, before any BC run:** VAT Group Management replaces BankDeposits. BankDeposits' v3 leg under `--no-client` passed no test at baseline: 70 not run and 5 failed. So the join would refuse it ("none of the tests BC refuses passed on v3"). That is a finding for the owner, not a proof input.
- **v3 leg:** `lethal run --backend al-runner-v3` with `"alRunnerV3": { "noClient": true }`, no `--tests-only`, no narrowing, on the pinned al-runner build. Local, one heavy slot.
- **BC leg:** `lethal run --backend bcdev --v3-verdicts <that v3 report>` on a throwaway BC 28 server without Microsoft's own copies of the two apps: `bc5` (kraken questions `q-20261110T195756-eaeca11b` and `q-20261110T203601-afe9813f`). Not a gate server.
- Each leg writes `--out`, `--progress-out` and a scratch store.

## Properties that must hold (any failure is reported as a finding, never as a pass)

For each app:

1. **The join is accepted.** The BC run starts, and is not refused by `--v3-verdicts`. A refusal is a finding, and its reasons are reported verbatim.
2. **Verdicts do not move.** Replaying the BC run's own events without its `v3-verdicts-joined` event (`foldEvents`/`buildReport`) gives a report equal to the run's own in every row's `verdict`, in `counts` and in `mutationScore`.
3. **Kills only on `no-coverage` rows.** Every row with `v3Verdict` has `verdict: "no-coverage"`, no `failureNote`, and is not in `unplaceableMutants` for its batch.
4. **Only refused tests.** Every `v3Verdict.coveringTests` entry, and every `killingTest`, is in the BC run's `testPageRefused.tests`.
5. **Only v3 kills.** For every row with `v3Verdict`, the v3 report's row with the same identity key has `verdict: "killed"` and the same `killingTest`. No such row has `cause: "runner-refused"`.
6. **The counts add up.** `v3Verdicts.killed` equals the number of rows with `v3Verdict`. `killed + notShown.survived + notShown.timeoutKilled + notShown.otherVerdict` equals the number of eligible rows, recomputed independently from the two reports by the eligibility rule in the plan.
7. **The label is the killing test's own.** `killingTestFlagged` is present exactly when the v3 report's `testMethods` entry for the killing test has `baselineFlagged`, and `killedByFlaggedTest` counts those rows.
8. **The report says so.** The caveat `v3-verdicts-joined` is present, and the console output has its `NOT BC VERDICTS:` line.

## Not pre-committed

The number of kills. It depends on the v3 runs under `--no-client`, which do not exist yet. It is reported, per app, with R-906's census figure beside it, as context only.

## Gates afterwards

The v3 gate and `itest:bcdev` on the final head, then CI with both jobs green. No gate passes `--v3-verdicts`, so no frozen figure may move. Any moved figure is a BLOCK.
