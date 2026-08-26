# R164 build: `loop-truncate`, every verdict pre-committed, in two stages

Written before either run. Design:
`docs/superpowers/specs/2026-08-26-r164-loop-truncate-design.md`. Nothing below is edited afterwards.

## 0. An amendment to the design's §6, made before running rather than after

§6 predicted `itest:hang` would go from 3 non-terminating mutants to **4** in stage 1 and back to
**3** in stage 2. That is wrong, and the reason is worth stating because it is the same fact that
shaped `shift-integer`'s build a few hours earlier.

**Any loop whose progress is arithmetic can be made non-terminating by an operator that touches that
arithmetic.** The arm's `Walked += 1` is deleted by `remove-assignment`, which strands the loop just
as surely as the negated exit does. So the arm necessarily adds TWO non-terminating mutants, not one,
and one of them survives the cession because it has nothing to do with the exit condition.

Corrected: **3 -> 5 in stage 1, 5 -> 4 in stage 2.** The claim that matters was never the total
anyway, and §6 said so in its own step 2: the assertion is the operator NAME at the arm's `until`
span. This amendment makes the totals agree with that.

## 1. The two stages, and why stage 1 has to happen first

**Stage 1**: `loop-truncate` registered, `negate-conditional` UNCHANGED. Both claim the arm's `until`
span, and both ship, because §3.2 dedup keys on replacement text.

The point of stage 1 is the one measurement the fix makes permanently unobservable: that
`until NextRow() <> 0` really does hang on this shape. Ceding without measuring it would mean
deleting 326 corpus mutants on reasoning alone, which §7 of the design lists as a refusal.

**Stage 2**: the cession lands. `negate-conditional` refuses a `repeat` exit condition; the mutant at
that span becomes `loop-truncate` and stops hanging.

## 2. `itest:hang`, stage 1 (before the cession): 9 mutants -> 23

The fixture gains `NextRow` and `WalkOneRow`, and every existing mutant shifts down two lines because
the arm adds two `var` declarations. Existing verdicts do not move.

| line | operator | predicted | why |
| ---: | --- | --- | --- |
| 34 | `empty-block` | killed | unchanged, was line 32 |
| 35 | `remove-assignment` | survived | unchanged, was 33. Equivalent: a fresh instance starts `Counter` at 0 |
| 35 | `shift-integer` | survived | unchanged, was 33. Equivalent by arithmetic |
| 37 | `void-method-call` | timeout-killed | unchanged, was 35 |
| 38 | `conditional-boundary` | killed | unchanged, was 36 |
| 39 | `return-value` | killed | unchanged, was 37 |
| 43 | `empty-block` | timeout-killed | unchanged, was 41 |
| 44 | `remove-assignment` | timeout-killed | unchanged, was 42 |
| 44 | `shift-integer` | killed | unchanged, was 42 |
| **38** | **`loop-truncate`** | **killed** | `CountUpTo(3)` advances once and returns 1, and the test expects 3. This is the operator's killability proof, and it needed no new fixture |
| **62** | `empty-block` | **survived** | `NextRow` emptied returns 0, so the walk exits after one row, which is the right answer for a one-row walk |
| **63** | `conditional-boundary` | **killed** | `Walked >= Rows` becomes `> Rows`, so the walk takes a second lap and returns 2 |
| **65** | `return-value` | **survived** | `exit(1)` is only reached while rows remain, and a one-row walk never reaches it. Covered but unreached, not no-coverage |
| **69** | `empty-block` | **killed** | `WalkOneRow` emptied returns 0, the test expects 1 |
| **70** | `remove-assignment` | **survived** | deleting `Rows := 1` leaves 0 on a fresh instance, and `Walked >= 0` is true at once, so the walk still returns 1 |
| **70** | `shift-integer` | **killed** | `Rows := 2` takes a second lap, returns 2 |
| **71** | `remove-assignment` | **survived** | deleting `Walked := 0` leaves 0 on a fresh instance |
| **71** | `shift-integer` | **killed** | `Walked := 1` means the walk returns 2 |
| **73** | `remove-assignment` | **timeout-killed** | deleting `Walked += 1` removes the loop's only progress. THE SECOND HANG, and it is not the exit condition's, which is why it survives stage 2 |
| **73** | `shift-integer` | **killed** | `Walked += 2` overshoots and returns 2 |
| **74** | **`loop-truncate`** | **survived** | THE DOCUMENTED EQUIVALENT. Truncating a one-iteration loop to one iteration changes nothing, and the operator's doc comment says so before the verdict arrives |
| **74** | **`negate-conditional`** | **timeout-killed** | **THE MEASUREMENT.** `NextRow()` returns 0 forever once exhausted, so `<> 0` is false forever |
| **75** | `return-value` | **killed** | returns 0, the test expects 1 |

