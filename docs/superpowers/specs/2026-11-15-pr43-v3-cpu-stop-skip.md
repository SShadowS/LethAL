# PR-43 pre-commitment: skip R577's reproduction for a provable al-runner v3 CPU-time stop

Status: pre-commitment (coord PR-43, lethal-code, 2026-11-15), before the build. Follow-up of PR-41 (R1055), whose first version
of this skip was withdrawn (that spec's addendum 1: review findings B1 and B2). The orchestrator approved the four conditions below
(2026-11-15). Evidence: `/coord/handoff/PR-41/` (trace), `/coord/handoff/R-984/t5-timeouts.md`, upstream #8168 (comment with the
source read).

## B2, settled from the source (al-runner at 5a58a0f16, `/coord/cache/al-runner-v3-src`, read-only)

- The limit is the test THREAD's CPU time from the test's start (`Watchdog::start_paused` in `crates/al-testrun/src/runtime/run.rs`;
  on Linux `pthread_getcpuclockid(pthread_self())`). Other threads (GC, the serve loop) do not count.
- Two other stops set the same flag and print the same row (`Test exceeded Ns timeout.`, `clock: "cpu"`): the wall backstop at
  10 x N (`WALL_BACKSTOP`), and the wall stop at N when no CPU clock can be read (not expected on Linux or Windows). A row cannot
  name them. The backstop cannot fire before 10 x N of wall time, so a row whose `durationMs` is below that is a CPU stop.
- Not settled by the source: CPU time is not fully load-proof. Under SMT contention or frequency scaling the same work costs
  more CPU seconds. Hence the margin in condition 3.

## The change (runner only; the emitted AL does not change)

A v3 timeout kill skips `reproduceKill` and is scored `timeout-killed` with stop evidence `v3-cpu-stop` (a new `StopEvidence`
value) only when ALL hold:
1. the killing row has `clock: "cpu"` (v3 rows now carry `clock`; a missing or other value keeps R577);
2. the killing row's `durationMs` is below 10 x N x 1000 (N = the stop the call was sent);
3. the unmutated NONE confirm of that test passed, and its own `durationMs` is at most N x 1000 / 4;
4. (B1) R652's comment above `checkBound` is rewritten: a CPU-stop kill is not re-sent, so a file change that came and went inside
   its send's gap is not caught; a lasting one is caught by the confirm's own bound check.

Any condition failing keeps R577's reproduction exactly as today. The v3 backend marks the verdict (a CPU-stop flag set only from
conditions 1-2); the orchestrator adds condition 3. bcdev never sets the flag, so it is unchanged. R577's resume carries a
`v3-cpu-stop` kill without `killReproduced`. If upstream adds a distinct `clock` value for the backstop and the fallback (asked on
#8168), condition 2 is dropped in a follow-up.

## Predictions

1. Unit tests, red both ways, one per condition: each failing condition (clock absent or not `cpu`; `durationMs` at or above
   10 x N; NONE failed, or its duration above N/4) keeps the reproduction; all holding skips it and records `v3-cpu-stop`; a
   non-timeout v3 kill and a bcdev timeout kill still reproduce; resume carries `v3-cpu-stop` and re-executes a v3 timeout kill with
   neither `killReproduced` nor `v3-cpu-stop`.
2. The schemas gain the enum value (and the report its count); SessionReport ripple rules followed; every committed sample report
   still validates. A committed sample or frozen baseline that pins a moving stop-evidence value is reported before any re-record.
3. `itest:alrunner-v3` passes every leg; no frozen verdict moves.
4. DO, the next window carrying it: verdicts and killing tests equal. t5's five real hangs all meet the conditions (killing tests'
   unmutated own time 0-449 ms, under 15 s; kill rows 63-183 s, under 600 s), so their reproductions go: about 450 s of single runs
   plus about 5 x 32 s of restarts, about 610 s of t5's 10,525 s mutant phase. Each such hang meets the timeout once (P) or twice
   (P and A).

## Addendum 1 (2026-11-15, after the first build, before any review or gate)

**Condition 3's time when the row has none.** al-runner omits `durationMs` on a row whose time is zero
(`crates/alrunner-cli/src/output.rs`, `test_row`: `if !time.is_zero()`), so a 0 ms unmutated test (2 of t5's 5 hangs: M11934 and
M11940) gives a confirm with no measured time, and condition 3 as written would always keep R577 for it. Condition 3 now reads the
confirm's own `durationMs` when the row has one, else the confirm call's wall time, which is never below the test's own time. So
the rule stays conservative. A missing time on both keeps R577.

**Only the cold confirm site.** The skip applies where a kill at position 1 is confirmed by the NONE run of that test. A warm group
timeout (position > 1, confirmed by `confirmWarm`) has no NONE run of that test's own time: it reproduces as today. Prediction 4
holds for t5's hangs that were killed at position 1. One killed at a warm position keeps its reproduction, and the result names it.

**Predictions, added to 1.** A confirm with no measured time and a wall at most N/4 skips. One with a wall above N/4 reproduces.
Both are red both ways.

## Addendum 2 (2026-11-15, after the Opus build review, before any gate)

**No separate report count.** Prediction 2 said "the report its count". A new `SessionReport` field means regenerating every
committed sample report live (CLAUDE.md's ripple rule), and the count can already be read from each mutant's `stopEvidence`
(`v3-cpu-stop`) in the report. So no count is added. Prediction 2 now reads: the schemas gain the enum value, and every committed
sample report still validates.

**Every-kill-reproduced checks.** `killReproductionFailures` (`kill-reproduction.ts`) and the v3 itest's `assertReproduced`
exempt a `timeout-killed` mutant with `stopEvidence` `v3-cpu-stop`. A v3 timeout kill with neither marker still fails them. The
exemption is unit-tested both ways. No v3 baseline holds a `timeout-killed` today (hang sites stay in `itest:hang`, R164), so the
v3 gate cannot exercise the skip live; DO's next window is where it shows (prediction 4).
