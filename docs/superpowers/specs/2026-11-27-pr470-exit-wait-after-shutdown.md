# PR-470 pre-commitment (R1233, al-runner #9232): let a serve daemon exit on its own after its shutdown reply

Coord PR-470 (lethal-preproc, 2026-11-27). Evidence: `/coord/handoff/PR-470/`. Counts and timings only.

## The measurement the bound comes from (the probe, done)
- **Build and kit:**
  - LethAL probe branch `lethal/pr-470-probe` b62d2c140 (never merged): master plus PR-467's recycle-once kit, plus a close
    that, after the shutdown reply, waits up to 60 s for the process to exit and logs the time;
  - al-runner main 80960b023 (contains #8446), PR-467's privately gated build.
- **The run:** DO, PR-452's scope (1121 mutants), 5 workers, recycle once per lane, cores 3-11 (`probe/`).
- **Result: 26 closes, every one answered the shutdown at once (0-2 ms) and exited on its own.** Time from reply to exit:
  min 2 ms, median 258 ms, p90 419 ms, max 859 ms. None needed the 60 s.
- **With the wait,** a new `.alcw` entry was written at lane 0's recycle (05:56:56Z, 314 s into the run), and all 5
  restarted daemons read the cache (`workspaceCache` = `read`, warm-up 2.8-6.3 s).
- **Without it** (PR-467 arm R, master's close): lane 0's restarted daemon built again, and no entry was written.
- **Confound:** the probe's cache already held lane-0 entries left from PR-467's runs. The measurement below uses a cache
  without them.

## The change
- **The fix:** `AlRunnerServer.close()` (`al-runner-server.ts`): after the shutdown REPLY, wait for the process to exit,
  bounded by **`SHUTDOWN_EXIT_WAIT_MS = 5_000`** (about 6 times the 859 ms worst case on DO, the largest workspace we run).
  - Only past the bound does `terminate()` send SIGTERM.
  - A process that exited within the bound is never signalled. `terminate()` still reaps it and drains its stderr, as
    today.
- **Unchanged:**
  - with no reply within `SHUTDOWN_REPLY_WAIT_MS` (500 ms), the SIGTERM comes at once, as today, so a daemon that is not
    answering costs no extra wait;
  - there is no SIGKILL change.
- **Every close benefits:** recycle, refusal or timeout close, and session end all use `close()`.

## Red tests, both directions (call counters on a fake process, no wall clock)
- A daemon that replies and exits within the bound: `kill` is called 0 times, and `wait` resolved before `close()` returned.
- A daemon that replies and never exits: `kill` is called once, after the bound (the bound is a constructor option, so the
  test sets it small).
- A daemon that never replies: `kill` comes without the exit wait (the wait is never awaited before it).
- Each is red-checked by reverting its part.

## The measurement of the build (pre-committed outcomes)
- **The arm:** LethAL `lethal/pr-470` plus PR-467's recycle-once kit (kit branch only, never merged); the same build, scope,
  workers and cores as the probe.
  - The cache is a fresh copy of the probe's cache dir WITHOUT `compile/*-ws-*.alcw`, so lane 0's first daemon must build.
  - **Control:** PR-467 arm R (master's close, recycle once), whose recycled lane-0 daemon built again with no entry
    written.
- **Holds when:**
  1. lane 0's first daemon reads `built`, and a new `.alcw` is written within its recycle close (mtime between the close
     and 5 s after);
  2. every restarted daemon's first request reads `read` (5 of 5 lanes);
  3. verdicts equal PR-467 arm N's on the full site key (1121 of 1121);
  4. the added close wall: every close's reply-to-exit time is at most the bound, and none reaches it. The median, the max
     and the sum over the run are reported.
- **If (1) or (2) fails, the default does not change** (the task's condition). The branch is not submitted as a speed change,
  and the finding goes to the orchestrator.
- **Then:** VERIFY, the v3 gate, and CI. The BC legs that `legs.ts` selects for `al-runner-server.ts` run too.
- **Not claimed here:** the speed win, which lands with the first gated `current` that carries #8446.
