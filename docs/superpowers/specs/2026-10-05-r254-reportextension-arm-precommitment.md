# R254 pre-commitment: the `reportextension` arm in `sandbox-data`

Status: FINAL, 2026-10-05. To be committed at build as
`docs/superpowers/specs/2026-10-05-r254-reportextension-arm-precommitment.md`, BEFORE any mutant
run. Plan: `/coord/handoff/R-254/plan.md` (r4). Every figure below was derived offline on branch
`lethal/r254` at 9e9068d3 (master 775dcdcd merged in, so R-452, R-454, R-455 and R-457 are in),
plus plan r4's code changes, in a scratch copy. Nothing here is left open: the live premises were
measured (M1, M2 below). If a mutant run differs from this file, that is a BLOCK, not
a re-record.

## What is predicted

The arm adds `report 79340 "Data Band Report"` (no code), `reportextension 79341 "Data Band Ext"`
(`src/DataBandExt.ReportExt.al`) and two tests in `codeunit 79310 "Data Tests"`:
`BandClassifiesDirectly` (calls `Band(3)` and `Band(2)` through the report variable, no report run)
and `BandReportSumsBands` (seeds four 'BAND' rows in `Data Related`, entry numbers 1 to 4, runs the
report, expects total 1+1+2+2 = 6). Engine: plan r4's build, including the symbol-table fix (the
reportextension's members are indexed for scope). IDENTITY_SCHEME **17** (amended at build: master
took 16 for R-364 while R254 was open, so 12 and 15, both once reserved for R254, stay unused; a
scheme number is not a gate figure).

Derived with `scripts/r214-capture.ts` (deployed rows, keys, `hang=`, `plat=`), mutant codes in
`assignMutantIds` order (file, then start offset, then operator name), and the specs' own
original and mutated text.

## Live premises (measured, not predicted)

- **M1, Cronus28, 2026-10-05.** Pair published: `sandbox-data` 1.0.0.11 and
  `sandbox-data-tests` 1.0.0.19 (plain, uninstrumented). `bcdev_test_run`, codeunit 79310, the two
  Band tests, `coverage: "procedure"`:
  - both tests PASS. `BandReportSumsBands` passing IS the unmutated seeded sum, 6;
  - `BandClassifiesDirectly` covers ONLY `22:79341` method `Band` (method id -911704490);
  - `BandReportSumsBands` covers `22:79341` `Band`, `GetTotal` (-19554105) and two trigger method
    ids (-1436085861, -60573562);
  - `Unreached` (-1904503862) is covered by no test; no row at all for object 79340.
- **M2, Cronus28, 2026-10-05.** `bcdev_test_run` on all of codeunit 79310: 69 of 70 pass.
  `NegationFlipChangesTheCount` fails ONLY inside one multi-test `bcdev_test_run` call, which has no
  rollback between tests (it passes alone, twice); the cause is `Data Related` rows written by five
  pre-existing tests. LethAL's own harness rolls back per test, so this is not a gate prediction and
  no gate figure rests on it. The 70 tests match offline discovery (70).
  Note (added at build, no figure changes): the per-test rollback is LethAL's, cited.
  `extensions/lethal-control/src/RunMany.Codeunit.al` runs each method of a `RunMutantMany` call as
  its own `CODEUNIT.Run` under the stock test runner, so `RequiredTestIsolation` applies per method;
  R198 measured no write leak between methods (`scripts/r198-group-runner-probe/`, E1 vs E7).
  `bcdev_test_run` lacks this, hence M2's multi-test failure.

## The oracle (15 mutants, file `src/DataBandExt.ReportExt.al`)

Failure text is a substring of `killingTestFailure`. Kill position counts from 1 in R197's order.
No mutant in the file carries a platform-kill tag (`plat=-` on all 15), none is hang-capable
(`hang=-`), the file has no R-454 refusal, and no other mutant may appear in the file.

| code | line | operator | mutation | verdict | killing test | pos | failure text |
|---|---|---|---|---|---|---|---|
| M0005 | 12 | empty-block | modify trigger body -> `begin end` | killed | BandReportSumsBands | 2 | `band total should be 6, got 0` |
| M0006 | 13 | remove-assignment | `Total += Band(BandItem."Entry No.")` removed | killed | BandReportSumsBands | 1 | `band total should be 6, got 0` |
| M0007 | 19 | empty-block | OnPreReport body -> `begin end` | survived (equivalent: Total starts at 0) | - | - | - |
| M0008 | 20 | remove-assignment | `Total := 0` removed | survived (equivalent) | - | - | - |
| M0009 | 20 | shift-integer | `0` -> `1` | killed | BandReportSumsBands | 2 | `band total should be 6, got 7` |
| M0010 | 24 | empty-block | Band body -> `begin end` | killed | BandClassifiesDirectly | 1 | `Band(3) should be 2, got 0` |
| M0011 | 25 | conditional-boundary | `N >= 3` -> `N > 3` | killed | BandClassifiesDirectly | 1 | `Band(3) should be 2, got 1` |
| M0012 | 26 | return-value | `exit(2)` -> `exit(0)` | killed | BandClassifiesDirectly | 1 | `Band(3) should be 2, got 0` |
| M0013 | 27 | return-value | `exit(1)` -> `exit(0)` | killed | BandClassifiesDirectly | 1 | `Band(2) should be 1, got 0` |
| M0014 | 31 | empty-block | GetTotal body -> `begin end` | killed | BandReportSumsBands | 1 | `band total should be 6, got 0` |
| M0015 | 32 | return-value | `exit(Total)` -> `exit(0)` | killed | BandReportSumsBands | 1 | `band total should be 6, got 0` |
| M0016 | 36 | empty-block | Unreached body -> `begin end` | no-coverage | - | - | - |
| M0017 | 37 | conditional-boundary | `N > 0` -> `N >= 0` | no-coverage | - | - | - |
| M0018 | 38 | return-value | `exit(N + 1)` -> `exit(0)` | no-coverage | - | - | - |
| M0019 | 38 | swap-additive | `N + 1` -> `N - 1` | no-coverage | - | - | - |

