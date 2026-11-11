# R-914 pre-commitment: five BC.History apps on al-runner v3

Committed before any run, 2026-11-11. Coord task R-914 (owner: more BC.History on v3, to dig out bugs). Evidence goes to
`/coord/handoff/R-914/`. No BC.History source text is committed here or anywhere: file, object, procedure and test names only.

## Setup

- **Corpus:** `/work/src/BC.History` (w1-28.6.55443.0), read-only. Scratch copies in `/coord/handoff/R-914/src/`. Only
  `app.json` changes, as in R-902: the build placeholders are filled (version 28.6.55443.0, platform and application 28.0.0.0),
  and minimum dependency versions are lowered from 28.6 to 28.0, because the packages are 28.4.
- **MasterDataManagement:** its `_Exclude_` test library project is folded into the test app (3 files copied, the dependency
  dropped), and the test app is added to the target's `internalsVisibleTo`, as R-882 did for Payment Practices.
- **SAF-T:** depends on Audit File Export, which we hold no package for. It runs only if Audit File Export builds from its
  corpus source against the held packages; that built app then sits in a separate package dir. If it does not build, SAF-T is
  reported as blocked, with the reason.
- **Packages:** R-881's Microsoft packages from `bc3` (BC 28.4.53241.56646). A difference that comes from the 28.6 / 28.4 gap is
  the setup's, not LethAL's.
- **Demo data:** downloaded once by the first run into `/coord/handoff/R-914/cache` (the default since R-895).
- **Probing paths (R900):** MasterDataManagement and EmailLogging declare .NET types, so their configs carry
  `assemblyProbingPaths`.
- **al-runner:** `current` = edge-3138effad. **LethAL:** master at the time of the run; each report names the sha.
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run`, serve-entries, auto isolation, no `--no-client`, full
  mutant set, all tests of the app's own test project, with `--time-budget`: 14400 s for Withholding Tax and Subcontracting,
  10800 s for MasterDataManagement and SAF-T, 5400 s for EmailLogging. A run stopped by its budget is continued with `--resume`
  when time allows, and the report says which mutants were never scored. One heavy slot (`scripts/heavy-slot.sh other`) per run,
  at least 10 GB available at start.

| app | key | `[Test]` | deployed mutants | hang-refused sites |
|---|---|---|---|---|
| Withholding Tax | wht | 71 | 6386 | 1080 in 7 files |
| MasterDataManagement | mdm | 24 | 5347 | 95 in 6 files |
| EmailLogging | eml | 14 | 1565 | 0 |
| Subcontracting | sub | 231 | 6903 | 154 in 8 files |
| SAF-T | saft | 27 | from its dry run | from its dry run |

Counts are from `lethal run --dry-run` (`/coord/handoff/R-914/dry-<key>.txt`).

## What is expected

Nothing in particular is predicted: this is a hunt. Every new refusal cause, crash, hang, wrong-looking verdict, misleading
report line or piece of tool friction is a finding, and each one gets a roadmap item or an upstream al-runner issue.
The one firm expectation: a run stopped by `--time-budget` exits 7 with the caveat `time-budget-reached`; anything else is a
finding. The estimate printed in the mutants phase is compared with the actual time, per app.
