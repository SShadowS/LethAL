# PR-252: PERF-10's "1,967 s wait" was a wall-clock step; LethAL times durations and deadlines on the wall clock — spec-light

lethal-preproc, 2026-11-20 (coord PR-252). Offline. No code; build only after the orchestrator's ruling. Evidence:
`/coord/handoff/PR-252/notes.md`; PERF-10's events `/coord/handoff/PR-217/perf10c.run.events.ndjson`; y3's
`/coord/handoff/PR-204/y3.run.events.ndjson`.

## 0a. Amendment 1 (2026-11-20, the rulings and the cause; before the build lands)
- **RULED:** build it (Q1); report timestamps stay on wall time. **The cause (kraken):** server1 is a laptop and it
  SUSPENDED 06:46:03Z-07:18:59Z (1,976 s); the owner keeps suspend on, so expect more. Linux `CLOCK_MONOTONIC` does not
  count suspended time, so the monotonic helper EXCLUDES a sleep from durations and deadlines: the right behaviour.
- **Added (orchestrator): suspend detection.** The run samples `wall − monotonic`; when that gap grows by more than a
  threshold (pre-committed: 30 s) between two samples, a suspend of that length is recorded with its wall time.
  - **Reported through a new WARNING code** `run-suspended` (`[lethal] the machine was suspended (or its clock stepped)
    for N s at <ISO wall time>; durations and deadlines exclude it (monotonic clock)`; the "(or its clock stepped)" was
    added after the Opus build review: a forward time-sync step above 30 s fires it too), one per suspend, plus the total in the pre-run/stats
    lines. A warning lands in the report's existing warnings, so NO SessionReport field and no schema ripple (CLAUDE.md's
    field ripple would regenerate every committed sample report live).
  - Gates never suspend, so no gate's warning set moves (`GATE_WARNINGS` unchanged); a gate that did see one would fail by
    name, which is right.
  - **Red tests:** a stepped wall clock (+60 s between two samples with the monotonic clock still) emits exactly one
    `run-suspended` with N ≈ 60 and its wall time; a +10 s step (under the threshold) emits none; a backward step emits none.

## 0b. Amendment 2 (2026-11-20, the orchestrator relaying kraken; before any code): a boot-clock suspend signal
- **Change:** the suspend watch samples `boot − monotonic` instead of `wall − monotonic`, where `boot` is the kernel's
  CLOCK_BOOTTIME read from `/proc/uptime`'s first field (seconds since boot, counting suspend).
  - That gap grows by exactly the time slept. An NTP step of the wall clock does not move it, so a time-sync step no
    longer reads as a suspend.
  - Where `/proc/uptime` is missing or unreadable when the watch is created (not Linux), it falls back to
    `wall − monotonic`, today's behaviour. The source is chosen ONCE per watch and never mixed mid-run.
  - A read that fails mid-run skips that sample: no warning, and the baseline is kept.
  - The warning's wall time stays `Date.now()`.
- **Unchanged:** the warning text, including "(or its clock stepped)", which is still true on the fallback. The code
  `run-suspended`, the 30 s threshold, the TIMING total, `GATE_WARNINGS` and the report shape. No new event field.
- **Seam:** `clock.boot` beside `clock.mono` (replaceable in tests, restored after).
  - PR-252's existing suspend tests pin `clock.boot` to "missing", so they keep testing the wall fallback.
- **Pre-committed tests:**
  - boot source: the boot clock +60 s between two samples with the monotonic clock still emits exactly one warning,
    N ≈ 60;
  - the wall clock +60 s (an NTP step) with the boot clock still emits NONE;
  - +10 s on the boot clock emits none;
  - fallback: with `clock.boot` missing, PR-252's +60 s wall step still warns once (the existing tests);
  - a boot read that fails after the watch was created emits nothing and does not throw;
  - `readBootMs` parses a real `/proc/uptime` line and returns undefined for an unreadable or garbage one.
- **Red checks, both directions:**
  - the default source forced back to wall turns the NTP-step test red;
  - the fallback broken (no wall when boot is missing) turns the existing +60 s test red;
  - a boot reader returning seconds, not ms, turns the boot +60 s test red (N would be about 0.06).
- **Gates:** whatever `selectLegs` names for the diff, on the final head.
- **As built (PR-264):**
  - The seconds-not-ms red check went red through the `readBootMs` parse test. The boot +60 s test injects
    `clock.boot` and never calls the reader.
  - So a test that reads the boot clock THROUGH `readBootMs` (a fake `/proc/uptime`) was added, and red-checked.
  - So was a suspend during failed boot reads (reported on recovery from the kept baseline).

