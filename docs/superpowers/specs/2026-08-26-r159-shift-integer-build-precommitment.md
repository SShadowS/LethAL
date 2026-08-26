# R159 build: `shift-integer`, every new verdict, pre-committed

Written before any gate ran. Nothing below is edited afterwards; the outcome is appended.

Spike: `docs/superpowers/specs/2026-08-26-r159-shift-integer-spike.md` (677 marginal sites, both
compile halves, 6 conformance cases, 7 of 7 live verdicts predicted).

## 1. Two corrections to the spike's own recommendation

The spike attached two conditions and put both in `sandbox-data`. One of them was in the wrong place
and the reason matters more than the correction.

**The loop-condition witness does NOT go in a scored gate, and gets no live arm at all.** [[R164]]
already ruled on this: a hang-capable site belongs in `fixtures/sandbox-hang`, which exists so the
other gates never pay for one. Checking whether a *safe* covered loop could be built instead, there
is none, a loop whose exit depends on a counter is turned non-terminating by `remove-assignment`,
by `swap-additive`, and by **`shift-integer` itself** (`Seen += 1` -> `+= 2` walks 2, 4, 6 past an
`= 3` exit). Every operator that can reach the counter can hang it.

And the arm would buy nothing, because a refusal produces NO MUTANT: the server never runs one
either way, so a live run observes exactly what an offline enumeration does. The proof is therefore
`packages/builtin-tier1/tests/shift-integer.test.ts`, against real AL, asserted POSITIONALLY, the
literal in the loop's exit condition refused, the one in its body still claimed, so a whole-loop
refusal fails the test too. Red-checked: deleting the `inLoopCondition` call turns it red.

**The assertion-screen witness DOES need a live arm**, because R121's screen reads failure TEXT that
only a real BC error produces. `codeunit 79325 "Data Shift Ops"`, below.

## 2. The arm: a twin pair that happens to control four operators

`Data Shift Ops` follows R132's device and `Data Blank Ops`'s precedent: two procedures identical in
shape, whose covering tests differ in nothing but how they raise. It turned out to carry more than
intended, the shape produces FOUR mutants per half, so the pair is a control across four operators
at once, not just this one:

```al
procedure BandedViaAssert(Amount: Integer): Integer   // killed via Library Assert
begin
    if Amount = 10 then
        exit(1);
    exit(0);
end;
procedure BandedViaError(Amount: Integer): Integer    // killed via bare Error(...)
```

## 3. `itest:tables`, 11 new mutants, 334 -> 345 deployed (354 -> 365 raw)

Inventory taken through the real pipeline (`--dry-run` reports `DataShiftOps sites=8 deployed=8`),
so no §3.2 displacement is hiding in it.

| # | site | operator | predicted | screen |
| --- | --- | --- | --- | --- |
| T1 | `Data Commit Ops.CommitThenFail:37` | `shift-integer` `5`->`6` | **survived** |, |
| T2 | `CommitThenRun:51` | `shift-integer` `7`->`8` | **survived** |, |
| T3 | `CommitThenRunValueForm:88` | `shift-integer` `9`->`10` | **survived** |, |
| T4 | `BandedViaAssert:37` | `empty-block` | **killed** `ShiftKillIsAssertionEarned` | NOT flagged |
| T5 | `BandedViaAssert:38` | `negate-conditional` | **killed** same | NOT flagged |
| T6 | `BandedViaAssert:38` | `shift-integer` `10`->`11` | **killed** same | NOT flagged |
| T7 | `BandedViaAssert:39` | `return-value` | **killed** same | NOT flagged |
| T8 | `BandedViaError:45` | `empty-block` | **killed** `ShiftKillIsBareErrorRaised` | FLAGGED |
| T9 | `BandedViaError:46` | `negate-conditional` | **killed** same | FLAGGED |
| T10 | `BandedViaError:46` | `shift-integer` `10`->`11` | **killed** same | FLAGGED |
| T11 | `BandedViaError:47` | `return-value` | **killed** same | FLAGGED |

T1-T3 are the spike's measured survivors: the commit tests assert the row exists and that `Flagged`
is set, and never read `Amount`. `remove-assignment` and `toggle-blank-string` both survive the same
three arms.

Every mutant of the pair kills, for the same reason in both halves, the mutated procedure returns 0
where 1 is expected, whether the body was emptied, the comparison negated, the constant shifted or
the return replaced. **The verdicts are therefore a control and the only variable is the screen.**

New totals: **killed 267 / survived 63 / no-coverage 15 over 345** (365 raw), score
0.8119 -> **0.8091**. Baseline tests 58 -> 60, still with exactly ONE expected failure,
`Data Tests.PageActionComputesNonZero`. `declarativeSites` unchanged at 1 site in 1 file.
`assertionScreen.discrimination` stays **`partial`**.

## 4. The other four gates

| gate | new mutant | predicted | frozen -> new |
| --- | --- | --- | --- |
| `itest:bcdev` | `Sandbox Logic.LogAudit:22` `0`->`1` | **survived** | 3/11/4 -> **3/12/4** |
| `itest:alrunner` | same site | **survived** | 3/15/0 -> **3/16/0** |
| `itest:envtool` | same site | **survived** | 3/11/4 -> **3/12/4** |
| `itest:hang` | `Hang Logic.CountUpTo:33` `0`->`1` | **survived** | 7 -> **9** mutants |
| `itest:hang` | `Advance:42` `1`->`2` | **killed** `CountUpToReachesTheLimit` | 3 non-terminating, UNCHANGED |
| credit-limit demo | `WouldExceedLimit:33` `0`->`1` | **killed** `NoCreditLimitMeansNoBlock` | 41 -> **42**, 22/8/11 -> **23/8/11**, 73.3% -> **74.2%** |
| gift-card demo | none |, | 60 at 69.4%, UNCHANGED |

