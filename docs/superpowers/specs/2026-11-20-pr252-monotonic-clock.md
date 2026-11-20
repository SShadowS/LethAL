# PR-252: PERF-10's "1,967 s wait" was a wall-clock step; LethAL times durations and deadlines on the wall clock — spec-light

lethal-preproc, 2026-11-20 (coord PR-252). Offline. No code; build only after the orchestrator's ruling. Evidence:
`/coord/handoff/PR-252/notes.md`; PERF-10's events `/coord/handoff/PR-217/perf10c.run.events.ndjson`; y3's
`/coord/handoff/PR-204/y3.run.events.ndjson`.

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
