# Pre-commitment: `fixtures/sandbox-harden`'s first live run

Written before any live run, from the offline dry run
(`.superpowers/sdd/2026-09-25-C02-03-harden-fixture/dry-run-task1.txt`) and the pre-committed table
in `packages/runner/itest/harden-expected.ts` (the `EXPECTED` array, committed in `6661f13`). This
file states the same rows as that module, row for row, plus the reasoning the module does not carry.
Nothing above the OUTCOME line is edited afterwards.

Plan: `.superpowers\sdd\2026-09-25-C02-03-harden-fixture\plan.md`, Decisions 1 to 9 and "The five
planted survivors". Fixtures: `fixtures/sandbox-harden` (target, `codeunit 79500 "Harden Logic"` +
`table 79501 "Harden Entry"`, id range 79500-79549), `fixtures/sandbox-harden-tests`
(`codeunit 79550 "Harden Tests"`, id range 79550-79574), `fixtures/sandbox-harden-answers`
(`codeunit 79575 "Harden Answer Key"`, id range 79575-79599). Mark:
`fixtures/sandbox-harden/lethal.equivalent.json`.

## 1. Leg A, every mutant, the final `EXPECTED` table

`lethal run --project fixtures/sandbox-harden --tests fixtures/sandbox-harden-tests`. The dry run
found 2 files, 22 raw mutant sites, 21 deployed, 1 batch. The one raw site that does not deploy is
`HardenLogic.Codeunit.al:14`'s `lethal.void-method-call` on `Entry.SetRange(...)`: `remove-setrange`
(Tier 2, AL-specific) displaces it at the same span under section 3.2 dedup, so it is not a row
below and not part of the 21. `HardenLogic.Codeunit.al:25`'s `exit(0)` also gets no mutant:
`return-value` skips a zero result and `shift-integer` claims only a literal directly in an
assignment or an equality comparison, neither of which this is.

| # | file | line | operator | scope | predicted verdict | killer (by name) |
|---|---|---:|---|---|---|---|
| 1 | HardenLogic.Codeunit.al | 5 | `lethal.empty-block` | `IsLarge` | killed | `IsLargeSeparatesSmallFromLarge` |
| 2 | HardenLogic.Codeunit.al | 6 | `lethal.conditional-boundary` (`>` to `>=`) | `IsLarge` | **survived (S1)** | |
| 3 | HardenLogic.Codeunit.al | 6 | `lethal.return-value` | `IsLarge` | killed | `IsLargeSeparatesSmallFromLarge` |
| 4 | HardenLogic.Codeunit.al | 13 | `lethal.empty-block` | `CountInCategory` | killed | `CountInCategoryCountsRows` |
| 5 | HardenLogic.Codeunit.al | 14 | `lethal.remove-setrange` | `CountInCategory` | **survived (S2)** | |
| 6 | HardenLogic.Codeunit.al | 15 | `lethal.return-value` | `CountInCategory` | killed | `CountInCategoryCountsRows` |
| 7 | HardenLogic.Codeunit.al | 22 | `lethal.empty-block` | `FirstAmount` | killed | `FirstAmountReadsARow` |
| 8 | HardenLogic.Codeunit.al | 23 | `lethal.negate-guard` | `FirstAmount` | killed | `FirstAmountReadsARow` |
| 9 | HardenLogic.Codeunit.al | 23 | `lethal.swap-find-direction` (`FindFirst` to `FindLast`) | `FirstAmount` | **survived (S3)** | |
| 10 | HardenLogic.Codeunit.al | 24 | `lethal.return-value` | `FirstAmount` | killed | `FirstAmountReadsARow` |
| 11 | HardenLogic.Codeunit.al | 30 | `lethal.empty-block` | `SetAmount` | killed | `SetAmountStoresTheAmount` |
| 12 | HardenLogic.Codeunit.al | 31 | `lethal.void-method-call` | `SetAmount` | killed | `SetAmountStoresTheAmount` |
| 13 | HardenLogic.Codeunit.al | 31 | `lethal.validate-to-assign` | `SetAmount` | **survived (S4)** | |
| 14 | HardenLogic.Codeunit.al | 39 | `lethal.empty-block` | `BonusFor` | killed | `BonusForPaysOnlyAboveTen` |
| 15 | HardenLogic.Codeunit.al | 40 | `lethal.remove-assignment` (`Bonus := 0`) | `BonusFor` | **survived (S5)** | |
| 16 | HardenLogic.Codeunit.al | 40 | `lethal.shift-integer` | `BonusFor` | killed | `BonusForPaysOnlyAboveTen` |
| 17 | HardenLogic.Codeunit.al | 41 | `lethal.conditional-boundary` | `BonusFor` | killed | `BonusForPaysOnlyAboveTen` |
| 18 | HardenLogic.Codeunit.al | 42 | `lethal.remove-assignment` (`Bonus := Amount`) | `BonusFor` | killed | `BonusForPaysOnlyAboveTen` |
| 19 | HardenLogic.Codeunit.al | 43 | `lethal.return-value` | `BonusFor` | killed | `BonusForPaysOnlyAboveTen` |
| 20 | HardenEntry.Table.al | 12 | `lethal.empty-block` | `OnValidate` (trigger, `Amount`) | killed | `AmountValidateDoublesIt` |
| 21 | HardenEntry.Table.al | 13 | `lethal.remove-assignment` (`Doubled := Amount * 2`) | `OnValidate` (trigger, `Amount`) | killed | `AmountValidateDoublesIt` |

