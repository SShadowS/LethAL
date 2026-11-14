# R-964 pre-commitment: BC.History batch 11 on al-runner edge-c8fe56e05

Committed before any run, 2026-11-13. Coord task R-964 (lethal-bugs), in parallel with R-962's batch 10 (lethal-preproc). Evidence goes
to `/coord/handoff/R-964/`. No BC.History source text is committed: app, test and procedure names and counts only.

## Batch 11

From R-962's inventory (`/coord/handoff/R-962/inventory.md`: 70 runnable, not-yet-run test projects), the next eight in its order that
batch 10 does not take; the split was agreed with lethal-preproc by message, and both batches are marked taken in the inventory
(54 runnable projects untaken).

| key | test project | [Test] | deployed (dry run) | hang-refused | selector ids |
|---|---|---|---|---|---|
| recur | System Application Test / Recurrence Schedule | 29 | 280 | 9 (1 file) | the hunt's pick |
| dataadmin | System Application Test / Data Administration | 21 | 202 | 0 | spare range (no idRanges) |
| aaduser | System Application Test / Azure AD User | 21 | 225 | 0 | spare range (no idRanges) |
| pdf | System Application Test / Pdf | 23 | 299 | 0 | spare range (no idRanges) |
| image | System Application Test / Image | 26 | 230 | 0 | spare range (no idRanges) |
| planconf | _Exclude_PlanConfiguration_ Tests | 31 | 7 | 0 | spare range (R888 clash) |
| continia | E-Document Connector - Continia Tests | 74 | 2,761 | 21 (2 files) | the hunt's pick |
| apiv1 | _Exclude_APIV1_ Tests | 478 | 5,442 | 0 | the hunt's pick |

## Method (as batch 10)

- **LethAL:** lane-bugs at current master, named in each run's first line; defaults as master ships them.
- **al-runner:** `current`, edge-c8fe56e05, named in each run's first line. Transport: the default (serve-entries).
- **Environment:** `onprem` (R938), as batches 7-10, so the batches stay comparable.
- **Packages:** the hunt's pool, cached as `bch-notrun-closure@d9fad4a0933b+25661207`, copied (writable) into the task folder.
- **Runs:** the full mutant set, one `--time-budget 3600` window each, one at a time, smallest first, through
  `scripts/heavy-slot.sh --wait --peak serve baseapp` (admission by memory, R972), retry on exit 75 only. APIV1's 5,442 and
  Continia's 2,761 mutants may not finish inside the hour; the report then says how many were left out, and that is the figure.

**Nothing is pre-committed about verdicts**, with two expectations stated beforehand: Azure AD User is expected to score nothing at
baseline (its tests use the MockGraphQuery library, refused upstream as #7934, as Azure AD User Management was in batch 8), and
PlanConfiguration's 7 mutants make its score a small-number figure. Reported per app as batches 7-10: transport, executed and
decided per hour, daemon closes, refusals by cause, baseline reds, a false-kill sample. Every al-runner refusal or difference gets
an invented repro and an upstream issue, or a count comment on an existing one; every LethAL gap a roadmap item. The inventory's
"run" list is updated when the batch is done.
