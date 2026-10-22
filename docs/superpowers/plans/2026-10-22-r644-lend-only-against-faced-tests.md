# R-644 plan (r1): lend a survivor only against tests it actually survived

Evidence: `/coord/handoff/R-644/measure.md`. Red test: `packages/runner/tests/r644-source-baseline-lend.test.ts`
(uncommitted, in `/work/lethal-wt/r644`).

## The rule

A prior survivor M is lent only when **every test that would run against M now is in M's recorded
`covering_tests`**, and that set is not empty. Otherwise M is executed like any other mutant.

- "Would run against M now" = this batch's selection for M: green at THIS session's baseline, and
  covering M under this session's coverage mode (all green tests under `coverage: "none"`). Compared as
  `qualifiedTestName`, the form `covering_tests` holds.
- `covering_tests` is exactly what M was run against when it was scored. A test red at the source's
  baseline is never in it. So "red then, green now" re-runs M. "Red then, red now" lends.
- Fail closed:
  - NULL `covering_tests` (pre-R192 row): no record. M is re-run.
  - Malformed `covering_tests`: throw (`parseCoveringTests`, as today). Never a quiet re-run.
  - No green test covers M now (empty set): not lent. M takes the normal path and reads no-coverage, as
    R621 does for a carry.
  - This batch has no green test at all: no candidate is lent. They are handled like `execute`.
  - The baseline stops the batch (unsafe, lease): candidates are treated exactly like `execute` mutants.

## When it is checked: option (ii), at option (i)'s time

History is decided before the baseline today (step 2, before deploy). The run-level checks stay there.
The per-mutant check moves to `select`, after this batch's baseline and coverage selection.

- Step 2 keeps computing `knownSurvivors` (`filterHistory`), but they become CANDIDATES. They are not
  recorded there any more.
- `select` computes the covering plan over `execute` plus the candidates. Then it splits: a candidate that
  passes the rule is recorded `known-survivor` and dropped from the plan; the rest stay in the plan.
- Cost: none in time for a lent mutant. Every batch already deploys every mutant (step 3, "always") and
  already runs its baseline whether or not anything executes. Only a mutant facing a new test re-runs.

Options weighed:

| option | correct? | cost |
|---|---|---|
| (i) batch level, after baseline: lend the batch's survivors only if green-now ⊆ green-at-source | Misses coverage that changed between runs. Needs a `batch_index` on baseline rows (none today). A `--resume`-carried batch has no baseline rows, and a partly carried batch's rows are the wrong run's. | Schema change. One new green test re-runs every survivor of the batch. |
| **(ii) per mutant, after baseline, against `covering_tests`** | Exact: compares with what M actually faced. Covers carried rows, snapshot reuse, multi-batch, and coverage drift. No schema change. | Re-runs only mutants that face a new test. Known-survivor rows must record a list (below). |
| (iii) refuse the whole history when the source baseline had any non-pass row | Still blind to fully carried batches and to coverage drift. | 40 of 101 local runs have a non-pass row. Tables fixture, DO rung 2 (11 Job Queue tests) and the R85 projects (71 TestPage) would never lend again. |

Recommended: (ii).

## Chaining: a lent row must keep its evidence

Today a `known-survivor` row stores `covering_tests = []`. Under (ii) the run after it would re-run every
one of them. So a lent M records the SOURCE row's `covering_tests` (the tests it survived), not `[]`.

- `priorSurvivorKeys` returns each survivor's `covering_tests` with its key (from the same `mutants` query).
  No new refusal there.
- `record(..., "known-survivor", ...)` passes that list. Check the ripple: the report's `coveringTests` on
  known-survivor rows changes from `[]`; run `report-equality`, `schemas.test.ts` and any snapshot that pins
  a known-survivor row. If a reader treats a non-empty list as "this run executed it", keep the report
  field `[]` and write the list to the store row only. Decide in review.
- A store written before the fix has `[]` on its known-survivor rows. The next session re-runs those once
  (fail closed), and lends again from the run after.

## Where it sits

- `priorSurvivorKeys` order is unchanged: `runMayLend` step 1, site checks, R557 steps 2 and 3, then R585's
  scope check LAST. No existing refusal is renamed (the R-619/R-585 order rule).
- R644's check comes after all of them, in the orchestrator, per mutant, after the baseline. It never runs
  for a run that a run-level check refused.

## Warning

One new warning per batch, emitted only under `--skip-known-survivors` and only when at least one
candidate is re-run:

