# R828 pre-commitment: what a compare per pass costs, and the limit that decides O3

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
