# PR-24 (speed lever L2): a restarted daemon warms each codeunit on first use — results

Pre-commitment `docs/superpowers/specs/2026-11-15-pr24-l2-lazy-warmup.md` (a027deb2). Evidence: `/coord/handoff/PR-24/`
(`safety.md` with both reviews, `carry-probe/`, `fx/`). Reports are not committed.

## The fixture legs
- **Setup:** A is the branch point a027deb2 and B is the build. Both use al-runner edge-5a58a0f16 pinned, serve-entries, isolation
  "test" and `daemonMaxRequests: 1` (a restart after every request), with a fresh store per leg (`fx/run.sh`).
- **B on the merged head:** B was re-run on the head after master was merged in (542bcbee). It is still IDENTICAL to A on both
  fixtures, with the same daemons, warm-ups and entries (`fx/run-merged.log`).

| fixture | mutants (killed / survived / no-coverage) | A vs B per mutant | daemons A / B | warm-ups A / B | entries sent A / B |
|---|---|---|---|---|---|
| sandbox-app | 22 (3 / 14 / 5) | IDENTICAL | 5 / 5 | 4 / 4 | 54 / 54 |
| sandbox-data (tables) | 418 (326 / 67 / 25) | IDENTICAL | 14 / 14 | 13 / 13 | 2,116 / 2,116 |

## Predictions, scored
1. **B equals A per mutant** (verdict and killing test, `report-diff`). **Held** on both fixtures.
2. **B starts as many daemons as A.** **Held** (5 and 14).
3. **Warm-up entries:**
   - The first daemon's warm-up is unchanged, and each later warm-up holds only codeunits of its next request. **Held**, pinned
     exactly by the unit tests.
   - B sends fewer warm-up entries in total than A. **Missed: equal on both fixtures.** On these small fixtures every request after
     a restart spans the whole union: sandbox-app's tests are in one codeunit, and each table-fixture request covers all of its
     covered codeunits. So the lazy warm-up holds the same codeunits as today's. The saving needs a suite where a restarted daemon
     uses a part of the union, as on DO (below).
4. **No mutant entry is sent before its codeunits are proven on that daemon.** This was to be read from a serve trace, but master
   has no committed trace (PR-18's was a scratch patch). **Checked by the unit tests instead.** That is a deviation from the
   pre-commitment:
   - each restarted daemon's first request proves exactly the codeunits of the request after it;
   - a drifting codeunit is refused before its first entry;
   - with the proof removed, those tests go red.

## What DO would save, from stored data (no DO window run)
PR-18's scratch trace of a DO window (`/coord/handoff/PR-18/trace.ndjson`, edge-847b1fa5a, one entry timing per codeunit) has four
daemons. Each warm-up ran all 110 codeunits:

| daemon | today's warm-up: entries (request wall) | codeunits its later requests used | lazy warm-up: entries |
|---|---|---|---|
| 0 (first: unchanged) | 66.2 s (95.3 s) | 10 | (the whole union, as today) |
| 1 | 69.1 s (104.1 s) | 24 | 32.3 s |
| 2 | 45.9 s (91.7 s) | 4 | 1.3 s |
| 3 | 36.8 s (69.6 s) | 3 | 0.9 s |

**The saving.** About 117 s of test running over 3 restarts, about 39 s per restart.
- Each warm-up request's daemon start and compile (about 35-45 s) is not saved: it moves to the restarted daemon's first request.
- t4 has had at least 18 restarts so far, all R612 cuts. As code warned, a restart after an R612 cut may hold more codeunits than
  these.
- The figure per window is pre-committed in an amendment from t4's restart count once t4 is scored, before any DO window measures it.

## Reviews and checks
- **Safety argument:** reviewed by lethal-bugs (measurements) and lethal-code (design). The carry-over probe is clean (24 of 24
  readings, positive controls). See the pre-commitment.
- **Red checks:** 7 reverts, each red, all restored green. Six were by a sonnet `mutation-red-checker` and one by hand: the
  `leftOutNames` choice, which the first round found unpinned, so a test was added.
- **Build review (lethal-code, Opus, d9b547b3): one BLOCK, fixed.**
  - **B1:** the lazy warm-up's spent-budget check could turn a live call's verdict into `deadline-exceeded` in a `--time-budget`
    run. The check is removed, as master's restart warm-up has none.
  - **Smaller fixes:**
    - a failure with no baseline rows now closes the daemon;
    - the request-bound comment gives the right reason;
    - the `lastWarmupMs` comment is corrected;
    - a stray block from the extraction is removed.
  - **New tests,** each red on its revert, checked by hand: a live call on a spent budget keeps its real verdict; a kill pair is
    preceded by its codeunit's warm-up; after a daemon-filled baseline the first mutant daemon warms the whole union.
  - R1035 states the spec's departures and withdrawals.
