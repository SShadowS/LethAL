# R-928 pre-commitment: seven System Application modules on al-runner v3

Committed before any run, 2026-11-12. Coord task R-928. Evidence goes to `/coord/handoff/R-928/`. No source text from BC.History is
committed: app, test and procedure names and counts only.

## Why these apps

R-927 found 110 BC.History apps buildable with the Windows BC 28.4 service folder as probing path. The ones outside System Application
with their own tests are taken (R-927's sample; code's R-925 list). What is left with real tests is System Application modules. The
seven with the most tests are run here. R-927 left open whether a module runs on v3 beside the System Application package, which
holds the module's objects too; the first run answers it.

## Setup

- **LethAL:** branch `lethal/r928` (master 8228ce80 plus R934's fix: a mutant's summed time reads each test's own time), recorded
  in each run's first line. Defaults as master ships them: serve-entries, demo data, the sidecar, auto isolation, the hang cut.
- **al-runner:** the pinned `current` (edge-42af5d384 when this was written), recorded in each run's first line.
- **Probing path:** `/coord/cache/bc28-service-windows` only.
- **Packages:** the modules' dependency closure, 73 projects, built from BC.History source by R-927's driver into
  `pool-build/pool`, plus R-903's 13 published 28.4.53241.56646 packages. Every project builds and closes.
- **Apps** (`prep.ts`; placeholders filled to 28.6/28.0):

| key | module | [Test] | deployed (dry run) | hang-refused | selector ids |
|---|---|---|---|---|---|
| retention | Retention Policy | 113 | 1,824 | 10 | 1999990010, 1999990009, 1999990008 |
| sharepoint | SharePoint | 71 | 2,503 | 89 | 9140, 9139, 9138 |
| mcp | MCP | 58 | 1,105 | 7 | 8370, 8369, 8368 |
| rest | Rest Client | 50 | 739 | 0 | 1999990010, 1999990009, 1999990008 (extra range in the copy) |
| aadplan | Azure AD Plan | 32 | 1,219 | 4 | 9828, 9827, 9826 |
| profiler | Performance Profiler | 30 | 776 | 44 | 1929, 1928, 1927 |
| filestorage | External File Storage | 28 | 871 | 7 | 1999990010, 1999990009, 1999990008 (extra range in the copy) |

- **Runs:** `lethal run --backend al-runner-v3`, the full mutant set (`--allow-large-run`), the default transport, one
  `--time-budget 3600` window each, one at a time in one heavy slot (`scripts/heavy-slot.sh other`). Rest Client runs first and is
  also the smoke test: if v3 cannot load a module beside the System Application package, that is the finding, and the rest stop.

## Expectations

**Nothing is pre-committed about verdicts.** These modules were never measured on v3.

Estimate: module test suites are small and fast, so most modules finish inside the hour; SharePoint and Retention Policy may not.

## Per app, reported

Transport (and any fallback reason), executed and decided mutants per hour over the mutant loop (`/coord/handoff/R-924/sb/rate.ts`),
refusals by cause, baseline reds by cause, and a sample of kills checked for false kills: at least 5 killed mutants per app (all if
fewer), each read by its killing test's failure against the mutation, and any doubtful one re-run unmutated.

## What counts as a finding

Every new refusal cause, crash, hang, wrong-looking verdict, false kill, misleading report line or tool friction. Each al-runner
refusal or difference gets an invented repro and an upstream issue; LethAL ones a roadmap item, small ones fixed in this task, red
both ways.
