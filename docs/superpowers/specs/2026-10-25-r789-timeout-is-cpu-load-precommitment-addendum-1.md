# R789 pre-commitment, addendum 1 (2026-10-25): contention is read from A's CPU time; allowed cores only

Adds to `2026-10-25-r789-timeout-is-cpu-load-precommitment.md` (3070d576), written after the opus build review of
494082ea and before the live run of the change below. It replaces rule 2 of that file and narrows rule 1.

## Why
- The first version read every late A (durationMs over 3000 ms) as contention. A wall-time limit WITH slack (for
  example a 3.5 s stop for a 2 s limit) stops A late on an idle core too, so it would read `unmeasurable` ("core
  contended") every day and never `diverged`. That is lost detection and a wrong diagnosis. Only a wall limit with no
  slack stops A at about the limit whatever the load, so the original claim held for that case only.
- The picker read every `cpuN` line in `/proc/stat`. On a host where the process may use only some cores, an excluded
  core looks idle, `taskset` refuses it, and the fact reads `unmeasurable` on every run.

## The rule, as amended
1. **Core choice:** the least busy core among the cores in `Cpus_allowed_list` (from `/proc/self/status`). If that list
   cannot be read, core 0.
2. **Contention check:** a stopped A whose durationMs is over 3000 ms is contention ONLY when A's own process CPU time is
   under 0.75 x its wall time. A pinned process that shares its core gets a fraction of it; one alone on its core uses
   about all of it. Then the fact reads `unmeasurable` ("A late: core N contended, cpu X of wall Y ms") and B is not
   run.
   - A late with CPU time at or over 0.75 x wall (the core was free, so the stop itself came late): B runs and the old
     rules judge it. A wall-time limit with slack stops B at about A's time, so it reads `diverged`.
   - A late with CPU time unknown: `unmeasurable`, naming the missing reading.
3. Everything else as in the original file.

## Predicted readings
- Unchanged from the original file: `matches` on a free core, `diverged` for a wall-time build (with or without slack,
  loaded or not), `unmeasurable` for a correct build on a core that stays shared through A.
- Same reading set, no pin changes, and every other fact unchanged.
