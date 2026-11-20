# PR-250 pre-commitment: cut a mutant request's codeunit entry before a test whose BASELINE answer is an unkept refusal; stop a session that churns daemons without scoring

Lane lethal-bugs, coord PR-250, 2026-11-20. The orchestrator's rulings (option (2); the owner's guard). Committed before any
code.

## What happened (PERF-10b, 2026-11-19 22:36Z - 2026-11-20 01:09Z; `/coord/handoff/PR-217/perf10b.run.events.ndjson`)
Test `CDO Aut Stat Bal Check Tests` (codeunit 68874).`CustomerWithNegativeBalance_WithDoNotSendNegativeBalanceFlag_ShouldNotCreateJournalLine`
answers `NotRun` with upstream's by-value SetFilter refusal (correct upstream, alrunner's PERF-17) in the BASELINE, with no
mutant. Every mutant request that holds codeunit 68874 meets the same refusal, which is not in the keep list, so the daemon closes
(R612's cut), an after-refusal warm-up re-proves the lane's codeunits (~73 s, ~1,980 tests), and the rest of the mutant's group is
re-sent once. It is not an unbounded loop: each mutant is re-sent at most once (the `resent` set). But y3 has 614 mutants covered by
codeunit 68874, 457 of them by >= 50 codeunits: about 25 h of lane time of churn. Lane 2 closed 69 times on that one test; no
mutant was scored for 72 minutes.

## The change, part 1: the cut (option (2))
- From the baseline: per codeunit, the FIRST test (in the codeunit's baseline order) whose baseline answer is an UNKEPT refusal: a
  `notRun` row whose message no `V3_SERVE_SAFE_REFUSALS` entry keeps. A baseline FAIL, a pass, a timeout, or a kept refusal does
  NOT trigger it (a fail is the existing red-baseline path, unchanged).
- In every mutant request (prefetch, live, kill pairs), that codeunit's entry is cut just BEFORE that test: the test and every
  later test of the codeunit are excluded (`excludeTests`), combined with today's cuts (the larger exclusion wins).
- **Verdict:** a mutant with a covering test in the cut part is never `survived` and never killed by such a test. Those covering
  tests are not measured. The mutant is `error`, with a named cause naming the test and the baseline refusal, unless another
  measured test KILLS it (then killed, as today). Never a silent survive.
- Baseline, warm-ups, the withheld-kill recheck's baseline and the update gate's legs are unchanged.
- **Reported:** the session counts the cut entries and names each cut test once (one line per codeunit), and the report carries
  the count.

## The change, part 2: the churn guard (the owner)
- Per lane: **10 daemon closes in a row with no mutant scored anywhere in the session in between** (mutant phase only; the
  baseline's closes do not count) stops the session with a named error (`al-runner-v3-daemon-churn`), writing its report, as a
  budget stop does.
- **N = 10, from the events:**
  - y2: max 5 per lane (all lanes 9);
  - y3: max 6 per lane (all lanes 8);
  - the first PERF-10 start (the Company-table storm): max 7 per lane;
  - PERF-10b: lane 1 reached 10 at minute 42, 10 min after its last score; lane 2 later reached 36.
  So 10 never trips y2 or y3, and stops PERF-10b's churn about 10 min in.

## Predictions
1. **y3's 614 mutants under codeunit 68874** (10 tests; the refused one is the 6th, so it and the 4 after it are cut), by y3's
   covering sets and killing tests:
   - 363 change, all to `error` with the named cause: 356 y3-survived with a covering test at/after the cut, and 7 y3-killed BY
     a test at/after the cut;
   - 251 unchanged: 146 survived and 61 killed with no covering test at/after the cut; 43 killed by a test before the cut or in
     another codeunit; 1 error stays error.
   PERF-10's result reports these against this table. A mutant moving otherwise is a finding.
2. **On `current` (edge-4ebfe7913) nothing changes:** that test is not refused there (edge ran it), so no codeunit is cut. The v3
   gate on `current` passes unchanged, and a same-scope DO run on `current` with and without this change is IDENTICAL.
3. **The guard:** no trip on y2 or y3 (replayed from their events in a test). On a fake that refuses deterministically per mutant,
   it trips at the 10th close.
4. **Warning codes:** `al-runner-v3-baseline-refused-cut` (one per cut codeunit) and the guard's `al-runner-v3-daemon-churn`
   (fatal). Neither is expected in any v3 gate leg, so if either prints there it is a gate-fail. Pre-committed: no GATE_WARNINGS
   entry.

## Tests (red both ways)
- Cut: an unkept baseline refusal cuts; a baseline fail, a pass, a timeout or a kept refusal does not. A covering test after the
  cut makes the mutant error (never survived). A kill before the cut stands.
- Guard: 9 closes do not trip, the 10th does; one scored mutant resets the count; baseline closes do not count.

## Amendment 1 (2026-11-20, after the build review, before any gate result is read)
1. **The cut goes out only in a request sent with `runSelectedOnly`** (PR-102's rule for kill-pair cuts). Without the flag,
   `excludeTests` only hides rows: v3 still runs the refused test, and a hidden unkept refusal would never close the daemon. So an
   unflagged request is sent with master's exclusions (R998's tail and the L4 cut), the refused row is seen, and the daemon closes as
   on master. The coverage window (never flagged) never carries the cut. The VERDICT rule does not depend on the flag: a covering
   test at or after the cut is a `baseline-refused-cut` error, never read. Measured share of flagged requests: y3 6,670 of 7,744
   prefetch+live requests (86%). So PR-250 removes most of the churn, not all of it, and the guard catches the rest. The
   `refusedCutEntries` count counts entries SENT with the cut.
2. **No cut for a codeunit that runs one test at a time** (`isolation: auto` switched it to method). Its baseline rows are the
   whole-codeunit ones and do not describe how it runs.
3. **The count is not a `SessionReport` field.** It goes in the serve-entries summary line and the lane trace. Adding a report field
   ripples through every committed sample report, and nothing reads the count from the report. If one is needed, it gets its own item.
4. **Prediction 3's y2/y3 replay is a script run, not a unit test** (tests never read /coord). Result on the real events: y2's
   highest per-lane count is 5 and y3's is 6, so no trip. PERF-10b would trip on lane 1 at minute 42. The unit tests cover 9, 10,
   reset, baseline and per lane.
5. **A churn stop exits with the time-budget code**, as a budget stop does. "Fatal" in Prediction 4 means the session stops. A real
   signal and a churn trip are kept apart: neither hides the other.
6. **Prediction 1 holds for PERF-10's flagged requests.** For a mutant whose request went out unflagged, the verdict is the same,
   because the rule does not depend on the flag. Only the cost differs: that request closes as on master.
