# R-586 pre-commitment r14 (R693): `timeout-is-cpu` judged by when a never-ending burn is stopped

Master path: `docs/superpowers/specs/2026-10-23-r586-alrunner-v3-precommitment-r14-timeout-is-cpu.md`.

Written by lethal-code (coord task R-693) on 2026-10-23, after the change was coded on `lethal/r693` and checked by
three offline leg-C runs, and BEFORE any full `itest:alrunner-v3` run of a head that carries it. A delta on r13
(`2026-10-23-r586-alrunner-v3-precommitment-r13-dependency-skip.md`) and the deltas before it; everything there stands
except what is below.

## Why
r6 judged `timeout-is-cpu` with two fixed burns: `CpuBurnLong` (110M steps, ~3.0 s of CPU) alone must be stopped at
2 s, and `CpuBurnShort` (55M steps, ~1.49 s of CPU) on core 0 beside ONE busy loop must pass with durationMs over 2 s.
Since 2026-10-23 the fact reads `diverged` master-wide (master 4a8a0dbe in a clean worktree included): core 0's speed now
varies 2-3x within seconds, so 55M steps costs 1.6-3.8 s of CPU and the shared run is stopped about half the time
(`/coord/handoff/R-693/measure.md`). v3's limit is unchanged and is CPU time: the stop message says "the test used
more than the time limit of 2 s of CPU time". A calibrated size was tried and failed the same way: a burn sized from
a calibration ran 2x faster seconds later (`legC-sanity-3.log`).

## The new reading (r14, "r14b" in the R-693 notes)
One burn, `BURN_HUGE` = 2,000,000,000 steps in codeunit 50656 (it never finishes within any budget here). Limit
L = 2 s. Both calls carry a 60 s process guard.
- **Call A:** `--codeunit 50656` under `taskset -c 0`, NO busy loop, `--test-timeout-secs 2`. Expected: a notRun row
  "Test exceeded 2s timeout." (a limit exists).
- **Call B:** the same, beside SEVEN busy loops `taskset -c 0 timeout -s KILL 150 sh -c 'while :; do :; done'`
  (killed in a `finally`; the `timeout` ends any loop a killed process leaves behind).
  Expected: also a notRun timeout row, with row `durationMs` > 1.5 x L = 3000 ms. A CPU-time stop comes after 2 s of
  the test's CPU, so its wall is about 2 s / (its share of core 0); a wall-time stop comes at about 2 s.
- `durationMs` is wall time on this path: B read 16019 ms with a 16530 ms call wall (`legC-sanity-b1.log`).

| reading | rule |
|---|---|
| `matches` | A stopped AND B stopped with durationMs > 3000 AND B's durationMs > 2 x A's (healthy: about 8x) |
| `diverged` (gate-fail) | A not stopped or killed by the guard (no limit); B not stopped (it passed or failed); B stopped at durationMs <= 3000, or at no more than 2 x A's durationMs (a wall-like stop, including one with slack: a wall limit stops A and B at about the same time, a CPU limit stops B much later) |
| `unmeasurable` (infra-fail) | taskset missing; a row missing; B killed by the guard |

Gate-only as before (a session reads `.gated`). Fact count unchanged: 28 (9 defect, 18 contract, 1 warn). Leg C costs
about 20 s more than r6 (B about 16 s, A about 2 s).

## Evidence before this pre-commitment (offline, leg C only, alpha.2, R-693 head 0e5a76d9)
| run | A durationMs (wall) | B durationMs (wall) | reading |
|---|---|---|---|
| b1 | 2019 (2080) | 16019 (16530) | matches |
| b2 | 2052 (2082) | 16108 (17038) | matches |
| b3 | 2031 (2102) | 16056 (16647) | matches |

## Expected readings
| build | `timeout-is-cpu` |
|---|---|
| alpha.2 (91253f2d6, `current`) | `matches` |
| edge 3.0.0-alpha.4+edge.20261022 (57f1e4f98) | `matches` (INFERRED: the same limit message and the same 2 s CPU stop were measured on edge in `measure.md`) |

## Live runs (R-693, on its final head)
- **Code:** `lethal/r693` at **d28ac36d** (code as built at b9942236, after the build review's B1 (B > 2 x A), S1 and
  S2; two more offline leg-C runs read `matches`: A 2011/2005 ms, B 16091/16059 ms), clean tree; an addendum names a new
  head if it moves.
- **Run 1 and run 2:** `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396 bun
  run itest:alrunner-v3`, all 12 legs, back to back. Each must PASS, with `timeout-is-cpu = matches` and the update-gate
  outcome `pass`.
- **Edge:** leg C with `LETHAL_ALRUNNER_V3_CANDIDATE=1` and `LETHAL_ALRUNNER_V3_PATH=<edge 57f1e4f98>`; only this fact
  is judged (`matches`); the other facts keep their known edge readings.
- **Stop:** this fact reading anything other than `matches` on either full run or on edge.

## Effect
Until this lands, every v3 leg C and the daily update gate read gate-fail on this fact. After it, leg C is back to
pass on a healthy pinned build, and the fact still tells a CPU-time limit from a wall-time limit and from no limit.
