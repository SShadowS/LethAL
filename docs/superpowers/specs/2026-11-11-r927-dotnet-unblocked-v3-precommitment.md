# R-927 pre-commitment: three BC.History apps the DotNet errors used to block, sampled on al-runner v3

Committed before any run, 2026-11-11. Coord task R-927. Evidence goes to `/coord/handoff/R-927/`. No source text from BC.History is
committed: app, test and procedure names and counts only.

## Why these apps

R-903 left 115 BC.History apps blocked, 112 of them only by DotNet generic-conversion errors (AL0133, AL0122). The owner measured
the cause: the Linux BC service folder's assemblies. With the Windows BC 28.4 service folder (`/coord/cache/bc28-service-windows`)
as the only probing path, R-927's re-run (`/coord/handoff/R-927/hunt/`) closes 110 of the 115 with 0 emit errors. Three of the
apps that now build sit outside System Application and have their own test app. They are sampled here. System Application modules
are left out: their test libraries depend on the whole System Application package, so a module's v3 run would load its objects
twice.

## Setup

- **LethAL:** `lethal/lane-preproc` at current master (3cbff9cf or later), recorded in each run's first line. Defaults as master
  ships them: serve-entries, demo data, the sidecar, auto isolation, the hang cut. `--no-client` off.
- **al-runner:** the pinned `current` (edge-42af5d384 when this was written), recorded in each run's first line.
- **Probing path:** `/coord/cache/bc28-service-windows` only, in each config's `assemblyProbingPaths` and each copy's
  `.vscode/settings.json`.
- **Apps** (BC.History w1-28.6, placeholders filled to 28.6/28.0, runtime 17, dependencies at 28.0, `prep.ts`; R-882's 28.4
  package set plus AI Test Toolkit built from source; every app, library and test app compiles with 0 errors):

| app | test app | deployed (dry run) | sample (seed 927, at most 150) | selector ids |
|---|---|---|---|---|
| Email - SMTP API | Email - SMTP API Tests (with its Test Library) | 277 | 8 files, 119 | 1999990010, 1999990009, 1999990008 (extra range in the copy) |
| Email - SMTP Connector | Email - SMTP Connector Tests | 812 | 6 files, 87 | 2147483647, 5540, 5539 |
| Sales Lines Suggestions | Sales Lines Suggestions Tests | 2,235 | 6 files, 150 | 1999990010, 1999990009, 1999990008 (extra range in the copy) |

- **Sample:** R-915's rule (`sample.ts`): files shuffled with seed 927, taken in that order while the total stays at or under 150
  deployed mutants. Passed as `--only`.
- **Runs:** `lethal run --backend al-runner-v3`, the default transport, `--time-budget 3600`, one at a time in one heavy slot
  (`scripts/heavy-slot.sh other`).

## Expectations

**Nothing is pre-committed about verdicts.** These apps were never measured on v3.

Estimate, from R-915's samples (20 to 70 min one-shot, faster on serve): under 30 min each. Reported beside the actual wall time.

## What counts as a finding

Every new refusal cause, crash, hang, wrong-looking verdict, misleading report line or tool friction. Each gets an invented repro,
then a roadmap item or an upstream al-runner issue (refusals and differences go upstream, with invented repros). Small LethAL ones
are fixed in this task, red both ways. A serve fallback is reported with its reason.
