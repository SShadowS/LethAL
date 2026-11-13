# R-961 pre-commitment: BC.History batch 9 on al-runner edge-c8fe56e05

Committed before any run, 2026-11-13. Coord task R-961. Evidence goes to `/coord/handoff/R-961/`. No BC.History source text is
committed: app, test and procedure names and counts only.

## Selection

Of R-927's buildable System Application modules with tests, not run in R-913..R-953 or R-958
(`/coord/handoff/R-961/select.ts`, `select.txt`), favouring features earlier batches covered less: install and upgrade codeunits,
event subscribers, temporary tables, JSON, a .NET zip stream, text conversion. No module left in that list declares a report,
query, XMLport or API page. The Azure AD User, Graph and Licensing modules are left out: their tests create the platform class
MockGraphQuery, which al-runner refuses (#7934), as it refused every Azure AD User Management test in batch 8.

| key | module | [Test] | deployed (dry run) | hang-refused |
|---|---|---|---|---|
| usrset | User Settings | 13 | 429 | 0 |
| uptags | Upgrade Tags | 12 | 199 | 15 |
| usrperm | User Permissions | 19 | 229 | 3 |
| docshare | Document Sharing | 17 | 167 | 0 |
| appsrc | AppSource Gallery | 7 | 346 | 14 |
| telem | Telemetry | 9 | 387 | 2 |
| zip | Data Compression | 10 | 138 | 0 |
| b64 | Base64 Convert | 13 | 88 | 0 |

## Method

- **LethAL:** lane-preproc at current master (9067c67f or later), named in each run's first line; defaults as master ships them.
- **al-runner:** `current`, edge-c8fe56e05, named in each run's first line. Transport: the default (serve-entries).
- **Environment:** `onprem` (R938), as batches 7 and 8: it honours each test's SetTestability* calls in both directions and
  matches the on-prem bc servers LethAL's gates measure, so the batches stay comparable.
- **Packages:** the eight modules' closure (63 projects) built with R-927's driver, cached as
  `bch-sysapp-pool-batch9@d9fad4a0933b+25661207`. Probing path the Windows BC 28.4 service folder.
- **Runs:** the full mutant set, one `--time-budget 3600` window each, one at a time, through `scripts/heavy-slot.sh --wait
  --peak serve` (admission by memory, R972), retry on exit 75 only.

**Nothing is pre-committed about verdicts.** Reported per app (as R-940 and R-953): transport, executed and decided per hour,
daemon closes by reason, refusals by cause, baseline reds by cause, peak RSS, a false-kill sample. Every al-runner refusal or
difference gets an invented repro and an upstream issue, or a count comment on an existing one; every LethAL gap a roadmap item.