Totals for the arm: +9 killed / +2 survived / +4 no-coverage over 15.

**Why the positions.** The five trigger mutants (lines 12 to 20) have no member entry and take
object-level FALLBACK 1 (`selection.ts`), and M1 measured that BOTH tests cover object `22:79341`.
R197 orders covering tests by kills in the same scope this session, then fewest members covered
(`memberCountsByTest`: `BandClassifiesDirectly` 1, `BandReportSumsBands` 2), then name (which gives
the same order). So `BandClassifiesDirectly` runs first and passes, and the first kill in each
trigger is at position 2: M0005 (modify trigger) and M0009 (OnPreReport, after M0007 and M0008
survived). M0006 follows a kill in its own trigger, so its killer moves first: position 1. `Band`'s
mutants are killed by the narrower test at position 1. `GetTotal` is covered only by
`BandReportSumsBands` (M1), so position 1. `Unreached` is covered by no test (M1), so no-coverage.
Not a table trigger, so FALLBACK 2 never applies (`untargetedTriggerCount` stays 0). Line 13 has no
`swap-additive`: R294's implicit-with rule types nothing inside a `modify` trigger.

## Gate figures

### `itest:tables` (before = merged master 775dcdcd `EXPECTED`)

| figure | before | after |
|---|---|---|
| killed / survived / no-coverage | 301 / 68 / 18 | **310 / 70 / 22** |
| deployed / raw sites (`totalMutantSites`) | 387 / 407 | **402 / 422** |
| `mutationScore` | 301 / 369 (about 0.81572) | **310 / 380** (about 0.81579) |
| `groupedCalls` | 369 + 13 = 382 | **380 + 15 = 395** (11 arm mutants scored, 2 warm replays) |
| `warmKills` | 13 | **15** |
| `killPositions` | M0160 5 / M0164 4 / M0156 2 | **M0175 5 / M0179 4 / M0171 2** (same mutants, `DataMain.Table.al` 55 / 69 / 31, +15), plus **M0005 2, M0009 2** (`BandReportSumsBands`) |
| `platformArtifactKills.killedCount` | 4 (R-457) | **4**, same four mutants; the forced group's one killed mutant is `DataOps.Codeunit.al:96` flip-boolean-literal, code M0223 -> **M0238** (the gate pins it by procedure, file and line; only comments and one assertion message name the code) |
| `untargetedTriggerCount` | 0 | 0 |
| `unplaceableCount` | 0 | 0 |
| `assertionScreen.discrimination` | partial | partial (the arm's kills raise through bare `Error(...)`, so they join `flagged`; both populations stay non-empty) |
| `declarativeSites` | 1 in `src/DataMainList.Page.al` | unchanged |
| `notInstrumented` | the query, 1 file / 5 sites | unchanged (the reportextension no longer appears in `skipped`) |
| baseline | no failure; exactly `Data Tests.PageActionComputesNonZero` refused (R-236c) | unchanged |
| two-run determinism | identical | identical |

Baseline (`tables.baseline.json`) key diff, offline: **0 removed, 0 changed, 15 added**; all 387
existing keys identical, including their `plat=` tags.

### Other gates

- `itest:chunked`: **unchanged** (both legs 17 / 7 / 2, control `warmKills` 9 / `groupedCalls` 33,
  chunked 5 / 57, every `killingTest` identical). It runs `--only src/DataMain.Table.al`, whose
  codes restart, and the two new tests cover no `Data Main` code, so no covering set or member
  rank there moves.
- `itest:verify-scale` (reads `tables.baseline.json`): `SURVIVORS` 68 -> **70**,
  `COMMITTED_TESTS` 68 -> **70** (offline discovery: 70), scratch suite 73 -> **75**.
- `itest:bcdev`, `itest:alrunner`, `itest:envtool`: untouched (no reportextension in their
  fixtures).

## How it is checked

`packages/runner/itest/r254-arm-oracle.ts` holds the table above keyed by file+line+operator (not
by code). The gate runs it on both runs BEFORE `assertGateBaseline`; any difference fails the run,
so a record run cannot write a baseline that disagrees with this file. `EXPECTED.killPositions`
gains M0005 and M0009. A verdict, killer, position or failure text that differs is a BLOCK, not a
re-record.
