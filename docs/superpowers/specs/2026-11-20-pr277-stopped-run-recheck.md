# PR-277 pre-commitment: a stopped run skips the withheld-kill recheck; a second signal ends the process; no daemon for a 0-test recheck (R1158)

Lane lethal-bugs, coord PR-277, 2026-11-20. Committed before any code.

## What happened (R1158, lethal-preproc's PR-267 arm P; /coord/handoff/PR-267/ab-P.stopped-1644Z/events.ndjson)
- A SIGTERM at 16:44Z stopped the mutants phase as designed: `time-budget-reached`, `stoppedBySignal: true`, 485 mutants left out.
- The process then started the withheld-kill recheck (PR-144): a NEW serve daemon on DO's full instrumented build.
  `recheck-baseline-finished` came 663 s after the stop, with `tests: 0`, `elapsedMs: 547044` and no verdicts.
- A second SIGTERM was not acted on; SIGKILL ended the run, so the report was never written.

**The premise is measured:**
- unstopped runs' recheck baselines take 2,088 s for 1,161 tests (y3) and 586 s for 497 tests (perf10c);
- the stopped run's took 547 s for 0 tests.
So the 547 s is the cost of starting a recheck daemon for nothing, not something peculiar to stopped runs.

## The change
1. **A stopped run skips the recheck.** When the session stopped by a signal, the time budget, the memory guard or the PR-250
   churn guard (anything that makes `time-budget-reached` the session's end), the withheld-kill recheck does not start. The report
   is written at once.
   - Its withheld kills stay withheld, as they are when the recheck is off, and the report says why: a new caveat line or warning
     `al-runner-v3-recheck-skipped-stopped`, naming the stop.
   - A recheck cannot fill in the mutants the stop left out, and the user asked the run to end.
2. **A second SIGTERM or SIGINT ends the process.** After the first signal has been acted on (the budget spent), a second one ends
   whatever still runs (a recheck in progress, teardown): its daemons are closed, the report is written with what is known if
   possible, and the process exits with the signal stop's code. It must not hang waiting on a daemon.
3. **A 0-test recheck starts no daemon.** When the recheck's targets select no test to run (the R1158 case: `tests: 0`), the
   baseline is skipped: no daemon, no `recheck-baseline-finished` with an empty run. A warning names the case (targets, but no
   tests), as PR-225's skip does when there is no candidate kill.

## Unchanged
- An unstopped run with targets and tests runs the recheck exactly as today: the same events, verdicts and report.
- The off switch `alRunnerV3.recheckWithheldKills: false`.
- The first signal's handling of the mutants phase (R955).

## Predictions
- **The v3 gate:** PASS, unchanged. No leg stops a session, and no leg's recheck has 0 tests; if any did, its warning set moves and
  that is a BLOCK.
- **Unstopped DO runs:** no change; y3's and perf10c's rechecks had tests.
- **Arm P's case** (a stop, then a recheck with 0 tests) now ends at the stop with its report written. It is not re-run live: the
  unit tests carry it.

## Tests (red both ways)
- stopped by a signal, by the budget, and by the churn guard: no recheck starts and the report is written with the skip warning;
  unstopped with targets: the recheck runs as today;
- a second signal during the recheck: the process ends promptly (a fake recheck that would block), and the daemons are closed;
- targets with 0 tests: no daemon is started, the warning is given; targets with tests: the baseline runs.

## Order
Code and red-going tests now. VERIFY, the v3 gate and CI wait until code's PR-274 timed series ends (the orchestrator's quiet box).

## Amendment 1 (2026-11-20, from the build, before any gate): the R1158 cause was misread
- **What actually happened:** arm P's 0-test recheck baseline was NOT "a recheck whose targets selected 0 tests". The nested
  recheck session registered its OWN process signal handlers (`registerProcessStopSignal`). So the operator's SECOND SIGTERM became
  the nested session's FIRST: it spent the nested budget, and the nested baseline broke out with 0 tests run. The 547 s was a
  daemon start plus a baseline cut short by that signal. The second signal never reached the outer session, which is why only
  SIGKILL ended the run. Evidence: the events, stderr and run.log end at 16:55, which is the second SIGTERM.
- **So part 3 needs no new code.** A target set with no tests already skips before any daemon (PR-225's
  `withheld-recheck-skipped`), and a name that matches no test is refused (`keepOnlyTests`). Part 3 gets tests both ways, not a
  second warning code.
- **The fix for the cause:** the nested recheck session registers no signal handler, and the outer session's handler owns every
  signal:
  - the first spends the budget;
  - the second aborts the recheck (closing its backend) and closes the daemons, and the process exits with the signal stop's code
    7 after a 10 s grace;
  - a third exits at once.
