# R-425 pre-commitment: the reach-filter fields on `itest:verify` and `itest:agreement`

Addendum to `2026-10-04-r384-reach-precommitment.md`. Written before any live run of R-425's code.
Plan: `docs/superpowers/plans/2026-10-04-R-425-verify-report-filter-state.md`.

R-425 adds two fields to the verify JSON (schema v5) and changes nothing that decides `testsRun`, a
verdict, a count or a stderr line. So every value below follows mechanically from the `testsRun`
that R-384's pre-commitment already fixed, by these rules:

- `reachFilter` is present whenever verify got past the `coverage-mode-changed` check, and absent
  when it refused before that. Both gates run under `fenced` coverage without `--no-reach-filter`,
  so a present value is always `{"state": "on"}`, with no `reason` key.
- `results[].reachNarrowed` is true when the filter left at least one new test out of that row's
  request. Each unfiltered request is the row's covering tests plus every new test, so a row is
  narrowed exactly when some `newTests[].test` is missing from its `testsRun`, and the tests left
  out ("dropped") are `newTests[].test` minus `testsRun`. A skipped row carries no `reachNarrowed`.
- With zero new tests, nothing can be dropped, so every planned row is `false`.

The gate checks these through one helper, `assertReachFields` in
`packages/runner/itest/verify-reach-fields.ts`, which reads the JSON with `verify-read.ts`, so a
missing field fails as "unknown", never passes as "off". Every assertion is an ADDITION: no R-384
pin is changed.

## Gate 1: `itest:verify`

| Step | `reachFilter` | Row | `reachNarrowed` | Dropped |
|---|---|---|---|---|
| 3 | `{"state": "on"}` | ClampPercent `negate-conditional` | `false` | none |
| 3 | | LogAudit `negate-conditional` | `true` | `["Sandbox Tests.ZzC0206ClampRejectsAboveHundred"]` |
| 4 | `{"state": "on"}` | ClampPercent `negate-conditional` | `false` | none (N = 0) |
| 4 | | LogAudit `negate-conditional` | `false` | none (N = 0) |
| 4b | `{"state": "on"}` | each of the LogAudit then-block gap's two members | `false` | none (N = 0) |
| 5a `not-a-survivor` | absent; reads unknown, `not-decided` | no rows | | |
| 5b `unknown-artifact` | absent; reads unknown, `not-decided` | no rows | | |
| 5c `unknown-gap` | absent; reads unknown, `not-decided` | no rows | | |
| 5d `gap-has-no-survivor` | absent; reads unknown, `not-decided` | no rows | | |

Why step 3's LogAudit row is `true`: R-384 fixed its `testsRun` as `["Sandbox Tests.ClampPercentRuns"]`
and the one new test is `ZzC0206ClampRejectsAboveHundred`, which is therefore the one dropped.
ClampPercent's `testsRun` holds the new test, so nothing was dropped. All four step-5 refusals come
from resolving the request against the store, which happens before the coverage-mode check.

## Gate 2: `itest:agreement`

Step 3 only (no later step calls verify). N = 5 answer tests in `Harden Verify Answers`:
`IsLargeAtTheBoundary`, `CountInCategoryIgnoresOtherCategories`, `FirstAmountReadsTheFirstRow`,
`SetAmountRunsValidation`, `BonusForTwiceOnOneInstance`.

| Row | `reachNarrowed` | Dropped (as a set) |
|---|---|---|
| S1 `IsLarge` | `true` | the four answer tests other than `IsLargeAtTheBoundary` |
| S2 `CountInCategory` | `true` | the four other than `CountInCategoryIgnoresOtherCategories` |
| S3 `FirstAmount` | `true` | the four other than `FirstAmountReadsTheFirstRow` |
| S4 `SetAmount` | `true` | the four other than `SetAmountRunsValidation` |
| S5 `BonusFor` (skipped, marked equivalent) | absent | none |

`reachFilter` is `{"state": "on"}`. Each S1-S4 row's `testsRun` is its base test plus its own
killer (R-384), so the other four answer tests, `BonusForTwiceOnOneInstance` included, are dropped.

## Live red-check (itest:verify only)

An uncommitted edit that writes `reachNarrowed: false` on every planned row must fail step 3 on
LogAudit's `reachNarrowed` (predicted `true`). Restore, then re-run green.

## Undecided

Nothing. The order of step 4b's two rows is not decided, and the helper checks rows by id.
