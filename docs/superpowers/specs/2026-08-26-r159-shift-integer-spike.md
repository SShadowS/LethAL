# R159 spike: `shift-integer`, the off-by-one probe

Written before the live half. §4's verdicts were fixed before the operator was registered anywhere.

## 1. Sizing: 3,016 to 677, in three measured deductions

`integer` was the largest kind the node-kind census left unclaimed. The raw count is not the
candidate, and this row's own caution, count the CONTEXTS first, removed three quarters of it.

| deduction | remaining | why |
| --- | ---: | --- |
| raw, in bodies | 3,016 | the kind count |
| behavioural contexts only | **1,212** | comparison operand 777, assigned value 435. The discarded 1,804 are other things wearing the same node kind: `Code[20]` and `Text[250]` are type LENGTHS (530 and 181 occurrences of those two values alone), and field declarations, enum values and page properties are declarative surfaces R135 refuses |
| minus loop conditions | **873** | 339 sit in a `repeat`/`while` condition, 336 of those against `.Next(...)`. Shifting the `0` in `until Rec.Next() = 0` never terminates on a one-row set, R164's measured hazard, 290 such loops, each costing a session where `--stop-hung-sessions` is off |
| minus ordering comparisons | **677** | 196 are `<`, `<=`, `>`, `>=`, where `conditional-boundary` ALREADY shifts that boundary: `if X < 5` becomes `X <= 5` there and `X < 6` here, and those admit exactly the same values |

**677 marginal, 52x R13's bar**, with **0** exact-span overlap. The ordering-comparison cession is the
third time this row's point 1 has decided a design, and §3.2 dedup would not have caught it, that
rule compares SPANS, and the comparison node and the literal inside it are different spans. Exactly
how `flip-boolean-literal` came to duplicate `swap-modify-flag`.

## 2. Compile, both halves

- **Naive splice:** 14 of 14, on a probe carrying both claimed contexts, a compound `+=`, a subscript
  target, and every refused shape, on a baseline proven clean first.
- **Real emit path:** instrumented artifact compiles with **0 errors**, 14 of 172 mutants from this
  operator, dispatch verified.
- **Conformance: 6 cases, PASS**, including four refusals, ordering comparison, loop-exit condition,
  a literal at AL's 32-bit ceiling, and a declarative type length.

The loop refusal is POSITIONAL, not whole-loop, and the compile proof shows it: in `LoopExit` the
operator claims `Seen += 1` in the loop BODY while refusing the `0` in the loop CONDITION. Refusing
the whole loop would have cost sites for no safety.

## 3. Landing cost

7 fixture sites, touching four gates: `sandbox-data` 3, `credit-limit` 1, `sandbox-app` 1 (which
moves `itest:bcdev`, `itest:alrunner` AND `itest:envtool`), `sandbox-hang` 2. gift-card has none.

## 4. Live half, pre-committed

| # | site | mutation | predicted | why |
| --- | --- | --- | --- | --- |
| I1 | `Data Commit Ops.CommitThenFail:37` | `Amount := 5` -> `6` | **survived** | the commit tests assert the row EXISTS and that `Flagged` is set. Two operators have now measured that they never read `Amount`: `remove-assignment` and `toggle-blank-string` both survive in these three arms |
| I2 | `CommitThenRun:51` | `Amount := 7` -> `8` | **survived** | same |
| I3 | `CommitThenRunValueForm:88` | `Amount := 9` -> `10` | **survived** | same |
| I4 | `credit-limit WouldExceedLimit:33` | `if "Credit Limit" = 0` -> `= 1` | **killed** by `NoCreditLimitMeansNoBlock` | the zero-limit customer stops short-circuiting, exposure 400 > 0, and the order that test expects to register is blocked |
| I5 | `sandbox-app LogAudit:22` | `if Amount <> 0` -> `<> 1` | **survived** | the guarded block is `Amount := Amount`, a self-assignment. Changing WHICH inputs enter a block that does nothing is unobservable |
| I6 | `sandbox-hang CountUpTo:33` | `Counter := 0` -> `1` | **survived** | EQUIVALENT by arithmetic. `CountUpTo(3)` advances until `Counter >= 3`: from 0 it runs 1,2,3 and from 1 it runs 2,3. Both return 3 |
| I7 | `sandbox-hang Advance:42` | `Counter += 1` -> `+= 2` | **killed** by `CountUpToReachesTheLimit` | from 0 it runs 2,4 and exits at 4. The test expects 3 |

Derived: `sandbox-data` **0 killed / 3 survived**, `credit-limit` **1 / 0**, `sandbox-app` **0 / 1**,
`sandbox-hang` **1 / 1**.

