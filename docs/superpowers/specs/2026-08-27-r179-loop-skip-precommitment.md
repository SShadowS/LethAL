# R179 build: `loop-skip`, every verdict pre-committed, in two stages

Written before either run. Nothing above the OUTCOME line is edited afterwards.

## 0. The ruling this build required, made explicitly rather than by shipping

`loop-skip` is a **hazard** candidate, and R13's bar was calibrated for a **coverage** one.

- On coverage it FAILS: 33 `while` loops on `do-rel2/Cloud`, `empty-block` already claims the body at
  28 of them, so 5 are marginal against a bar of 13.
- On hazard it PASSES: at **19** of those 28 the existing `empty-block` mutant cannot terminate,
  because a `while` loop's body is what advances its condition (it must be, or the original would
  never end), so emptying the body freezes the condition forever.

**Ruling: a candidate that replaces a non-terminating mutant with a terminating one is judged on
hazards removed, not on marginal sites.** By construction it adds little coverage, so the coverage
bar would refuse it precisely because it does its job. R164 accepted `loop-truncate` on the same
grounds; there the raw count was 334, so the question never had to be asked out loud.

This ruling is the reviewable part of this build. If it is wrong, nothing below should land.

## 1. The cession is POSITIONAL, not conditional

`empty-block` refuses a block whose parent is a `while_statement`. Full stop, no inspection of
whether that particular body advances that particular condition.

The precise rule would be "refuse where the body drives the condition", and that is an inference
about VALUES. This codebase has been burned by exactly that class of reasoning as recently as R175,
where a premise about what BC would do was encoded in the code AND in the test pinning it. A
positional rule is checkable by reading the parent node.

Cost of the coarser rule: at the 9 `while` bodies where `empty-block` currently terminates, its
mutant is replaced by `loop-skip`'s, which asks nearly the same question. Corpus effect: 28
`empty-block` mutants leave, 33 `loop-skip` mutants arrive, 19 hangs go with them.

**`repeat` is NOT ceded.** A `repeat` body always runs once, so `until true` does not remove its
effect and `loop-truncate` is not a substitute. The 6 frozen `repeat` bodies measured on the corpus
stay, and stay recorded on R179.

## 2. The arm

`Hang Logic.DrainQueue`, a `while` loop whose body advances its own condition, in `sandbox-hang`
because R164 already ruled that a hang-capable site belongs nowhere near a scored gate.

```al
Pending := Depth;
while Pending > 0 do begin
    Pending -= 1;
    Drained += 1;
end;
exit(Drained);
```

Its `conditional-boundary` mutant is the CONTROL and is the reason this arm is worth more than one
measurement. `>` becomes `>=`, which is [[R173]]'s exact hazardous shape, and here it TERMINATES:
`Pending` reaches 0, takes one extra lap, reaches -1 and the test fails. R173's 7 hazardous sites are
all `StrPos(...) > 0`, where the value cannot go below 0. Same syntax, opposite outcome, which is
precisely why R173 must not cede on syntax alone.

## 3. `itest:hang`, stage 1 (loop-skip registered, `empty-block` UNCHANGED): 22 -> 32

The existing 22 do not move. The ten new ones:

| line | operator | predicted | why |
| ---: | --- | --- | --- |
| 101 | `empty-block` | **killed** | the PROCEDURE body, not the loop's; returns 0 against a test expecting 3 |
| 102 | `remove-assignment` | **killed** | `Pending := Depth` deleted leaves 0, the loop never runs, `Drained` is 0 |
| 103 | **`loop-skip`** | **killed** | `while false`: body never runs, `Drained` is 0 |
| 103 | `conditional-boundary` | **killed** | THE CONTROL. `>=` takes one extra lap and returns 4, and it TERMINATES |
| 103 | **`empty-block`** | **timeout-killed** | **THE MEASUREMENT.** The loop BODY emptied, so `Pending` never decrements and `Pending > 0` is true forever |
| 104 | `remove-assignment` | **timeout-killed** | `Pending -= 1` deleted: same freeze, reached by a different operator, and NOT ceded |
| 104 | `shift-integer` | **killed** | `-= 2` walks 3,1,-1 and returns 2 |
| 105 | `remove-assignment` | **killed** | `Drained += 1` deleted returns 0 |
| 105 | `shift-integer` | **killed** | `+= 2` returns 6 |
| 107 | `return-value` | **killed** | returns 0 |

Stage 1 ON-leg totals: **killed 19 / timeout-killed 6 / survived 7**, 32 mutants.

