# R-592b (roadmap R592): pre-commitment for itest:lend and itest:bcdev on the R-592b head (2026-10-22)

Written BEFORE any live run of the R-592b code, from an offline reading of the change and of the gate's seeds. Any
difference is a BLOCK, recorded and not reinterpreted.

## What changes in the product
- `backendBuildRefusal`, step 1 of `runMayLend`, refuses ANY pair of different backends. Before, it refused only
  pairs that include `al-runner-v3`.
- Pairs without v3 get a new text: "a verdict is lent only within one backend (R592)".
- Pairs with v3 keep R586's text verbatim.
- The warning codes do not change.
- `--resume-run` is unchanged: it already threw on another backend before `runMayLend`.

## itest:lend: NOTHING moves
- Every leg runs a bcdev session.
- The only seeds of another backend are al-runner-v3 runs: R3's snapshot, N1, and the KV `--resume-run` refusal.
  These take the v3 branch, whose text is unchanged.
- No leg seeds a bcdev or al-runner (v2) run against a session of the other backend.

| figure | expected (unchanged) |
|---|---|
| `fresh` (L0, N1, N5) | 3 / 12 / 4, groupedCalls 15 |
| `history` (L1, N0) | 3 / 0 / 4, knownSurvivors 12, groupedCalls 3 |
| `resumeWhole` (R1) | 1 artifact; carryable 19, carried 15, groupedCalls 0 |
| `resumeSnapshot` (R2, RP) | carryable 9, carried 7, nonCarryableRows 1, groupedCalls 8 |
| `resumeRefusedSnapshot` (R3) | codes `resume-reusing-run`, `snapshot-backend-build-changed` (the R586 v3 text); carried 15, groupedCalls 0 |

- Every leg's per-mutant verdicts, warning codes and asserted texts are unchanged.
- No text containing "(R592)" appears on any leg.

## itest:bcdev: unchanged
3 / 12 / 4 per mutant, equal to `bcdev.baseline.json`, groupedCalls 15, and the protocol probes PASS. It lends nothing.

## How the run is judged
The gates run one at a time on the final R-592b head, on a proven bc server, under a lease taken only when a slot is
free. Any moved figure, any new or missing warning code, or any differing verdict is a BLOCK.