**I6 is the row worth watching.** It is an equivalent mutant produced by arithmetic rather than by
dead code, and the operator cannot see it, an honest survivor that no source-derived layer could
refuse in advance. If it comes back killed, my arithmetic is wrong and the fixture is more sensitive
than it looks.

**The threshold.** 2 kills of 7 is a thin live half and is expected: these fixtures were built to
exercise other operators. What would refuse this candidate is not a low count but a WRONG one, I4 or
I7 surviving would mean the mutation is not observable even where the arithmetic says it must be.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**Seven of seven matched**, including both of the two kills and the one equivalent mutant.

```
sandbox-data (Cronus283), narrowed to this operator
  M0001 DataCommitOps:37   survived
  M0002 DataCommitOps:51   survived
  M0003 DataCommitOps:88   survived
  0 killed / 3 survived / 0 no-coverage

credit-limit (Cronus283)
  M0001 CreditLimitMgt:33  killed  NoCreditLimitMeansNoBlock
        "An order of 999,999 would take customer C-10000 over their credit limit."
  1 killed / 0 survived / 0 no-coverage

sandbox-app (Cronus281)
  M0001 SandboxLogic:22    survived
  0 killed / 1 survived / 0 no-coverage

sandbox-hang (Cronus281)
  M0001 HangLogic:33       survived
  M0002 HangLogic:42       killed  CountUpToReachesTheLimit
        "CountUpTo(3) returned 4, expected 3"
  1 killed / 1 survived / 0 no-coverage
```

Both kill messages carry the arithmetic the pre-commitment predicted, not just the verdict. I4's is
the app's own guard text firing on a customer whose limit no longer short-circuits, and I7's names
the value **4**, the `0, 2, 4` walk §4 derived, so the kill is the mutation and not something else
that happened to fail.

### I6, the equivalent mutant, survived exactly as predicted

`Counter := 0` -> `1` is behaviourally identical here by arithmetic: from 0 the loop walks 1, 2, 3 and
from 1 it walks 2, 3, and both return 3. It came back `survived`, which is the right verdict and a
useless one, because **nothing in the report distinguishes it from I1, I2, I3 and I5**, which are
honest coverage gaps a reader should act on. All five are listed the same way under SURVIVORS BY
PROCEDURE.

This is not a defect in the operator, and no source-derived layer can refuse it: deciding that a
loop's start value does not change its result needs the loop's arithmetic, not its syntax. It is a
PRODUCT gap this operator makes routine rather than rare, and it is now filed as [[R172]]. 435 of
the 677 sites are assignments, so the shape recurs.

### The loop refusal has no live witness, and that is a build condition

The refusal that guards R164's 336 `until Rec.Next() = 0` sites did not fire once across the four
fixtures, because **none of them contains a loop condition with an integer literal in it**. The one
loop in all four (`until Counter >= Limit`) compares against a parameter, and would have been ceded
to `conditional-boundary` in any case.

So the refusal is proven by conformance and by the compile probe's `LoopExit`, and by nothing live.
That is precisely the shape R171 hit when `remove-not`'s corrected cession added zero sites
everywhere, and it was answered the same way: a fixture arm, so the refusal is exercised by a gate
rather than by a unit test alone.

### R121's screen could not be measured here either

Both kills were flagged, both suites raise through bare `Error(...)`, and the screen reported
**`vacuous`** on each. Same answer, same reason, as `toggle-blank-string`'s spike: not a finding
about this operator, and not a pass. `codeunit 79320 "Data Blank Ops"` is where that operator's
build settled the question, and this operator has **no site there**, its only `sandbox-data` sites
are the three in `Data Commit Ops`.

## Recommendation

**Build it**, with two conditions attached rather than deferred, both of them fixture arms in
`sandbox-data`:

1. **A loop-condition arm**, so the R164 refusal is proven live. Its load-bearing result is an
   ABSENCE, the site produces no mutant, which is the assertion `assertFilterLiteralEvidence`
   already makes for `flip-filter-literal`'s two refusal kinds, by procedure name.
2. **An assertion-raised kill**, so R121's screen SEPARATES on this operator instead of reporting
   `vacuous`. `Data Blank Ops` is the precedent and the natural home: it already carries the
   `Library Assert` half of the twin pair.

Everything else is settled: 677 marginal sites at 52x R13's bar with 0 overlap, both compile halves,
6 conformance cases including 4 refusals, and 7 of 7 live verdicts predicted.

**Landing cost**, all measured: `itest:tables` +3, `itest:hang` +2, `credit-limit` +1, and
`sandbox-app` +1, which moves `itest:bcdev`, `itest:alrunner` AND `itest:envtool` together.
gift-card has no site. Note that `itest:envtool`'s environment expired on 2026-08-26 and its
baseline is deliberately stale, so the build must either restore that environment or state plainly
that the third gate went unverified, it cannot quietly re-record.
