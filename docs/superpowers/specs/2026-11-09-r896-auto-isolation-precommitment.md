# R-896 pre-commitment: v3 `isolation: "auto"` on PaymentPractices and ServiceDeclaration

Committed before any run of the R-896 build, 2026-11-09. Coord task R-896; plan `/coord/handoff/R-896/plan.md` (reviewed, round 1).
Evidence goes to `/coord/handoff/R-896/proof/`. No BC.History source text is committed: codeunit and test names and counts only.

## Setup (as R-890's round 2)

al-runner v3 `current` (edge-05d692e5e at the time of writing; the run prints it), R-887's settings (demo data cache, the build's own
sidecar), R-882's scratch sources, R-886's 28.4.53241.56646 packages. `isolation: "auto"` (the new default, written explicitly).
Narrowed exactly as R-890's round 2, so each baseline is the full suite and the mutant phase is small:
- PaymentPractices: `--lines src/Core/PaymentPracticeBuilders.Codeunit.al:78-80 --lines src/Tables/PaymentPeriod.Table.al:104-126`;
- ServiceDeclaration: `--lines src/Processing/ServiceDeclarationMgt.Codeunit.al:484-486`.
Each runs on serve-entries (the default transport). PaymentPractices runs again with `"transport": "one-shot"` (review finding 6b).

## Predictions

Derived by the plan's rule from R-890's `method` baselines and the `test` baselines of R-890 (PP) and R-887 (SD), with
`/coord/handoff/R-896/predict.ts`:

| app | codeunit | tests | `test` passes | `method` passes | chosen |
|---|---|---|---|---|---|
| SD | Serv. Decl. Suggest Lines | 7 | 0 | 1 | method |
| SD | Service Declaration Demo Tests | 2 | 2 | 2 | test (not a candidate: no row) |
| SD | Service Declaration Posting | 13 | 0 | 4 | method |
| SD | Service Declaration UI Tests | 5 | 2 | 2 | test (a candidate that STAYED: a row with the tie) |
| SD | Service Declaration UT | 34 | 1 | 34 | method |
| PP | Payment Practices UT | 36 | 31 | 36 | method |

1. **Choice rows:** the report's isolation section has exactly the 5 candidate rows above (SD 4, PP 1), with these choices and these
   pass counts. Demo Tests has no row.
2. **Chosen baseline per test:** for a switched codeunit, it equals R-890's `method` baseline. For a codeunit that stays, it equals
   the `test` baseline. Totals: SD 43 of 61 pass, PP 36 of 36.
3. **PP's 7 mutants** (M0279, M0281, M0665, M0671, M0673, M0675, M0683 in R-882's numbering) are killed, each by the same test as in
   R-890's `method` run. Every other mutant's verdict equals R-890's `pp-method` run.
4. **One-shot = serve, per mutant**, for PP (verdict and killing test). If they differ, one-shot refuses `auto` with any `method`
   codeunit by name. That is the plan's rule, not a retune.
5. **Cost**, recorded and not predicted: the extra baseline pass's wall time, against the `test` baseline's.
6. **Gates:** the full v3 gate passes per mutant on the final head (every leg runs explicitly under `test`). No frozen figure moves.

A difference from 1-4 is a finding. Its cause is named before any change, and nothing here is retuned after the run.
