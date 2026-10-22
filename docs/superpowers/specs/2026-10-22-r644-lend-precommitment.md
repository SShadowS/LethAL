# R-644: pre-commitment for itest:lend and itest:bcdev on the R-644 head (2026-10-22)

Written BEFORE the R-644 build and before any live run of it. The adopted plan is
`docs/superpowers/plans/2026-10-22-r644-lend-only-against-faced-tests.md` (r2, master ff273562). The live runs are
compared against this file; any difference is a BLOCK, recorded and not reinterpreted.

## What changes in the product
History (`--skip-known-survivors`) lends a survivor only if every test that covers it NOW is inside the non-empty
`covering_tests` it was scored against. Otherwise it is re-run. An empty or NULL record means "no record" and is
re-run (`history-survivor-no-record`). A lent known-survivor row keeps the source's `covering_tests`, so the next run
can check it too.

## itest:lend: NOTHING moves

On the sandbox-app fixture every test is green at every baseline, so every survivor's covering tests now are inside
its stored set, and every survivor lends as before. N0's clone copies `covering_tests`.

`LEND_FIGURES` stays exactly as on master ff273562:

| figure | expected (unchanged) |
|---|---|
| `totalMutantSites` | 19 |
| `fresh` (L0, N1, N5) | killed 3, survived 12, noCoverage 4, groupedCalls 15 |
| `history` (L1, N0) | killed 3, survived 0, noCoverage 4, knownSurvivors 12, groupedCalls 3 |
| `resumeWhole` (R1) | carryable 19, carried 15, groupedCalls 0 |
| `resumeSnapshot` (R2, RP) | carryable 9, carried 7, nonCarryableRows 1, groupedCalls 8 |
| `resumeRefusedSnapshot` (R3) | carried 15, groupedCalls 0 |
| `sentinel` | M0004, durationMs 987654 |
| `kept` / `keptAsError` / `r3Rerun` | unchanged |

- **Every leg:** the same per-mutant verdicts as `bcdev.baseline.json` (3 / 12 / 4) and the same lend warning codes as
  today.
- **No new warning:** neither `history-survivor-no-record` nor the "faced a test it was not run against" warning
  appears on any leg (no row is empty and no test changed colour).
- **The known survivors:** L1 and N0 keep all 12; NONE is re-run.

## itest:bcdev: unchanged
3 killed / 12 survived / 4 no-coverage, per mutant equal to `bcdev.baseline.json`, groupedCalls 15, the protocol
probes PASS. bcdev starts from an empty store and never lends.

## How the run is judged
- The gates run on the final R-644 head, on a proven bc server, under a lease taken only when a slot is free.
- Any moved figure, any survivor re-run on L1 or N0, any new warning code, or any differing verdict is a BLOCK.
