# R136 - pre-committed verdicts for all 51 new mutants the trio's fixture growth adds

**Written BEFORE the live run that measures them.** This file exists so a contradiction between what
it predicts and what Cronus283 answers is a FINDING, recorded as one, rather than something
reconciled quietly afterwards. R73's own `remove-commit` prediction was contradicted by the gate, and
that contradiction WAS the finding: it is what eventually produced the 2x2x2 probe and the correct
rule. R82 pre-committed 30 verdicts across six swap arms and all 30 matched; R72 pre-committed five
and all five matched. This is the same discipline applied to a much larger change.

Date: 2026-08-12. Gate: `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `fixtures/sandbox-data` plus
`fixtures/sandbox-data-tests`, Cronus283.

Rows below are keyed on (arm, operator, before text, after text), NOT on line number and not on
mutant code. Mutant codes renumber, and the line numbers already moved once during this wave: the
fixture's own review fix round added a comment to `DataKeyProbe.Table.al` and shifted its two mutants
down seven lines without changing anything about them. Arm plus operator plus text is the key that
survives both.

## Why the fixture grew at all

Three operator changes landed in this wave and not one of them had a live site.

- `lethal.swap-modify-flag` went from 1.0.0 to 1.1.0, extending the `true` to `false` run-trigger
  rewrite from `Modify` alone to `Insert` and `Delete` as well. The fixture's two pre-existing sites
  are both `Modify(true)`, so nothing measured the new half.
- `lethal.swap-find-direction` is new. It rewrites `FindFirst()` to `FindLast()` and back. The
  fixture had no site for it in either direction.
- `lethal.validate-to-assign` is new. It rewrites a two-argument `Validate(F, V)` into the plain
  assignment that skips the field's `OnValidate` trigger. The fixture had no two-argument `Validate`
  in a target-app statement position at all.

An operator proven only against a constructed string is the R31 shape this project exists to avoid,
so each of the three needed at least one arm that KILLS and, where the operator has a real
equivalence class, one that SURVIVES. Eleven arms were added, A through K.

## The change

Five new files in `fixtures/sandbox-data/src`, plus eleven tests and one seeding helper appended to
`fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`:

- `DataTriggerProbe.Table.al`, `table 79330 "Data Trigger Probe"`: the shared target. Its `OnInsert`
  sets a Boolean, its `OnDelete` inserts a `TOMB-` prefixed tombstone row, and its `"Level"` field's
  `OnValidate` doubles the value into `"Level Doubled"`. It also carries arm I, a table procedure
  calling `Validate` with an implicit receiver.
- `DataKeyProbe.Table.al`, `table 79331 "Data Key Probe"`: arm K's own table, deliberately separate.
  Its `OnInsert` assigns the primary key from a row count when the key is blank.
- `DataFlagOps.Codeunit.al`, `codeunit 79314 "Data Flag Ops"`: arms A, B, C and K.
- `DataFindOps.Codeunit.al`, `codeunit 79315 "Data Find Ops"`: arms D, E and F.
- `DataValidateOps.Codeunit.al`, `codeunit 79316 "Data Validate Ops"`: arms G, H and J.

Task A8's offline census over `fixtures/sandbox-data/src` is the authority on what the pipeline
actually produces from that AL. Its BEFORE run at commit `965ae92` reproduces the frozen gate's 141
deployed mutants exactly, and every one of the 154 BEFORE raw specs reappears byte-identical in the
AFTER run at `84cf478`, so the census's composition and not merely its total is what backs the table
below.

## Aggregate prediction

| figure | before | after |
| --- | --- | --- |
| `totalMutantSites` (raw specs) | 154 | **207** |
| deployed mutants | 141 | **192** |
| specs displaced by dedup | 13 | **15** |
| `killed` | 113 | **158** |
| `survived` | 18 | **24** |
| `noCoverage` | 10 | **10, unchanged** |
| `mutationScore` | 113 / 131 | **158 / 182** |
| `platformArtifactKills.killedCount` | 1 | **1, unchanged** |
| `assertionScreen.discrimination` | `vacuous` | **`vacuous`, unchanged** |
| `untargetedTriggerCount` | 0 | **0, unchanged** |
| expected baseline failures | 1 (`Data Tests.PageActionComputesNonZero`) | **1, unchanged** |
| `[Test]` procedures in the suite | 33 | **44** |

Of the 51 new deployed verdicts: **45 killed, 6 survived, 0 no-coverage.** 113 plus 45 is 158; 18
plus 6 is 24; 158 plus 24 plus 10 is 192, which is the deployed count, so the three verdict buckets
account for every deployed mutant with nothing left over.

`mutationScore` must be exactly `158 / (158 + 24)`, that is `158 / 182`, which reduces to `79 / 91`
and is about 0.8681. No-coverage mutants stay out of the denominator, as before.

Raw 207 minus deployed 192 is 15, the usual dedup. Thirteen of those displacements pre-existed. The
two new ones are both the SAME pre-existing pattern: at each of the two find arms that HAVE a
`SetRange` call, which is arms D and E and not arm F, Tier-1
`lethal.void-method-call` and Tier-2 `lethal.remove-setrange` propose the identical deletion, and
section 3.2 precedence keeps the Tier-2 one. **No mutant of any of the three changed operators
displaces anything, and none is displaced.** If the AFTER census's displacement count arrives as
anything other than 15, or if a displaced row names an operator other than `void-method-call`,
dedup precedence has moved and that is a block.

### The six survivors, listed once, because they are the load-bearing predictions

An aggregate that only grows `killed` proves an operator claims sites. It does not prove the operator
can tell a strong test from a weak one. These six are what does:

1. arm F, `swap-find-direction`: an existence-only assertion cannot see a direction reversal.
2. arm B, `swap-modify-flag`: `Insert(false)` still lands a row, so a read-back assertion misses it.
3. arm H, `validate-to-assign`: the assignment leaves the field value CORRECT, so a value-only
   assertion misses the skipped trigger.
4. arm K, `empty-block` on the procedure body.
5. arm K, `empty-block` on the loop body.
6. arm K, `void-method-call` deleting the `Insert`.

**Three of them share a span with a mutant predicted `killed`**, and the third is not the same kind of
evidence as the first two. Arm B's `Insert(true)` span carries a surviving `swap-modify-flag` and a
killed `void-method-call`; arm H's `Validate` span carries a surviving `validate-to-assign` and a
killed `void-method-call`. Two mutants, one span, two different verdicts, which no aggregate count can
fake and which a report that merged same-span mutants could not produce at all.

Arm K's `KeyProbe.Insert(true)` is the third such span, carrying rows 29 and 30, and its polarity is
REVERSED: there the Tier-1 deletion SURVIVES and the Tier-2 rewrite KILLS. It is worth stating
separately rather than folded into a count of three, because **arm K's pair is not evidence that the
operator distinguishes a strong test from a weak one.** Its covering test asserts nothing at all, so
there is no assertion strength to distinguish; the kill is a duplicate-key platform error. Arms B and
H are the discrimination evidence. Arm K is the demonstration that a kill can arrive without any
assertion earning it.

## Per-mutant prediction

All 51 deployed mutants, in the census's own order (by file, then source order). Rows marked NOT
DEPLOYED are shown so the reader can line this table up against the census without a gap; they are
not counted in the 51.

### `DataFindOps.Codeunit.al`, arms D, E and F (13 deployed, 2 displaced)

Arm D is `FirstLevelInRange(FromNo, ToNo)`, covered by `FindFirstPicksTheLowestKeyInRange`, which
seeds an out-of-range decoy `'FIND-0'` at Level 90, then `'FIND-A'` at Level 1 and `'FIND-B'` at
Level 2, calls the arm with the range `'FIND-A'` to `'FIND-B'`, and asserts the result is 1.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 1 | `lethal.empty-block` | arm D's whole body -> `begin end` | **killed** | the body never runs, so the Integer function returns its type default 0, and 0 is not 1 |
| 2 | `lethal.swap-call-arguments` | `Probe.SetRange("No.", FromNo, ToNo)` -> `Probe.SetRange("No.", ToNo, FromNo)` | **killed** | the range becomes `'FIND-B'` to `'FIND-A'`, a reversed range that matches no row, so `FindFirst` is false, the `if` body never runs and the function falls off the end returning 0. See the uncertainty note below: this row rests on BC not reordering a reversed `SetRange` range |
| - | `lethal.void-method-call` | `Probe.SetRange(...)` -> deleted | NOT DEPLOYED | displaced by row 3, which proposes the identical deletion at a higher tier |
| 3 | `lethal.remove-setrange` | `Probe.SetRange(...)` -> deleted | **killed** | with no filter, `FindFirst` reads the whole table and lands on the decoy `'FIND-0'`, whose Level 90 is not 1. The decoy and its sort direction are the ONLY reason this collateral is killable rather than equivalent |
| 4 | **`lethal.swap-find-direction`** | `Probe.FindFirst()` -> `Probe.FindLast()` | **killed** | inside the filtered range the site now lands on the HIGH row `'FIND-B'`, Level 2, and the test asserts 1. This is the kill for one of the two directions, in EXPRESSION position (the call is an `if` condition) |
| 5 | `lethal.return-value` | `exit(Probe."Level")` -> `exit(0)` | **killed** | 0 is not 1. The arm's asserted value is non-zero precisely so this collateral is not equivalent |

Arm E is `LastLevelInRange(FromNo, ToNo)`, covered by `FindLastPicksTheHighestKeyInRange`, which
seeds `'FIND-C'` at Level 3 and `'FIND-D'` at Level 4 plus a decoy `'FIND-Z'` at Level 91 that sorts
AFTER the range, calls the arm with `'FIND-C'` to `'FIND-D'`, and asserts 4.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 6 | `lethal.empty-block` | arm E's whole body -> `begin end` | **killed** | returns 0, and 0 is not 4 |
| 7 | `lethal.swap-call-arguments` | `Probe.SetRange("No.", FromNo, ToNo)` -> `Probe.SetRange("No.", ToNo, FromNo)` | **killed** | the reversed range `'FIND-D'` to `'FIND-C'` matches nothing, `FindLast` is false, the function returns 0. Same platform premise as row 2 |
| - | `lethal.void-method-call` | `Probe.SetRange(...)` -> deleted | NOT DEPLOYED | displaced by row 8 |
| 8 | `lethal.remove-setrange` | `Probe.SetRange(...)` -> deleted | **killed** | unfiltered, `FindLast` lands on the decoy `'FIND-Z'`, Level 91, not 4. The decoy sorts AFTER the range here, which is the directional half of the decoy rule |
| 9 | **`lethal.swap-find-direction`** | `Probe.FindLast()` -> `Probe.FindFirst()` | **killed** | lands on the LOW row `'FIND-C'`, Level 3, and the test asserts 4. This is the OTHER direction, which is what makes "both directions measured live" a measurement rather than a claim |
| 10 | `lethal.return-value` | `exit(Probe."Level")` -> `exit(0)` | **killed** | 0 is not 4 |

Arm F is `AnyRow()`, covered by `ExistenceOnlyAssertionMissesTheDirection`, which seeds one row
`'FIND-ANY'` at Level 50 and asserts only that something was found. Arm F has no `SetRange` and no
parameters, on purpose.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 11 | `lethal.empty-block` | arm F's whole body -> `begin end` | **killed** | the Boolean function returns its default `false`, and the test's `if not FindOps.AnyRow() then Error(...)` fires |
| 12 | `lethal.return-value` | `exit(Probe.FindFirst())` -> `exit(not (Probe.FindFirst()))` | **killed** | the baseline answer is `true`, so the negation returns `false` and the same assertion fires. This is why the arm asserts `true` rather than `false` |
| 13 | **`lethal.swap-find-direction`** | `Probe.FindFirst()` -> `Probe.FindLast()` | **survived** | with no filter and at least one row present, both directions answer "found". An existence-only assertion cannot see a direction reversal, which is exactly the equivalence class this operator's documentation claims. NOT flagged uncertain, deliberately: an existence answer has only two cases, and both directions give the same answer in each, so no seeded data can separate them. See the unflagging note below for why a kill here would therefore be a stronger finding than a flagged uncertainty |

### `DataFlagOps.Codeunit.al`, arms A, B, C and K (17 deployed)

Arm A is `InsertWithTrigger(No)`, covered by `InsertRunTriggerSetsTheTriggerField`, which clears any
residue with `Delete(false)` and asserts the returned Boolean is `true`.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 14 | `lethal.empty-block` | arm A's whole body -> `begin end` | **killed** | returns Boolean default `false`, the assertion fires |
| 15 | `lethal.void-method-call` | `Probe.Insert(true)` -> deleted | **killed** | no row is written and `OnInsert` never runs, so the in-memory `"Inserted By Trigger"` is still `false`. An assertion kill, not a platform kill: nothing raises |
| 16 | **`lethal.swap-modify-flag`** | `Probe.Insert(true)` -> `Probe.Insert(false)` | **killed** | `Insert(false)` skips `OnInsert`, the flag stays `false`, the assertion fires. This is the kill for the `Insert` half of the 1.1.0 extension |
| 17 | `lethal.return-value` | `exit(Probe."Inserted By Trigger")` -> `exit(not (...))` | **killed** | the baseline answer is `true`, so the negation returns `false` |

Arm B is `InsertCounted(No)`, covered by `WeakInsertAssertionMissesTheFlag`, which asserts only that
a row landed. The read-back's return value is CONSUMED (`exit(Probe.Get(No))`) rather than being a
statement-position `Get`, so a missing row answers `false` instead of raising.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 18 | `lethal.empty-block` | arm B's whole body -> `begin end` | **killed** | returns `false`, the assertion fires |
| 19 | `lethal.void-method-call` | `Probe.Insert(true)` -> deleted | **killed** | with no insert there is no row, so `Probe.Get(No)` answers `false`. This is the KILLED half of the same-span pair with row 20 |
| 20 | **`lethal.swap-modify-flag`** | `Probe.Insert(true)` -> `Probe.Insert(false)` | **survived** | `Insert(false)` still writes the row, it merely skips the trigger, so the read-back still finds it and this weak assertion passes. The SURVIVING half of the same-span pair, and the discrimination the operator exists for |
| 21 | `lethal.return-value` | `exit(Probe.Get(No))` -> `exit(not (Probe.Get(No)))` | **killed** | the baseline answer is `true`, the negation returns `false` |

Arm C is `DeleteWithTrigger(No)`, covered by `DeleteRunTriggerLeavesTombstone`, which clears both the
row and its tombstone with `Delete(false)`, seeds the row itself, then asserts the returned Boolean.
Arm C is the only code in the fixture allowed to run `OnDelete`. Its `Delete(true)` on a record
variable carrying only the primary key was MEASURED live against a real container in the fixture
task's fix round (`scripts/r136-armc-probe/README.md`): it locates the row by primary key, deletes
it, and runs `OnDelete`, stably across three runs. So it adds no baseline failure.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 22 | `lethal.empty-block` | arm C's whole body -> `begin end` | **killed** | returns `false`, the assertion fires |
| 23 | `lethal.void-method-call` | `Probe.Delete(true)` -> deleted | **killed** | no delete means no `OnDelete`, so no tombstone, so `Tomb.Get('TOMB-' + No)` answers `false` |
| 24 | **`lethal.swap-modify-flag`** | `Probe.Delete(true)` -> `Probe.Delete(false)` | **killed** | the row is still deleted but `OnDelete` is skipped, so no tombstone appears. This is the kill for the `Delete` half, proven by its own arm rather than inferred from the `Insert` one. One premise is reasoned and not measured: that `Delete(false)` locates the row by primary key alone, the way arm C's probe measured `Delete(true)` doing. If it raised instead, this row would still be `killed` but by a platform error, and the "proven by its own arm" claim would be unearned. See the lesser-premise note below |
| 25 | `lethal.return-value` | `exit(Tomb.Get('TOMB-' + No))` -> `exit(not (...))` | **killed** | the baseline answer is `true`, the negation returns `false` |

Arm K is `InsertTwiceWithKeyTrigger()`, a two-iteration `for` loop whose body is `KeyProbe.Init();
KeyProbe.Insert(true);` against `Data Key Probe`. Its covering test
`DoubleInsertWithoutKeyTriggerRaises` clears the table and **asserts nothing at all.** In the
baseline the two iterations insert `'KEY-1'` and `'KEY-2'` and the test passes.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 26 | `lethal.empty-block` | arm K's whole procedure body -> `begin end` | **survived** | nothing runs, nothing is inserted, nothing raises, and the test asserts nothing there is to fail. This is arm K's CONTROL: it is what proves the kill at row 30 came from the platform and not from the arm being reached at all |
| 27 | `lethal.empty-block` | arm K's `for` loop body -> `begin end` | **survived** | the loop turns twice doing nothing. Same reason as row 26, one nesting level in |
| 28 | `lethal.void-method-call` | `KeyProbe.Init()` -> deleted | **killed by a duplicate key, a PLATFORM ARTIFACT no screen tags** | after `Insert(true)` the record variable carries the key `OnInsert` assigned, `'KEY-1'`. Without `Init()` the second iteration therefore inserts with `"No."` already set to `'KEY-1'`, `OnInsert`'s blank guard is false, and the second insert raises a duplicate primary key. The test asserts nothing, so this kill cannot have come from an assertion. UNCERTAIN: see the note below |
| 29 | `lethal.void-method-call` | `KeyProbe.Insert(true)` -> deleted | **survived** | with the insert gone the loop turns twice doing only `Init()`. No row lands and nothing raises |
| 30 | **`lethal.swap-modify-flag`** | `KeyProbe.Insert(true)` -> `KeyProbe.Insert(false)` | **killed by a duplicate key, a PLATFORM ARTIFACT no screen tags** | `OnInsert` never runs, so `"No."` stays blank both iterations. The first blank-key insert succeeds, because blank is a legal `Code[20]`, and the second raises a duplicate primary key. This is the arm the whole of R138 rests on: the mutant IS killed, and the suite did NOT earn the kill. MECHANISM flagged, verdict not: uncertainty 5 below |

### `DataKeyProbe.Table.al` (2 deployed)

Both mutants sit inside the `OnInsert` trigger, so neither has a member-level coverage key and both
take object-level attribution. `Data Key Probe` is touched by exactly one test, arm K's. **Both
reach the identical duplicate-key mechanism as row 30, and neither is tagged by any screen.** The
table's own comment names the second of them; the first is named here for the first time.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 31 | `lethal.empty-block` | the `OnInsert` body -> `begin end` | **killed by a duplicate key, a PLATFORM ARTIFACT no screen tags** | emptying the trigger removes the key assignment, so `"No."` stays blank both iterations, exactly as under row 30. First insert succeeds, second raises. A THIRD route to the same mechanism, alongside rows 28 and 32. MECHANISM flagged, verdict not: uncertainty 5 below |
| 32 | `lethal.negate-conditional` | `"No." = ''` -> `"No." <> ''` | **killed by a duplicate key, a PLATFORM ARTIFACT no screen tags** | on a freshly `Init()`d record the key IS blank, so the negated guard is false and the assignment never runs. Same blank key, same duplicate on the second insert, via a different operator than arm K's own. MECHANISM flagged, verdict not: uncertainty 5 below |

### `DataTriggerProbe.Table.al` (8 deployed)

Rows 33 to 36 sit inside trigger bodies, so they take object-level attribution across every test
that measurably executed something in `Data Trigger Probe`. Rows 37 to 40 are arm I, a table
PROCEDURE, which needs a member-level coverage entry instead.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 33 | `lethal.empty-block` | the `"Level"` field's `OnValidate` body -> `begin end` | **killed** | `"Level Doubled"` is never written, so it stays 0. Arms G, I and J all assert the doubled value, and whichever of their tests runs first fails. Arm H is unaffected, because it asserts the plain field value |
| 34 | `lethal.empty-block` | the table's `OnInsert` body -> `begin end` | **killed** | `"Inserted By Trigger"` is never set, so arm A's assertion fires. Arm B's weak assertion still passes, and every seeding insert in the suite uses `Insert(false)` and never reached this trigger anyway |
| 35 | `lethal.empty-block` | the table's `OnDelete` body -> `begin end` | **killed** | no tombstone row is written, so arm C's read-back answers `false`. Arm C is the only code in the fixture that runs `OnDelete`, so it is also the only test that can kill this |
| 36 | `lethal.void-method-call` | `Tomb.Insert(false)` -> deleted | **killed** | the same effect as row 35 by a narrower edit: the tombstone is never written and arm C's assertion fires |
| 37 | `lethal.empty-block` | arm I's whole body -> `begin end` | **killed** | returns Integer default 0, and `ImplicitValidateRunsInsideTheTable` asserts 12. UNCERTAIN on ATTRIBUTION, not on the verdict: see the note below |
| 38 | `lethal.void-method-call` | `Validate("Level", NewLevel)` -> deleted | **killed** | with no `Validate` call, neither `"Level"` nor `"Level Doubled"` is written, so the function returns 0. UNCERTAIN on attribution |
| 39 | **`lethal.validate-to-assign`** | `Validate("Level", NewLevel)` -> `Rec."Level" := NewLevel` | **killed** | the assignment writes the field and skips `OnValidate`, so `"Level Doubled"` stays 0 and the test's assertion of 12 fires. This is the IMPLICIT-receiver emit path, and the only live proof that the synthesised `Rec.` prefix compiles, deploys and scores inside a `table` object. UNCERTAIN on attribution |
| 40 | `lethal.return-value` | `exit("Level Doubled")` -> `exit(0)` | **killed** | 0 is not 12. UNCERTAIN on attribution |

### `DataValidateOps.Codeunit.al`, arms G, H and J (11 deployed)

None of these three arms touches a database row. `Validate` runs `OnValidate` against the in-memory
record, which `Data Tests.BlankNoValidateFails` and `Data Tests.NoTriggerValidateRunsWeak` already
establish on this fixture, so no seeding, no keys and no duplicate-key concerns arise here.

Arm G is `SetLevel(NewLevel)`, covered by `ValidateRunsTheFieldTrigger`, which calls it with 5 and
asserts 10.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 41 | `lethal.empty-block` | arm G's whole body -> `begin end` | **killed** | returns 0, and 0 is not 10 |
| 42 | `lethal.void-method-call` | `Probe.Validate("Level", NewLevel)` -> deleted | **killed** | nothing is written at all, so `"Level Doubled"` is 0 |
| 43 | **`lethal.validate-to-assign`** | `Probe.Validate("Level", NewLevel)` -> `Probe."Level" := NewLevel` | **killed** | the assignment skips `OnValidate`, `"Level Doubled"` stays 0, the assertion of 10 fires. This is the kill for the qualified-receiver form, with a QUOTED field identifier |
| 44 | `lethal.return-value` | `exit(Probe."Level Doubled")` -> `exit(0)` | **killed** | 0 is not 10 |

Arm H is `SetLevelWeak(NewLevel)`, covered by `ValueOnlyAssertionMissesTheTriggerSkip`, which calls
it with 7 and asserts 7. This is the sharpest arm in the wave.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 45 | `lethal.empty-block` | arm H's whole body -> `begin end` | **killed** | returns 0, and 0 is not 7 |
| 46 | `lethal.void-method-call` | `Probe.Validate("Level", NewLevel)` -> deleted | **killed** | deleting the call altogether leaves `"Level"` at 0, so the assertion of 7 fires. The KILLED half of the same-span pair with row 47 |
| 47 | **`lethal.validate-to-assign`** | `Probe.Validate("Level", NewLevel)` -> `Probe."Level" := NewLevel` | **survived** | the assignment leaves `"Level"` itself CORRECT at 7, which is all this test asserts. Only `"Level Doubled"` is wrong, and nothing looks at it. The SURVIVING half of the same-span pair. UNCERTAIN: see the note below |
| 48 | `lethal.return-value` | `exit(Probe."Level")` -> `exit(0)` | **killed** | 0 is not 7 |

Arm J is `TouchLevel(NewLevel)`, covered by `TouchLevelRunsTheTriggerAgain`, which calls it with 9
and asserts 18. Arm J is the REFUSAL negative: its `Probe.Validate("Level")` takes a single argument,
which has no assignment equivalent, so `validate-to-assign` must emit NOTHING there.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 49 | `lethal.empty-block` | arm J's whole body -> `begin end` | **killed** | returns 0, and 0 is not 18 |
| 50 | `lethal.void-method-call` | `Probe.Validate("Level")` -> deleted | **killed** | the hand assignment on the line above still sets `"Level"` to 9, but with the `Validate` call gone `OnValidate` never runs, so `"Level Doubled"` stays 0 |
| - | **`lethal.validate-to-assign`** | the single-argument `Probe.Validate("Level")` | **NOT EMITTED, and this is a prediction** | the exact-count argument guard must refuse this site. The census confirms it offline: `validate-to-assign` appears exactly three times in the AFTER run, at rows 39, 43 and 47, and not here. Live, a mis-claim would emit a truncated assignment, `alc` would reject the artifact as an `AlcCompileError`, bisection would isolate the shard, and every mutant in it would be recorded `error`. So the failure shape is an aggregate mismatch plus `error` rows in the per-mutant diff, never a compiler message in the gate's own output |
| 51 | `lethal.return-value` | `exit(Probe."Level Doubled")` -> `exit(0)` | **killed** | 0 is not 18 |

## Where this prediction is genuinely uncertain

**Four uncertainties that could move a VERDICT** (items 1 to 4, covering rows 2, 7, 28, 37, 38, 39,
40 and 47), and **one that can move only a MECHANISM** (item 5, covering rows 30, 31 and 32). Each
carries what would settle it. An honestly flagged uncertainty is worth more than a confident guess,
because the gate settles it either way and a wrong confident guess damages the record. Equally, a
flag on something determinable is padding: one earlier candidate was removed on that ground and the
removal is recorded below with its reasoning, so the list can be checked rather than trusted.

**1. Arm I's attribution, rows 37 to 40. The most likely contradiction in the whole table.** Arm I
sites four mutants in a table PROCEDURE. A trigger mutant that misses at member level falls back to
object-level coverage and then to every green test; a PUBLIC procedure mutant that misses at member
level gets neither fallback and is reported `no-coverage`. So if BC does not report a member-level
coverage entry for `Data Trigger Probe.ValidateLevelImplicit`, all four rows become `no-coverage`
together, and the aggregate becomes killed 154, survived 24, no-coverage 14, score `154 / 178`. The
design spec names this as its leading attribution risk and rates it "already measured once,
re-checked here", because `DataMain.Table.al` records the member-versus-object distinction as
measured and this fixture's existing table procedures do attribute. That is why the table above
predicts `killed` rather than hedging to `no-coverage`. **Settled by:** `report.mutants` for those
four, specifically a non-empty `coveringTests` naming `ImplicitValidateRunsInsideTheTable` and an
attribution of `exact`. If they arrive `no-coverage`, that is a coverage FINDING to report, not a
reason to move arm I into a trigger.

**2. Arm H's survival, row 47.** The prediction is that a plain field assignment writes the value
without running any validation, leaving the field correct and the test blind. If the platform runs
some validation on assignment, the value could differ and the mutant would be killed instead. Either
result is a finding: `survived` is the bug class the operator exists for, and `killed` would retire a
premise the design spec asserts. **Settled by** the row's verdict, and if killed, by
`killingTestFailure` showing which value the test actually saw.

**3. Rows 2 and 7, the reversed `SetRange` range.** Both predict `killed` on the premise that BC
treats `SetRange(Field, High, Low)` as a range that matches no row rather than normalising it to
`Low..High`. This is a platform behaviour I reasoned about and did not measure. If BC normalises, both
mutants are exactly equivalent to the original and both `survive`. **Settled by** the two verdicts,
and it would be a platform fact worth recording rather than a fixture defect: the fix would be to
document the normalisation, not to strengthen the arms.

**4. Row 28, `Init()` deleted in arm K.** The prediction rests on `OnInsert`'s key assignment being
visible on the CALLER's record variable after `Insert(true)` returns, which is the ordinary No.
Series pattern in BC. If instead the variable's key were still blank after the insert, the second
iteration would enter `OnInsert` with a blank key, get `'KEY-2'` assigned, succeed, and the mutant
would `survive`. **Settled by** the row's verdict together with `killingTestFailure`: a duplicate-key
message confirms the mechanism, and a survival would mean the trigger's write does not propagate
back, which is worth writing down about the platform.

**5. Rows 30, 31 and 32 all rest on a blank primary key being INSERTABLE.** Each predicts that the
first blank-key insert succeeds and the second raises a duplicate, which assumes an `Insert` with a
blank `Code[20]` primary key is accepted rather than refused. This premise is VERDICT-safe but not
MECHANISM-safe: if the first insert itself refused, all three rows would still be `killed`, still by
a platform error, still untagged. But they would be killed by a different mechanism than the one this
document records, and these three rows are the fixture's live statement of R138, where the mechanism
IS the thing being recorded. **Settled by** `killingTestFailure` on each of the three: a duplicate-key
message confirms the recorded mechanism, and any other refusal message means R138's shape needs
restating even though its point stands.

Two lesser members of the same class, neither flagged as an uncertainty because neither can move a
verdict, but both worth naming so nobody re-derives them at the gate:

- **`Count()` inside `OnInsert` returning the PRE-insert count** is what fixes the baseline keys as
  `'KEY-1'` then `'KEY-2'`. If it counted the row being inserted, they would be `'KEY-2'` then
  `'KEY-3'`. Cosmetic: either reading leaves the baseline green and every arm K verdict unchanged,
  because nothing asserts on the key values.
- **`Delete(false)` locating the row by primary key alone**, in row 24. The arm C probe measured
  `Delete(true)` on a key-only record variable and not `Delete(false)`. If the flagless form instead
  raised "the record does not exist", row 24 would still be `killed`, but by a platform error rather
  than by the missing tombstone, and the wave's claim that the `Delete` half is proven BY ITS OWN ARM
  would be unearned. **Settled by** row 24's `killingTestFailure`: it must be the arm C test's own
  `Error('expected Delete(true) to run OnDelete and leave a tombstone')`, not a platform message.

**Arm F's survival, row 13, is deliberately NOT flagged**, and this is a change from an earlier draft
of this document. The design spec lists "arm F may kill" as its risk 3, on the premise that something
in the seeded data could make the existence answer differ between the two directions. On inspection
nothing can: `AnyRow` carries no filter, so both `FindFirst` and `FindLast` read the whole table, and
an existence answer has only two cases. If any row exists, both directions find one and both return
`true`. If none exists, both return `false` and the test fails identically under the mutant and under
the original. There is no third case for the seeded data to land in, so the equivalence is total with
respect to the only thing the arm observes, independent of how many rows the test seeds. Flagging it
anyway would have padded the uncertainty list with something determinable. **The consequence of
unflagging is that a kill here is a STRONGER finding, not a weaker one:** it would be unexplained by
any mechanism this document can name, and would have to be diagnosed rather than absorbed as "the
arm's data was not neutral".

**The three groups partition all 51, so "not flagged" is a claim and not an omission.** Eight rows
are verdict-flagged: 2, 7, 28, 37, 38, 39, 40 and 47. Three are mechanism-flagged only: 30, 31 and
32. The remaining **forty** are unflagged: rows 1, 3 to 6, 8 to 27, 29, 33 to 36, 41 to 46 and 48 to
51. Eight plus three plus forty is 51. Every unflagged row follows from either a type default (an
emptied body returns 0 or `false`), a negation of a value the covering test asserts is non-zero or
`true`, or a trigger effect the covering test reads back directly.

## What must ALSO hold, and would be a finding if it did not

- **No pre-existing mutant may move.** `assertMatchesBaseline` checks that per mutant. In particular
  the MINOR version bump on `swap-modify-flag` must move no identity: both pre-existing
  `Modify(true)` sites, in `DataMain.Table.al` and `DataOps.Codeunit.al`, must keep their key and
  their recorded verdict. The mechanism behind that claim is that a baseline row is keyed on
  `astHash|codeunitName|operatorName|operatorMajor`, `operatorMajor` is the leading digit alone so
  1.0.0 and 1.1.0 share it, and `astHash` hashes only the ORIGINAL subtree and never the operator
  version or the replacement text. This is the run that checks that live rather than by reading the
  hashing source.

- **`platformArtifactKills.killedCount` stays exactly 1**, `byMechanism` stays exactly
  `["write-txn-codeunit-run"]`, the screened mutant stays the `lethal.remove-commit` in
  `CommitThenRunValueForm`, and its verdict stays `killed`. **This is true at the same time as this
  wave adding FOUR kills that are platform artifacts by construction**, at rows 28, 30, 31 and 32,
  all reaching one duplicate-key mechanism, and **none of the four is tagged.** The screen tags only
  mechanisms an operator DECLARES, and only `lethal.remove-commit` declares one today. So the
  screened count staying at 1 is not evidence that only one platform artifact exists in the run; it
  is the measured size of the screen's blind spot, which is what `docs/roadmap/R138.md` holds open.
  A report on this run may say those four mutants were killed. It may not say the suite caught them.

- **`untargetedTriggerCount` stays 0, and the reason is not "every new trigger has a test".** The
  fallback that keeps the count at 0 consumes a NON-EMPTY object-level coverage entry for the table,
  which requires BC to report an observation keyed to that object during a GREEN BASELINE test. A
  test can exercise a trigger and contribute nothing, if the observation is not reported or is not
  keyed to the object. Having a named test is necessary and not sufficient. The precedent that it
  does work on this fixture is `Data No Trigger`, whose only route in is a `Validate` on a
  never-inserted record and whose `empty-block` mutant is `killed` in the committed baseline with the
  count at 0. **This wave adds TWO new tables, and either can break the invariant, so here are all
  three arithmetics in advance rather than derived at the gate while staring at an unexpected
  number.** `Data Key Probe` hosts two trigger mutants, rows 31 and 32; `Data Trigger Probe` hosts
  four, rows 33 to 36. If `Data Key Probe`'s object-level entry comes back empty, its two take
  `coverageFilter`'s FALLBACK 2 and the count is **2**. If `Data Trigger Probe`'s comes back empty,
  its four do and the count is **4**. If both miss, it is **6**. Any other non-zero value means a
  PRE-EXISTING trigger also stopped attributing, which is a wider regression than this wave and must
  be diagnosed as one.
  `Data Key Probe` is the likelier of the two: it is touched by exactly one test, where
  `Data Trigger Probe` is touched by ten of the eleven new ones, six of them through real rows and
  four only through an in-memory `Validate`. In every one of those cases the VERDICTS do not move,
  because the covering test is in the all-green set either way, so the tally is the only thing that
  can catch it. That is precisely why the gate asserts the tally rather than trusting the verdicts.

- **The assertion screen still reports itself as `vacuous`.** All 44 tests in
  `fixtures/sandbox-data-tests` raise through bare `Error(...)` and none uses an assertion library,
  including all 11 new ones, so the screen flags every kill that carries failure text and separates
  nothing. Concretely: `assertionScreen.discrimination` is `vacuous`, `flagged` equals
  `killsWithText`, `killsWithText` is greater than 0, and `runnerRefusals` is 0. The four
  duplicate-key kills do not change this: a BC platform error message is no more an assertion-library
  message than a bare `Error(...)` is, so it is flagged too. A `partial` would mean either the
  fixture grew an assertion library or the rule started matching something it was never scored on.
  Note for whoever updates the gate: its comment says "all 22 tests", which was already stale before
  this wave (the suite held 33 tests at `965ae92` and holds 44 now). The count in that comment is
  wrong; the claim it supports is not.

- **Exactly ONE baseline test failure, by name: `Data Tests.PageActionComputesNonZero`**, the TestPage
  test the fenced session refuses. Eleven new tests must add none. The one that could have is arm C,
  whose `Delete(true)` runs on a record variable carrying only the primary key; that shape was
  measured live against a real container rather than argued, and it locates the row, deletes it and
  runs `OnDelete` stably. Arm K's test is also green in the baseline: the two iterations insert
  `'KEY-1'` and `'KEY-2'` and nothing raises.

- **The raw spec count is 207, not 208.** The extra one would be a `validate-to-assign` mutant at arm
  J's single-argument `Validate`, which the operator's exact-count guard must refuse.

- **The four durable gate assertions** the design spec requires must be present and passing, because
  `astSubtreeHash` canonicalises identifier text and therefore collapses arms A, B and K into one
  `swap-modify-flag` key, arms D, E and F into one `swap-find-direction` key, and arms G and H into
  one `validate-to-assign` key. The assertions pin what the key cannot: a `killed`
  `swap-modify-flag` whose `originalText` contains `Insert(true)`, another whose `originalText`
  contains `Delete(true)`, a `killed` `swap-find-direction` whose `mutatedText` contains `FindLast`,
  and another whose `mutatedText` contains `FindFirst`.

- **The per-mutant review reads `report.mutants`, not baseline rows.** For the same collapsing
  reason. A baseline row carries no `file`, `procedureName`, `originalText` or `coveringTests`, and a
  survivor's killing test is null, so the collapsed groups cannot be told apart from the baseline
  file at all. Checking this table against baseline rows would produce a confident, empty match,
  which is this project's signature bug.

## What this wave does NOT prove

- **Any rate on real code.** The census counts syntactic sites, not killable ones, and no fixture
  turns one into the other.
- **Anything about assertion quality behind an `Insert` kill on real code.** On a table whose
  `OnInsert` assigns the primary key, `Insert(false)` kills through the platform, not through any
  assertion, and no screen separates the two. Rows 28, 30, 31 and 32 are this wave's demonstration
  that killed and caught are different things, not a licence to read either one as the other.
- **The `false` to `true` flag direction.** Out of scope: it ADDS a trigger run rather than skipping
  one, a different bug class whose population is unmeasured.
- **`FindSet` direction.** Deferred. A reversed set needs a SECOND statement inserted before the
  find, which no operator in this product emits, and the ascending state outlives the call, so the
  mutation would not be local to its site.
- **The single-argument `Validate`.** Refused: no assignment equivalent exists. Arm J proves the
  refusal HOLDS; it says nothing about whether such sites are worth mutating some other way.
- **Any equivalence RATE for the find swap.** The fixture holds one deliberate equivalent survivor.
  It demonstrates the class and measures nothing about how often the class occurs.
- **Anything about the assertion screen's discriminating power.** This fixture is the measured
  vacuous case, by construction.
- **Anything about the other three gates** beyond "unchanged". `fixtures/sandbox-app` was censused
  and is byte-for-byte identical, which is a measurement rather than an argument, but it is a
  measurement about the mutant population and not about those gates' verdicts.
- **Six platform premises this document reasons about rather than measures.** Four are load bearing
  for a verdict or a recorded mechanism: a reversed-range `SetRange` matching nothing, no validation
  running on a plain field assignment, a trigger's write propagating back to the caller's record
  variable, and a blank `Code[20]` primary key being insertable. Two are load bearing for wording
  only: `Count()` inside `OnInsert` returning the pre-insert count, and `Delete(false)` locating a row
  by primary key alone. Whichever way the gate answers each, the answer belongs in the report as a
  platform fact, not absorbed into a verdict.
