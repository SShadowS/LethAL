# R-457 - pre-committed itest:tables change for the `run-trigger-forced` tag

**Written BEFORE the live run.** If Cronus answers differently, that is a FINDING, recorded as one, not reconciled quietly.

Date: 2026-10-05. Gate: `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `fixtures/sandbox-data` plus `-tests`. Master at 4443ca0c. Plan: `/coord/reviews/R-457-plan/plan.r3.md`. Baseline file: `packages/runner/itest/tables.baseline.json`. Evidence: the real manifest diff (20 of 20 runs, 0 failures) and sol's r2 check against the baseline.

## What changes in the product

Two operators now declare `run-trigger-forced` when they FORCE a trigger to run that did not run before:
- `lethal.swap-modify-flag`, forward direction (`Modify()` to `Modify(true)`, and the Insert/Delete forms);
- `lethal.flip-boolean-literal`, the `false` to `true` flip of a RunTrigger argument.

The rule is conservative (`forceCanRaise`): the tag is dropped only where the table is resolved and provably has no trigger, and no observer, for that kind. It is kept for anything unresolved. A kill is then screened and listed in `platformArtifactKills`. The tag never moves a verdict (R72/R121). No key changes: `IDENTITY_SCHEME` stays 13, no new Caveat, no new `SessionReport` field.

## (a) The seven mutants that gain the tag on `sandbox-data`

Key format: `<astHash>|<object>|<procedure>|<operator>|<major>[|<ordinal suffix>]`. Hash `31c85a76...` is the shared hash of the `false` flip subtree, so the FULL key (object, procedure, ordinal) is what separates rows. Key on all of it, never on the code alone (codes shift between runs).

| Code | File:line | Object / procedure | Operator | Baseline key (hash prefix) | Verdict | Killing test | Counts? |
|---|---|---|---|---|---|---|---|
| **M0223** | `DataOps.Codeunit.al:96` | `Data Ops` / `InsertWithoutTrigger` | `lethal.flip-boolean-literal`, `Insert(false)` to `Insert(true)` | `31c85a76...\|Data Ops\|InsertWithoutTrigger\|lethal.flip-boolean-literal\|1\|1` (ordinal 1) | **killed** | `InsertWithoutTriggerKeepsAmount` | YES, the only one |
| M0034 | `DataCommitOps:38` | `Data Commit Ops` / `CommitThenFail` | flip false to true | `31c85a76...\|Data Commit Ops\|CommitThenFail\|lethal.flip-boolean-literal\|1` | survived | none | no |
| M0045 | `DataCommitOps:52` | `Data Commit Ops` / `CommitThenRun` | flip false to true | `31c85a76...\|Data Commit Ops\|CommitThenRun\|lethal.flip-boolean-literal\|1` | survived | none | no |
| M0056 | `DataCommitOps:89` | `Data Commit Ops` / `CommitThenRunValueForm` | flip | `31c85a76...\|Data Commit Ops\|CommitThenRunValueForm\|lethal.flip-boolean-literal\|1` | survived | none | no |
| M0065 | `DataCommitTarget:18` | `Data Commit Target` / `OnRun` | flip false to true | `31c85a76...\|Data Commit Target\|OnRun\|lethal.flip-boolean-literal\|1` | survived | none | no |
| M0362 | `DataTriggerProbe.Table:62` | `Data Trigger Probe` / `OnDelete` | flip false to true | `31c85a76...\|Data Trigger Probe\|OnDelete\|lethal.flip-boolean-literal\|1` | survived | none | no |
| M0186 | `DataMainListExt.PageExt:41` | `Data Main List Ext` / `OnOpenPage` | `lethal.swap-modify-flag`, `Main.Modify()` to `Main.Modify(true)` | `46d6cf5b...\|Data Main List Ext\|OnOpenPage\|lethal.swap-modify-flag\|1` | no-coverage | none | no |

Notes that stop a wrong join:
- Same hash, different mutant: `Data Commit Target|OnRun` and `Data Trigger Probe|OnDelete` each have a second flip row under hash `637aa2af...` (`OnRun` is killed by `CommitBeforeCodeunitRunSucceeds`). Those are NOT in the list and must stay untagged.
- `Data Ops|InsertWithoutTrigger` has two flip rows. Ordinal 0 (M0218, line 92, key ends `|1`) is **survived** and sits on a table with no trigger and no observer, so it stays untagged (dropped). Ordinal 1 (M0223, key ends `|1|1`) is the tagged one.
- M0223's kill is assertion-earned: `InsertWithoutTriggerKeepsAmount` (`sandbox-data-tests/src/DataTests.Codeunit.al:262`) raises its own `Error` when `Amount <> 5`. It is a named OVER-TAG, the same honest kind R138's arm A and R281's arm C were. No platform refusal is claimed or measured.
- `sandbox-data-tests` also gains 18 tagged flips. No gate mutates that app, so no gate sees them.

## (b) Assertions that change (`packages/runner/itest/tables.itest.ts`)

1. `EXPECTED.platformArtifactKills` (currently `platformArtifactKills: 3,`, about line 555): **3 to 4**. Extend its doc comment, which now ends with the R281 paragraph ("R281 TOOK THIS FROM 2 TO 3 ... Pre-committed in docs/superpowers/specs/2026-10-05-r281-delete-tag-precommitment.md"). Add: "R-457 TOOK IT FROM 3 TO 4: forced-trigger mutants declare `run-trigger-forced`. Only M0223 (`Data Ops.InsertWithoutTrigger`, `Insert(false)` to `Insert(true)`) is killed, by a test that raises its own Error, so it is a named OVER-TAG. Six more gain the tag and are survived or no-coverage, so they do not count. Pre-committed in docs/superpowers/specs/2026-10-05-r457-forced-tag-precommitment.md before the run." Also fix the "1 + 1 = 2" arithmetic line so it reads 1 + 1 + 1 + 1.
2. The `byMechanism` deepEqual (currently, about line 1040):
   ```
   screen.byMechanism.map((g) => g.mechanism),
   ["run-trigger-skipped-delete", "run-trigger-skipped-insert", "write-txn-codeunit-run"],
   "all three mechanisms must be present and named - R138 added Insert, R281 Delete, and the report sorts them",
   ```
   becomes
   ```
   ["run-trigger-forced", "run-trigger-skipped-delete", "run-trigger-skipped-insert", "write-txn-codeunit-run"],
   ```
   and the message becomes "all four mechanisms ... R138 added Insert, R281 Delete, R-457 forced". Sort order: `report.ts` sorts with `.sort(([a], [b]) => a.localeCompare(b))`. `run-trigger-forced` sorts before `run-trigger-skipped-...` because `f` precedes `s` at the first differing letter (`run-trigger-f` vs `run-trigger-s`), so it is FIRST.
3. ADD a by-mutant pin for the forced group, after the Delete group block, mirroring it:
   ```
   const forcedGroup = groupOf("run-trigger-forced");
   const forcedScreened = forcedGroup.mutants.map(mutantOf);
   assert.deepEqual(
     forcedScreened.map((m) => [m.operatorName, m.procedureName, m.verdict, m.killingTest]),
     [["lethal.flip-boolean-literal", "InsertWithoutTrigger", "killed", "InsertWithoutTriggerKeepsAmount"]],
     "...")
   ```
   Also assert its `originalText` matches `/false/i` and its file line is `DataOps.Codeunit.al:96` if the report exposes it. Use the exact field names the existing blocks use; `killingTest` is added only if `mutantOf`'s row carries it (else pin it through the baseline join). The message names the over-tag, and says the group disappearing means the conservative rule dropped a tag on a resolved table that has a trigger (under-tagging, unsafe), and a second member means a survived or no-coverage mutant is being counted or a wrong site is claimed. Add `assert.ok(forcedGroup.explanation.length > 0)` and that it differs from the Insert group's explanation (the mechanisms must not share one text).
4. The comment above the Insert group block says the screen never holds "or a `Modify` site, which gets no mechanism at all." That is still true of the Insert group, but a forced Modify flip or forward swap now gets `run-trigger-forced`, so reword: a Modify site is never in the INSERT group (a forced one has its own group, below).
5. Not changed: `assertionScreen.discrimination` stays `partial`; the `platform-artifact-kills` caveat check stays.

Source note for the implementer (not a gate change): the current `run-trigger-forced` explanation in `packages/runner/src/platform-artifact-kills.ts` is written for the old narrow operator. It says "rewriting `Modify()` to `Modify(true)`" only, "PROVABLY contains a raise-capable statement, never as a blanket", and "STRONGER THAN `run-trigger-skipped-insert`". The plan's rule is conservative (blanket where unresolved), so that text is now FALSE and must be rewritten with the plan (keep the other-app observer limit). If the gate pins any explanation substring, pin one that survives that rewrite.

## (c) What must NOT change

- `tables.baseline.json`: no edit, no re-record. The baseline holds no mechanism, only verdict, killingTest, `coverageFiltered`, `errorClass` per key. All seven rows above keep their values, and every other row too.
- Totals: killed **301** / survived **68** / no-coverage **18** over 387 deployed (407 raw). `untargetedTriggerCount` **0**. `declarativeSites` 1 in 1 file. `mutationScore` unchanged (a screened kill stays inside it).
- `groupedCalls` **382**, `warmKills` **13** with M0160 at 5, M0164 at 4, M0156 at 2. The manifest diff changes tags only, not mutant lists or order.
- The ONE expected baseline failure, `Data Tests.PageActionComputesNonZero`, by name, and its named refusal.
- The write-txn group: exactly 1 mutant, `lethal.remove-commit` in `CommitThenRunValueForm`, killed. Note M0056 (a flip in the SAME procedure) gains the forced tag but is survived, so it must not appear in the write-txn group.
- The Insert group: exactly 1 mutant, `InsertTwiceWithKeyTrigger` (arm K). The Delete group: exactly 1 mutant, `DeleteWithTrigger` (arm C). Neither group may take a forced mutant.
- Number of mutants per `byMechanism` group except the new one: unchanged. `platformArtifactKills.killedCount` is exactly 4: write-txn 1, Insert 1, Delete 1, forced 1.
- `assertionScreen.discrimination` stays `partial`. No new Caveat, no `SessionReport` field, no schema change, `IDENTITY_SCHEME` 13.
- Other gates cannot move: `sandbox-data.only-DataMain` (`itest:chunked`) manifest is byte-identical, and so are sandbox-app, hang, harden, layout, symbols and multiobject manifests (18 of 20 byte-identical; only `sandbox-data` and `sandbox-data-tests` differ). `itest:bcdev`, `itest:alrunner`, `itest:envtool`, `itest:chunked` stay frozen.

## Failure reading

- `killedCount` 4 with a different fourth mutant, or the forced group holding anything but M0223: the rule or a verdict path moved. BLOCK.
- `killedCount` still 3: the rule dropped the tag on M0223, whose table (`Data Ops` receiver `Data Main`) has a trigger. Under-tagging, the unsafe direction. BLOCK.
- `killedCount` above 4, or a survived or no-coverage mutant in a group: the count logic changed. BLOCK.
- Any verdict, killingTest, total, groupedCalls or warmKills difference: a real regression, never "close enough".
