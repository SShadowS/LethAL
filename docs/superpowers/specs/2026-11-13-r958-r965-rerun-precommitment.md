# R-958 pre-commitment: re-run the apps with the most R965 at-risk survivors, on master after R965

Coord task R-958 (lethal-bugs), 2026-11-13. Written before any new run. Related: R965 (fixed in coord R-954: a mutant in an
overloaded procedure took exact coverage from another overload's tests), R-954's blast count (`/coord/handoff/R-954/blast/count.md`).

## What runs

Five al-runner-v3 apps, fresh (no `--resume` of an old store), on the LethAL master of the run day and al-runner
`edge-c8fe56e05` (the `current` pin), default transport, one at a time in one heavy slot (`heavy-slot.sh --wait --peak serve`).
Configs keep each old run's sources, packages, selector ids, probing path, bcVersion and flags; environment as the old run had it
(`ai` onprem, the rest saas). `ext` (38 at-risk) is left out: its package folder would have to be rebuilt from three BC.History apps.
SharePoint and Rest Client use a package pool rebuilt for this task by the R-927 hunt driver from the same sample list as R-928's.

| App | Old report | Old LethAL / al-runner | Mutants | killed / survived / no-coverage / error | At-risk survivors (count.md) |
|---|---|---|---|---|---|
| ai | R-940/ai.run.report.json | 3a5fcc0715 / 2bd87774f | 2188 | 235 / 271 / 1671 / 11 | 98 |
| sharepoint | R-928/sharepoint.run.report.json | 6289261f35 / 42af5d384 | 2503 | 769 / 1159 / 489 / 86 | 668 |
| crypto | R-950/runs/crypto.report.json | e3cc73c3c9 / c8fe56e05 | 1389 | 400 / 305 / 431 / 253 | 213 |
| rest | R-928/rest.run.report.json | a533e4248e / 42af5d384 | 739 | 321 / 161 / 241 / 16 | 111 |
| saft | R-926/saft.s2.report.json | 97d11119 / 42af5d384 | 3834 | 427 (+1 timeout-killed) / 1245 / 2044 / 117 | 30 |

## Predictions (per mutant, joined by file, start, end, operator and AST hash)

1. **At-risk survivors.** An at-risk survivor whose own overload is not covered by any test becomes `no-coverage`; one whose own
   overload is covered stays `survived` or becomes `killed` (its own tests now run). Predicted: no at-risk survivor stays
   `survived` with the SAME covering tests as before; at least one at-risk survivor per app moves to `no-coverage`. Each at-risk
   survivor that becomes `killed` is listed with its killing test, and the test is checked to be one of its own overload's.
2. **crypto (same al-runner build as its old run, so master is the only change):** every mutant that was NOT an at-risk row keeps
   its verdict and killing test. Any other move is a finding to explain before the result is written.
3. **ai, sharepoint, rest, saft (al-runner and master both moved):** non-at-risk moves are allowed only as al-runner build
   differences, each family explained (and, where it moves away from BC or is a new refusal, an invented repro and an upstream
   issue). The baseline's failing-test count must equal the old run's (ai 24/55, sharepoint 3/71, rest 2/50, saft 0/27, crypto
   13/68) or the difference is explained first; a rebuilt pool that changes the baseline makes that app not comparable.
4. **saft stale-buffer family** (100 mutants refused on edge-42af5d384; 4 of 4 in `AuditDataHandlingSAFT.Codeunit.al` still refused on
   c8fe56e05, R-952): the count of the family on c8fe56e05 over the whole app is reported, and #7964 is updated.
5. **No verdict moves from `killed` to anything else** among non-at-risk mutants on crypto. On the other apps a lost kill is a
   finding.

## What is reported

Per app: the transition table (old verdict -> new verdict, counts), at-risk transitions separately, killing-test differences, new
refusals by cause, baseline counts, wall time; the R965 effect in total (at-risk survivors that became no-coverage, stayed survived,
became killed).
