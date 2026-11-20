# PR-274 pre-commitment: how a DO run's wall scales with `--workers` (3, 4, 6, 8)

Coord PR-274 (lethal-code, 2026-11-20). Measure only: no code change. From PR-273 (`/coord/handoff/PR-273/result.md` §4):
perf10c's lanes were bound by `--workers 3`, while memory would allow about 6-11 and CPU about 12. alrunner's PERF-27 answer
ranks more lanes as the cheapest lever. Evidence directory: `/coord/handoff/PR-274/`. A spec-adversary review (Opus) of the
first draft found eight problems; the fixes are in place below, and the review is in `spec-review.md` there.

## The arms
- **A discarded warm-up first, then five timed runs in this order:** W3a, W6, W4, W8, W3b. They are interleaved; W3b repeats
  W3a as the drift control.
- **Identical except for `--workers <n>`** and the declared heavy-slot peak. The driver `arm.sh` in the evidence directory
  holds the exact command.
  - **The same LethAL head for all,** at this spec's master commit or later.
  - **The command:** `lethal run --project <DO> --tests <DO tests> --backend al-runner-v3 --config v3.json --profile slim
    --allow-large-run --db <fresh per arm> --workers n --out ... --progress-out ...` plus the 22 `--only` files of
    `slice.txt`.
    - No `--resume`, no `--time-budget`, no `--isolate-tests`, no CPU pinning.
    - It runs under `env -u` for every `LETHAL_V3_*` and `LETHAL_*` tuning variable, so no knob leaks in from the shell.
  - **The config `v3.json`:**
    - al-runner is pinned by path to `/work/tools/al-runner-v3/main-ccd0f823d/al-runner` (R1018), so a move of `current` cannot
      split the arms. Its own .NET sidecar comes from its `.gated`.
    - Its own `cacheDir`, `/coord/handoff/PR-274/cache`, is seeded from the DO cache and then warmed by the warm-up, so no arm
      runs cold and no other lane writes to it.
  - **The slice:** 22 files picked by `select.py` from perf10c (every 3rd file by name with test time, no timeout-killed site).
    The estimate is about 8,400 lane-s of test time.
    - A `--dry-run` before the warm-up fixes the mutant count. It is written into `slice.txt` before W3a starts.
    - Every arm must score exactly that set.
- **`--workers` stops at 8:** the CLI caps it at 2-8 (`MAX_V3_WORKERS`). A default above 8 would need that cap raised, which is
  a separate item.
- **The declared peak, and the lane gate it feeds:**
  - LethAL's own gate (`decideLanes`, `affordableLanes`, `laneMayStart`) starts lane k only while
    k × (the session's highest per-daemon peak) + 4 GiB (`LANE_LETHAL_BYTES`) fits under the declared heavy-slot peak.
  - So P is set to 4 + 3 × n GiB, capped at 26: W3 13, W4 16, W6 22, W8 26.
  - At W8 = 26, eight lanes start only while every daemon stays under 2.75 GiB (perf10c: p90 2.41, worst 4.48).
  - A watchdog sends SIGTERM to the run if the tree's RSS passes P + 2 GiB; that arm is void.
  - If W8 is not admitted within 30 minutes of waiting, it is dropped and reported.
- **When to start:** after PR-235's DO session has ended, with the arms back to back.

## What is recorded per arm
- **Lanes REALISED:** the `al-runner-v3-lane-memory-fit` notice (lanes asked and started), lane holds, and the busy lanes over
  time from the request events.
  - An arm that ran fewer than n lanes for more than 10% of its mutant phase is reported as "memory-bound at n" and left out of
    S.
  - That is still a finding for the default, since the gate would do the same in production.
- **Times:**
  - mutant-phase wall by `atMs` (monotonic), and the whole-run wall;
  - the baseline phase.
- **Requests:**
  - per-lane busy %;
  - requests per kind;
  - per request: median al-runner fixed cost (setup + compile + engine + baseline + other) and `testsMs` per test.
  - A rise in `testsMs` per test as lanes grow is contention.
- **Memory:**
  - peak tree RSS and per-daemon RSS (a sampler every 2 s);
  - cgroup `memory.current` max;
  - any memory-guard or budget stop.
- **The shared box** (server1, a 22-core laptop shared with other lanes and the alsem and alrunner tentacles), every 5 s:
  - `/proc/loadavg`, `/proc/pressure/cpu` and `/proc/pressure/memory`;
  - cgroup `memory.current`;
  - the heavy-slot holders and their declared peaks.
- **The clock:** the BOOTTIME-minus-MONOTONIC gap at the start and end of each arm. An arm the machine slept in is re-run.
- **Verdicts:** per mutant, on the full site key (file, line, operator, start and end index).

## Bounds (pre-committed)
- **COMPLETE (void otherwise):** an arm scores every mutant of the dry-run set.
  - It ends with no memory-guard, budget, latch or watchdog stop, and no suspend.
  - A void arm is re-run once; a second void is reported as is.
- **V (BLOCK):** every mutant's verdict is EQUAL across all complete arms.
  - Any `timeout-killed` that appears in some arms only is a FALSE KILL caused by load (the per-mutant stop is set from an
    unloaded baseline), and it BLOCKS that n as a default.
  - Any other difference is reported per mutant, and no default above 3 is proposed until it is explained.
  - `killingTest` differences are reported but do not block: prefetch windows are sized by lane count (`splitWindowCaps`, PR-99),
    so a legitimate change of order is possible.
- **N (neighbours, void otherwise):** an arm is void if, for more than 20% of its mutant phase, other jobs held heavy slots
  whose declared peaks total more than 8 GiB, or the host load average passed 22 while the arm's own tree was not the cause.
  - "Not the cause" means the load stays above 22 in the samples where the arm's lane count is at its lowest.
- **D (drift):** W3b's mutant-phase wall is within ±5% of W3a's.
  - Otherwise the box changed speed during the series. The comparisons are marked unsafe, and the series is re-run on a quieter
    box before any proposal.
- **S (scaling), predictions, judged only on complete arms that ran their full n lanes:**
  - W4 ≤ 0.85 × W3;
  - W6 ≤ 0.65 × W3;
  - W8 ≤ 0.55 × W3 (W3 = the mean of W3a and W3b).
  - A miss is reported with its cause: rising `testsMs` per test means contention; fewer lanes realised means memory; rising
    fixed cost per request means LethAL's own thread; a window tail means the slice is too small for n.
- **The baseline phase is supporting evidence only.** It runs on one daemon whatever the lane count, so neighbours slow it less
  than the parallel phase.

## What the proposal will contain, and its limits
- **A lane rule from the code's own charge,** because the box is shared:
  - lanes = min(8, floor((P - 4 GiB) / per-daemon peak));
  - the per-daemon peak is the measured session maximum, not the p90;
  - P = min(the measured need, 32 GiB - 4 GiB reserve - `memory.current` at admission).
- **CPU is unmeasured.** No arm is short of CPU. Any CPU term (free cores) is marked as such, not fitted.
- **The default for DO-sized runs:** the largest measured n whose mutant-phase wall beats the next smaller arm by ≥ 10%, with
  `testsMs` per test within 25% of W3's, V and COMPLETE holding, and n lanes realised.
- **The `--peak` that default needs, and whether the combined DO run should use it.**
- **The claim is limited to slice-sized runs.** A full DO run's prefetch windows are 600 s × n (`splitWindowCaps`), so the slice
  gives W8 only about 2 windows. Extrapolating to a full run is a stated estimate, not a measurement.
