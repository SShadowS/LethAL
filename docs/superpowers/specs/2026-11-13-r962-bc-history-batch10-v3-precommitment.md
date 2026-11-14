# R-962 pre-commitment: BC.History batch 10 on al-runner edge-c8fe56e05

Committed before any run, 2026-11-13. Coord task R-962. Evidence goes to `/coord/handoff/R-962/`. No BC.History source text is
committed: app, test and procedure names and counts only.

## Inventory (part 1, measured before this pre-commitment)

BC.History holds 176 test projects (an `app.json` with at least one `[Test]`). 73 have run on v3 (R-882..R-961); 33 are
blocked (32 of BaseApp's `Tests-*` slices, which need Base Application itself compiled: upstream #7920 and #7914; and OnPrem
Permissions, whose app holds only permission sets); 70 are runnable: all build and instrument in a fresh hunt over their
230-project closure (R-927's driver, Windows BC 28.4 probing path; `/coord/handoff/R-962/inventory.md`). Nine of the 70 need
selector ids from the spare range, because the hunt's pick clashed with a dependency's codeunit (R888). The note itself lands
with the task's branch.

## Batch 10

The eight runnable projects that cover the most features earlier batches did not: API pages (APIV2), Power BI queries and
reports, Business Foundation's No. Series, the largest System Application module left (Email), an HTTP/JSON connector
(Avalara), Word layouts (Word Templates), Barcode and Data Classification.

| key | app under test | test project | [Test] | deployed (dry run) | hang-refused |
|---|---|---|---|---|---|
| apiv2 | _Exclude_APIV2_ | _Exclude_APIV2_ Tests | 771 | 7,654 | 2 |
| pbi | Power BI Report embeddings | PowerBI Reports Tests | 118 | 2,515 | 0 |
| noseries | No. Series | No. Series Tests | 90 | 1,261 | 13 |
| email | Email | Email Test | 226 | 3,934 | 66 |
| avalara | E-Document Connector - Avalara | its Tests | 149 | 1,785 | 0 |
| barcode | Barcode | Barcode Test | 73 | 205 | 0 |
| wordtpl | Word Templates | Word Templates Test | 32 | 1,922 | 27 |
| dataclass | Data Classification | Data Classification Test | 38 | 537 | 0 |

## Method

- **LethAL:** lane-preproc at current master (14d79686 or later), named in each run's first line; defaults as master ships them.
- **al-runner:** `current`, edge-c8fe56e05, named in each run's first line. Transport: the default (serve-entries).
- **Environment:** `onprem` (R938), as batches 7-9, so the batches stay comparable.
- **Packages:** the hunt's pool, cached as `bch-notrun-closure@d9fad4a0933b+25661207`. Selector ids from the spare range
  1999990000-1999990010 for No. Series, Email, Barcode and Word Templates.
- **Runs:** the full mutant set, one `--time-budget 3600` window each, one at a time, through `scripts/heavy-slot.sh --wait
  --peak serve baseapp` (admission by memory, R972), retry on exit 75 only. APIV2's 7,654 mutants may not finish inside the
  hour; the report then says how many were left out, and that is the figure, not a failure.

**Nothing is pre-committed about verdicts.** Reported per app as batches 7-9. Every al-runner refusal or difference gets an
invented repro and an upstream issue, or a count comment on an existing one; every LethAL gap a roadmap item. The result states
how many runnable projects remain after this batch (62 if all eight run).