Row 12 (`void-method-call` on `Entry.Validate(...)`) and row 13 (`validate-to-assign` on the same
call) both deploy at the same line: dedup keys on replacement text, and `validate-to-assign`'s is
never empty, so the two coexist rather than one displacing the other.

## 2. The five survivors

**S1** (`IsLarge`, `lethal.conditional-boundary`, `>` to `>=`, line 6). The base test
(`IsLargeSeparatesSmallFromLarge`) calls `IsLarge(500)` and `IsLarge(50)`, never exactly `100`, so
moving the boundary by one changes neither result. Answer-key killer: `IsLargeAtTheBoundary` calls
`IsLarge(100)` and requires `false`; under the mutant `100 >= 100` is `true`, so it fails and kills.

**S2** (`CountInCategory`, `lethal.remove-setrange`, line 14). The base test
(`CountInCategoryCountsRows`) inserts two rows, both category `A`, and asks for `A`: every row is
already in the wanted category, so deleting the filter changes nothing. Answer-key killer:
`CountInCategoryIgnoresOtherCategories` inserts two `A` rows and one `B` row and requires
`CountInCategory('A') = 2`; under the mutant the unfiltered count is 3, so it fails and kills.

**S3** (`FirstAmount`, `lethal.swap-find-direction`, `FindFirst` to `FindLast`, line 23). The base
test (`FirstAmountReadsARow`) inserts exactly one row (`Amount = 7`), so the first row and the last
row are the same row and the swap is invisible. Answer-key killer: `FirstAmountReadsTheFirstRow`
inserts row 1 (`Amount = 7`) then row 2 (`Amount = 9`) and requires the result to be `7`; under the
mutant `FindLast` returns row 2's `9`, so it fails and kills.

**S4** (`SetAmount`, `lethal.validate-to-assign`, line 31). The base test
(`SetAmountStoresTheAmount`) reads only `Entry.Amount` after the call, never `Entry.Doubled`, which
is what `OnValidate` sets; assigning `Amount` directly instead of validating it still leaves `Amount`
at 5, so the test cannot tell. Answer-key killer: `SetAmountRunsValidation` calls
`SetAmount(Entry, 5)` and requires `Entry.Doubled = 10`; under the mutant `OnValidate` never runs, so
`Doubled` stays 0 and it fails and kills.

**S5** (`BonusFor`, `lethal.remove-assignment` on `Bonus := 0`, line 40). This one is EQUIVALENT, not
merely untested, and no test can kill it:

