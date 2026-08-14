# R138 pre-commitment: the second platform-kill mechanism

Written 2026-08-14, BEFORE any live run and before the operator change was written. Nothing in this
file may be edited after the run. A contradicted prediction is the finding.

## What is changing

`SessionReport.platformArtifactKills` recognises exactly one mechanism today, `write-txn-codeunit-run`,
declared only by `lethal.remove-commit`. This wave adds a second, `run-trigger-skipped-insert`,
declared by `lethal.swap-modify-flag` on its `Insert` mutants.

No verdict moves. A diagnosis never moves a verdict (R72's discipline, which R121 also obeys), so
`killed`, `survived`, `no-coverage`, `mutationScore` and the per-mutant baseline file must all be
byte-identical to the run before this one.

## The ruling on which methods get a mechanism

`lethal.swap-modify-flag` covers three record methods. Only one of them can ADD a platform error.

- **`Insert(true)` -> `Insert(false)`: tagged.** With `OnInsert` skipped, a table whose `OnInsert`
  assigns the primary key leaves that key blank. The first blank-key insert succeeds (blank is a
  legal `Code[20]`) and a second raises a duplicate primary key; the single-row variant is a later
  `Get`/`Modify` on the expected key raising "the record does not exist". Either way the test dies on
  the platform before any assertion runs.
- **`Delete(true)` -> `Delete(false)`: NOT tagged.** Skipping `OnDelete` REMOVES work — a tombstone
  not written, a related row not cascaded. Nothing about it can raise where the unmutated program did
  not. A downstream failure caused by an orphan row is a real consequence a suite may legitimately
  catch, not a platform refusal at the mutation site.
- **`Modify(true)` -> `Modify(false)`: NOT tagged**, for the same reason. `OnModify` stamps fields;
  skipping it writes less, never more, and the row is still located by the same key.

## What the tag claims, and what it does not

The tag is SYNTACTIC and is applied to every `Insert` mutant this operator emits. It is therefore
BROADER than its mechanism: whether the target table's `OnInsert` actually assigns the primary key is
not visible at the call site, and for a base-app record it is not visible at all (the semantic layer
is source-derived and cannot see base-app triggers). So `run-trigger-skipped-insert` means "a kill
here CAN be the platform rather than an assertion — read it", never "this kill is false".

That is weaker evidence than `write-txn-codeunit-run` carries, and the two must not be presented as
equally proven. `PLATFORM_ARTIFACT_KILL_DIAGNOSIS`, which is shared across mechanisms, currently says
each screened mutant "sits at a site where Business Central is MEASURED to refuse the mutated program
outright" — true of the write-transaction mechanism, not true of every `Insert` site. The shared text
therefore becomes mechanism-neutral and each mechanism's own explanation states how strong its own
evidence is. Nothing about the write-transaction claim is weakened: its explanation still names
Cronus281 and the 2x2x2.

The narrowing that would make the tag precise — resolve the receiver's table, find its `OnInsert`,
check whether it assigns a field in the table's primary key — is real work the R138 row does not ask
for, and it is filed as its own row rather than smuggled in here.

## The population, counted from the fixture before the run

`fixtures/sandbox-data/src` holds exactly six run-trigger-flag sites, and only that project is
instrumented (the test project is not):

| site | method | arm | frozen verdict |
| --- | --- | --- | --- |
| `DataFlagOps.Codeunit.al:20` | `Probe.Insert(true)` | A | killed by `InsertRunTriggerSetsTheTriggerField` |
| `DataFlagOps.Codeunit.al:38` | `Probe.Insert(true)` | B | survived |
| `DataFlagOps.Codeunit.al:55` | `Probe.Delete(true)` | C | killed by `DeleteRunTriggerLeavesTombstone` |
| `DataFlagOps.Codeunit.al:89` | `KeyProbe.Insert(true)` | K | killed by `DoubleInsertWithoutKeyTriggerRaises` |
| `DataMain.Table.al:75` | implicit `Modify(true)` | — | killed by `FlaggedFiresModifyTrigger` |
| `DataOps.Codeunit.al:69` | `DataMain.MODIFY(TRUE)` | — | killed by `MarkProcessedFiresModifyTrigger` |

Three `Insert` sites, so three mutants gain the tag. The screen counts only the KILLED ones, so two of
the three are screened: arm A and arm K. Arm B keeps the tag and is not screened, because a survivor
at such a site is just a survivor.

## Predictions

1. `platformArtifactKills.killedCount` = **3**. It is 1 today. The delta is +2, NOT +3.
2. `platformArtifactKills.byMechanism` has **two** groups, sorted by mechanism name:
   `run-trigger-skipped-insert` (2 mutants) then `write-txn-codeunit-run` (1 mutant).
3. The `write-txn-codeunit-run` group still holds exactly the `lethal.remove-commit` mutant in
   `CommitThenRunValueForm`, unchanged.
4. The `run-trigger-skipped-insert` group holds exactly the two `lethal.swap-modify-flag` mutants in
   `Data Flag Ops` whose `originalText` is an `Insert(true)` call and whose verdict is `killed` —
   arm A's `InsertRunTriggerSetsTheTriggerField` kill and arm K's `DoubleInsertWithoutKeyTriggerRaises`
   kill. Arm C's `Delete` mutant is NOT in it. Neither `Modify` mutant is in it.
5. Every count is unchanged: killed **191**, survived **31**, no-coverage **10** over 232 deployed
   (252 raw), score 191/222, `untargetedTriggerCount` **0**, `assertionScreen.discrimination`
   **`partial`**, exactly one baseline failure by name (`Data Tests.PageActionComputesNonZero`).
6. The per-mutant baseline file is NOT re-recorded. If it needs to be, something moved that must not
   have, and that is a block, not a re-record.

## The number this wave is honest about

Of the two kills the new mechanism screens on this fixture, exactly ONE is a platform artifact:

- **arm K IS one.** `DoubleInsertWithoutKeyTriggerRaises` asserts nothing at all, and the kill is a
  duplicate primary key raised by the platform. This is the case R138 was filed on.
- **arm A is NOT one.** `InsertRunTriggerSetsTheTriggerField` asserts the field `OnInsert` sets, so
  `Insert(false)` fails that assertion honestly. `Data Trigger Probe`'s `OnInsert` does not touch the
  primary key, so no duplicate-key error is available at that site.

So the screen's precision on this fixture is 1 of 2. That is a two-kill sample and no rate should be
read off it, but it is the direction of the cost and it is stated here rather than discovered by a
reader. It is also exactly what the screen's contract already says out loud: it screens on the site,
which it can prove, not on the reason the test went red, which it cannot.

## What this run may NOT conclude

- It does not measure how often a real project's `Insert(true)` sites sit on a table whose `OnInsert`
  assigns the key. The 91 `Insert(true)` sites in the 658-file Document Output snapshot are a
  population, not a classification.
- Arm K's other two untagged kills (the `empty-block` on `Data Key Probe`'s `OnInsert` body and the
  `negate-conditional` on its blank-key guard) reach the SAME duplicate-key mechanism through Tier-1
  operators mutating the trigger itself. This wave does not tag them and does not try to. The screen's
  blind spot shrinks; it does not close.
