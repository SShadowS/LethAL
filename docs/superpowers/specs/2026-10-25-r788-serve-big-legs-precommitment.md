# R788 pre-commitment: the v3 gate's D1, D1c and T legs run serve-entries

Coord task R-788, branch `lethal/r788`. On master before the change merges. Evidence:
`/coord/handoff/R-788/observe.log` (D1, D1c, T on serve, observe warnings, at e1cbb4f5, current `edge-dcdf9e821`,
18:43-18:44Z) against the one-shot `--regate a0b6e49c` log
(`/work/tools/al-runner-v3/regate/a0b6e49c1de71917ac973b05ac74d73022fccd10.gate.log`).

## What moves
- The transport of D1, D1c and T: one-shot -> serve-entries (`V3_GATE_SERVE_LEGS`). Every other leg is unchanged
  (S1, N1, MO and WR keep one-shot covered; S1E, N1E and N1S were serve already). `LETHAL_ITEST_V3_TRANSPORT` still
  names one transport for every leg.
- Leg walls (measured): D1 532 -> 32 s, D1c 462 -> 31 s, T 161 -> 30 s. Timing only, never asserted.
- New printed lines on the three legs: `entries {...}` and the split line.
- New asserted serve counters on each of the three legs: `pairRequests` equals the killed count (D1 51, D1c 51,
  T 290), and `echoMismatches`, `pairFallbacks1`, `pairFallbacks2` and `pairBatchRefused` are 0. These follow from
  the verdicts; lane-, batch- and timing-dependent counters (daemons, liveRequests, entriesSent, pairBatchStored)
  are printed, not asserted.

## What does not move (measured identical on serve and one-shot)
- D1 51 / 12 / 0 over 63, D1c 51 / 8 / 4 over 63, T 290 / 50 / 59 (errors 7) over 406.
- Per-mutant: D1 and D1c against `docs/measurements/r594/bc3-A` / `bc3-B`, T against its own baseline with
  `T: pinned 7 rows` (#5788). A per-mutant move is a BLOCK.
- D state notes 51 (the asserted set), Sleep index D 3 + 0, T 0 + 0; T notes state 28, refused-nearby 50, §6 0.
- Gate warnings: D1 and D1c exactly `CDO_D`, T exactly `TABLES` (`gate-expected.ts`), unchanged.

## Predictions
1. The full v3 gate (`TABLES=1`, CDO) on the R788 head: every leg pass with the figures above; total wall about
   23 min -> under 10 min.
2. R777: the merge changes what the update gate measures for D1, D1c and T, so `current` is regated once, at the
   last of the R-771 pin fix, R-784 and R-788 merges (orchestrator sequencing). Predicted `pass`.
