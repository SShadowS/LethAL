# R161 pre-commitment: the four new `itest:tables` mutants, and the five new demo mutants

Written **before** the live run, per the project's pre-commitment discipline. A verdict that differs
from this document is a finding, not a number to update.

R161 widens six operators' guard from `isStatementPosition` to `isStatementSlot`, so a call that is
the un-braced body of a branch or loop is now claimed. Measured on `do-rel2/Cloud`: 1,280 sites
gained, 0 lost. On the fixtures the change is small and every new mutant is nameable in advance.

## What the new mutants ARE, which is the headline

All nine are the same shape:

```al
if <bad condition> then
    Error('...');
```

A guard clause. It is the most common validation shape in Business Central, and until this change
LethAL emitted **no mutant at any of them**, because the `Error(...)` call sits in a `then_branch`
slot rather than in a statement list. Deleting it removes the validation while leaving everything
else intact, which is exactly the bug a mutation-testing tool for BC should be able to plant.

## Gate impact, measured per fixture

| fixture | gained | gate |
| --- | ---: | --- |
| `fixtures/sandbox-data` | **4** | `itest:tables` re-freezes |
| `examples/gift-card` | **5** | demo rehearsal report re-records |
| `fixtures/sandbox-app` | **0** | `itest:bcdev` and `itest:envtool` UNCHANGED |
| `fixtures/sandbox-hang` | **0** | `itest:hang` UNCHANGED |

Two of the four gates need nothing. That is measured, not assumed.

## `itest:tables`: the four, with predicted verdicts

| # | site | mutant | predicted | why |
| --- | --- | --- | --- | --- |
| 1 | `src/DataMain.Table.al:23`, field 1 `"No."` `OnValidate` | delete `Error('No. must not be blank')` | **killed** | `BlankNoValidateFails` does `asserterror DataMain.Validate("No.", '')`. With the raise gone the validate completes, the `asserterror` finds no error and the test fails. |
| 2 | `src/DataMain.Table.al:49`, field 3 `Category` `OnValidate` | delete `Error('related total too large')` | **killed** | `CategoryGuardNeedsCalcFields` seeds two related rows summing to 1,300 and does `asserterror DataMain.Validate(Category, 'Z')`. The guard is the only thing that raises. Same statement as the existing `remove-calcfields` mutant, so the two become siblings in one dispatch chain. |
| 3 | `src/DataNoTrigger.Table.al:12`, field 1 `"No."` `OnValidate` | delete `Error('No. too long')` | **killed** | `TooLongNoValidateFails` does `asserterror DataNoTrigger.Validate("No.", '12345678901')`, 11 characters against a `StrLen > 10` guard. |
| 4 | `src/DataOps.Codeunit.al:92`, `InsertWithoutTrigger` | delete `DataMain.Delete(false)` | **survived** | the only covering test, `InsertWithoutTriggerKeepsAmount`, calls `DeleteMain('T-INS')` first, so `DataMain.Get(MainNo)` returns `false` and the deleted statement never executes on that path. Coverage is procedure-level, so the site is COVERED and the verdict is `survived`, not `no-coverage`. Expect `reach: covered-but-unreached`. |

### Predicted new frozen figures

| | before | after |
| --- | ---: | ---: |
| killed | 191 | **194** |
| survived | 31 | **32** |
| no-coverage | 10 | **10** |
| deployed mutants | 232 | **236** |
| raw specs | 252 | **256** |

Everything else the gate pins must NOT move, and each is predicted deliberately:

- `untargetedTriggerCount` **0**. The new sites sit in triggers that tests already reach at object
  level; nothing about attribution changes.
- `platformArtifactKills.killedCount` **2**. None of the four is an `Insert`, so neither the
  `remove-commit` kill nor the arm K `Insert` kill is affected, and no new tag is declared.
- `assertionScreen.discrimination` **`partial`**. The R132 twin pair is untouched. All four new
  kills raise through the fixture's own bare `Error(...)`, so the screen flags them, which is what
  `partial` already describes; the gate pins the discrimination rather than a count for exactly this
  reason.
- `declarativeSites` **1 site in 1 file**. Unchanged.
- Exactly ONE expected baseline failure, `Data Tests.PageActionComputesNonZero`, BY NAME.

## The demo: five, all predicted killed

| site | mutant | predicted | why |
| --- | --- | --- | --- |
| `GiftCard.Table.al:19` `"Customer No."` `OnValidate` | delete `Error(CustomerRequiredErr)` | **killed** | `IssueRequiresCustomer` asserterrors `Issue('GC-NOCUST', '', …)`. |
| `GiftCardMgt.Codeunit.al:14` `Issue` | delete `Error(AmountMustBePositiveErr)` | **killed** | `IssueRejectsNegativeAmount` asserterrors `Issue('GC-NEG', 'C10000', -50, …)`; with the guard gone a negative card is issued without raising. |
| `GiftCardMgt.Codeunit.al:35` `Redeem` | delete `Error(CardBlockedErr, CardNo)` | **killed** | `RedeemBlockedCardFails`. |
| `GiftCardMgt.Codeunit.al:38` `Redeem` | delete `Error(CardExpiredErr, CardNo)` | **killed** | `RedeemExpiredCardFails`. |
| `GiftCardMgt.Codeunit.al:41` `Redeem` | delete `Error(InsufficientBalanceErr, CardNo)` | **killed** | `RedeemMoreThanBalanceFails`; the redemption completes and drives the balance negative rather than raising. |

Predicted demo totals: **41 mutants, 25 killed, 9 survived, 7 no-coverage** (from 36 / 20 / 9 / 7).

**Note for the conference material.** Five of five killed reads as "the demo app's guards are well
tested", which is true and is a better story than it looks: the planted bug (`remove-setrange` in
`GetBalance`) still survives, so the run now shows both halves at once, a suite that catches every
guard clause and still misses the one thing nobody asserted.

## What would count as a finding

- Any verdict differing from the table above.
- Any of the four unchanged aggregates moving.
- A `no-coverage` verdict on #4 instead of `survived`, which would mean coverage attribution
  disagrees with "the procedure ran".
- An `AlcCompileError` anywhere. `scripts/r161-emit-proof.ts` compiles all four slot shapes offline
  with a negative control that must be rejected, so a compile failure here would mean the offline
  proof does not cover the shape the fixture actually has.
