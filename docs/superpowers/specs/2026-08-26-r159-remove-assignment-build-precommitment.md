# R159 build: per-mutant pre-commitment for `remove-assignment`

Written before the gates were run against the built state. Every verdict below was fixed first; the
outcome is appended and nothing above it is edited.

**This operator moves EVERY gate** — five of them, and every frozen figure in CLAUDE.md. It is the
largest landing any R159 candidate has produced.

## Where each verdict comes from

**60 are MEASURED**, in the spike (`2026-08-26-r159-remove-assignment-spike.md`), against the same
fixtures and the same operator on Cronus283. They are emitted here from the reports rather than
retyped, so a transcription slip cannot put a wrong verdict into the document that exists to be
compared against. Restating a measurement is not a prediction and this file does not pretend
otherwise.

**15 are PREDICTED**, in §3 — gift-card, `sandbox-hang` and `sandbox-app` were never run with this
operator. Those are the rows where a disagreement is a finding.

## 1. `itest:tables` — 52 new mutants, MEASURED

33 killed / 16 survived / 3 no-coverage.

| file:line | procedure | verdict | killing test |
| --- | --- | --- | --- |
| `DataBuilder.Codeunit.al:14` | `SetRange` | **killed** | `UserDefinedBuiltinsRun` |
| `DataCommitOps.Codeunit.al:35` | `CommitThenFail` | **killed** | `CommittedWriteSurvivesFailure` |
| `DataCommitOps.Codeunit.al:36` | `CommitThenFail` | **survived** | — |
| `DataCommitOps.Codeunit.al:37` | `CommitThenFail` | **survived** | — |
| `DataCommitOps.Codeunit.al:49` | `CommitThenRun` | **killed** | `CommitBeforeCodeunitRunSucceeds` |
| `DataCommitOps.Codeunit.al:50` | `CommitThenRun` | **survived** | — |
| `DataCommitOps.Codeunit.al:51` | `CommitThenRun` | **survived** | — |
| `DataCommitOps.Codeunit.al:86` | `CommitThenRunValueForm` | **killed** | `CommitBeforeValueFormCodeunitRunSucceeds` |
| `DataCommitOps.Codeunit.al:87` | `CommitThenRunValueForm` | **survived** | — |
| `DataCommitOps.Codeunit.al:88` | `CommitThenRunValueForm` | **survived** | — |
| `DataCommitOps.Codeunit.al:91` | `CommitThenRunValueForm` | **killed** | `CommitBeforeValueFormCodeunitRunSucceeds` |
| `DataCommitTarget.Codeunit.al:17` | `OnRun` | **killed** | `CommitBeforeCodeunitRunSucceeds` |
| `DataFlagOps.Codeunit.al:19` | `InsertWithTrigger` | **survived** | — |
| `DataFlagOps.Codeunit.al:37` | `InsertCounted` | **killed** | `WeakInsertAssertionMissesTheFlag` |
| `DataFlagOps.Codeunit.al:54` | `DeleteWithTrigger` | **killed** | `DeleteRunTriggerLeavesTombstone` |
| `DataFlagOps.Codeunit.al:88` | `InsertTwiceWithKeyTrigger` | **killed** | `DoubleInsertWithoutKeyTriggerRaises` |
| `DataKeyProbe.Table.al:37` | `OnInsert` | **killed** | `DoubleInsertWithoutKeyTriggerRaises` |
| `DataLoader.Codeunit.al:16` | `SetLoadFields` | **killed** | `UserDefinedBuiltinsRun` |
| `DataMain.Table.al:24` | `OnValidate` | **survived** | — |
| `DataMain.Table.al:63` | `OnValidate` | **survived** | — |
| `DataMain.Table.al:98` | `OnInsert` | **survived** | — |
| `DataMain.Table.al:105` | `OnModify` | **killed** | `FlaggedFiresModifyTrigger` |
| `DataMainListExt.PageExt.al:40` | `OnOpenPage` | **no-coverage** | — |
| `DataOps.Codeunit.al:68` | `MarkProcessed` | **killed** | `MarkProcessedFiresModifyTrigger` |
| `DataOps.Codeunit.al:80` | `MarkWithFlag` | **killed** | `ModifyWithFlagVariableRuns` |
| `DataOps.Codeunit.al:94` | `InsertWithoutTrigger` | **killed** | `InsertWithoutTriggerKeepsAmount` |
| `DataOps.Codeunit.al:95` | `InsertWithoutTrigger` | **killed** | `InsertWithoutTriggerKeepsAmount` |
| `DataScopeProbe.Page.al:40` | `OnOpenPage` | **no-coverage** | — |
| `DataScopeProbe.Table.al:61` | `OnValidate` | **killed** | `ScopeProbeTracksFieldChange` |
| `DataScopeProbe.Table.al:77` | `OnInsert` | **killed** | `ScopeProbeCountsOnlyFilteredRelated` |
| `DataShadow.Table.al:36` | `TestField` | **killed** | `ShadowedBuiltinsRun` |
| `DataShadow.Table.al:45` | `SetRange` | **killed** | `ShadowedBuiltinsRun` |
| `DataShadow.Table.al:51` | `Commit` | **killed** | `ShadowedBuiltinsRun` |
| `DataSwapOps.Codeunit.al:44` | `RunningTotal` | **killed** | `SwapRedirectsTheAccumulatorWriteback` |
| `DataSwapOps.Codeunit.al:45` | `RunningTotal` | **killed** | `SwapRedirectsTheAccumulatorWriteback` |
| `DataSwapOps.Codeunit.al:52` | `Accumulate` | **killed** | `SwapRedirectsTheAccumulatorWriteback` |
| `DataSwapOps.Codeunit.al:97` | `RecordFlags` | **killed** | `CommutativeCalleeMakesTheSwapEquivalent` |
| `DataSwapOps.Codeunit.al:121` | `StampCodes` | **killed** | `WeakStampAssertionMissesTheSwap` |
| `DataSwapOps.Codeunit.al:122` | `StampCodes` | **survived** | — |
| `DataSwapOps.Codeunit.al:151` | `NarrowStamp` | **survived** | — |
| `DataSwapOps.Codeunit.al:152` | `NarrowStamp` | **survived** | — |
| `DataSwapOps.Codeunit.al:176` | `LinkPair` | **killed** | `LinkedPairIsStamped` |
| `DataSwapOps.Codeunit.al:177` | `LinkPair` | **survived** | — |
| `DataSwapOps.Codeunit.al:183` | `Link` | **killed** | `LinkedPairIsStamped` |
| `DataSwapOps.Codeunit.al:184` | `Link` | **survived** | — |
| `DataTriggerProbe.Table.al:39` | `OnValidate` | **killed** | `ValidateRunsTheFieldTrigger` |
| `DataTriggerProbe.Table.al:53` | `OnInsert` | **killed** | `InsertRunTriggerSetsTheTriggerField` |
| `DataTriggerProbe.Table.al:60` | `OnDelete` | **killed** | `DeleteRunTriggerLeavesTombstone` |
| `DataTriggerProbe.Table.al:61` | `OnDelete` | **survived** | — |
| `DataValidateOps.Codeunit.al:54` | `TouchLevel` | **killed** | `TouchLevelRunsTheTriggerAgain` |
| `DataValidator.Codeunit.al:15` | `TestField` | **killed** | `UserDefinedBuiltinsRun` |
| `DataValueCard.Page.al:47` | `OnAction` | **no-coverage** | — |

