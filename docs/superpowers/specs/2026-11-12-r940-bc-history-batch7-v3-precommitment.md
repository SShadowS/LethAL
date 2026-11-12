# R-940 pre-commitment: BC.History batch 7 on al-runner v3, eight System Application modules, on the new edge build

Committed before any run, 2026-11-12. Coord task R-940 (owner direction: more BC.History on v3 to find al-runner bugs). Evidence goes to
`/coord/handoff/R-940/`. No source text from BC.History is committed: app, test and procedure names and counts only.

## Why these apps

Of the 110 apps R-927 found buildable, the System Application modules not run in R-913..R-937 with the most tests, picked to cover
features earlier batches did not (`/coord/handoff/R-940/select.ts` counts tests and feature markers): a report (Password), an XMLport
(Security Groups), heavy JSON and events (AI, Page Summary Provider), HTTP (Azure File Services API), permission sets and RecordRef
(Record Reference), heavy temporary tables (External File Storage), and .NET `System.Uri` (URI). No candidate module marks
isolated storage, so that feature is not targeted.

## Setup

- **LethAL:** `lethal/lane-preproc` at current master (a7b74b1d or later: R945's seven keep-list families), recorded in each run's
  first line. Defaults as master ships them: serve-entries, demo data, the sidecar, auto isolation, the hang cut.
- **Environment:** `alRunnerV3.environment: "onprem"` (R938) in every config. Why: under `onprem` al-runner honours each test's
  `SetTestability*` calls in both directions, while `saas` ignores `SetTestabilitySoftwareAsAService(false)`; and it is what the
  on-prem bc servers that LethAL's gates measure answer.
- **al-runner:** the NEW edge build (R-939 moves `current` to edge-2bd87774f). No run starts before `current` names it; the build is
  recorded in each run's first line. Not pinned to the old build.
- **Probing path:** `/coord/cache/bc28-service-windows` only.
- **Packages:** the shared cache entry `bch-sysapp-pool-excel-crypto@d9fad4a0933b+25661207` (R-933's rebuild of the System
  Application closure with R-927's driver), read-only. `bcVersion` 28.4.53241.56646.
- **Apps** (`prep.ts`; placeholders filled to 28.6/28.0):

| key | module | [Test] | deployed (dry run) | hang-refused |
|---|---|---|---|---|
| uri | URI | 61 | 233 | 4 |
| ai | AI | 58 | 2,188 | 21 |
| recref | Record Reference | 33 | 155 | 0 |
| extfs | External File Storage | 28 | 871 | 7 |
| password | Password | 22 | 191 | 3 |
| secgroups | Security Groups | 19 | 613 | 31 |
| pagesum | Page Summary Provider | 19 | 367 | 8 |
| afs | Azure File Services API | 11 | 1,052 | 4 |

- **Runs:** `lethal run --backend al-runner-v3`, the full mutant set (`--allow-large-run`), the default transport, one
  `--time-budget 3600` window each, one at a time in one heavy slot (`scripts/heavy-slot.sh other`, retried on exit 75 only).

## Expectations

**Nothing is pre-committed about verdicts.** These modules were never measured on v3, and the build is new. Estimate: most finish
in minutes; AI (2,188 mutants) may reach its hour.

## Per app, reported

Transport (any fallback is a finding), executed and decided per hour (`/coord/handoff/R-924/sb/rate.ts`), serve daemon closes by
reason (R939), refusals by cause, baseline reds by cause, the serve daemon's peak RSS (R-934's sampler, or a 30 s `/proc` sample of
the daemon tree; the R950/R-934 daemon-growth finding needs data points), and a false-kill sample (at least 5 kills per app,
flagged ones included).

## What counts as a finding

Every new refusal cause, crash, hang, wrong-looking verdict, false kill, misleading report line or tool friction. Each al-runner
refusal or difference gets an invented repro and an upstream issue; each LethAL gap a roadmap item.
