# PR-434 pre-commitment (R1190): spread the per-test baseline fill over the lanes' daemons

Coord PR-434 (lethal-code, 2026-11-25). Ruling (orchestrator): build only the largest LethAL-side lever, and only if it
saves at least 5% of the recheck. No verdict may move. Evidence: `/coord/handoff/PR-434/findings.md`, `measure.sh`,
`m1/`.

**r2 (after the spec-adversary, same day).** The review found 3 blockers, 8 serious findings and 3 minor ones, and no
direct false-kill path. This r2 replaces r1's "The change" and outcomes. Each finding is answered under its number
(A1-A14) in §"Answers to the review".

## What was measured
- **c5's recheck** (`/coord/handoff/PR-422/c5`, 2,120.8 s): generate 23.9 s, deploy 47.3 s, baseline 757.3 s,
  mutants 1,278.0 s. For the whole nested baseline, the process tree held one al-runner (about 3.3 GiB, against about
  15.8 GiB at 5 lanes in its mutants phase).
- **Why one al-runner.** A method-isolated (or `--isolate-tests`) baseline takes `takeDaemonBaseline` →
  `fillIsolatedBaseline` → `fillIsolatedViaDaemon`. That loop sends one request per test, on ONE lane's daemon, in
  sequence. R951's cross-check samples are awaited in the loop: PR-119 made the whole-codeunit fill's samples
  concurrent, but left the per-test fill's sequential.
- **m1** (part 1's receipt line; one method-isolation DO run, CPUs 0-11, heavy-slot `--peak 8`, mean load1 29.3,
  with preproc and bugs on CPUs 12-21): fill wall 1,788.0 s.
  - Daemon requests: **1,979, taking 1,695.1 s (94.8%)**.
  - Cross-check one-shots: **16, taking 91.0 s (5.1%)**.
  - That is 0.86 s per request. Scaled to c5's 593-test recheck: about 508 s of requests and about 91 s of samples.
- **The prize:**
  - c5's recheck: about 400 s (19%) at 5 lanes.
  - **The larger one is the main session.** Every method-isolated or `--isolate-tests` run on DO spends about 1,700 s
    of its baseline on this one daemon, and this change covers it too.
  - The concurrent samples are left out (at most about 91 s, 4.3% of c5's recheck: under the 5% bar).

## Why R-948 used one daemon
- R-948 (0546dc060, `2026-11-13-r948-db-leg-precommitment.md`) states no answer-stability reason. One daemon was the
  first daemon baseline, built with its memory guard.
- Answer stability is guarded by R951's cross-check samples (a fresh process against the daemon's answer, per test).
- This change keeps a codeunit's tests on one daemon, in queue order, and samples every daemon that answered (A9).

## The change (r2)
1. **One tree.** Every baseline daemon of this fill, on any lane, is sent LANE 0's request base: `sourcePaths` start
   with lane 0's `realActive`.
   - Nothing is activated during the baseline (`lastActivated` is null on every lane), so lane 0's tree is the proved
     unmutated tree, the same bytes as each `active.<k>`.
   - Coverage file paths are therefore identical whichever daemon answered. `compareBaselineAnswers`, `coverageOf`'s
     F1 check and `sleepIndex` keep working unchanged on lane 0's paths, and a sample's one-shot runs on lane 0's tree
     in place, as today (A3).
   - Each request calls `checkBound(lane 0)` (R652). If al-runner wrote into the tree under a request, that check
     already refuses by name.
   - The daemon's own process (cwd `daemon-<k>`, its pid, its stderr file) stays the lane's.
2. **Groups and workers.** `refs` (queue order) is split into codeunit groups: maximal runs of one codeunit id, never
   split. Workers pull the next whole group from one shared queue. Lane 0's worker starts at once. Lane k ≥ 1's
   worker joins only as in step 3.
   - A worker sends its group's requests in order, with today's checks around each one: `spent()`, `checkBound`,
     `baselineRequest`, `signalled()`. The memory gate is per lane (step 3).
