# R1008 (coord R-999): results

Pre-commitment: `precommit.md` (commit 7862fbc1, before any run). LethAL `lethal/r999` 7862fbc1, al-runner edge-a184cfc79 (`current`),
2026-11-14. Reports, stores and logs: `/coord/handoff/R-999/` (not committed: the reports carry the project's AL source).

| run | what | exit | mutants scored | time |
|---|---|---|---|---|
| A | uninterrupted, serve-entries | 0 | 222 (69 killed, 151 survived, 2 no-coverage) | 20:56:46-21:02:44 UTC (6 min) |
| B1 | `--time-budget 290` | 7 (budget) | 98 of 222 | 21:02:49-21:07:42 |
| B2 | `--resume` of B1 | 0 | 222 (69 / 151 / 2) | 21:07:47-21:10:07 |

1. Held: B1 stopped on its budget in the mutant phase (`time-budget-reached`), 98 scored.
2. Held: B2 found B1's run (caveat `resumed`), printed no `al-runner-v3-serve-default-fallback` and no `resume-baseline-reused`,
   ran on serve (one warm-up request, the baseline run again), and finished (exit 0).
3. Held: `bun scripts/report-diff.ts A.report.json B2.report.json`: 222 and 222 mutants, 0 differences, IDENTICAL.
