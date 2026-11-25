# PR-434 pre-commitment (R1190): spread the per-test baseline fill over the lanes' daemons

Coord PR-434 (lethal-code, 2026-11-25). Ruling (orchestrator): build only the largest LethAL-side lever, and only if it
saves at least 5% of the recheck. No verdict may move. Evidence: `/coord/handoff/PR-434/findings.md`, `measure.sh`,
`m1/`.

## What was measured
- **c5's recheck** (`/coord/handoff/PR-422/c5`, 2,120.8 s): generate 23.9 s, deploy 47.3 s, baseline 757.3 s,
  mutants 1,278.0 s. For the whole nested baseline, the process tree held one al-runner (about 3.3 GiB, against about
  15.8 GiB at 5 lanes in its mutants phase).
- **Why one al-runner.** A method-isolated (or `--isolate-tests`) baseline takes `takeDaemonBaseline` →
  `fillIsolatedBaseline` → `fillIsolatedViaDaemon`. That loop sends one request per test, on ONE lane's daemon, in
  sequence. R951's cross-check samples are awaited in the loop: PR-119 made the whole-codeunit fill's samples
  concurrent, but left the per-test fill's sequential.
- **m1** (part 1's receipt line; one method-isolation DO run, CPUs 0-11, mean load1 29.3, with preproc and bugs on
  CPUs 12-21): fill wall 1,788.0 s.
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
- Answer stability is guarded by R951's cross-check samples (a fresh process against the daemon's answer, per test),
  not by the daemon count.
- Even so, this change keeps a codeunit's tests on one daemon, in queue order (below). Every test still sees the same
  earlier requests of its own codeunit as today. Only requests of OTHER codeunits drop out of its daemon's history.

## The change
1. **Groups and workers.** `fillIsolatedViaDaemon` splits `refs` (queue order) into codeunit groups: the maximal runs
   of one codeunit id, never split. Then:
   - With `lanesBuilt` and more than one lane, one worker per joined lane takes the next whole group from a shared
     queue and sends that group's requests, in order, on its own lane's daemon.
   - Today's checks run unchanged around every request: `stopHandle.spent()`, `memoryGate(true)`, `checkBound`,
     `baselineRequest`, `memoryRelease`, `stopHandle.signalled()`.
   - Each request's outcome (`got` / `failed`) is stored by its position in `refs`.
2. **The decision pass is today's loop, unchanged.** It walks `refs` in queue order over the stored outcomes, with the
   same skip rules, the same R951 sample plan, cross-checks in place, replacements, `dropDaemonBaseline`, R1001's
   clean-sample count and the R1007 refusal rule. Only the request call is replaced by a lookup.
   - Answers, samples and replacements are therefore those of the sequential loop over the same rows.
   - A `dropped` or `stop` result ends the pass exactly where it does today. Requests the workers already sent past that
     point are cost only: nothing from them is kept or served.
3. **Joining lanes.** Lane 0 always works, and its memory behaviour is today's (`memoryGate(true)` waits, then stops the
   session).
   - Lane k ≥ 1 joins only when ONE side-effect-free read of the memory guard admits it, with no waiting and no stop.
     The read admits when `used + (joined + 1) × memoryEstimate() + reserve ≤ bound`, with PR-119's admission
     constants.
   - With the guard off or absent, every built lane joins.
   - A lane that is not admitted never starts a daemon. Its groups stay in the queue for the others.
   - `LETHAL_V3_PERTEST_LANES=1` makes lane 0 the only worker: today's fill, for an A/B and as a way back.
4. **Stops.**
   - A worker that meets `spent()`, `signalled()` or a refused `memoryGate` sets `stopped`, and no worker starts a new
     request after that.
   - The decision pass ends at the first position with no stored outcome, as the sequential loop's `break` would.
   - Every worker is awaited before the pass, and before any throw goes on (R866's rule: no daemon outlives the fill).
5. **End.** Every joined lane's daemon is closed with `closeLane(lane, "baseline-end")`, as lane 0's is today. The
   mutants phase therefore starts as it does now.
6. **Receipt.** Part 1's line names the workers ("one daemon, in sequence" becomes "<n> daemons, by codeunit") and the
   lanes not admitted. It stays a plain receipt line, not a warning code, so no gate's warning set moves.
7. **Part 1 (built and red-checked):**
   - the per-test fill's receipt line;
   - the nested recheck's own TIMING, printed after it as "recheck (nested session) TIMING…".

## Pre-committed outcomes (any difference is a BLOCK)
1. **Verdicts on DO.** m1's command (`measure.sh`, its own new folder, the PR head) gives per-mutant verdicts and
   killing tests equal to m1's report (`m1/report.json`: 43 killed, 16 survived, 10 no-coverage).
   - Its receipt shows more than one daemon.
   - The fill's wall is at most 50% of m1's 1,788.0 s; the prediction is about 1,695 / n + one first warm-up. This
     is a cost claim under shared load: the run names its load, and a miss is reported, not hidden.
2. **v3 gate** (`itest:alrunner-v3`, all legs): every figure unchanged. That includes DBI (the per-test path) and
   ISO's per mutant, the `daemonBaselineReport` facts DBI reads, and every leg's warning set.
   - DBI runs unlaned (no `lanes(N)`), so it takes lane 0 alone. A worker count above one is proven by a unit test
     (below) and by outcome 1. Not by the gate.
3. **Carry gate** (`itest:alrunner-v3-carry`): unchanged (the carry rig is session isolation; it never enters this
   path).
4. **The recheck's saving** is read at the next full DO run from the nested TIMING line (part 1). It is reported, not a
   gate: predicted nested baseline about 250-400 s against c5's 757 s.
5. **Unit tests, red both ways:**
   - A multi-lane per-test fill gives answers, samples, replacements and drops equal to the sequential fill, over a fake
     daemon. The cases are a clean fill, a differing sample (drop), a skipped sample (replacement), and a stop
     mid-fill. Red: send the groups' outcomes in completion order instead of queue order.
   - A codeunit's tests all go to one lane, in order. Red: split a group across workers.
   - A lane the memory read does not admit starts no daemon, and the fill still finishes on the others. Red: drop the
     admission check.
   - `LETHAL_V3_PERTEST_LANES=1` gives one worker. Red: ignore the variable.