3. **Memory (A2, A8).**
   - Lane 0 keeps today's `memoryGate(true)` around each request: one hold, as today.
   - No lane k ≥ 1 joins before lane 0's first request has completed. By then the cache is warm (any demo-data download
     is done) and lane 0's daemon RSS can be read.
   - At each group boundary, a lane k ≥ 1 that has not joined asks PR-98's `decideLanes(lanesCharged(joined + 1))`. This
     is the mutants phase's rule: it includes the heavy-slot declared peak (`declaredPeakGib`) and `LANE_RESERVE_BYTES`.
     The per-lane reading is lane 0's measured daemon RSS. A "no" is asked again at the next boundary; it never waits
     and never stops.
   - A joined lane k ≥ 1 takes a new group only while `memoryGate(false)` (no hold) admits it. Otherwise it stops
     taking groups.
4. **Closing while others are in flight (A4).** While more than one worker runs, the gate's over-bound path closes only
   baseline daemons whose lane has no request in flight (`lane.inFlight === undefined`). Today, with one worker,
   nothing changes.
5. **What is stored (A1).** A worker stores, per position:
   - `failed`, `wallMs`, the row count, the row method, and `keptAnswer(got)`. Never the raw answer.
   - A sample position keeps the raw row set it needs for the compare (its rows), not raw coverage beyond what
     `keptCoverage` keeps. `keptCoverage`'s own contract: the compare reads hits and per-test keys only.
6. **Throws (A6).**
   - A worker that throws records `{ threw }` at its position, and no worker starts a new request after that.
   - The pass rethrows only when it reaches that position, so an earlier drop or stop wins, as in the sequential loop.
   - Exception: the memory-bound error with no stop handle stays immediate (today's behaviour).
7. **The decision pass** walks `refs` in queue order over the stored outcomes, with today's rules: skip kinds, R951's
   sample plan and replacements, `dropDaemonBaseline`, R951's `BASELINE_MIN_CLEAN_SAMPLES` (4, counted as `compared`
   less `comparedBefore`), and R1007's refusal rule.
   - A position with no stored outcome ends the pass as a stop ONLY when `spent() || signalled() || memoryStopped`.
   - Otherwise it throws `al-runner-v3-pertest-fill-gap` by name (A5).