Stage 1 ON-leg totals: **killed 11 / timeout-killed 5 / survived 7**, 23 mutants.

## 3. `itest:hang`, stage 2 (after the cession): 23 mutants -> 22

Exactly one row leaves: **line 74 `negate-conditional`**. Nothing else moves, on any line.

Stage 2 ON-leg totals: **killed 11 / timeout-killed 4 / survived 7**, 22 mutants.

The load-bearing assertion is per-mutant and not the total: at line 74 there must be exactly ONE
mutant and its operator must be `lethal.loop-truncate`. A cession that was too broad would also
remove line 38's `conditional-boundary` or the `negate-conditional` mutants elsewhere in the
codebase; a cession that was too narrow would leave two mutants at line 74. Both are operator-NAME
changes the per-mutant baseline catches, and a matching total would not.

## 4. The other gates

| gate | change | predicted |
| --- | --- | --- |
| `itest:tables` | none. `sandbox-data` has **0** `repeat` loops, measured | UNCHANGED at 267/63/15 over 345 |
| `itest:bcdev` | none. `sandbox-app` has 0 | UNCHANGED at 3/12/4 |
| `itest:alrunner` | none | UNCHANGED at 3/16/0 |
| `itest:envtool` | none | UNCHANGED (still unverified for the reasons already recorded) |
| credit-limit demo | none. 0 `repeat` loops | UNCHANGED at 42, 23/8/11 |
| gift-card demo | ONE site, `Gift Card Mgt.BlockExpiredCards:68`, `GiftCard.Next() = 0` | count UNCHANGED; the mutant's OPERATOR changes from `negate-conditional` to `loop-truncate`, verdict stays **no-coverage** because no test calls that nightly job |

gift-card is the second cession witness and the more interesting one: it is the CANONICAL shape, on a
real recordset, and the change there is visible only as an operator name. A gate that compared totals
would report it as unchanged.

## 5. Corpus effect, measured

334 `loop-truncate` sites on `do-rel2/Cloud`, with **326** exact-span `negate-conditional` collisions
that the cession removes. Net **+8 mutants**, and 326 potential strandings become mutants that cannot
hang. Five exact-span collisions remain and are deliberately kept: `remove-not` 3,
`conditional-boundary` 2.

## 6. What would refuse the build

- Line 74's `negate-conditional` NOT coming back `timeout-killed` in stage 1. Then this shape does
  not hang, the arm is not R164's hazard, and the cession has no measurement behind it.
- Line 74 carrying anything but exactly one `lethal.loop-truncate` mutant in stage 2.
- Line 38's `conditional-boundary` disappearing: the cession is too broad and has deleted a working,
  terminating, killed mutant.
- Line 38's `loop-truncate` surviving: the operator does not do what it claims, on the one loop here
  whose test drives more than one iteration.
- Any of the nine existing verdicts moving.

---

## OUTCOME, appended after both runs. Nothing above is edited.

**Every verdict in both stages matched, including the amended totals.**

### Stage 1, before the cession: 23 mutants, killed 11 / survived 7 / timeout-killed 5

