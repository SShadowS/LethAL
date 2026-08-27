# R180 build: `empty-block` claims a case arm, every verdict pre-committed

Written before the run. Nothing above the OUTCOME line is edited afterwards.

## 0. A correction to R180's own sizing, made before building on it

R180 recorded **291** claimable sites (233 `case_branch` + 58 `case_else_branch`). The 58 is wrong,
and the error is one this row has now made twice: counting NODES without checking which node KIND the
operator targets.

`empty-block` targets `code_block`. Measured by chain on `do-rel2/Cloud`:

| chain | count | status |
| --- | ---: | --- |
| `code_block <- case_branch` | **233** | the fix, one parent kind |
| `code_block <- if_statement <- case_branch` | 62 | ALREADY claimed, parent is `if_statement` |
| `code_block <- statement_block <- case_else_branch` | **9** | needs a different match, deferred |

The 58 were `statement_block` nodes, which `empty-block` cannot target by kind. Only **9** else arms
hold a `begin ... end` at all; the other 49 are a single statement with no block to empty.

**Corrected: 233 sites from a one-line change, 18x R13's bar.** The else's 9 are under the bar on
their own and need a grandparent match rather than a parent one, so they are left and recorded.

## 1. The change

`case_branch` replaces `case_statement` in `empty-block`'s `BODY_PARENT_KINDS`. The old entry matched
nothing: an arm's body is a `code_block` whose parent is `case_branch`, never the `case_statement`.

## 2. The arm, and why its three cases are a control set

`codeunit 79326 "Data Case Ops"`, covered by one test asserting all three paths.

| shape | the fix must | why it is here |
| --- | --- | --- |
| `1:` with a `begin ... end` body | **ADD** one `empty-block` mutant | the claim itself |
| `2:` with a single statement | **ADD NOTHING** | separates "claims arm BLOCKS" from "claims arms" |
| `else` with a `begin ... end` body | **ADD NOTHING** | the deferred 9-shape, pinned so it cannot change silently |

The middle row is load-bearing. A fix that claimed arms rather than arm BLOCKS would add a mutant
there, which the per-mutant baseline catches as an extra row where a total would just look bigger.

## 3. `itest:tables`: 345 -> 358 deployed (365 -> 378 raw)

All thirteen are killed: the covering test asserts all three arms, so nothing there can survive.

| line | operator | predicted | why |
| ---: | --- | --- | --- |
| 27 | `empty-block` | killed | the PROCEDURE body, pre-existing shape; returns 0 |
| **30** | **`empty-block`** | **killed** | **THE NEW ONE.** Arm 1's block emptied, so level 1 scores 0 against an expected 15 |
| 31 | `remove-assignment` | killed | `Score := 10` gone leaves 5 |
| 31 | `shift-integer` | killed | 11 + 5 = 16 |
| 32 | `remove-assignment` | killed | `Score += 5` gone leaves 10 |
| 32 | `shift-integer` | killed | 10 + 6 = 16 |
| 35 | `remove-assignment` | killed | level 2 scores 0 against 20 |
| 35 | `shift-integer` | killed | 21 |
| 38 | `remove-assignment` | killed | else scores 9 against 99 |
| 38 | `shift-integer` | killed | 91 + 9 = 100 |
| 39 | `remove-assignment` | killed | else scores 90 |
| 39 | `shift-integer` | killed | 90 + 10 = 100 |
| 42 | `return-value` | killed | returns 0 |

New totals: **killed 280 / survived 63 / no-coverage 15 over 358**, score 0.8091 -> **0.8163**. The
score RISES because this arm is thirteen kills and no survivors, which is what an arm asserting every
path should do.

## 4. The other gates

UNCHANGED, and measured rather than assumed: **no other fixture contains a `case` statement**. The
four `case` tokens in `fixtures/sandbox-data` outside this arm are the English word inside comments,
and `sandbox-app`, `sandbox-hang`, `credit-limit` and `gift-card` have none.

## 5. What would refuse the build

- Line 30's `empty-block` absent: the fix does not claim an arm block and the change is inert.
- A mutant appearing at line 35 (the single-statement arm) or in the `else` block: the fix claims
  arms rather than arm blocks, or reached the else, and its scope is wrong.
- Any of the existing 345 verdicts moving: `empty-block` ships everywhere and a wrong parent-kind
  entry could remove claims elsewhere.

---

## OUTCOME, appended after the run. Nothing above is edited.

**All thirteen matched, and the control set held.**

```
M0013 DataCaseOps:27  empty-block        killed   (procedure body, pre-existing shape)
M0014 DataCaseOps:30  empty-block        killed   <- THE NEW ONE, the arm's block
M0015 DataCaseOps:31  remove-assignment  killed
M0016 DataCaseOps:31  shift-integer      killed
M0017 DataCaseOps:32  remove-assignment  killed
M0018 DataCaseOps:32  shift-integer      killed
M0019 DataCaseOps:35  remove-assignment  killed   <- single-statement arm: NO empty-block
M0020 DataCaseOps:35  shift-integer      killed
M0021 DataCaseOps:38  remove-assignment  killed   <- else block: NO empty-block
M0022 DataCaseOps:38  shift-integer      killed
M0023 DataCaseOps:39  remove-assignment  killed
M0024 DataCaseOps:39  shift-integer      killed
M0025 DataCaseOps:42  return-value       killed
```

Totals: **killed 280 / survived 63 / no-coverage 15 over 358**, score **81.6%**, exactly as
pre-committed. The per-mutant baseline diff is **0 changed, 0 removed, 13 added**, so nothing that
existed before moved.

**The two ABSENCES are the result worth reading.** Line 35 is a single-statement arm and line 38 is
the `else` block, and neither gained an `empty-block` mutant. A fix that claimed arms rather than arm
BLOCKS would have added one at 35; a fix that reached the else would have added one at 38. Both are
pinned by mutant, where a total would simply have looked bigger and right.

`itest:tables` **PASS**. 2590 unit tests. No other gate can move: no other fixture contains a `case`
statement.