8. **Per-daemon samples (A9).** With more than one worker, each lane k ≥ 1 that answered is also sampled.
   - The sample is its first group's second request, or its first when that group has one test.
   - Every lane that answered needs at least one clean compare. Otherwise the daemon baseline is dropped by name
     (`pertest-lane-unsampled:<k>`).
   - These extra samples are counted apart, so the one-worker plan (and DBI's `sampledPerTest`) is unchanged.
9. **Close before the pass (A12).**
   - After `Promise.allSettled` over the workers, every joined lane k ≥ 1's baseline daemon is closed in a `finally`,
     before the pass's one-shots run.
   - Lane 0's daemon closes at the fill's end, as today.
   - No daemon outlives the fill (R866). `spawnDaemon`'s late `setDaemon` is covered, because the close runs after
     every worker has settled.
10. **Knob (A13).** `LETHAL_V3_PERTEST_LANES` is read at construction. Unset means the spread; `1` means lane 0 alone,
    today's fill. Any other value is refused by name.
11. **Run-ahead (A7), accepted and named.** Workers may send past a sample position the pass has not judged yet.
    - A drop therefore costs the requests already sent. Their side effects stay as today's per request: refusal closes,
      the storm notice, `test-data-off`.
    - A drop is rare: m1 and c5 had none. The warning CODES of outcome 1 must still equal m1's (below). A difference
      blocks, and the next step would be a window.
12. **Receipt.** Part 1's line names the workers ("<n> daemons, by codeunit"), the lanes not admitted and the extra
    lane samples. It stays a plain receipt line, not a warning code.
13. **Part 1 (built and red-checked):**
    - the per-test fill's receipt line;
    - the nested recheck's own TIMING, printed after it as "recheck (nested session) TIMING…".

## Pre-committed outcomes (any difference is a BLOCK)
1. **Verdicts on DO (A10).**
   - **m2:** m1's command on the PR head, from a new driver.
     - No SIGTERM; it records LethAL's own pid when it starts and stops only that pid.
     - heavy-slot `--peak 20`. At m1's `--peak 8` no lane can be admitted, and the mutants phase then also runs with
       more lanes; LethAL's per-mutant verdicts do not depend on the lane count.
   - Equal to m1's `report.json` per mutant: verdict and killing test.
   - The daemon baseline is not dropped (no `al-runner-v3-baseline-daemon-*` drop notice), and the receipt shows more
     than one daemon.
   - The skipped sets equal m1's by name. A test may only differ in the `tooSlow` direction under contention, and each
     such test is listed by name.
   - Warning codes equal to m1's.
   - The fill's wall is at most 50% of m1's 1,788.0 s. This is a cost claim under shared load: the run names its load,
     and a miss is reported, not hidden.
2. **v3 gate:** every existing figure unchanged, DBI and ISO per mutant included, and each leg's warning set.
3. **New leg DBI-W (A11):** DBI's session laned, with `workers` 2 and admission forced open by the memory seams. Its
   per-mutant figures, `daemonBaselineReport` facts (less the counted-apart lane samples) and warning set equal DBI's,
   and its receipt shows 2 daemons.
4. **Carry gate:** unchanged.
5. **The recheck's saving** is read at the next full DO run from the nested TIMING (part 1). It is reported, not a
   gate: predicted nested baseline about 250-400 s against c5's 757 s.
6. **Unit tests, red both ways (A14):**
   - stored outcomes hold no raw unhit top-level coverage (A1);
   - lane k's request carries lane 0's `sourcePaths` (A3);
   - the over-bound path never closes a lane with a request in flight (A4);
   - a gap without a stop throws by name (A5);
   - a throw at a later position loses to a drop at an earlier one (A6);
   - no lane k ≥ 1 joins before lane 0's first answer or when `decideLanes` says no, and the fill still finishes (A2,
     A8);
   - each answering lane is sampled, and an unsampled lane drops by name (A9);
   - every joined lane is closed before the pass (A12);
   - the knob gives one worker, and a bad value is refused (A13);
   - a codeunit's tests go to one lane, in order.

## Answers to the review
- **A1** (raw answers held, OOM): store the kept form only (change 5).
- **A2** (admission ignores the declared peak; double count): PR-98's `decideLanes` after lane 0's first answer; no
  hold on lanes k ≥ 1 (change 3).
- **A3** (coverage paths per lane): one tree for every baseline daemon (change 1). This is chosen over a path rebase:
  nothing to rewrite, and R652 already guards the tree.
- **A4** (gate closes in-flight lanes): change 4.
- **A5** (a gap read as complete): change 7.
- **A6** (throws in completion order): change 6.
- **A7** (run-ahead side effects): accepted and named (change 11), checked by outcome 1's warning codes.
- **A8** (cold-cache concurrent starts): no lane k ≥ 1 joins before lane 0's first answer (change 3).
- **A9** (lanes never sampled): change 8.
- **A10** (outcome 1 as written could not show the change): rewritten (outcome 1).
- **A11** (no gate runs it laned): leg DBI-W (outcome 3).
- **A12** (idle daemons during the one-shots): change 9.
- **A13** (the knob): change 10.
- **A14** (weak red check): outcome 6.
- **Wrong about the code (r1):** R1001's uniform watch is not in the per-test fill; the minimum is R951's. PR-119's
  admission has no reserve term; PR-98's does, and r2 uses PR-98's rule.
