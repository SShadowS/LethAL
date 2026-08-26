# R159 build: per-mutant pre-commitment for `flip-boolean-literal`

Written before the gates were run against the built state. Every verdict below was fixed first; the
outcome is appended and nothing above it is edited.

What lands: `lethal.flip-boolean-literal` registered (Tier 1, 1.0.0), on the `receiver.ts` move that
already shipped so its cession consults `claimsRecordMethod` rather than restating it.

## Where these verdicts come from, and why that is not cheating

Fourteen of the sixteen were MEASURED during the spike
(`2026-08-26-r159-flip-boolean-spike.md` §6), against the same fixtures and the same operator, on
Cronus283 and Cronus281. Restating a measurement is not a prediction and this document does not
pretend otherwise.

Four of them are corrections. The spike PREDICTED D1, D2, D3 and D12 killed and measured them
survived, because it credited the suite with assertions it does not make. The measured values are
what appear below. Using the predictions instead would be re-committing to a value already known to
be wrong.

The two genuinely unmeasured numbers are the raw site count and the aggregate totals, and the raw
count is deliberately not predicted — see §3.

## 1. `itest:tables` — 13 new mutants

| # | site | mutation | verdict | killing test |
| --- | --- | --- | --- | --- |
| D1 | `Data Commit Ops.CommitThenFail:38` | `Insert(false)` -> `Insert(true)` | **survived** | — |
| D2 | `Data Commit Ops.CommitThenRun:52` | `Insert(false)` -> `Insert(true)` | **survived** | — |
| D3 | `Data Commit Ops.CommitThenRunValueForm:89` | `Insert(false)` -> `Insert(true)` | **survived** | — |
| D4 | `Data Commit Target.OnRun:17` | `Flagged := true` -> `false` | **killed** | `CommitBeforeCodeunitRunSucceeds` |
| D5 | `Data Commit Target.OnRun:18` | `Modify(false)` -> `Modify(true)` | **survived** | — |
| D6 | `Data Ops.MarkProcessed:68` | `Processed := true` -> `false` | **killed** | `MarkProcessedFiresModifyTrigger` |
| D7 | `Data Ops.MarkWithFlag:80` | `Processed := true` -> `false` | **killed** | `ModifyWithFlagVariableRuns` |
| D8 | `Data Ops.InsertWithoutTrigger:92` | `Delete(false)` -> `Delete(true)` | **survived** | — |
| D9 | `Data Ops.InsertWithoutTrigger:96` | `Insert(false)` -> `Insert(true)` | **killed** | `InsertWithoutTriggerKeepsAmount` |
| D10 | `Data Scope Probe.OnValidate:61` | `Bumped := true` -> `false` | **killed** | `ScopeProbeTracksFieldChange` |
| D11 | `Data Trigger Probe.OnInsert:53` | `"Inserted By Trigger" := true` -> `false` | **killed** | `InsertRunTriggerSetsTheTriggerField` |
| D12 | `Data Trigger Probe.OnDelete:61` | `Tombstone := true` -> `false` | **survived** | — |
| D13 | `Data Trigger Probe.OnDelete:62` | `Tomb.Insert(false)` -> `Insert(true)` | **survived** | — |

Six killed, seven survived, none uncovered.

**The seven survivors are the point, not an embarrassment.** `sandbox-data` is the most worked-over
suite in this repository, and four of these seven are behaviours nothing asserts:
`CommitBeforeCodeunitRunSucceeds` checks that the row exists and `Flagged` is set but never reads
`Amount`, which D1-D3 double through `OnInsert`; `DeleteRunTriggerLeavesTombstone` checks a RETURN
VALUE rather than the tombstone's own field, which is D12. D5, D8 and D13 are genuine shrugs.

**They are also the answer to R159's point 2**, the strongest argument against building this
operator: `empty-block` KILLS those procedures while the fine-grained boolean flip SURVIVES. Coarse
and fine disagree at the same sites, which is discrimination evidence no aggregate can fake. A
survivor count that went to zero here would mean the operator added nothing.