| | frozen | predicted |
| --- | ---: | ---: |
| deployed mutants | 272 | **324** |
| killed | 219 | **252** |
| survived | 41 | **57** |
| no-coverage | 12 | **15** |

Mutation score 252 / 309, about **0.8155**,
down from 0.8423. A wave adding 16 survivors against 33 kills should lower it.

## 2. `credit-limit` — 8 new mutants, MEASURED

4 killed / 1 survived / 3 no-coverage. The three `no-coverage` rows are the posting
helpers the README already names as called by no test.

| file:line | procedure | verdict | killing test |
| --- | --- | --- | --- |
| `CreditLimitMgt.Codeunit.al:13` | `RegisterOrder` | **killed** | `OrderUnderLimitIsAllowed` |
| `CreditLimitMgt.Codeunit.al:14` | `RegisterOrder` | **killed** | `OpenOrdersCountTowardTheLimit` |
| `CreditLimitMgt.Codeunit.al:15` | `RegisterOrder` | **killed** | `OrderUnderLimitIsAllowed` |
| `CreditLimitMgt.Codeunit.al:16` | `RegisterOrder` | **survived** | — |
| `CreditLimitMgt.Codeunit.al:37` | `WouldExceedLimit` | **killed** | `OrderOverLimitIsBlocked` |
| `CreditLimitMgt.Codeunit.al:67` | `PostEntry` | **no-coverage** | — |
| `CreditLimitMgt.Codeunit.al:68` | `PostEntry` | **no-coverage** | — |
| `CreditLimitMgt.Codeunit.al:69` | `PostEntry` | **no-coverage** | — |

Totals: 33 -> **41** recorded, killed 18 -> **22**, survived 7 -> **8**,
no-coverage 8 -> **11**.

## 3. The 15 PREDICTED rows

### gift-card, 12 sites

