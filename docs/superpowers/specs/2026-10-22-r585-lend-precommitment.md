# R-585: pre-commitment for itest:lend and itest:bcdev on the R-585 head (2026-10-22)

Written BEFORE any live run of the R-585 code, from an offline reading of the code at the R-585 build head
(`lethal/r585` db38591b; evidence `/coord/handoff/R-585/lend-prediction.md`). The adopted plan is
`docs/superpowers/plans/2026-10-22-r585-r621-carry-scope.md` (r2). The live runs are compared against this file; any
difference is a BLOCK, recorded and not reinterpreted.

## What changes in the product
- **R585:** each run records its baseline test names (`runs.test_scope`). `--skip-known-survivors` lends history only
  when this session's tests are a subset of the source run's. A NULL scope is refused as
  `history-test-scope-changed`. The check runs LAST, after `runMayLend`, so no existing refusal is renamed.
- **R621:** `carriedVerdictFor` never returns a stored no-coverage, so it is always re-derived from this session's
  coverage.

## itest:lend: only leg R1 moves (R621)

R1 runs `--resume-run F`, where F is an unfinished full clone of A: one batch of 19 rows (3 killed, 12 survived,
4 no-coverage). The batch no longer carries whole. It deploys once, reuses L1's run B snapshot, re-derives the 4
no-coverage mutants as fresh no-coverage, and carries the other 15 by key.

| figure | before | PREDICTED |
|---|---|---|
| `LEND_FIGURES.resumeWhole.carryable` | 19 | **19** |
| `LEND_FIGURES.resumeWhole.carried` | 19 | **15** |
| `LEND_FIGURES.resumeWhole.groupedCalls` | 0 | **0** |
| R1 warning codes (`assertCodes`) | `resume-reusing-run`, `resume-batch-carried` | **`resume-reusing-run`, `resume-baseline-reused`** |
| R1 `resume-baseline-reused` text | (none) | includes **`same as run ${B}'s batch 0,`** (B = L1's run) |
| R1 artifacts deployed | 0 | **1** |
| R1 carried keys | all 19 | **all minus the 4 frozen no-coverage** (`carriedInPartBatch(ALL)`) |
| R1 `resumedFrom` | `{F, carriedMutants: 19, skippedStranded: 0}` | **`{F, carriedMutants: 15, skippedStranded: 0}`** |
| R1 per-mutant verdicts (`assertFrozen`) | frozen | **unchanged** (3 / 12 / 4, per mutant) |
| R1 unmutated tests run here | 0 | **0** (snapshot reused) |
| R1 `resume-reusing-run` "19 mutant verdict(s) may be carried" | present | **present** (a new R621 sentence follows it) |

## itest:lend: every other leg is unchanged

| leg | expected |
|---|---|
| L0 | 3 / 12 / 4, groupedCalls 15, no lend |
| L1 | 3 / 0 / 4, knownSurvivors 12, groupedCalls 3 (A records its own `test_scope`, the same suite, so it lends) |
| N0 | as L1 (`seedRunFrom` copies A's `test_scope`; a NULL source is refused) |
| N1 | `history-backend-build-changed`, exactly; nothing lent (refused at `runMayLend` step 1) |
| N5 | `history-test-app-changed`, exactly; nothing lent (refused at the test-app site check, before the scope check) |
| R2 / RP | carryable 9, carried 7, nonCarryableRows 1, groupedCalls 8; B's snapshot reused |
| R3 | carryable 18, carried 15, groupedCalls 0; the v3 snapshot refused (`snapshot-backend-build-changed`) |
| RN1d, RN2, RN3, RN4 | refused in `resolveResume` before any batch, unchanged |

## itest:bcdev: unchanged
3 killed / 12 survived / 4 no-coverage, per mutant equal to `bcdev.baseline.json`, groupedCalls 15, the protocol
probes PASS. bcdev starts from an empty store and never lends, so R-585 cannot move it.

## How the run is judged
- `gate-expected.ts` (`LEND_FIGURES.resumeWhole.carried` 15) and R1's assertions in `lend.itest.ts` are edited to
  this table only after this file is on master. `docs/gates/lend.md` is updated to match.
- The gates run on the final R-585 head, on a proven bc server, under a lease.
- Any figure, code, key set or verdict that differs from this file is a BLOCK.