`itest:bcdev` keeps `assertionScreen.discrimination: vacuous`, a survivor adds no kill for the
screen to see.

**`itest:hang` line 33 now carries two equivalent mutants side by side**, and the gate should read
that way: `remove-assignment` already survives there (a codeunit `Integer` global is 0 on a fresh
instance, so deleting the initialiser changes nothing) and `shift-integer` joins it (from 1 the loop
walks 2, 3 instead of 1, 2, 3, and still returns 3). Two operators, one site, both honest survivors,
neither distinguishable in the report from a real coverage gap. That is [[R172]] with a second
witness, filed by this operator's spike.

**`itest:envtool` cannot be verified.** Its environment expired and was deleted 2026-08-26 and its
committed baseline is already STALE from R159's previous operator. This build makes that a SECOND
unreviewed number on the same gate. The constants are updated to the prediction above and the gate
is declared UNVERIFIED rather than quietly re-recorded, if the environment is restored, the run
must name the two accumulated mutants, not re-freeze whatever it finds.

## 5. What would refuse the build

- Any T4-T11 verdict that is not `killed`: the pair stops being a control and the screen evidence
  is worthless, because a difference in screen outcome could then be a difference in verdict.
- Any T4-T7 kill FLAGGED, or any T8-T11 kill NOT flagged: the screen is reading something other
  than the assertion style, which is the one thing this arm exists to isolate.
- The `itest:hang` non-terminating count moving off 3: this operator must not create a hang, and
  the loop cession is what stops it.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**All 16 new verdicts matched, on five gates, with ZERO existing mutants moving.**

| gate | result | new mutants |
| --- | --- | --- |
| `itest:tables` | **PASS** 267/63/15 over 345 (365 raw), score 0.8091 | 11, all as predicted |
| `itest:bcdev` | **PASS** 3/12/4 | 1 survived |
| `itest:alrunner` | **PASS** 3/16/0, al-runner v2.3.1.0 | 1 survived, same identity key and verdict as bcdev |
| `itest:hang` | **PASS** killed 4 / timeout-killed 3 / survived 2 | 2, one survived and one killed |
| credit-limit demo | re-frozen at **42**, 23/8/11, **74.2%** | 1 killed |
| `itest:envtool` | NOT RUN, see below | 1, inferred |

Per-mutant baselines were re-recorded for tables, bcdev and al-runner. Every diff was checked before
committing: **0 changed, 0 removed**, only the predicted additions.

### The twin pair separated in both directions, across all four operators

```
BandedViaAssert  empty-block / negate-conditional / shift-integer / return-value
                 all killed by ShiftKillIsAssertionEarned   -> screen did NOT flag
BandedViaError   the same four operators, same shape
                 all killed by ShiftKillIsBareErrorRaised   -> screen FLAGGED all four
```

The killing tests came back exactly as split, which is the part a count could not show: eight kills,
one difference, and it is the one the arm was built to isolate.

### An unplanned result: this is the first live proof R166 was load-bearing

The two halves are byte-identical in shape, so each operator's pair shares an `astSubtreeHash`
exactly:

```
463500c9…|Data Shift Ops|BandedViaAssert|lethal.empty-block|1
463500c9…|Data Shift Ops|BandedViaError |lethal.empty-block|1
```

Four such pairs, separated by nothing but `procedureName`. Before R166 added it to the identity key
this arm could not have been built at all: four pairs of colliding identities would have collapsed,
and the baseline would have recorded half of them. R166 was landed on reasoning about guard
deletions; this is the first fixture that would have broken without it.

### The loop cession held where it mattered

`itest:hang`'s non-terminating count stayed at **3** while this operator put two mutants into that
very fixture, one of them inside the loop. That assertion now carries the cession's name, so a future
regression that let a loop-exit condition through would fail there rather than by hanging a run.

### `sandbox-hang` line 33 now carries two equivalent mutants side by side

`remove-assignment` (deleting `Counter := 0`, which a fresh codeunit instance defaults to anyway) and
`shift-integer` (shifting it to 1, from which the loop still returns 3). Two operators, one
statement, both honest survivors, and the report distinguishes neither from a real coverage gap.
That is [[R172]] with its second witness and its cleanest example.

### `itest:envtool` was NOT run, deliberately and on the record

Its environment expired and was deleted 2026-08-26, and its constants were already carrying one
unreviewed move from R159's previous operator. This build makes two. The gate's constants are set to
the prediction, the `!!` block at the top of `EXPECTED` now says so at length, and the next run must
confirm BOTH accumulated mutants by name against `itest:bcdev` rather than re-freezing whatever it
finds. Two stacked unverified numbers is the point at which a baseline stops being evidence, and
saying so is the honest result rather than letting the figure look measured.

### One thing found on the way that is not about this operator

`packages/runner/tests/publish-ceiling.test.ts` generates a fixture of an exact mutant count from two
procedure shapes whose yields it MEASURES. Registering this operator took the small shape's yield
from 2 to 3, equal to the big one's, and `measureShapeYields` refused with both numbers in the
message instead of quietly building a mis-sized file and failing eleven tests elsewhere. That
safeguard was added when `remove-assignment` broke the same generator, with a comment promising
exactly this; it kept the promise on the first try. The fix was to the SHAPE, which no longer
contains a literal at all, rather than to a constant.