| file:line | procedure | mutation | predicted | why |
| --- | --- | --- | --- | --- |
| `GiftCard.Table.al:58` | `OnInsert` | `"Issued Date" := WorkDate()` | **survived** | the README names this stamp but no test reads the issued date |
| `GiftCardMgt.Codeunit.al:17` | `Issue` | `GiftCard."No." := CardNo` | **killed** | the card is then inserted under a blank key and every `Get(CardNo)` in the suite fails |
| `:19` | `Issue` | `"Initial Amount" := Amount` | **survived** | the suite reads `Remaining Amount`, never the initial one |
| `:20` | `Issue` | `"Remaining Amount" := Amount` | **killed** | `RedeemReducesBalance` expects 60 after redeeming 40 of 100; it would start at 0 |
| `:21` | `Issue` | `"Expiry Date" := ExpiryDate` | **killed** | a blank date sorts before `WorkDate()`, so the expiry guard fires for every card and the valid-card tests fail |
| `:43` | `Redeem` | `"Remaining Amount" -= Amount` | **killed** | the balance never decreases and `RedeemReducesBalance` reads 100, not 60 |
| `:66` | `BlockExpiredCards` | `GiftCard.Blocked := true` | **no-coverage** | no test calls `BlockExpiredCards`; it joins its other ten |
| `:76` | `PostEntry` | `"Gift Card No." := CardNo` | **killed** | `GetBalance` filters on this field, so the sum finds nothing and the balance reads 0 |
| `:77` | `PostEntry` | `"Customer No." := CustomerNo` | **survived** | nothing in the suite reads the entry's customer |
| `:78` | `PostEntry` | `"Entry Type" := EntryType` | **survived** | the README states the string `Entry Type` appears nowhere in the suite |
| `:79` | `PostEntry` | `Amount := Amount` | **killed** | `GetBalance` sums this field |
| `:80` | `PostEntry` | `"Posting Date" := WorkDate()` | **survived** | never read |

Derived: **6 killed / 5 survived / 1 no-coverage**. Totals 47 -> **59**, killed 26 -> **32**,
survived 11 -> **16**, no-coverage 10 -> **11**, score 70.3% -> **66.7%**.

### `sandbox-hang`, 2 sites — and one of them is a HANG

| file:line | procedure | mutation | predicted | why |
| --- | --- | --- | --- | --- |
| `HangLogic.Codeunit.al:33` | `CountUpTo` | `Counter := 0` | **survived** | a local `Integer` already defaults to 0, so this is an equivalent mutant |
| `:42` | `Advance` | `Counter += 1` | **timeout-killed** | the counter never advances, so the loop never reaches its bound. This is a NEW non-terminating mutant, and the gate runs both `--stop-hung-sessions` modes: expect `timeout-killed` with the flag ON and an `error` / quarantine with it OFF |

That second row is the one to watch. `itest:hang` asserts both modes, so it moves in both.

### `sandbox-app`, 1 site — moves THREE gates

| file:line | procedure | mutation | predicted | why |
| --- | --- | --- | --- | --- |
| `SandboxLogic.Codeunit.al:23` | `LogAudit` | `Amount := Amount` | **survived** | a self-assignment. Deleting it changes nothing observable — an equivalent mutant by inspection, and a good one to have in the record |

`itest:bcdev`, `itest:alrunner` and `itest:envtool` all run this fixture, so all three move
17 -> 18 mutants with one more survivor: bcdev and envtool to **3 / 11 / 4**, al-runner to
**3 / 15 / 0**.

## 4. The raw site count is NOT predicted

`totalMutantSites` is read from the run, as for R171 and `flip-boolean-literal`.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**74 of 75 matched.** The 60 measured rows restated themselves exactly; 14 of the 15 predictions held.

| gate | frozen | measured |
| --- | --- | --- |
| `itest:tables` | 219 / 41 / 12 over 272 | **252 / 57 / 15 over 324** (344 raw), PASS |
| `itest:bcdev` | 3 / 10 / 4 | **3 / 11 / 4**, PASS |
| `itest:alrunner` | 3 / 14 / 0 | **3 / 15 / 0**, PASS |
| `itest:hang` | 5 mutants, 2 non-terminating | **7 mutants, 3 non-terminating**, PASS |
| `credit-limit` | 33 at 72.0% | **41 at 73.3%** (22 / 8 / 11) |
| gift-card | 47 at 70.3% | **59 at 68.8%** (33 / 15 / 11) |

`totalMutantSites` came in at **344**, the number §4 declined to predict. The re-recorded tables
baseline gained **48 keys covering 52 mutants**, removed none, and **no pre-existing key changed
verdict**; every addition is `remove-assignment`.

### The one miss

`GiftCard.OnInsert`'s `"Issued Date" := WorkDate()` was predicted **survived** and is **killed**, by
`IssueCreatesCard`. The prediction reasoned that the README names the stamp but nothing reads it; that
test does read it. A guess about a suite made without opening the suite.

### Both hang predictions held, and the pair is the interesting one

`Counter := 0` **survived** — a local `Integer` already defaults to 0, so it is an equivalent mutant
by inspection. `Counter += 1` is **timeout-killed**: deleting it removes the loop's only progress,
making it the fixture's THIRD non-terminating mutant and the third operator to reach that property.
Both modes of `--stop-hung-sessions` moved and the gate pins both.

### `itest:envtool` is UPDATED BUT NOT VERIFIED

Its external environment expired and was deleted on 2026-08-26, the day of this build, so the gate
could not run. Its constants are updated (the fixture is `sandbox-app`, which genuinely gained the
site, and `itest:bcdev` measured the verdict on that same fixture), and its committed baseline is
deliberately left **STALE**.

That is the honest state and it is chosen rather than defaulted. Deleting the baseline would make the
next run RECORD one nobody reviewed, which is R29's trap. Leaving it stale makes the next run fail
loudly, naming the new mutant. The gate is wrong in the direction that says so.
