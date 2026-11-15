# PR-25: R1034, a reused baseline counts as line evidence on every transport

Status: pre-commitment (coord PR-25, lethal-code, 2026-11-15), before any build or run. Related: R1034, R1033 (PR-21, the serve
half), R192, R926, R975.

## The defect

A session that reuses a stored baseline on `--resume` (R192) attributes covering sets from the snapshot's coverage maps, but R926
(a statement's reach from baseline line coverage) and R975 (trigger mutants placed by line) count only rows that ran in the session
(`ranHere`). So a resumed session decides fewer trigger mutants than an uninterrupted one. Measured on Service Declaration
(`/coord/handoff/PR-21/oneshot/`, one-shot transport, isolation test, `--only GetServiceDeclarationLines`, al-runner edge-5a58a0f16):
`report-diff A B2` gives 2 differences of 222, `Get Service Declaration Lines` `OnRun` `flip-boolean-literal` and `remove-not`:
`no-coverage` uninterrupted, `survived` resumed. PR-21 fixed it for serve only, for a snapshot that passed L5's re-check.

No reason for the exclusion was ever recorded: R926 (af5b3b8d) wrote it, and R975's review (eb61c6ce) copied it as "R926's
condition".

## The change

Every reused baseline counts as this session's line evidence for R926 and R975 (`lineEvidenceOf`: the rows that ran here, plus all
of a reused snapshot's rows), on every transport. The reused rows still do not count for durations (R272) or flags.

## Why it is safe

- R192 already trusts the snapshot's coverage maps to build every covering set; the lines are part of those same maps. Leaving them
  out of R926/R975 made the resumed session answer differently from the uninterrupted one on the same inputs, which is the defect.
- The snapshot is found only under R192's keys (instrumented source, test app, dependencies, coverage mode, server generation) and
  `runMayLend` (the backend build), so its lines are the lines of these inputs. On DO, three stored baselines and a fourth fresh one
  agree on every test's coverage (PR-21).
- The line rules' own guards still apply to reused rows: line granularity, no naming gap, a passing row.

## Which figures it can move

The line rule applies only to coverage maps of `"line"` granularity. Only al-runner v3 produces them (`al-runner-coverage.ts`); the
bcdev backend produces `"procedure"` maps only (`bcdev-backend.ts`). So:
1. **`itest:lend`** (bcdev, `fixtures/sandbox-app`): no figure can move. Prediction: it passes against its frozen baseline,
   unchanged.
2. **`itest:alrunner-v3`**: no leg resumes ("no resume", `alrunner-v3-legs.ts`). Prediction: it passes, every leg.
3. **Committed campaigns that rest on a v3 reuse.** Every `resume-baseline-reused` in `/coord/handoff` was searched: the bcdev
   lend logs (procedure grain), red-check experiments (R-512, R-619, R-496, R-514), R-999/PR-21's own proofs, and one real v3
   run, R-942's DO window 2 (`dod.w2`, 2026-11-13, one-shot). That run predates R975 (a7d35069), so only R926's survivor reach
   notes could differ there, never a verdict; its figures are cited in R975 as the evidence for R975, not frozen. The committed
   campaigns that use `--resume` after R926 (R-913, R-914, PR-06) show no baseline reuse in their logs.
4. **Service Declaration, one-shot** (the fixture above, fresh stores under `/coord/handoff/PR-25/`): A uninterrupted, B1 with a
   `--time-budget` that stops it in the mutant phase, B2 `--resume`. Prediction: B2 prints `resume-baseline-reused` and
   `report-diff A B2` is IDENTICAL (222), where before this change it gave the 2 differences above.

## Red checks

`lineEvidenceOf` both ways: a reused snapshot's rows count (red if only `ranHere` counts); without a reuse only `ranHere` counts (red
if every row counted). The fixture run is the live red check: the same comparison before the change gave 2 differences.
