# PR-144: re-check the withheld kills in isolation after the main pass (spec)

Status: r1, committed to master before any build (coord PR-144, lethal-preproc, 2026-11-18). The build waits for a
spec-adversary review. Evidence: `/coord/handoff/PR-144/` (`result.md`, `prep.py`, `run-m.sh`, `m.report.json`).

## 1. The problem
- A **withheld kill** (R1108, `withheldKillOf`) is an `error` row where a covering test FAILED under the mutant, but al-runner
  v3 did not trust the failure: an earlier test of its codeunit was refused, failed or ran out of time, and the state that
  test left is not BC's. LethAL scores it `error`, outside `mutationScore`.
- On DO it is the largest error class: 295 of x3's 446 errors.
- Isolation `"auto"` recovers them (R1102: 450 of 451), but it moves whole codeunits to one test per session for the WHOLE
  run (about 21 min more baseline and about 3x per mutant in those codeunits). So DO's default stays `"test"`.

## 2. The measurement (arm M, PR-144)
- **Arm M:** only x3's 295 withheld-kill sites (`--lines`), baseline narrowed to their 51 covering test files, under
  `"isolation": "method"`. The build is x3's (edge-4ebfe7913), with x3's flags and `--workers 3`. It ran beside another
  DO window.
- **294 of 295 became `killed`, every one with `killReproduced`:**
  - 281 with the same failure x3 had withheld;
  - 13 by another covering test's own assertion.
- **1 stayed `error`:** M18076, a direct refusal, which isolation cannot change. 0 became `survived`.
- **The cost:** 3,464 s, of which 1,692 s is the per-test baseline of the 51 files and 150 s the mutants (median 13 ms).

## 3. The change
1. **When:** after the main pass of an `al-runner-v3` session, if at least one scored mutant carries `withheldKill` and the
   session's isolation is not already `"method"`. It runs inside the session's time budget. If the budget is spent, the
   recheck is skipped and the report says so (the existing `withheld-kills` caveat stays).
2. **What runs:** a recheck pass over the withheld-kill mutants only (exactly those rows, not their lines' other mutants):
   - under `"method"` isolation;
   - on fresh serve daemons (no daemon of the main pass is reused);
   - with a baseline of only those mutants' covering test codeunits, run one test per session.
   - Plans come from that baseline, so a covering test that is not green alone is not used.
3. **The verdict rule.** A recheck replaces the main pass's `error` with `killed` ONLY when all of these hold:
   - (a) the main-pass row is a withheld kill (`withheldKill` set). A direct refusal is never rechecked;
   - (b) the recheck's verdict is `killed` with `killReproduced` true, i.e. the failure reproduced under the mutant alone;
   - (c) the killing test passed at the recheck's own baseline, alone;
   - (d) the recheck ran the same build and the same compiled app as the main pass (the session's fingerprint).
   - **In every other case the row stays `error`.** That includes a recheck `survived`: a survivor seen only in isolation
     is not taken over, because the main pass's codeunit-level run is the measured one. Its note names the recheck's
     outcome.
4. **The report:**
   - a rechecked kill keeps its `killingTest` and `killingTestFailure` from the recheck, and its `failureNote` starts with
     `[v3-isolated-recheck]`, naming the main pass's withheld failure and the earlier test;
   - the `withheld-kills` caveat counts only the rows still withheld after the recheck, and states how many were
     rechecked into kills;
   - no new `SessionReport` field: the note and the caveat's wording carry it (avoiding the R-ripple of a new field).
5. **What is not changed:**
   - no row other than a withheld-kill `error` can change;
   - `killed` and `survived` rows of the main pass are never touched;
   - bcdev is unaffected.
6. **Tests:**
   - the verdict rule, each condition (a) to (d) failing alone, keeps `error`;
   - a recheck `survived` keeps `error`;
   - rows that are not withheld kills are never sent to the recheck;
   - the time-budget skip;
   - red checks both ways for each condition.

## 4. Predictions
- **P1 (replay):** the recheck pass over x3's 295 withheld kills reproduces arm M: 294 killed and 1 error.
- **P2 (the next DO window on a head with this change):**
  - at least 95% of that window's withheld kills become `killed`, all with `killReproduced`;
  - no `killed` or `survived` main-pass row changes.
- **P3 (cost):** the recheck's wall time is at most its narrowed baseline plus 2x its mutant count times the main pass's
  median per covered mutant. That window's report states it.
- **The gates:** the al-runner-v3 gate on the final head. Its fixtures have no withheld kills unless a leg is built for
  this, so the build adds a fixture leg with one withheld kill, made from an earlier test that refuses.
