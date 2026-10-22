# R-635 pre-commitment, addendum 3: the timer-overflow fix, then every leg plus itest:alrunner

Committed by lethal-code on 2026-10-22, before any leg below runs. It amends the R-635 pre-commitment (fcdf21ca) and
addenda 1 (a8639bec) and 2 (dac3bf6d). Everything not restated stands.

## Why
- **Run 2 on ec6a2680** (`/coord/handoff/R-635/live/run2/results.md`):
  - every verdict was equal, but E3a STOPPED on 2 daemons, against the pre-committed 1;
  - E3b was not run.
- **The cause** (`/coord/handoff/R-635/live/run2/second-daemon.md`):
  - the prefetch request (63 groups, 1386 tests) got a deadline of `v3CallDeadlineMs(180, 1386)` = 2,494,890,000 ms;
  - `LineReader.next`'s `setTimeout` overflowed above 2^31-1, and Bun fired it after about 1 ms;
  - the request was read as `deadline`, daemon 1 was closed, and the prefetch dropped the request silently.
- **The fix**, on lethal/r635 at **5159e50e**, approved by delta build review r3
  (`/coord/reviews/R-635-build/review-r3.md`):
  - `v3CallDeadlineMs` is clamped to 2^31-1;
  - `LineReader.next` caps each timer and waits again until the real deadline, keeping the in-flight read, and marks
    a fired timer with a Symbol;
  - a dropped prefetch request warns by name (`al-runner-v3-entries-prefetch-dropped`) and is counted.

## The amendment
- **Code under test:** lethal/r635 at **5159e50e**. The leg runner's HEAD check names this sha.
- **All seven v3 legs re-run in the original order:** E0-S, E1, E0-T, E2, E0-D, E3a, E3b. Outputs go to
  `/coord/handoff/R-635/live/run3/`, and runs 1 and 2 stay as history.
  - The pre-committed figures are unchanged, including E3a and E3b at **1 daemon**.
  - E0-T's 7 pre-named `error` mutants stand, as in addendum 2.
  - `al-runner-v3-entries-prefetch-dropped` must not occur. Its count is pre-committed at 0, and any drop is a STOP.
- **Plus `itest:alrunner`, v2:** `LineReader` also serves v2's `--server` legs, so
  `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner -- --parallel=3` runs ONCE on 5159e50e. It must PASS with every
  leg's per-mutant verdicts equal to its frozen baselines (`docs/gates/alrunner.md`). Any difference is a BLOCK.
- **The results** give the per-phase split for E3a and E3b, as the orchestrator ruled: the coverage pass, the §5
  windows, `baselineMs`, warm-up, prefetch and live. The next speed step can then target the right phase.
