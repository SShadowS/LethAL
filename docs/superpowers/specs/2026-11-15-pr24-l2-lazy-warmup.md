# PR-24 (speed lever L2): a restarted serve daemon warms each codeunit on first use — pre-commitment

Written before any build or measured run, 2026-11-15. Coord task PR-24. Full safety argument with both reviews:
`/coord/handoff/PR-24/safety.md` (lethal-code and lethal-bugs reviewed it; code: "the five rules are the ones I'd have written").

## Today
Every new serve daemon, first or restarted, sends one NONE warm-up over the session's whole union of codeunits for its mode
(`startDaemon`, R635 §3, R896). On DO that is the whole suite, about 70-100 s per start (PR-18). In t4 so far there have been 18
restarts, all R612 cuts, and each restarted daemon served about 1-18 of the union's codeunits (rough: scoring lags the daemons).

## The change
- **The first MUTANT daemon** of each lane and mode is unchanged. It warms the whole union, keeps R786/R960's fallback, and
  refuses as today. L5's baseline daemon is not counted as this first daemon.
- **Every later daemon** starts with no warm-up and an empty `proven` set. Before any request sends entries for codeunits not in
  `proven`, the backend sends one NONE request for exactly those codeunits plus the echo, with today's checks:
  - echo;
  - agreement with the baseline through the same `expected()`, with the warm-up's excludes (`leftOutNames`, not
    `mutantLeftOutNames`);
  - R612 clean.

  If they pass, the codeunits join `proven`. If they fail, the error is today's later-daemon refusal by name, never a fallback.
- **Rules from the review:**
  - The proof sits in `request()`/`send()`, so every entry path passes it: prefetch chunks, live calls, kill pairs and PR-20's
    widening live call.
  - A warm-up does not count toward R952's request bound; otherwise `daemonMaxRequests: 1` loops.
  - A warm-up checks `stopHandle.spent()` before it is sent, and is watched by `signalled()` (R1014).
  - Each warm-up counts in `stats.warmups` (R652's `boundChecks`), and `noteEntryCost` does not sample it.
  - `proven` belongs to the daemon instance.

## Why no verdict can change
- **Every mutant entry still runs on a daemon where its codeunits' NONE rows were compared, on that daemon, with the echo,
  before the entry.**
- **What is no longer checked: codeunits a restarted daemon never runs.** Entries are independent, so no verdict reads them.
- **Measured** (`/coord/handoff/PR-24/carry-probe/out.txt`, edge-5a58a0f16):
  - six kinds of state set in one entry (IsolatedStorage, NumberSequence, a manual binding, WorkDate, GlobalLanguage, a
    SingleInstance global) are not seen by a later entry of the same request, nor by a later request on the same daemon;
  - this holds under isolation test and codeunit, in 24 of 24 readings, and every reader is shown to work by a positive control.
- **lethal-bugs' earlier probes** (R-937, R-998, PR-14, PR-18) agree: no state carried across requests or after refusals, and four
  DO baselines are equal on 1,979 tests.
- **Limits stated:**
  - a leaked ROW was never observable (rows roll back per test, as for every entry today);
  - the .NET helper's own state across requests is unmeasured;
  - disabled isolation is never sent on serve;
  - the unit is a whole codeunit, never narrower.
- **A side gain:** a codeunit that joins the union after a daemon started (`liveCall`, `fetchPair`) is warmed on every restarted
  daemon before its first use. Today it is warmed on none.

## Measured runs and predictions
**Legs.** The fixtures `fixtures/sandbox-app` and `fixtures/sandbox-data` (the table fixture), al-runner edge-5a58a0f16 pinned,
serve-entries, `alRunnerV3.daemonMaxRequests: 1` (a restart after every request). Each is run twice: master as it is (A) and the
build (B).

**Predictions:**
1. **Per mutant, B equals A:** verdict and killing test (`bun scripts/report-diff.ts`: IDENTICAL).
2. **Daemon starts:** B starts as many daemons as A.
3. **Warm-up entries:**
   - B's first daemon per mode sends the same warm-up as A's;
   - every later warm-up in B holds only codeunits of the request that follows it on the same daemon, and never a codeunit
     already proven there;
   - B's total warm-up entries are fewer than A's.
4. **No mutant entry in B** is sent to a daemon before its codeunits were proven there. Read from the serve trace.

**Red checks, both ways, as tests:**
- a restarted daemon whose codeunit differs from the baseline under NONE (a seam) is refused by name before that codeunit's first
  entry, and with the proof removed the entry is sent;
- a restarted daemon sends no warm-up for codeunits it does not use, and with the change reverted it does;
- the first daemon still warms the whole union and still falls back on the default transport;
- `daemonMaxRequests: 1` does not loop;
- a spent budget sends no warm-up;
- the lazy proof also covers each other entry path: kill pairs, a live call and the PR-20 widening.

## DO
The saving per restarted daemon is the test-running time of the codeunits it does not use. Daemon start and compile are not saved.
The DO figure is pre-committed in an amendment, from t4's stored data, once t4 is scored and BEFORE any DO window measures it.
Today t4 is still running. The amendment will give:
- restarts per window;
- the warm-up time per start, split into start and compile against running tests;
- codeunits per restarted daemon.
