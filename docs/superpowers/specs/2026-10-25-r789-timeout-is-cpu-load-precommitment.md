# R789 pre-commitment (R-789): leg C's `timeout-is-cpu` is robust to machine load

Written 2026-10-25 by lethal-bugs, before any build or live run.
Seen: `/coord/handoff/R-786/v3b/alrunner-v3.log`. On a correct build (dcdf9e821) under three heavy v3 jobs, run A took
16009 ms and B 16069 ms, so "B over twice A" failed and the fact read `diverged` (leg C `gate-fail`).

## The new rule
1. **Core choice:** pin A, B and B's busy loops to the least busy core, chosen from two `/proc/stat` samples taken just
   before A, instead of always core 0. If `/proc/stat` cannot be read, use core 0 as today. The chosen core is named in
   the fact's `measured` text.
2. **Contention check:** a stopped A whose durationMs is over `BURN_WALL_FACTOR` x the limit (3000 ms) means the core was
   shared, and the fact reads `unmeasurable`, not `diverged`. Leg C reads an `unmeasurable` contract fact as
   `infra-fail`, which the update gate retries and never blacklists. A wall-time limit stops A at about the limit
   whatever the load, so this path cannot hide a wall-time build.
3. Everything else is unchanged: A not stopped or killed by the process timeout is `diverged`; B with no timeout row, or
   B at or under 3000 ms, or B at or under twice A, is `diverged`; B killed is `unmeasurable`.

## Predicted readings
- Every build `itest:alrunner-v3` and the update gate judge, on a quiet or a loaded machine where the chosen core is
  free: `timeout-is-cpu` = `matches`, as today. Leg C's fact count and every other fact's reading are unchanged.
- A correct build on a core that stays contended through A: `unmeasurable` (leg C `infra-fail`), never `diverged`.
- A build that counts wall time: `diverged`, as today.
- The fact's reading set stays {`matches`, `diverged`, `unmeasurable`}; no pin changes.

## Other wall-clock facts
R-789 checks each one (`sleep-is-noop`'s call wall under 1 s, the hang and timeout probes) against the wall times
recorded in loaded gate logs, and lists each in R789 with its margin. If one has less than a 3x margin, it gets the same
treatment, described in a dated addendum before its live run.

## Judgement
Any other reading on the full v3 gate is a BLOCK until explained, in a dated addendum, never an edit of this file.
