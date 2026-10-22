# R-646b (roadmap R646): pre-commitment for itest:lend and itest:bcdev on the R-646b head (2026-10-22)

Written BEFORE any live run of the R-646b code, from an offline reading of the build (`lethal/r646b` 338041d6; the
prediction is in `/coord/handoff/R-646b/lend-prediction.md`, the fit check in `fit.md`). Any difference is a BLOCK,
recorded and not reinterpreted.

## What changes in the product
- `--resume` (scoreBatch step 5b) carries a stored `survived` or `known-survivor` only if every test covering it NOW
  is inside its non-empty stored `covering_tests`: R-644's rule, now a shared function, `facedEveryCoveringTest`, used
  by both history and the resume carry. Otherwise the survivor is re-run.
- The warnings: `resume-tests-not-faced`, and `resume-survivor-no-record` for an empty or NULL record. A carried kill
  is not checked.
- A whole-batch replay (`batchCarriesEntirely`) is refused for a batch holding a survivor with an empty record, which
  then takes the ordinary path.

## itest:lend: NOTHING moves
Every resumed leg's source is a clone of A. A's 12 survivors all hold non-empty `covering_tests`, and every test is
green at every baseline on this fixture, so every carried survivor faced every test covering it now. No leg replays a
batch with an empty record.

| figure | expected (unchanged) |
|---|---|
| `fresh` (L0, N1, N5) | 3 / 12 / 4, groupedCalls 15 |
| `history` (L1, N0) | 3 / 0 / 4, knownSurvivors 12, groupedCalls 3 |
| `resumeWhole` (R1) | carryable 19, carried 15, groupedCalls 0 |
| `resumeSnapshot` (R2, RP) | carryable 9, carried 7, nonCarryableRows 1, groupedCalls 8 |
| `resumeRefusedSnapshot` (R3) | carried 15, groupedCalls 0 |

- Every leg's per-mutant verdicts are unchanged, and so are its lend warning codes.
- Neither `resume-tests-not-faced` nor `resume-survivor-no-record` appears on any leg.
- No carried survivor is re-run.

## itest:bcdev: unchanged
3 / 12 / 4 per mutant, equal to `bcdev.baseline.json`, groupedCalls 15, the protocol probes PASS. It never resumes.

## How the run is judged
The gates run on the final R-646b head, on a proven bc server, under a lease taken only when a slot is free. Any moved
figure, re-run survivor, new warning or differing verdict is a BLOCK.
