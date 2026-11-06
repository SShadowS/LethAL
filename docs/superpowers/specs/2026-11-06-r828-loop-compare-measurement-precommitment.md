# R828 pre-commitment: what a compare per pass costs, and the limit that decides O3

**WITHDRAWN, 2026-11-06: read Addendum 1 at the end. Do not run this measurement or raise a floor from it.**

Written 2026-11-06 by lethal-code, before any live run. Coord: on the orchestrator's word. Plan: `/coord/handoff/R-828/plan.md`. A false `timeout-killed` is a BLOCK.

## The question

O3 replaces a chain at loop entry with a Boolean local, read once at entry, and a compare before each mutated statement in the loop. So a loop pays one plain compare per guarded statement per pass, and pays it in every run, the baseline included. [[R246]] measured one latch compare at about +63% on one tight loop, one sample each: 4,863 ms to 7,935 ms.

**How it can give a wrong verdict.** A mutant whose loop runs far more passes than baseline. Budget is `max(2 x baseline, floor)`, with a 180 s floor (`MIN_MUTANT_BUDGET_MS`), and a baseline test has 120 s (`BASELINE_TIMEOUT_DEFAULT`). On today's code it ends at 150 s and passes. With compares it runs past 180 s, is stopped, and its unmutated confirm passes: a false `timeout-killed`.

## The measurement

`bc1`, under a coord lease, BC 28.4 (28.4.53241.56590; `bc1` differs from `bc2` and `bc3`, .56646). One scratch app, ids 91500-91599, checked free against every fixture first, no table, so no schema ghost. It is driven over a web-service call, as `scripts/r53-probe` is. It is removed afterwards, and its web-service row with it. Three samples of each; the report gives all three, and the median decides.

**Shapes.** Two procedures for each K of 1, 10 and 40, in one tight `while`, sized so that a plain run takes 5 to 30 s, and never over 60 s, a hard bound in the probe:

- **plain(K):** K statements, each a plain Integer assignment, the cheapest real AL statement.
- **guarded(K):** the same K statements, each as O3 emits it: `if L<n> then begin <assignment> end else begin <assignment> end`, with each local read once before the loop, from a procedure that returns false.

Each runs with coverage OFF and with coverage ON (`CodeCoverageLog`), since a gate's run collects coverage.

Assignments are the cheapest statement, so the ratio is an upper bound for real code, where a statement does more than a compare.

**One more shape.** A procedure with 1,000 Boolean locals, read at entry, called once. BC has not seen this shape; alc compiled 30,000. It is published, installed and run, on the same scratch app.

## The limit

`F = max over K and coverage mode of median(guarded(K)) / median(plain(K))`.

**O3 may be built only if all of these hold:**

1. **F is at most 2.0.** Each guarded statement at most doubles the cheapest statement.
2. **The samples agree:** the three samples of any shape within 20% of their median. If not, run that shape once more; a second failure counts as over the limit.
3. **The 1,000-local procedure** publishes, installs and runs, and its call costs under 1 s over the same procedure with no locals. If not, O3 may still go ahead with a local cap per procedure set from the largest count that passed, and a chain above it.
4. **The server stays healthy:** `itest:bcdev` passes on `bc1` afterwards, under the same lease.

**And O3 must carry a budget rule, or it is not built at all.** O3 slows code by at most F, so a run that fit its budget on today's code fits `F x` that budget. So O3 raises the two fixed floors by F, rounded up to one decimal: `MIN_MUTANT_BUDGET_MS` and `BASELINE_TIMEOUT_DEFAULT`. A budget of `2 x baseline` needs no change: the baseline pays the compares too. Then a mutant that ended under the old budget ends under the new one, the race closes, and a truly hanging mutant only takes up to F times longer to stop. That is a cost of O3, reported on `itest:hang`.

**If the limit fails, O3 is not built, and R828 ends at O1:** the worst file stays near 43 MB, and that is reported plainly, with #28 left unresolved.

## What this does not settle

The time of a real mutant in a real suite: only gates do that. Whether chain length caused #28's crash: [[R826]]. BC 29: `bc4` is not up. One server at one load: samples are compared to each other, on one call each, so load shifts both sides; the 20% rule catches a load spike.

