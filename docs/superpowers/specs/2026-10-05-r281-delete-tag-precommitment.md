# R-281 - pre-committed itest:tables change for the `run-trigger-skipped-delete` tag

**Written BEFORE the live run.** If Cronus answers differently, that is a FINDING, recorded as one, not reconciled quietly.

Date: 2026-10-05. Gate: `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `fixtures/sandbox-data` plus `-tests`. Plan: `docs/superpowers/plans/2026-10-05-R-281-run-trigger-skipped-delete.md` (r2). Baseline file: `packages/runner/itest/tables.baseline.json`.

## What changes in the product

`lethal.swap-modify-flag` rewrites `Delete(true)` to `Delete(false)`. Today it declares no `PlatformKillMechanism` for that. After R-281 it declares `run-trigger-skipped-delete`, narrowed (R143 style) by `deleteSkipCanRaise`: the tag is dropped only where the table's `OnDelete` is proven harmless, and kept for anything unresolved. A kill is then screened and listed in `platformArtifactKills`. The tag never moves a verdict (R72/R121).

## (a) The one mutant that gains the tag: arm C

| Field | Value |
|---|---|
| Baseline key | `589ad2d30d6276e5f4ba3e93622b38428d87002fb4caa5115659dabaf58abe13\|Data Flag Ops\|DeleteWithTrigger\|lethal.swap-modify-flag\|1` |
| File | `fixtures/sandbox-data/src/DataFlagOps.Codeunit.al` (`codeunit 79314 "Data Flag Ops"`), line 55 `Probe.Delete(true);` |
| Procedure | `DeleteWithTrigger` |
| Operator | `lethal.swap-modify-flag` |
| Original / mutated text | `Delete(true)` / `Delete(false)` (the gate's `originalText` match is `Delete(true)`) |
| Baseline verdict | `killed` |
| Baseline killingTest | `DeleteRunTriggerLeavesTombstone` |
| Receiver table | `Data Trigger Probe` (table 79330). Its `OnDelete` INSERTS a `TOMB-` row, so it is a write to another record and is NOT proven harmless. The tag is kept. |

It is an OVER-TAG, named as such. The kill is earned by the test's own `Error('expected Delete(true) to run OnDelete and leave a tombstone')` after reading the tombstone back. It is not a duplicate-key or other platform refusal. This is the same honest over-tag R138's arm A was. The duplicate-key mechanism for Delete stays UNMEASURED live; the tag is syntactic.

## (b) Every swap-modify-flag mutant on the fixture

Seven in the baseline. Only one is a Delete. The only `Delete(true)` in `fixtures/sandbox-data/src` is the one above (line 55); no other `Delete(true)` exists in the fixture or its tests. `Data Ops.InsertWithoutTrigger`'s `DataMain.Delete(false)` is already `false`, so `swap-modify-flag` emits nothing there (the baseline has no swap-modify-flag key for it).

| Baseline key (hash prefix, procedure) | Method | Verdict | Gains tag? |
|---|---|---|---|
| `589ad2d3...` Data Flag Ops / DeleteWithTrigger | Delete(true) | killed (DeleteRunTriggerLeavesTombstone) | YES, the only one. killedCount +1 |
| `e75f9a09...` Data Flag Ops / InsertCounted | Insert(true) | survived | no. Insert keeps its R143 rule; unchanged |
| `e75f9a09...` Data Flag Ops / InsertTwiceWithKeyTrigger | Insert(true) | killed (DoubleInsertWithoutKeyTriggerRaises) | unchanged: keeps `run-trigger-skipped-insert` (arm K) |
| `e75f9a09...` Data Flag Ops / InsertWithTrigger | Insert(true) | killed (InsertRunTriggerSetsTheTriggerField) | unchanged: no tag (arm A left in R143) |
| `46d6cf5b...` Data Main List Ext / OnOpenPage | Modify | no-coverage | no (Modify stays untagged) |
| `e85f78ad...` Data Main / OnValidate | Modify | killed (FlaggedFiresModifyTrigger) | no |
| `f6cb2f57...` Data Ops / MarkProcessed | Modify | killed (MarkProcessedFiresModifyTrigger) | no |

(The Modify mutants are probably `Modify(true)` to `Modify(false)`; if one is the forward `false`->`true` direction, it is still Modify and untagged. Not a Delete either way.)

So: exactly ONE Delete mutant, killed. There is no non-killed Delete mutant that gains the tag, so no tagged-list entry exists beyond the one killed row.

## (c) Assertions that must change (`packages/runner/itest/tables.itest.ts`)

1. `EXPECTED.platformArtifactKills` (about line 549): **2 -> 3**. Update its doc comment: 1 write-txn (`CommitThenRunValueForm`) + 1 Insert (arm K) + 1 Delete (arm C, over-tag). Name R-281 and this file.
2. `screen.byMechanism.map((g) => g.mechanism)` deepEqual (about line 1035-1036): currently `["run-trigger-skipped-insert", "write-txn-codeunit-run"]`, becomes `["run-trigger-skipped-delete", "run-trigger-skipped-insert", "write-txn-codeunit-run"]` (the report sorts them; alphabetical gives this order). Update the message ("R138 added the second") to name R-281 as the third.
3. ADD a new pin for the Delete group, BY MUTANT, next to the Insert group block: `groupOf("run-trigger-skipped-delete")` has exactly 1 mutant; its `operatorName` is `lethal.swap-modify-flag`; its `originalText` matches `/\.?delete\s*\(\s*true/i`; its `verdict` is `killed`; its `procedureName` is `DeleteWithTrigger`; its explanation mentions the Delete trigger and carries the cross-app limit text. Mirror the Insert block's `procedureName` deepEqual.
4. The Insert group assertions stay as they are. Their comment says the screen never holds "the `Delete` or either `Modify` site, which the R138 ruling says get no mechanism at all". That sentence is now FALSE for Delete. Reword it: the Delete site is held by its OWN group, never the Insert group.
5. Header comments that say "183 kills" or similar need no change. The baseline JSON is NOT re-recorded (see d).

## (d) Everything that must NOT change

- `tables.baseline.json`: no edit, no re-record. Verdicts, killingTest, `coverageFiltered` and `errorClass` per key are identical. Mutant keys do not change; operator version is not bumped (R138/R143 precedent).
- Totals: killed **301** / survived **68** / no-coverage **18** over 387 deployed (407 raw). `untargetedTriggerCount` **0**. `declarativeSites` 1 in 1 file.
- `groupedCalls` **382**, `warmKills` **13** with M0160 at 5, M0164 at 4, M0156 at 2. `mutationScore` unchanged (a screened kill stays inside it).
- The ONE expected baseline failure, `Data Tests.PageActionComputesNonZero`, by name, and its named refusal.
- The write-txn group: exactly 1 mutant, `lethal.remove-commit` in `CommitThenRunValueForm`, verdict killed.
- The Insert group: exactly 1 mutant, `InsertTwiceWithKeyTrigger` (arm K). Arm A (`InsertWithTrigger`) and arm B (`InsertCounted`) stay out of it.
- The Modify mutants stay untagged; `Data Ops.InsertWithoutTrigger` `Delete(false)` still yields no swap-modify-flag mutant.
- The `killedMutantWith("lethal.swap-modify-flag", "originalText", "Delete(true)")` assertion still passes (arm C stays killed).
- `assertionScreen.discrimination` stays `partial`. The caveat `platform-artifact-kills` is still present (reused, not a new Caveat). No new `SessionReport` field, no schema change, no new caveat.
- Other gates (`itest:bcdev`, `itest:alrunner`, `itest:envtool`, `itest:chunked`, symbol/layout legs): no `Delete(true)` mutant anywhere on their fixtures (survey), so they cannot move. `itest:chunked` runs only `DataMain.Table.al`, which has no `Delete(true)`.

## Failure reading

- `killedCount` 3 with a different third mutant, or the Delete group holding more than arm C: the narrowing is wrong or a verdict path moved. BLOCK.
- `killedCount` still 2: the operator did not tag arm C, so `deleteSkipCanRaise` wrongly proved the tombstone-inserting `OnDelete` harmless. This is the unsafe direction (under-tagging). BLOCK.
- Any verdict, killingTest, total, groupedCalls or warmKills difference: a real regression, never "close enough".
