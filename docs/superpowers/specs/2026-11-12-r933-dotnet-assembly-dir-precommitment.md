# R-933 pre-commitment: probing paths reach al-runner's --dotnet-assembly-dir (R941, R943), measured before and after

Committed before any measured run, 2026-11-12. Coord task R-933. Evidence goes to `/coord/handoff/R-933/`. No source text is
committed: app, test and procedure names and counts only.

## What is measured

The change: LethAL passes each `assemblyProbingPaths` folder to al-runner as `--dotnet-assembly-dir`, with the .NET helper, on
one-shot calls and serve daemons. Each app runs twice with the SAME config (probing path `/coord/cache/bc28-service-windows`):
**before** from `lethal/lane-preproc` at master (the paths reach alc only), **after** from `lethal/r933`. al-runner: the pinned
`current` (edge-42af5d384 when written). Default transport, `--time-budget 3600`, one heavy slot.

| app | scope | from |
|---|---|---|
| Edit in Excel | full (563 deployed) | R-932's setup, pool rebuilt (`pool-build/`) |
| Cryptography Management | full (1,389 deployed) | R-932's setup, pool rebuilt |
| Sustainability | `--only src/ESGReporting/SustESGReportingName.Table.al` (40 deployed); the baseline runs all 526 tests | R-925's prep (`/coord/handoff/R-925-prep/`) |

## Expectations (from direct al-runner runs, R-932 and R-925)

- Edit in Excel: the baseline gains tests (direct run: 6 -> 11 passing).
- Cryptography Management: the baseline gains tests (direct run: 44 -> 53 passing; one test then fails).
- Sustainability: the 4 `Sustainability API Tests` refused for Newtonsoft.Json load, then stop on a separate refusal (R941); no other
  baseline test changes.
- Per mutant, on the mutants both runs scored: verdicts may change only for mutants whose covering tests changed. Every other change
  is a finding. **No verdict is pre-committed.**

## v3 gate

No fixture sets `assemblyProbingPaths` or holds a `.netpackages` folder, so no gate leg's command line changes: no gate figure moves.
