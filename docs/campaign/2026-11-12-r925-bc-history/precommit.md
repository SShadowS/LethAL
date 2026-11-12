# R-925 pre-commitment: eight BC.History apps on al-runner v3 serve

Committed before any run, 2026-11-12. Coord task R-925 (owner: more BC.History on v3, to dig out bugs; plan
`/coord/handoff/R-925-plan.md`). Evidence goes to `/coord/handoff/R-925/`. No BC.History source text is committed: names and counts.

## Why these eight

They ship test apps with real tests, need only packages we hold or can build from corpus source, and are spread over areas. No
standalone app covers manufacturing, service management, jobs, fixed assets, warehouse or intercompany with tests (those are tested
only by BaseApp's own test apps; a separate question to the owner).

## Setup

- **Corpus:** `/work/src/BC.History` (w1-28.6.55443.0), read-only; scratch copies in `/coord/handoff/R-925/src/`, `app.json` edited
  only as in R-914 (build placeholders filled; minimum versions lowered from 28.6 to 28.0, because the packages are 28.4).
- **Packages:** R-881's Microsoft 28.4.53241.56646 packages, per app in `pkgs-<key>`, plus apps built from corpus source: Email - SMTP
  API (smtp); Statistical Accounts, Power BI Report embeddings and PowerBI Reports Test Library (sus); Field Service Integration Test
  Library (fsi). The two test libraries are compiled against their targets (R-913's pattern), not folded: each target's
  `internalsVisibleTo` names the library.
- **Probing path (R900, as R-927 corrected it):** `/coord/cache/bc28-service-windows`, for the two apps that declare .NET (fsi, smtp).
- **Selector ids:** three free codeunit ids per app, checked against the target, the test app, built dependencies and every
  codeunit of the package folder (`selector-ids.json`).
- **al-runner:** `current` = edge-42af5d384. **LethAL:** master at the time of the run (b5762bd9 or later; each report names it).
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run`, default transport (serve-entries since R761; R919 admits the
  codeunit names, R924 the multi-object and wrapped shapes), auto isolation, full mutant set, all tests of the app's own test project,
  with `--time-budget`: 1800 s for rgl and ebh, 3600 s for smtp, lpp, saif and xl, 7200 s for fsi, 10800 s for sus. One heavy slot
  (`scripts/heavy-slot.sh other`), at least 10 GB available at start; retried only on exit 75.

| app | key | `[Test]` | sites | deployed | hang-refused |
|---|---|---|---|---|---|
| Review G/L Entries | rgl | 12 | 319 | 312 | 0 |
| Essential Business Headlines | ebh | 18 | 657 | 633 | 0 |
| Email - SMTP Connector | smtp | 60 | 816 | 812 | 2 |
| Late Payment Prediction | lpp | 13 | 1110 | 1060 | 0 |
| Sales and Inventory Forecast | saif | 28 | 1026 | 990 | 4 |
| Excel Reports | xl | 36 | 1815 | 1764 | 26 |
| Field Service Integration | fsi | 55 | 4944 | 4728 | 16 |
| Sustainability | sus | 526 | 15452 | 14857 | 242 |

Counts from `lethal run --dry-run` on b5762bd9 (`/coord/handoff/R-925/dry-<key>.txt`).

## What is expected

A hunt: nothing particular is predicted. Firm expectations: every app runs on serve (any fallback reason is a finding); a budget stop
exits 7 with the caveat `time-budget-reached`. Per app the report gives transport, decided and executed mutants per hour (R-924's
`rate.ts`), refusals by cause and baseline reds. A sample of kills is read against the source for false kills (R-916's method). Every
al-runner refusal or difference gets an invented repro and an upstream issue; every LethAL gap a roadmap item.
