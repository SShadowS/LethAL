# PR-41 pre-commitment, step 1: a v3 timeout kill whose NONE confirm passed is not reproduced (R577), so a hang meets the timeout once or twice, not four times

Status: pre-commitment (coord PR-41, lethal-code, 2026-11-15), before the build. Approved in design by the orchestrator (2026-11-15,
five conditions, below). Step 2 (refusing hang shapes up front) is separate and lands only after DO window t7 has started (it
changes the emitted AL, which L5's baseline reuse keys on). Evidence: `/coord/handoff/PR-41/`, `/coord/handoff/R-984/t5-timeouts.md`.

## Why

R-984 t5 (DO): 19 serve-daemon timeout closes came from 5 real hangs, about 2,670 s of a 10,525 s mutant phase. The trace
(`trace.md`, inferred from code and event order; no per-request log exists) gives, per hang: P, the prefetch request cut at the
first timeout; A, an alone call of the killer when P stopped at another test; then R577's reproduction (`reproduceKill`) as a live
call of the whole codeunit (L) and, when that stops at another test, another alone call (A2). L and A2 exist only for the
reproduction. M11468 met the timeout 4 times, M7544 3.

## The change (runner only; the emitted AL does not change)

For a kill on the al-runner v3 backend whose killing row is a TIMEOUT and whose unmutated NONE confirm passed, `reproduceKill`
is not run. The mutant is `timeout-killed` as today, with stop evidence `v3-cpu-stop` (a new `StopEvidence` value, named for the
rule: "v3 CPU-time stop, NONE confirmed"), and R577's resume rule carries such a kill without `killReproduced`. The session report
counts these kills. bcdev, and every non-timeout v3 kill, are unchanged: R577 reproduces them as today. The backend says whether
its stop is CPU time by a capability, not by its name.

## Why it is safe (the orchestrator's conditions 1 and 5)

- al-runner's `--test-timeout-secs N` stops a test after N seconds of CPU TIME: machine load does not count
  (`docs/measurements/README.md`, "al-runner v3"). The update gate measures it on every build as leg C's contract fact
  `timeout-is-cpu`: the same endless burn, pinned beside 7 busy loops, is stopped later in wall time than alone (a CPU-time stop);
  it read `matches` on the current build (`edge-5a58a0f16`, PR-37's gate receipt). So load cannot make a test time out earlier,
  which is what R577's reproduction guards a kill against. The NONE confirm (the unmutated test runs fast) stays.
- Measured: across every results store under `/coord/handoff` with al-runner v3 runs (252 stores; `repro-count.ts`), 61 of 61
  `timeout-killed` mutants reproduced; 0 failed; 0 `error` notes name a failed reproduction.

## Predictions

1. Unit tests, red both ways (condition 4): a v3 timeout kill with a passing NONE confirm skips reproduction and carries
   `v3-cpu-stop`; a non-timeout v3 kill still reproduces; a bcdev timeout kill still reproduces; R577's resume carries a
   `v3-cpu-stop` kill and still re-executes a v3 timeout kill with neither `killReproduced` nor `v3-cpu-stop`.
2. The schemas gain one enum value (and the report its count); every committed sample report still validates; SessionReport
   ripple rules (CLAUDE.md) followed. If a committed sample or frozen baseline pins a stop-evidence value that moves, that is
   reported before anything is re-recorded.
3. `itest:alrunner-v3` passes every leg; no frozen verdict moves (stop evidence is not part of the per-mutant compare).
4. The next DO window carrying it: every `timeout-killed` mutant meets the timeout at most twice in serve requests (P, and A when
   P stopped at another test), never in a reproduction; verdicts and killing tests of every mutant both windows score equal.

## Addendum 1 (2026-11-15, after the Opus build review, before any gate): the skip is withdrawn; R577 stays, its reproduction is an alone call

**Why.** The review of the skip build (lethal/pr-41 54635577) found two gaps, and the orchestrator chose to withdraw the skip:
- B1: R652's comment above `checkBound` rests on R577 re-sending every kill fresh; skipping the reproduction reopens a transient
  file-drift gap between the bound check and al-runner's read (a lasting drift is still caught by the confirm's own check).
- B2: "load cannot cause a CPU-time stop" is only partly measured: leg C's `timeout-is-cpu` loads the core from OUTSIDE the
  process; whether v3 counts the test thread's CPU or the process's is not known, nor whether the 10 x N wall stop for a waiting
  test prints the same text. Asked upstream: https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8168. The skip returns
  as a follow-up only if the answer is the test thread's CPU and a distinct wait-stop text (and B1's comment is rewritten).

**The change now (no verdict policy change; runner only, the emitted AL does not change).** On the al-runner v3 serve transport,
once a mutant's call was cut at a timeout, every further run of that mutant's tests (the alone call A, and R577's reproduction) is
an alone call of the one test asked, never a live call of the whole codeunit. So R577 still re-runs the killing test under the
mutant, fresh, but only that test: L (a whole-codeunit live call that can stop at another test) and A2 (the alone call it then
needs) are gone. A non-timeout kill, and every bcdev kill, are unchanged.

**Predictions (replacing 1-4 above).**
1. Unit tests, red both ways: after a cut-at-timeout, the reproduction of that mutant's killing test is an alone call (counted on
   a stateful fake), red when the routing is removed; a kill without a timeout still reproduces through the live path; NONE (the
   confirm) is never routed alone by this rule.
2. No schema or report change; no frozen baseline or sample report moves; `itest:alrunner-v3` passes every leg.
3. The next DO window carrying it: a hanging mutant meets the timeout P (+ A when P stopped at another test) + 1 (the reproduction,
   alone), plus a re-send when a later codeunit of the same mutant also hangs: at most 3, against 3-4 in t5; verdicts and killing
   tests of every mutant both windows score equal.
