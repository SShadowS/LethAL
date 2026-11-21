# The "combined" DO run c1 (2026-11-21): LethAL's levers at 5 lanes on edge-4ebfe7913, against y3

lethal-preproc. Pre-commitment: `docs/superpowers/specs/2026-11-21-combined-do-run.md` (ed37dd3e1). Evidence and scripts:
`/coord/handoff/combined-do/` (`run.log`, `c1.run.*`, `verdicts-vs-y3.py/.txt`, `c1-vs-y3-moves.tsv`,
`work-split.py`, `work-split-final.txt`, `midrun.py`). Numbers and names only.

## What actually ran: NOT the pre-committed build
- **The pre-commitment named `current` = main-ccd0f823d.** The run used the reused config
  `/coord/handoff/R-984/v3.do-serve-xb.json`, whose `alRunnerV3.path` pins
  `/work/tools/al-runner-v3/edge-4ebfe7913-4ebfe7913/al-runner`, and LethAL runs the config's path.
  - All daemons' `/proc/<pid>/exe` and the run's stderr (`al-runner 3.0.0-alpha.14+edge.20261115 (4ebfe7913)`) say
    so.
  - The run script checked `current`'s sha256, not the binary LethAL would use: preproc's error.
- **So this run is "LethAL's levers on y3's own build", not the combined run.** The levers are PR-246's cost model,
  `LETHAL_V3_PACK_ENTRIES=256`, PR-259's bound print and PR-252/264's clock, on LethAL ed37dd3e1.
  - It ran 5 lanes, not 8: the lane gate measured 3.1 GiB per lane (high-water mark, on this build without kept
    baselines). Six lanes plus LethAL's 4.0 GiB needed 22.8 GiB, over the declared 22.
  - The real combined run on main-ccd0f823d is re-run separately, with the config's binary checked.
- **No suspend:** BOOTTIME minus MONOTONIC was unchanged at 11,379 s. No watchdog stop, rc 0.

## Verdicts against y3: 10 moves, all explained (hard claim 1 holds on this build)
- All 43,511 mutants join on the full site key (file, line, operator, start/end index); 0 mutantCode mismatches.
- y3: no-cov 26,829 / surv 9,885 / killed 6,442 / error 348 / timeout-killed 7.
- c1: 26,829 / 9,885 / **6,452** / **338** / 7.
- **10 moves, all error -> killed:** exactly perf10c's 10 named moves (PR-217's result). A y3 cascade error ("an earlier
  test of this codeunit was refused") now runs, and the mutant is killed. These are LethAL changes since y3, not a
  build change.
- **8 killed mutants with another killing test:** all 8 equal perf10c's killing test. That is the same LethAL-side
  change.
- **Not seen here:** perf10c's 302 by-value set-aside. That refusal is perf-combined's and main's; edge does not refuse
  there.

## Speed against y3 (the same build; 5 lanes against 3)
| | y3 (3 lanes) | c1 (5 lanes) |
|---|---|---|
| mutant phase | 23,928.2 s | **19,911.5 s (−16.8%)** |
| s per covered mutant (16,682) | 1.43 | **1.19** |
| busy lane-s (merged intervals) | 69,557 | 96,988 |
| lanes busy | 96-98.5% | 96.6-98.7% |
| prefetch requests | 5,052 | **1,259** |
| prefetch setup + baseline (lane-s) | 7,897 | 3,633 |
| tests sent (prefetch / live) | 1,920,047 / 403,593 | 1,936,018 / 406,381 |
| testsMs per test (prefetch / live) | 23.4 / 17.7 ms | **34.3 / 28.2 ms** |
| warm-ups (count, compile s) | 198, 2,051 | 238, 3,516 |

- **The levers did what they were built for.** Prefetch requests fell 4× (packing with R987's model), and the per-request
  fixed cost fell with them. Hard claim 3 (prefetch under 4,000): PASS.
- **Hard claim 4 (total `boundMs` under perf10c's 2,381 s): PASS,** at 1,375 s over 3,767 checks, 365 ms per check. Per
  check it is above R1156's 3-lane 130 ms target, as pre-committed.
- **But each test ran 47-59% slower** with the same number of tests. That is +21,600 lane-s in prefetch and +4,300 in
  live, which swamps the savings. So the busy work ROSE 39%, and 5 lanes bought only −16.8% of wall.
  - **Not request size:** within c1, per-test time is LOWEST in the biggest packed requests (192+ entries 30.3 ms,
    96-191 37.1, 32-95 36.2, under 32 41.3).
  - **Leading suspect: the shared box's load at 5 lanes** (host load 1-min 65 and 15-min about 140 at 10:33Z, from
    other tentacles). PR-274 saw per-test time on one build move 20.8-38.3 ms with load. Not separated here: no
    interleaved control ran.
- **Hard claim 2 (phase under 10,000 s): MISSED** (19,911.5 s). Its prediction assumed main's kept baselines, 8 lanes
  and perf10c's per-test speed, and none of the three held for this run.

## What follows
- The real combined run on main-ccd0f823d. The run script checks the config's binary sha256 and the stderr version
  line against the gated `current`, and refuses otherwise. Lanes come from main's measured daemon peak (6 by default).
  It follows PR-281's A/B, with an amended prediction committed first.
- The per-test slowdown needs an interleaved control before any lane count is credited with speed.