No gate figure moves here. Nothing lands from this measurement but its result.

## Addendum 1, 2026-11-06: the limit and the budget rule are withdrawn

One opus review, from reading the code; nothing was run. The rule does not stand as written. Its idea holds: a run that fit today fits `F x` its old budget. The mechanism does not deliver that.

**Why it fails.**

- **A false kill remains. "`2 x baseline` needs no change" is false.** The baseline pays compares only for its own passes, and the case at issue is a mutant that runs far more. At F = 2: a test with a 110 s baseline, mostly database time, keeps its 110 s. Old budget 220 s, new budget 360 s. A mutant that ended at 210 s needs 420 s, is stopped at 360 s, its confirm passes, `reproduceKill` times out at the same 360 s, and the row scores `timeout-killed`.
- **F was mis-defined.** The design pays one compare per MUTANT, not per statement. A statement with m mutants pays m compares each pass, so the true bound is `1 + m x (F - 1)`: 2.9 at F = 1.63 and m = 3.
- **Two costs sit outside F.** A hot callee pays for its locals on every call. An active mutant at chain position k pays k `Active` calls today, and all N with one read per mutant.
- **The floors hit a fixed time this rule missed, `REQUEST_CEILING_MS`.** `fits` needs `budget + 30 s <= 300 s`. Headroom is 90 s at F = 1.0, 18 s at 1.4 and none at 1.5; from 1.6 no method fits and every default run reads `group-runs-inert`. `groupedCalls`, `warmKills` and `killPosition`, pinned in gates, would move above about 1.4. So this rule's limit of F = 2.0 was never safe, and R246's one sample of 1.63 is already in that zone.
- **The floors can break a hosted stop:** the same code notes 330 s aborted and a 360 s proxy ceiling. At F = 1.7 the stop lands at 336 s, with no 408, and the tier quarantines.
- **"Reported on `itest:hang`" was impossible:** that gate sets its own 20 s and 10 s budgets, so it never touches the floors.
- **Wrong premise:** the false kill needs `--stop-hung-sessions`. Without it the abort gives `in-flight-unknown` and a quarantine: loud and safe, though it costs the session. A user-set budget is outside any floor rule, and must not be scaled silently.
- **One sample cannot give a constant:** one server, one load, three samples, BC 28 only.

**The answers asked for.** No `*.baseline.json` holds a budget, and neither `sessionFingerprint` nor the batch hash does. So a raised floor changes no stored row by itself, and `--resume` and campaign freezes stay valid. But a moved constant IS gate-moving: gate figures shift through `fits` above about 1.4, so it needs the full BC list and the v3 gate, its own commit before O3, and a `docs/gates` line. `al-runner-v3.itest.ts`, `docs/gates/alrunner-v3.md`, the README and `report.ts` quote the numbers.

**The replacement, not yet pre-committed: change no constant.** In `reproduceKill`, for a timeout kill, send `min(M x testBudgetMs, cap)`, not the same budget, with M a named margin over the measured bound. A `pass` or `fail` at the larger budget is already `kill-not-reproduced`, an `error`: the safe direction. Only a second `timeout` scores `timeout-killed`. It covers the floor, `2 x baseline` and user-set budgets with one change, leaves `fits` and the gate figures alone, and a hang costs 540 s at M = 2. Limits: from position 2 on the replay still fits under the ceiling, so above about M = 1.5 at the default floor it ends `cap`, a lost kill and never a false one; a hosted server caps M at about 1.66; without the stop flag nothing changes; and some true kills become `error`.

**Before any new measurement, a new pre-commitment must state:** F per mutant, with shapes at m of 2, 3 and the largest in-loop m, computed offline first; a hot-call shape; the formula for M and its margin; each moved figure by name, which for this rule is nothing outside `itest:hang`; `stopRowFailures`' new duration window; a planted test that runs past its budget and scores `kill-not-reproduced` at positions 1 and above, since no gate holds this race; and a live probe of any held request above 180 s: does BC's 408 still arrive? BC 29 stays open until `bc4` is up. v3's stop cannot be raised by `reproduceKill`: file that, or measure its own ratio.
