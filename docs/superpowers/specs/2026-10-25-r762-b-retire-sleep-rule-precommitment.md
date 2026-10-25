# R-762 B pre-commitment: the §6 Sleep coverage rule is retired on builds whose pin records sleep-is-noop gone

Status: committed BEFORE any code change for R-762 item B and before any live run of it (lane bugs, 2026-10-25).
It is a delta on r5 (X (d)), r11 (X (d) Sleep 5000), r15 (alpha.5 readings) and r18 (build pins). Everything those say
stands except where this file says otherwise. A differing verdict in any leg is a BLOCK. Analysis:
`/coord/handoff/R-762/b-figures.md`.

## The change
- On a build whose pin (`findV3Pin` on version line AND sha256) records leg C `sleep-is-noop` = gone (today:
  `alpha.5-07342060e` and `edge-dcdf9e821`), AND whose own session probe also reads it gone, the backend:
  1. does not apply §6 (no `sleepPassRefusal`, no join refusal, no blind note, no unavailable-coverage error) to a
     covering pass under a mutant;
  2. passes no `--coverage-json` on a non-baseline call and joins no coverage for it;
  3. opens no coverage window and sends no second echo in serve-entries mode.
- Unchanged: B2's virtual-clock guard; the baseline bracket's coverage; every unpinned build (alpha.2, alpha.3, alpha.4,
  any unknown edge build) keeps the rule, the flag, the window and the echo exactly as before.
- The Sleep INDEX is still built for every batch (its sizes stay pre-committed figures, so no other leg moves).

## Figures that move (pinned-gone builds only)
Leg X (d), through the backend on `Probe Sleeper`, edge-dcdf9e821 (the current pin; alpha.5 shares the readings and is
INFERRED, not run):

| Mutant | Operator | Before | After |
|---|---|---|---|
| M0001 | empty-block | killed, SleeperDoubles, reproduced | unchanged |
| M0002 | void-method-call | survived | unchanged |
| M0003 | remove-assignment (:25) | error / runner-refused, [v3-sleep-noop] | survived, no killing test, no note |
| M0004 | shift-integer (:37) | error / runner-refused, [v3-sleep-noop] | survived, no killing test, no note |
| M0005 | return-value | killed, SleeperDoubles, reproduced | unchanged |

Counts 2 killed / 3 survived / 0 error (before 2 / 1 / 2). Sleep index 4 + 5 (unchanged). No ProbeSleep test in
`unsupportedTests`. The r5 raw-hit assertions (hits on :25 / :37) are not made on a pinned-gone build, because no
non-baseline call writes a coverage document. SleeperDoubles baseline `pass`, baselineGreen false on edge, as r11.
Leg X (e) and (f1)-(f3): not applicable on a pinned-gone build (printed as such, never skipped silently); on an
unpinned build they run and read as r5/r11 predict. X's overall reading on edge is still `held` through X (b).
GATE_WARNINGS: if a not-applicable X sub-leg's warning key is then never observed, the pin set is adjusted in the same
commit and named in the submit note (no other warning set moves).

## Figures that stay (pinned-gone builds)
Every other leg and baseline file: C (28 facts), S1 3/12/4, S3, N1 36/0/0, N1E, S1E (and its serve counters), X (a)-(c),
X (b) held line, L1 7/3/0, Y-A, Y-B 5/4/0, MO, WR, K 3/12/4 over 19, D1 51/12/0 over 63 (0 differences from bc3-A),
D1c 51/8/4, T 290/50/59 over 406 with the pinned 7 rows. Sleep index sizes: S1 0+0, N1 0+0, K/L1/Y/MO/WR 0+0, D1/D1c
3+0, T 0+0, X (d) 4+5. No committed baseline is re-recorded.

## Alpha.2 and other unpinned builds
Unchanged: X (d) r5 table (M0003 and M0004 error by §6 at :25 and :37, hits [[25,1]] and [[37,1]]), X (e) and (f1)-(f3)
fail closed, every figure as r11 (d1). Shown by unit tests (owner's lighter process: no separate alpha.2 live run).

## Tests (red per direction, coded after this is committed)
- pinned-gone build: a covering pass with a Sleep hit is survived; a non-baseline call's argv has no `--coverage-json`;
  no window; no second echo; the baseline call still has the flag and coverage; B2 still refuses a virtual timeout.
- unpinned build: the same inputs read error / runner-refused with the [v3-sleep-noop] note, with the flag, the window
  and the second echo.
- the switch reads the pin AND the session probe: a pinned binary whose probe reads defect-present keeps the rule.
Red check each by reverting the specific guard.

## Proof (after the build)
The full v3 gate on the final head: all legs pass on edge with the table above. gift-card and D1 wall times are recorded,
not predicted. BC legs are not run if the diff touches only v3 files (owner's lighter process), stated in the submit note.
