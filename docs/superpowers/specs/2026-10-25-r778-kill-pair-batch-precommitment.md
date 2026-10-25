# R778 pre-commitment (R-778): al-runner-v3 serve-entries batches the kill pairs

Written 2026-10-25 by lethal-bugs, before any live run of the R778 build.
Build: branch `lethal/r778`, code commit de183776 (head aa2670ad plus the itest pin edit below).
al-runner: the pinned `current`, edge dcdf9e821 (sha256 0e313935…).

## What changes

Kill pairs (R577/R653: NONE echo, NONE codeunit, M echo, M codeunit) used to go one request per kill.
Now they go in batched requests of kind `live` right after the prefetch, at most 64 kills (256 entries) per request.
The same entries are sent, so `entriesSent` does not move. Verdicts must not move.

Derivation, for each serve session with P kills that all come from the prefetch and need no fallback:
- `liveRequests`: P becomes ceil(P / 64).
- `boundChecks`: drops by the same amount (`boundChecks − warmups = prefetch + live + coverage` is unchanged).
- `pairRequests`: unchanged (it counts confirms that passed, served or sent).
- New counters: `pairBatchRequests` = ceil(P / 64), `pairBatchStored` = `pairBatchServed` = P, `pairBatchRefused` = 0.
- `pairFallbacks1/2` and their `…Passed`: 0.

## Predicted figures (`itest:alrunner-v3`, TABLES + CDO)

| Leg | Counter | Before (R761 / R763 pins) | Predicted |
|---|---|---|---|
| S1E | pairRequests | 3 | 3 |
| S1E | liveRequests | 3 | 1 |
| S1E | boundChecks | 5 | 3 |
| S1E | warmups | 1 | 1 |
| S1E | entriesSent | 44 | 44 |
| S1E | pairBatchRequests / Stored / Served / Refused | (new) | 1 / 3 / 3 / 0 |
| N1S | pairRequests | 33 | 33 |
| N1S | liveRequests | 33 | 1 |
| N1S | boundChecks | 35 | 3 |
| N1S | warmups | 1 | 1 |
| N1S | entriesSent | 200 | 200 |
| N1S | pairBatchRequests / Stored / Served / Refused | (new) | 1 / 33 / 33 / 0 |

The itest's `S1E_PINS` and `N1S_PINS` change to these values in the R778 branch. Echo mismatches stay 0 in both.

Every other leg and figure is unchanged, per mutant: every verdict, killing test, note set and refusal set, and every leg's counts. That includes D1 (51 / 12 / 0 over 63, 0 differences against `bc3-A.report.json`), D1c, T (hang) and the update gate.

## D1 serve counters (driver `LETHAL_ITEST_V3_LEGS=D1 LETHAL_ITEST_V3_TRANSPORT=serve-entries`)

| Counter | Before (R-778 breakdown) | Predicted |
|---|---|---|
| live requests | 51 | 1 |
| kill pairs (`pairRequests`) | 51 | 51 |
| batched pairs: requests / stored / served / refused | (new) | 1 / 51 / 51 / 0 |
| fallbacks (M cut, NONE cut) | 0 / 0 | 0 / 0 |
| entries sent | prefetch 126 + pairs 204 + warm-up 2 | unchanged |
| per-mutant verdicts and killing tests | 51 / 12 / 0 | identical (0 differences) |

Wall time is not pre-committed. It is reported beside the load at the time.

## Judgement

- Any differing verdict, killing test, note or refusal is a BLOCK.
- Any counter above that differs is a BLOCK until it is explained. If the explanation is sound, it goes in a dated addendum, never an edit of this file.
- Amendment 3 of the design review (no state carries over between entries in one request) rests on the order probe (`/coord/handoff/R-778/order-probe/result.md`: no carry-over on dcdf9e821 with the 17-app setup). R784 files the probe as a gated update-gate leg.