`Bonus` is declared `var Bonus: Integer` local to `BonusFor` (line 38). AL gives every local variable
its type's default value (0 for `Integer`) on each call, before the first statement runs. `Bonus :=
0` is that first statement, and nothing in the procedure reads `Bonus` before it runs. So at the
point right after line 40 executes (or would have executed), `Bonus` holds 0 either way, on every
input, every table state, and every call order. From there the procedure only conditionally
overwrites `Bonus` with `Amount` (line 41-42) and returns it (line 43); it touches no other state.
No test, however it calls `BonusFor`, can observe a difference between the mutated and unmutated
procedure.

Two things would break this claim, and the fixture avoids both on purpose:

1. **If `Bonus` were a codeunit GLOBAL instead of a local**, a second call on the same codeunit
   instance would start from whatever the previous call left in `Bonus`, and the mutant would become
   killable, exactly as `sandbox-hang`'s `Counter := 0` is equivalent only per fresh instance (the
   `CountUpTo` rows in `hang.itest.ts`).
2. **If any statement read `Bonus` before `Bonus := 0` ran**, the local's default would be
   observable and the deletion would change behaviour.

Neither holds in `BonusFor`: `Bonus` is local, and the first read of `Bonus` is line 41's
`if Amount > 10 then Bonus := Amount`, which does not read `Bonus`'s own value, only `Amount`'s.

**The repeat-call measurement.** The base test, `BonusForPaysOnlyAboveTen`, deliberately calls
`BonusFor` three times on ONE `Codeunit "Harden Logic"` instance: `BonusFor(11)` (expect 11),
`BonusFor(10)` (expect 0), `BonusFor(5)` (expect 0). This sequence is the base suite's own check
against condition 1: if AL carried a local across calls on the same instance, the second call would
inherit 11 from the first call's `Bonus := Amount`, and `BonusFor(10)` would return 11 instead of 0,
failing the test and killing the mutant regardless of whether `Bonus := 0` survives. The answer-key
attempt, `BonusForTwiceOnOneInstance`, repeats the same shape (`BonusFor(11)` then `BonusFor(5)`, one
instance) and is predicted to PASS on the mutant, which is the live measurement that the base test's
design assumption (AL does not carry locals across calls) actually holds, not only that it is
documented to.

## 3. Leg A totals

- Deployed mutants: **21** (raw dry-run count: **22** mutant sites, 1 not deployed, per §1).
- **killed 16 / survived 5 / no-coverage 0**.
- `likelyEquivalentSurvivors`: `{ count: 1, byRisk: [{ risk: "value-rewrite", mutants: [<S5's mutant code>] }] }`.
  Of the four survivor operators, only `remove-assignment` declares an `equivalenceRisk`
  (`value-rewrite`); `conditional-boundary`, `remove-setrange`, `swap-find-direction` and
  `validate-to-assign` declare none. So S1-S4 are absent from `likelyEquivalentSurvivors` and only
  S5 appears.
- `readerMarkedEquivalent.matched`: exactly S5's mutant code (the key
  `lethal.equivalent.json` carries resolves to row 15's mutant and no other).
  `readerMarkedEquivalent.stale` and `.contradicted`: both empty.

## 4. Leg B (`fixtures/sandbox-harden-answers`)

`lethal run --project fixtures/sandbox-harden --tests fixtures/sandbox-harden-answers`. Only the
five planted mutants are predicted; every other row's verdict on this leg is printed, not frozen:

- S1 killed by `IsLargeAtTheBoundary` (K1).
- S2 killed by `CountInCategoryIgnoresOtherCategories` (K2).
- S3 killed by `FirstAmountReadsTheFirstRow` (K3).
- S4 killed by `SetAmountRunsValidation` (K4).
- S5 **survived**, mark still `matched` (the answer key's `BonusForTwiceOnOneInstance` attempts it
  and is expected to pass on the mutant, per §2).

## 5. No existing gate moves

No existing fixture, test project, or committed baseline changes: `sandbox-harden`,
`sandbox-harden-tests` and `sandbox-harden-answers` are three new apps with their own ids, their own
`.alpackages`, and their own `itest:harden` gate (not registered in any existing gate table). The
only shared resource both legs touch is the Cronus28 container, which gains exactly these three
apps, published into id block 79500-79599, a block no other fixture in this repo declares (checked
against `fixtures/README.md` §"Object ids" and a fresh grep of every fixture's `app.json` at
plan-writing time). A collision with an app this project does not own and cannot see the source of
(Continia's `CG Test Harness`, mentioned in the plan as the known risk on this container) fails at
publish, loudly, before any gate runs. If that happens: stop, do not retry into the same range, and
pick another free block above 79600.

## 6. The stop rule

Any verdict, any `killingTest`, or any total in sections 1, 3 or 4 that the live run disagrees with
is a BLOCK, reported to the owner. It is never resolved by editing this file or `harden-expected.ts`
to match what the live run produced; a differing verdict means either the fixture does not measure
what it was designed to, or something in the pipeline is wrong, and both need a human decision before
`harden.baseline.json` is written.

## 7. Correction to the plan's C02-08 hand-off note

Plan line 408 (§"Hand-off rules for C02-08") calls `lethal verify --tests
fixtures/sandbox-harden-answers` "a ready deterministic control". Checked against the merged
`planVerify` (`packages/runner/src/verify.ts`), this is wrong. `planVerify`'s `matchCovering` takes
each mutant's `coveringTests` names from the SOURCE run's baseline (here, the base run against
`fixtures/sandbox-harden-tests`, so `Harden Tests.IsLargeSeparatesSmallFromLarge` and so on) and
requires the SAME `(codeunitId, method)` under the SAME codeunit name to still exist in whatever
`--tests` directory is passed. `fixtures/sandbox-harden-answers` contains only `Harden Answer Key`
(codeunit 79575); it does not contain `Harden Tests` (codeunit 79550) at all, so every one of S1 to
S4's covering-test names fails to resolve and `planVerify` throws `covering-test-unmatched` before
anything runs. Pointing `--tests` at the answers app alone is therefore not a usable control. The
working control is a temporary copy of `fixtures/sandbox-harden-tests` with `Harden Answer Key`'s
five test methods appended to (or added alongside) `Harden Tests`, so `--tests` resolves both the
original covering tests by name AND the new answer-key tests (which `planVerify` runs as `newTests`,
matched by `testKeyOf`, not by name). C02-08 needs its own copy of `sandbox-harden-tests` for this,
kept out of the committed fixture per the plan's other hand-off rule (its own id, or a republish of
the committed suite afterwards).

---

## OUTCOME

(Filled in by the owner after the first live run against Cronus28. Nothing above this line changes;
a difference from any prediction above is reported per §6, not edited into agreement.)
