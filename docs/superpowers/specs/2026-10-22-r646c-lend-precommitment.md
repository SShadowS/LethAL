# R-646c (roadmap R646): pre-commitment for itest:lend and itest:bcdev on the R-646c head (2026-10-22)

Written BEFORE any live run and BEFORE the build, from the adopted plan (`/coord/handoff/R-646c/plan.md`, "## r3" and
its "r3 amendment"; delta review: ADOPT). Any difference is a BLOCK, recorded and not reinterpreted.

## What changes in the product
- The whole-batch replay on `--resume` is removed: step 1b', `replayCarriedBatch` and `batchCarriesEntirely`.
  - Every fully scored batch now takes the ordinary path. It is deployed, then it either reuses an eligible baseline
    snapshot or runs a fresh baseline.
  - Step 5 computes coverage, and 5b carries verdicts, applying `facedEveryCoveringTest` to survivors.
- A stranded mutant (R53) is skipped BEFORE step 5, so it keeps `STRANDED_SKIP_NOTE` even when it is uncovered now.
- `resume-batch-carried` is no longer emitted.
- The texts of `resume-reusing-run` and `CAVEAT_INTERPRETATIONS.resumed` drop their R192 replay clauses. Every
  substring that itest:lend asserts is kept.

## itest:lend: NOTHING moves
No leg replays a batch whole today:
- R1's batch holds no-coverage rows, so it takes the ordinary path since R-585.
- R2 and RP hold an error row.
- R3 holds a row it still has to run.

| figure | expected (unchanged) |
|---|---|
| `fresh` (L0, N1, N5) | 3 / 12 / 4, groupedCalls 15 |
| `history` (L1, N0) | 3 / 0 / 4, knownSurvivors 12, groupedCalls 3 |
| `resumeWhole` (R1) | 1 artifact; codes `resume-reusing-run`, `resume-baseline-reused`; run B's snapshot; carryable 19, carried 15, groupedCalls 0 |
| `resumeSnapshot` (R2, RP) | carryable 9, carried 7, nonCarryableRows 1, groupedCalls 8; RP keeps R601's clause |
| `resumeRefusedSnapshot` (R3) | codes `resume-reusing-run`, `snapshot-backend-build-changed`; carried 15, groupedCalls 0 |

- Every leg's per-mutant verdicts are unchanged, and so are its lend warning codes.
- RN1d, RN2, RN3 and RN4 are still refused before the lease, with their texts unchanged.
- None of `resume-batch-carried`, `resume-tests-not-faced` or `resume-survivor-no-record` appears on any leg.

## itest:bcdev: unchanged
3 / 12 / 4 per mutant, equal to `bcdev.baseline.json`, groupedCalls 15, and the protocol probes PASS. It never resumes.

## How the run is judged
The gates run one at a time on the final R-646c head, on a proven bc server, under a lease taken only when a slot is
free. Any moved figure, any new or missing warning code, or any differing verdict is a BLOCK.