## 4. `itest:hang`, stage 2 (the cession lands): 32 -> 31

Exactly one row leaves: **line 103 `empty-block`**. Nothing else moves.

Stage 2 ON-leg totals: **killed 19 / timeout-killed 5 / survived 7**, 31 mutants.

Line 104's `remove-assignment` timeout REMAINS, and that is the point of listing it: the cession is
about the loop's BODY BLOCK, not about every way to freeze a loop. A cession that removed it too
would be reaching beyond its evidence.

## 5. The other gates

`itest:tables`, `itest:bcdev`, `itest:alrunner`, credit-limit and gift-card are all UNCHANGED.
Measured: **no fixture except `sandbox-hang` contains a `while` loop at all** (the seven `while`
tokens in `sandbox-data` are the English word inside comments), so neither the new operator nor the
cession can reach them.

## 6. What would refuse the build

- Line 103's `empty-block` NOT coming back `timeout-killed` in stage 1. Then a `while` body emptied
  does not freeze this loop, the arm is not the hazard, and the cession rests on reasoning.
- Line 103 carrying anything but exactly one `lethal.loop-skip` mutant in stage 2.
- Line 101's `empty-block` disappearing: the cession has reached the procedure body, which is not a
  loop body and is not its business.
- Line 104's `remove-assignment` timeout disappearing: the cession has reached beyond the block.
- Line 103's `conditional-boundary` coming back `timeout-killed`: then `>` to `>=` strands even a
  decrementing counter, R173's residual is larger than measured, and that row needs reopening before
  this one lands.

---

## OUTCOME, appended after both runs. Nothing above is edited.

**Nine of ten matched, in both stages, and the one miss has a measured cause.**

### Stage 1, before the cession: 32 mutants, killed 20 / survived 7 / timeout-killed 5

```
M0023  HangLogic:101  empty-block           killed          (procedure body)
M0024  HangLogic:102  remove-assignment     killed
M0025  HangLogic:103  conditional-boundary  killed          <- THE CONTROL, and it TERMINATES
M0026  HangLogic:103  loop-skip             killed
M0027  HangLogic:103  empty-block           timeout-killed  <- THE MEASUREMENT
M0028  HangLogic:104  remove-assignment     killed          <- PREDICTED timeout-killed
M0029  HangLogic:104  shift-integer         killed
M0030  HangLogic:105  remove-assignment     killed
M0031  HangLogic:105  shift-integer         killed
M0032  HangLogic:107  return-value          killed
```

**M0027 is why this build exists.** `empty-block` on a `while` body ran the full 20 s budget and was
stopped server-side. The hazard R179 measured statically at 19 corpus sites is now OBSERVED, on a
shape this repository runs, before the fix made it unobservable.

### The miss: M0028, and the mechanism was right while the outcome was not

Predicted `timeout-killed`, measured **`killed` in 4.4 s**, and BC says why:

```
Arithmetic operation resulted in an overflow.
Hang Logic(CodeUnit 79400).DrainQueue line 36
```

Deleting `Pending -= 1` freezes the condition exactly as predicted. What was wrong is the conclusion
that a frozen loop must strand: the surviving `Drained += 1` keeps accumulating and overflows Int32
in about four seconds, so the loop terminates by ARITHMETIC rather than by the budget.

**This does not weaken R179's count.** That measurement is `empty-block`-specific, and `empty-block`
empties the WHOLE body, so nothing is left to accumulate. M0027 running the full 20 s beside M0028
finishing in 4.4 s is the two cases separating on the same loop, which is better evidence than either
alone.

Worth carrying forward: **a frozen loop only strands when nothing inside it accumulates.** Every
"this mutant will hang" prediction in this repository should now be checked against that.

### Stage 2, after the cession: 31 mutants, killed 20 / survived 7 / timeout-killed 4

Diffed programmatically against stage 1:

```
REMOVED : (103, lethal.empty-block)
ADDED   : none
MOVED   : none
line 101 : lethal.empty-block            <- the PROCEDURE body, untouched: the cession did not overreach
line 103 : lethal.conditional-boundary, lethal.loop-skip
line 104 : remove-assignment killed, shift-integer killed
```

Every refusal condition in §6 held. The non-terminating count returns to **4**, its value before this
build: the arm added a fifth and the cession removed it.

### Gates

`itest:hang` **PASS** at 31 mutants. `itest:tables` and `itest:bcdev` **PASS unchanged** — run rather
than reasoned about, because `empty-block` ships everywhere and a cession that reached beyond a
`while` body would have deleted mutants from fixtures that have no loops at all. 2590 unit tests.