## 0c. Amendment 3 (2026-11-20, the orchestrator's ruling, before any code): `run-suspended` is an ENVIRONMENT warning
- **Found:** PR-264's v3 gate (leg WR) and tables gate at 876887eb2 both failed on one extra warning, `run-suspended`
  (2,178 s). server1 really slept about 13:05:04Z-13:41:22Z: CLOCK_BOOTTIME minus CLOCK_MONOTONIC grew by 2,177 s.
  The owner keeps suspend on. Deadlines are monotonic, so a sleep cannot change a verdict, but any gate spanning one
  would fail on its warning set at random.
- **Ruled:** gate warning-set comparisons leave `run-suspended` out, and the gate log prints it with its message (which
  carries the length).
  - **Mechanism:** `LOGGED_ONLY` in `packages/runner/itest/gate-warnings.ts`, which already holds `lease-renew-blip`
    for the same reason (R852). `assertGateWarnings` prints each logged-only code's message and leaves it out of the
    comparison, and so does hang's baseline leg.
  - No `GATE_WARNINGS` set changes. Observe mode still prints every code.
  - Runtime behaviour is unchanged: the warning is still emitted in the report.
- **Pre-committed tests:**
  - a gate whose only extra code is `run-suspended` passes, and its message is printed;
  - `run-suspended` plus any other new code still fails, naming that code and not `run-suspended`;
  - a missing expected code still fails when `run-suspended` is present.
- **Red check, both directions:** with `run-suspended` removed from `LOGGED_ONLY`, the "passes" test goes red. The
  "still fails" test already goes red with every code logged-only (a constant-true filter).
- **Gates:** every leg `selectLegs` names, on the final head.

## 1. What the "wait" is (measured)
- PR-251 saw one prefetch request per lane whose untimed part was the same 1,967.19 s. It is not a wait:
  - each request's `serve-request-timed` is followed by its own `serve-request-sized`, and lane 1's request 798 was
    answered ~20 s after request 797 on the same daemon (`atMs` 15,026,452 -> 15,046,229), yet its `wallMs` reads 1,986,688;
  - `wallMs` is `Date.now() − timedAt` (al-runner-v3-backend.ts `request()`), the WALL clock; event `atMs` comes from the
    progress stream's own clock (progress-ndjson.ts), which did not jump;
  - the mutants phase: `elapsedMs` 18,424,705 against an `atMs` span of 16,457,517: a difference of **1,967,188 ms**, the
    same step. Every other phase of PERF-10, and EVERY phase of y3, agree within ~75 ms.
- **So the system's wall clock stepped forward by ~1,967 s (~32.8 min) during PERF-10's mutant phase**, and every interval
  measured on `Date.now()` across that moment grew by it: the three requests in flight (one per lane) and the phase.
- **No lane time was lost and no verdict moved:** no deadline error, no "no summary line" message anywhere in PERF-10's
  events. PERF-10's TIMING "mutants 18,424.7 s" is overstated by 1,967 s; PR-251's 16,458 s (from `atMs`) is right.

## 2. The hazard (read in code)
- The runner times DURATIONS and DEADLINES on the wall clock: 65 `Date.now()` uses in 10 files of packages/runner/src
  against 9 `performance.now()`.
  - Every daemon deadline: `al-runner-server.ts` start, `runTests` and `runEntries` all compute `deadline = Date.now() +
    deadlineMs`. A forward step larger than a request's remaining deadline throws a `deadline` error.
  - A v3 deadline error scores `deadline-exceeded`, "never a kill (R635 §6)": a lost measurement (`error`), not a false
    kill. On BC the in-flight path reads `durationMs >= budget` to word a quarantine.
  - Durations reported (`wallMs`, `durationMs`, phase `elapsedMs`, TIMING) are inflated by a forward step and can go
    negative on a backward one.
- PERF-10 escaped because each in-flight deadline was longer than the step. A step during a short-deadline request (live
  requests, the R912 clamp near the end of a time budget) would turn real measurements into `error`.

## 3. Proposal
- Time every DURATION and DEADLINE on a monotonic clock (`performance.now()`, through one injectable clock helper, so tests
  can step the wall clock); keep `Date.now()` only for timestamps written to stores and reports.
- **Tests:** an injected wall-clock step of +2,000 s during a request leaves its deadline, its `wallMs` and the phase's
  `elapsedMs` unchanged (red against today's code); a backward step never yields a negative duration.
- No verdict or gate figure moves on a run without a clock step; a run with one stops misreporting.

## 4. For the orchestrator
- Q1: build it (small, mechanical: ~65 call sites through one helper), or file it as a roadmap item for later?
- Q2: the box's clock stepped ~32.8 min during PERF-10 (≈ 4 h 10 min after its 22:36Z start): worth asking kraken whether
  the host's time sync stepped (rather than slewed) the clock.
