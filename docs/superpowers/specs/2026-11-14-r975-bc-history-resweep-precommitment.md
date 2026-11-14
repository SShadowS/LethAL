# R-975 pre-commitment: BC.History on al-runner edge-736fc7677 (finish three runs, re-sweep refused baselines)

Committed before any run, 2026-11-14. Coord task R-975. Evidence goes to `/coord/handoff/R-975/`. Names and counts only; no
BC.History source text.

## 1. The three runs that stopped at their hour

Email (R-962), E-Document Connector - Avalara (R-962) and E-Document Connector - SignUp (R-969) cannot be resumed: LethAL lends a v3
verdict only to the same al-runner build AND the same session fingerprint (R586), and both moved (`current` is edge-736fc7677;
master added the baseline daemon). So each runs again, FRESH, on `current` with `--time-budget 7200` (two hours), from its earlier
source copy and selector ids. Nothing is pre-committed about verdicts; each report says which build it used.

## 2. The re-sweep: which refused baselines should now run

82 BC.History projects kept their source copies and have refused baseline tests in their latest v3 store: 2,248 refused tests
(`projects.bch.tsv`). For each, a dry baseline on `current`: al-runner `test` of the app and its test project, unmutated, isolation
`test`, environment `onprem`, every cached package pool, no mutants (`dry-baseline.sh`).

**Prediction** (`predict.py`: a refused test whose message matches an issue upstream closed after the earlier run's build):
- Service Declaration (R-882): 14 tests now run (#7524, a Base Application read under a lowered permission set).
- Intrastat (R-902): 4 tests now run (#7714, assigning `currXMLport.Filename`).
- No other project is predicted to gain. #8002 (the follow-on refusal) closed after edge-736fc7677 was built, and a repro still
  reproduces it on that build, so its projects (APIV2, PowerBI, Avalara, DO) are NOT predicted to gain here.
- No test that was green in the earlier baseline turns non-green. Any that does is a regression: an invented repro and an upstream
  issue, or the cause named.

Gains outside the prediction are reported as measured, by project and cause. Where a project gains tests, its mutants run for those
tests only (`--tests-only`), and every new wrong result or refusal goes upstream with an invented repro and a roadmap item.