| | frozen | predicted |
| --- | ---: | ---: |
| deployed mutants | 259 | **272** |
| killed | 213 | **219** |
| survived | 34 | **41** |
| no-coverage | 12 | **12** |
| `untargetedTriggerCount` | 0 | 0 |
| `declarativeSites` | 1 site in 1 file | unchanged |
| expected baseline failures | 1 (`PageActionComputesNonZero`) | unchanged |

Mutation score 219 / 260, about **0.8423**, DOWN from 0.8623. That direction is right and is the
thing to read: a wave that adds seven deliberate survivors and six kills must lower the score. A
score that rose would mean the survivors did not arrive.

## 2. The two demos

| | frozen | predicted |
| --- | ---: | ---: |
| `credit-limit` recorded | 32 | **33** |
| `credit-limit` killed / survived / no-coverage | 17 / 7 / 8 | **18 / 7 / 8** |
| `credit-limit` score | 70.8% | **72.0%** |
| gift-card recorded | 45 | **47** |
| gift-card killed / survived / no-coverage | 26 / 11 / 8 | **26 / 11 / 10** |
| gift-card score | 70.3% | **70.3% unchanged** |

`credit-limit`'s one site is `WouldExceedLimit`'s `exit(false)`, killed by
`NoCreditLimitMeansNoBlock`. Both gift-card sites are in `BlockExpiredCards`, which no test calls, so
both are `no-coverage` and the score cannot move — a `no-coverage` row is excluded from it.

## 3. The raw site count is NOT predicted

`totalMutantSites` is read from the run, as it was for R171. Two counts legitimately disagree by one
(a straight sum of `generate()` against the gate's number, which drops R144's declarative site), and
guessing which convention the constant uses would be inventing a number rather than measuring one.

## 4. What cannot move

`itest:bcdev`, `itest:alrunner` and `itest:hang` — `sandbox-app` and `sandbox-hang` contain zero
sites, measured before the build rather than assumed after it.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**All sixteen matched.**

`itest:tables` cleared every aggregate assertion on the first run and stopped only at the per-mutant
baseline, which is where thirteen new mutants are supposed to surface:

```
verdicts: killed=219 survived=41 noCoverage=12 baselineGreen=false
          score=0.8423076923076923 untargetedTriggers=0 declarativeSites=1
```

`totalMutantSites` came in at **292**, the number §3 declined to predict. Killed, survived,
no-coverage and the score are exactly as derived, and all thirteen per-mutant verdicts landed on the
rows the table above names — six killed with the predicted killing test, seven survived.

The re-recorded baseline gained **12 keys covering 13 mutants** (one pair shares an identity), removed
none, and **no pre-existing key changed verdict**. Every addition is `flip-boolean-literal`.

Both demos matched: `credit-limit` 33 recorded at 18 / 7 / 8 and **72.0%**, killed by
`NoCreditLimitMeansNoBlock`; gift-card 47 recorded at 26 / 11 / 10 and **70.3% unchanged**.

`itest:bcdev`, `itest:alrunner` and `itest:hang` were not re-run, for the reason §4 gave in advance.

### One thing this build broke, and it was not the operator

The credit-limit README named three survivors by mutant CODE — `M0015`, `M0019`, `M0025`. This
operator inserted a mutant at line 34 of `WouldExceedLimit` and every code after it shifted by one,
so all three then pointed at a different mutant: `M0015` became the new flip, `M0019` a
`return-value`, `M0025` an `empty-block`.

Nothing was wrong with the report. The README was quoting a per-run label as though it were an
identity, which is precisely why `assignMutantIds` restarting per batch made the per-mutant baseline
key on `astHash` in the first place. The README now names survivors by procedure and operator, and
`demo.precommit.md` records why so the next writer does not reintroduce it.