`history-tests-not-faced`: "[lethal] --skip-known-survivors: batch N: K survivor(s) of run R face test(s)
they were not run against there (a test red at that run's baseline, or coverage that changed): <names
sample>. They are executed, not skipped (R644)."

A separate count for the NULL-record case is not needed: it is the same message with "no record".
The R585 scope warning keeps its own code. Add the code wherever `history-*` codes are listed (the itest's
expected-warning sets, `startsWith("history-")` filters).

## Tests (test-first)

1. The red test above stays as it is: a test red at the source baseline, green now, kills; the survivor is
   re-run and killed, nothing lent, one `history-tests-not-faced`. RED on master (measured).
2. Control: all green at both baselines: every survivor lends, 0 mutant runs, no warning. Green on master.
3. Control: red at both baselines: every survivor lends. Green on master.
4. Coverage-mode stub (fenced-like): two survivors; the newly green test covers only one. Only that one is
   re-run; the other lends. Proves the check is per mutant, not per batch.
5. Chain: run 1 scores survivors, run 2 lends them, run 3 still lends them (needs the recorded list). RED
   with the rule but without the chaining change.
6. Fail closed: a source row with NULL `covering_tests` is re-run; a malformed one throws.
7. A `--resume`-carried survivor in the source (carried row, no baseline rows for its batch) lends only
   against its carried `covering_tests`.
8. Order: a source refused at run level keeps its own warning; R644's never fires for it
   (`r618-lend-order.test.ts` style).

Red checks, per direction (mutation-red-checker): drop the subset check (test 1 goes red); make the check
always refuse (tests 2, 3 go red); revert the chaining change (test 5 goes red); swap per-mutant for
per-batch (test 4 goes red).

## itest:lend (pre-commit on master before any live run)

Expected: **no figure moves.** L1 and N0 still lend 12 (`knownSurvivors` 12, `groupedCalls` 3). N0's clone
carries `covering_tests` (`seedRunFrom`'s `toMutantRow`). N1, N5 and every resume leg are unchanged. The
expected warning sets do not gain `history-tests-not-faced` on any leg. Any leg that re-runs a survivor
is a BLOCK to investigate (it would mean bcdev coverage differs between L0's and L1's baseline), not a
figure to re-record. Gates on the final head: itest:lend and itest:bcdev.

## Size

Medium. About 60 to 100 lines in `orchestrator.ts` (move the record into `select`, plan over candidates,
the split, the warning), about 15 in `store.ts` (return `covering_tests` with the keys), plus the event
ripple for a new warning code if codes are typed. Tests: one new file, about 350 lines. One deep plan
review, then build.

## Separate item to file

`--resume` carry has the same hole (`carriedVerdictFor` never compares the tests covering a carried
survivor now with its `covering_tests`). The same rule closes it. File it as its own roadmap item; do not
fold it into R644. (Filed as R646, master 2412a921; it comes after R-644 and should reuse the same check.)

## r2: orchestrator points and plan-review fixes (2026-10-22). These override anything above.

**Orchestrator points:**
- **(1) Empty never lends.** A known-survivor row with `covering_tests` = `[]` (every lent row stored before this
  fix) or NULL means "no record" and is RE-RUN, never "covered by nothing, so fine". This is the empty-vs-empty bug
  class. With review I2 below, it is named as "no record", not as a red test.
- **(2) Red-check each direction separately.** One break, one red test per direction:
  - lend when a covering test now is outside the stored set → the "re-run" test goes red;
  - re-run when every covering test is inside → the "lends" control goes red;
  - lend an empty or NULL record → the "no record" test goes red;
  - drop the inherited list on a lent row → the chain test goes red.

**Review fixes** (`review-opus-plan.md`):
- **I1:** keep the history candidates INSIDE `execute` through the compile bisect (3c), `select`'s no-green branch,
  coverage, and R53's stranded check. Drop the lent ones only after coverage, just before step 5b. So no mutant can
  vanish from the report, and a stranded mutant is never re-run. Tests:
  - a batch whose compile fails still records a row for every candidate;
  - a resumed run's stranded candidate is still skipped.
- **I2:** treat `[]` on a known-survivor row exactly like NULL. Name it with its own warning (e.g.
  `history-survivor-no-record`, "no covering-test record (lent before R644)"), separate from the "faced a test it
  was not run against" warning. A test pins both names.
- **Minor 3:** compute the candidates' covering tests in a SECOND `coverageFilter` call that emits nothing, so the
  `coverage-split` counts and `untargetedTriggerCount` are unchanged.
- **Minor 4:** a lend matched through a site (R391 rule 2) reads that row's own list. An ambiguous match re-runs.
- **Minor 5:** check report-equality and the sample reports for a `coveredBy` change on known-survivor rows and any
  reorder. If the report shape moves, follow CLAUDE.md's SessionReport ripple, or avoid emitting it.

**itest:lend:** no figure is predicted to move (L1 and N0: every test green at both baselines, and N0's clone copies
`covering_tests`). PRE-COMMIT that "unchanged" on master before the live run. Any survivor re-run there is a BLOCK to
investigate, not a figure to re-record.
