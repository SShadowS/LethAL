# PR-370 pre-commitment (R1189): the withheld-kill recheck gets a phase of its own, with its nested session's phases

Written 2026-11-23, before the build. Measured first (`/coord/handoff/PR-370/`: `gap.py` on read-only copies of PR-357's c3
and c3off events and stderr).

## What fills the gap (measured)
- **The events:** after `phase-left teardown`, c3 and c3off each carry only `recheck-baseline-finished`, 369
  `mutant-rechecked` (3 kept, 366 recovered; emitted within 48-52 ms, after the nested run returned), `test-costs` and
  `session-finished`.
- **The code** (`runWithheldRecheck`, `cli.ts`'s recheck runner): the gap is ONE nested session. It closes the main daemons,
  builds a new backend (method isolation), regenerates an instrumented workspace holding only the targets, then deploys,
  runs a baseline and a mutant phase, and tears down. Only its baseline's elapsed time is passed back.
- **The nested session's own serve-entries line** (the first of two in each stderr):

  | run | gap (wall) | recheck baseline (wall) | nested daemons | warm-up / prefetch / live (lane-s) | nested rows' test time |
  |---|---|---|---|---|---|
  | c3 | 874 s | 386 s | 28 | 420 / 1,302 / 937 | 50 s |
  | c3off | 1,012 s | 438 s | 28 | 499 / 1,402 / 1,023 | 51 s |

- **So the ~490-575 s outside the recheck baseline is the nested session's daemon starts (28 warm-ups) and its mutant phase
  (prefetch and live),** plus its generate and deploy.
  - Lane-seconds add up across lanes, so the exact wall split is not recoverable from these runs. The phase built here
    records it on every run from now on.

## The change
1. **`RunPhase` gains `"recheck"`.** `runWithheldRecheck` emits `phase-entered` `recheck` once the skip checks pass (before
   the main daemons close), with `detail`: "<n> withheld kill(s), <m> test(s): a nested session (its own daemons, baseline
   and mutant phase)".
   - It emits `phase-left` `recheck` with `elapsedMs` when the nested run returns, fails or is stopped. It always pairs: a
     skip emits neither.
2. **The nested session's phases are passed back:** `NestedRecheckResult` gains `phases`, each nested `phase-left`
   (`phase`, `elapsedMs`) in order.
   - `phase-left` `recheck` carries them as `detail`, for example "nested: generate 12.0 s, deploy 41.2 s, baseline 386.1 s,
     mutants 401.7 s, teardown 0.0 s".
   - `phase-left` gains an optional `detail`, the same shape `phase-entered` already has.
3. **The TIMING banner** (`timing-summary.ts`) lists `recheck` after `teardown`, and prints the nested split under it. The
   phases then sum to the session's elapsed time, short only of the gaps between phases.
- **Not changed:** any verdict, any recheck decision, the recheck's events or their order, the report's schema (`RunPhase`
  is an event type, and no schema lists it; checked).

## Tests (red-checked each way)
- A recheck that runs emits `phase-entered` then `phase-left` `recheck`, around `recheck-baseline-finished` and the
  `mutant-rechecked` events (a call-order fake, not wall time).
  - The nested phases appear in `detail`.
- A skipped recheck (no targets, method isolation, not serve, no baseline, a stop) emits no recheck phase.
- A nested run that throws still emits `phase-left` `recheck` once, and the warning is unchanged.
- The banner shows `recheck` and its nested split; with no recheck it shows exactly what it shows today.

## The daemon-reuse lever: sized, filed as R1190, NOT built
- **The cost:** the nested session closes the main daemons and starts 28 of its own: warm-up 420-499 lane-s (about 84-100 s
  of wall at 5 lanes), plus its generate and deploy (to be measured by the new phase).
- **Reuse would need the nested session to run against the MAIN instrumented build** (a superset of its targets) on the main
  daemons, switched to method isolation per request. That is a design change to the recheck's narrowing (`exactSites`),
  not a flag.
- **The ceiling:** at most about 100 s of wall plus generate and deploy, per run with a recheck, out of a 15-17 min gap. The
  first DO run with this phase measures generate and deploy, and the item is judged on that.

## Checks
VERIFY (one at a time beside any timed run), Opus review, CI. selectLegs decides the gates; the change touches no verdict
path.