```
M0006  HangLogic:38  lethal.loop-truncate       killed          CountUpToReachesTheLimit
M0011  HangLogic:62  lethal.empty-block         survived
M0012  HangLogic:63  lethal.conditional-boundary killed         WalkOneRowVisitsExactlyOneRow
M0013  HangLogic:65  lethal.return-value        survived
M0014  HangLogic:69  lethal.empty-block         killed          WalkOneRowVisitsExactlyOneRow
M0015  HangLogic:70  lethal.remove-assignment   survived
M0016  HangLogic:70  lethal.shift-integer       killed          WalkOneRowVisitsExactlyOneRow
M0017  HangLogic:71  lethal.remove-assignment   survived
M0018  HangLogic:71  lethal.shift-integer       killed          WalkOneRowVisitsExactlyOneRow
M0019  HangLogic:73  lethal.remove-assignment   timeout-killed  WalkOneRowVisitsExactlyOneRow
M0020  HangLogic:73  lethal.shift-integer       killed          WalkOneRowVisitsExactlyOneRow
M0021  HangLogic:74  lethal.loop-truncate       survived
M0022  HangLogic:74  lethal.negate-conditional  timeout-killed  WalkOneRowVisitsExactlyOneRow   <-- THE MEASUREMENT
M0023  HangLogic:75  lethal.return-value        killed          WalkOneRowVisitsExactlyOneRow
```

**M0022 is why this build exists.** R164 recorded that no gate had ever EXECUTED an until-position
`negate-conditional` mutant, so the non-termination behind 292 canonical corpus sites had been
measured on a real corpus and never once observed in this repository. It has now been observed, and
the cession that follows rests on a measurement rather than on the argument that produced it.

### Stage 2, after the cession: 22 mutants, killed 11 / survived 7 / timeout-killed 4

Diffed programmatically against stage 1:

```
REMOVED : (74, lethal.negate-conditional)
ADDED   : none
MOVED   : none
line 38 : lethal.conditional-boundary, lethal.loop-truncate     <-- the control, both still there
line 74 : lethal.loop-truncate                                  <-- exactly one, and it cannot hang
```

A cession one step too broad would have taken line 38's `conditional-boundary` with it; one step too
narrow would have left two mutants at line 74. Neither happened, and neither would have shown up in a
total.

### The gates

| gate | result |
| --- | --- |
| `itest:hang` | **PASS**, both legs, 22 mutants |
| `itest:tables` | **PASS**, unchanged at 267/63/15 over 345 |
| `itest:bcdev` | **PASS**, unchanged at 3/12/4 |
| gift-card demo | re-frozen at 60, 34/15/11, **69.4%**, unchanged |

`itest:tables` and `itest:bcdev` were run rather than reasoned about, because the cession changes a
Tier-1 operator that ships everywhere and a bug in its guard would silently DELETE
`negate-conditional` mutants from fixtures that have no loops at all. They did not move.

### gift-card is the second cession witness, and the better one

It carries the canonical shape on a REAL recordset, in a procedure no test calls. The re-run is
identical in every way a total could measure, 60 mutants and 69.4%, and the per-mutant diff shows the
one thing that changed:

```
only in old : a04daf56…|Gift Card Mgt|BlockExpiredCards|lethal.negate-conditional|1
only in new : a04daf56…|Gift Card Mgt|BlockExpiredCards|lethal.loop-truncate|1     no-coverage
```

Same `astSubtreeHash`, same span, same verdict, different operator. A gate comparing counts would
have reported this as "no change".

### Corpus effect, measured before and after

334 `loop-truncate` sites on `do-rel2/Cloud`. Exact-span collisions fell from **331 to 5**
(`negate-conditional` 326 -> 0, `remove-not` 3, `conditional-boundary` 2). Net **+8 mutants**, and
326 potential strandings became mutants that cannot hang.

### One correction the runs forced, and it was made before running

§0 amended the design's predicted non-terminating counts from 3 -> 4 -> 3 to **3 -> 5 -> 4**. Any
loop whose progress is arithmetic can be stranded by an operator that touches that arithmetic, so the
arm's `Walked += 1` deletion hangs too and no cession at the exit condition can help it. That is the
same fact that decided `shift-integer`'s build earlier the same day, and it is now stated in the
gate's own count assertion rather than left as a number.

### What is NOT fixed, and it is filed rather than glossed

The cession is exact-span and covers only `negate-conditional`. Still hang-capable in principle:
19 claims at `repeat` exit conditions (`conditional-boundary` 8, `remove-not` 8,
`toggle-blank-string` 3), 37 at `while` conditions, and 1 nested comparison inside a bigger `repeat`
condition. Recorded as its own roadmap row with these numbers.
