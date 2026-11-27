# PR-467 pre-commitment (alrunner PERF-37): does restarting a compiled serve daemon once drop about 1 GiB on DO?

Coord PR-467 (lethal-preproc, 2026-11-27). Measure only, no BC, never bc4. alrunner's ask:
`/coord/handoff/from-alrunner/PERF-37/lethal-ask.md`. Evidence: `/coord/handoff/PR-467/`. Counts and timings only: no DO
source text anywhere in the evidence or the answer.

## The build and the kit
- **al-runner:** upstream main 80960b023 (the commit alrunner's own recheck used; it contains #8446, merge 10d58e4d8, the
  workspace cache). Built privately (`cargo build --release --locked -p alrunner-cli`, own target dir, heavy-slot) and gated
  privately by the update gate's PR-226 route (`--root /coord/handoff/PR-467/gate-root --local-candidate <build>`). Never
  `current`, never under `/work/tools`. **If the private gate fails, no run:** the failure goes to the orchestrator.
- **LethAL:** master 8757e6ee6 plus a measurement kit (branch `lethal/pr-467-kit`, never merged). With
  `LETHAL_PR467_RECYCLE_ONCE=1`, each lane's first mutant daemon is recycled once, right after its first request (the
  warm-up, which compiled), through R952's own `recycle` close. Without the variable the code path is master's.

## The two arms (the same shape twice)
- PR-452's DO scope: `--only` CDOEMailHandler, CDOeSealServiceSetup.Page, CDOUnhandledServicePagesMgt (1121 mutants on
  edge-e5176a9fd), `--workers 5`, `--profile slim`, isolation `test`, `ciSessionKind` client, PR-452's config with
  `alRunnerV3.path` set to the gated private copy, the warm demo-data cache (`/coord/handoff/PR-437/arms/cache`), a fresh
  store each.
- **N:** no restart. **R:** `LETHAL_PR467_RECYCLE_ONCE=1`. N first, then R, one after the other.
- Cores 0-11 (`taskset`), heavy-slot `--peak 22`, an own-pid driver with PR-452's memory watchdog. Outside load is named in
  `outside-load.md` (lethal-preproc's PR-462 gate clients run on cores 12-21).

## What is measured, and what counts as an answer
- **(a) The cache read.** From the `serve-request-timed` events: in R, the first request of each restarted daemon (warm-up
  cause `recycle`) has `timings.extra.workspaceCache` = `"read"`. **Holds** if it reads `read` on every restarted daemon (5
  of 5 lanes); any other value is reported per lane. The value on each lane's FIRST daemon's first request is recorded for
  both arms.
- **(b) Verdicts.** Per mutant, on the full site key (file, startLine, operator, start and end index): the verdict in R
  equals N's. **Holds** if all mutants match. Any differing verdict is reported by site key. killingTest moves are listed
  separately (R197 order can move them between runs; PR-452 measured A1 = A2 on this scope).
- **(c) Memory.** From the `serve-request-sized` events, per lane and per request index: `start` (VmRSS at request start)
  and `hwm` (VmHWM over the request, after LethAL's verified reset). The same request indices are compared, N against R,
  from the first request after the restart point to the lane's end: median and maximum, in GiB.
  - **Holds** (the restart drops the leftover) if R's median `start` is lower than N's on at least 4 of 5 lanes. The
    drop is reported per lane. alrunner's recheck predicts about 1 GiB (2.56 vs 1.53 GiB floor on an invented 44 MB app).
  - Box memory (the run's process tree, every 15 s) is recorded for both arms.
- **(d) The cost.** The restarted daemon's warm-up wall time (`wallMs` of the cause-`recycle` request, which includes the
  spawn and the first answer) beside the first daemon's (`first`). Also each arm's total wall time; one run per arm under
  outside load, so the totals are not a speed claim.

## What this does not show
- One run per arm on one scope; a daemon in a full DO run lives longer and may grow back.
- Memory only on this build and this kernel; the timings are under named outside load.
