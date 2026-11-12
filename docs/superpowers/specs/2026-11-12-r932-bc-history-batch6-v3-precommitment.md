# R-932 pre-commitment: BC.History batch 6 on al-runner v3, eight System Application modules

Committed before any run, 2026-11-12. Coord task R-932 (owner direction: more BC.History on v3 to find al-runner bugs). Evidence goes to
`/coord/handoff/R-932/`. No source text from BC.History is committed: app, test and procedure names and counts only.

## Why these apps

Of the 110 apps R-927 found buildable with the Windows BC 28.4 service folder, these eight have the most tests among those not run in
R-913, R-914, R-915, R-925, R-926, R-927 or R-928, and they cover different features: pages and setup guides, DotNet-backed
cryptography, HTTP and JSON (Microsoft Graph, Azure Blob), permission sets with an XMLport, languages, extension management, and
Edit in Excel (web services).

## Setup

- **LethAL:** `lethal/lane-preproc` at current master (1e61bfc9 or later: R939's daemon close counts, R940's estimate label, R922's
  codeunit names and pre-flight caveat), recorded in each run's first line. Defaults as master ships them: serve-entries, demo
  data, the sidecar, auto isolation, the hang cut. The default environment (R938: v3 runs as saas).
- **al-runner:** the pinned `current` (edge-42af5d384 when this was written), recorded in each run's first line.
- **Probing path:** `/coord/cache/bc28-service-windows` only.
- **Packages:** the modules' dependency closure, 73 projects built from BC.History source by R-927's driver (`pool-build/`), plus
  R-903's 13 published 28.4.53241.56646 packages; every project builds and closes. `bcVersion` 28.4.53241.56646.
- **Apps** (`prep.ts`; placeholders filled to 28.6/28.0):

| key | module | [Test] | deployed (dry run) | hang-refused |
|---|---|---|---|---|
| guided | Guided Experience | 104 | 2,593 | 18 |
| crypto | Cryptography Management | 68 | 1,389 | 4 |
| graph | Microsoft Graph | 31 | 263 | 31 |
| permsets | Permission Sets | 30 | 1,338 | 8 |
| language | Language | 27 | 214 | 0 |
| extmgmt | Extension Management | 26 | 1,323 | 12 |
| excel | Edit in Excel | 23 | 563 | 42 |
| blob | Azure Blob Services API | 20 | 1,263 | 0 |

- **Runs:** `lethal run --backend al-runner-v3`, the full mutant set (`--allow-large-run`), the default transport, one
  `--time-budget 3600` window each, one at a time in one heavy slot (`scripts/heavy-slot.sh other`, retried on exit 75 only).

## Expectations

**Nothing is pre-committed about verdicts.** These modules were never measured on v3. Estimate, from R-928's modules: most finish in
minutes; a module with slow tests may reach its hour.

## Per app, reported

Transport (any fallback is a finding, shown as the `al-runner-v3-serve-default-fallback` caveat), executed and decided per hour
(`/coord/handoff/R-924/sb/rate.ts`), serve daemon closes by reason (R939), refusals by cause, baseline reds by cause, and a false-kill
sample (at least 5 kills per app, flagged ones included). A red that looks environment-driven (R938) is checked by hand under
`--environment onprem` and said so; R938 itself is not fixed here (code's R-930).

## What counts as a finding

Every new refusal cause, crash, hang, wrong-looking verdict, false kill, misleading report line or tool friction. Each al-runner
refusal or difference gets an invented repro and an upstream issue; each LethAL gap a roadmap item.
