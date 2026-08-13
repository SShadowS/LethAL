# R134 - pre-committed verdicts for all 32 new mutants the filter-literal fixture growth adds

**Written BEFORE the live run that measures them.** This file exists so that a contradiction between
what it predicts and what the container answers is a FINDING, recorded as one, rather than something
reconciled quietly afterwards. The precedent is direct and recent. The sibling wave in this same plan
pre-committed 51 verdicts, had a premise it had labelled cosmetic contradicted, and because the
prediction was already committed the contradiction read as a specific finding instead of a mystery
number. Its 51 predictions then matched exactly, 44 on one run and 7 on a later one. R82 pre-committed
30 and all 30 matched. R72 pre-committed 5 and all 5 matched.

Date: 2026-08-13. Gate: `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `fixtures/sandbox-data` plus
`fixtures/sandbox-data-tests`, Cronus283.

Rows below are keyed on (arm, operator, before text, after text), NOT on line number and not on mutant
code. Mutant codes renumber and line numbers move. Arm plus operator plus text is the key that
survives both.

## Why the fixture grew at all

One new operator landed in this wave and it had no live site anywhere.

`lethal.flip-filter-literal` is new, Tier 2, version 1.0.0. It mutates INSIDE the filter string a
`SetFilter` call hands to Business Central, through a four-rule ladder: flip a `<>` comparator to `=`,
shift a `<`/`<=`/`>`/`>=` boundary to its paired counterpart, reverse an open range (`..X` to `X..`),
or drop a placeholder-free alternative from a `|` list. Before this wave the fixture held exactly one
`SetFilter` call, and its filter text is the bare placeholder `'%1'`, which every rule in the ladder
declines. So nothing measured any rule of the four.

An operator proven only against a constructed string is the R31 shape this project exists to avoid.
Each of the four rules therefore needed at least one arm that KILLS, and the two most populous rules
needed one that SURVIVES as well, because an aggregate that only grows `killed` proves an operator
claims sites and proves nothing about whether it can tell a strong test from a weak one. Seven arms
were added, A through E plus G and H. Arm F is the spec's documented equivalence class and has no
procedure of its own.

This operator is also the first in the product to mutate a string that BC re-parses at RUNTIME rather
than AL that `alc` compiles. That distinction runs through the whole table below and is treated
explicitly in the platform-rejection section.

## The change

One new file in `fixtures/sandbox-data/src`, plus seven tests appended to
`fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`. No new table and no new seeding helper: the
arms reuse `table 79302 "Data Related"` and the existing idempotent `AddRelated`/`ClearRelated`
helpers.

- `DataFilterOps.Codeunit.al`, `codeunit 79317 "Data Filter Ops"`: all seven arms.
  - Arm A, `CountExcluding`, rule 1, the kill.
  - Arm B, `AnyExcluding`, rule 1, the weak-assertion survivor and arm A's hash-decoy twin.
  - Arm C, `CountBelowThreshold`, rule 2, the kill.
  - Arm D, `CountBelowThresholdSparse`, rule 2, the equivalence survivor and arm C's twin.
  - Arm E, `CountUpToBound`, rule 3, the kill.
  - Arm G, `CountDecoyOrTarget`, rule 4, the kill.
  - Arm H, `CountInRange`, the closed-range REFUSAL negative, where the operator must emit nothing.

Each arm reserves its own `"Main No."` tag and its own `"Entry No."` band, 79150 through 79192, so no
arm's count can see another arm's rows and no verdict depends on test execution order.

### The census is the authority, and it reconciles exactly

An offline census over `fixtures/sandbox-data/src`, using the committed `scripts/census-fixture-mutants.ts`
which mirrors the real planning pipeline, was run from two git worktrees pinned at two commits, created
outside the repository so no working-tree drift could contaminate either side.

- BEFORE: `59595a2`, the parent of the fixture commit. Result: **207 raw specs, 15 displaced, 192
  deployed.** That reproduces the frozen gate's figures exactly, which is what licenses the AFTER run.
- AFTER: `e000f4a`, current HEAD. Result: **243 raw specs, 19 displaced, 224 deployed.**

Every one of the 207 BEFORE rows reappears byte-identical in the AFTER run, and all 36 new raw rows sit
in the one new file. Nothing pre-existing moved, gained a mutant, or lost one. The operator's own source
is unchanged between the two commits as well: the only source edit in that range touches comments and
prose in the mini-parser, so the census diff is purely fixture-driven.

Arithmetic: 243 minus 207 is 36 new raw specs. 19 minus 15 is 4 new displacements. 36 minus 4 is 32 new
deployed mutants. 224 minus 192 is 32, so the two arrive at the same number from opposite directions.

## Aggregate prediction

| figure | before | after |
| --- | --- | --- |
| `totalMutantSites` (raw specs) | 207 | **243** |
| deployed mutants | 192 | **224** |
| specs displaced by dedup | 15 | **19** |
| `killed` | 157 | **183** |
| `survived` | 25 | **31** |
| `noCoverage` | 10 | **10, unchanged** |
| `error` | 0 | **0** |
| `mutationScore` | 157 / 182 | **183 / 214** |
| `platformArtifactKills.killedCount` | 1 | **1, unchanged** |
| `assertionScreen.discrimination` | `vacuous` | **`vacuous`, unchanged** |
| `untargetedTriggerCount` | 0 | **0, unchanged** |
| expected baseline failures | 1 (`Data Tests.PageActionComputesNonZero`) | **1, unchanged** |
| `[Test]` procedures in the suite | 44 | **51** |

Of the 32 new deployed verdicts: **26 killed, 6 survived, 0 no-coverage, 0 error.** 157 plus 26 is 183.
25 plus 6 is 31. 183 plus 31 plus 10 is 224, which is the deployed count, so the three verdict buckets
account for every deployed mutant with nothing left over.

`mutationScore` must be exactly `183 / (183 + 31)`, that is `183 / 214`, which does not reduce, since
183 is 3 times 61 and 214 is 2 times 107. It is about 0.8551, DOWN from the current 0.8626. A wave that
adds six deliberate survivors is supposed to move the score down, and a score that rose instead would
mean the survivors did not arrive.

### The four new displacements, named

All four are the same pre-existing pattern, and none involves the new operator. Arms C, D, E and H each
carry a `SetRange("Main No.", <tag>)` scope. At each of those four statements, Tier-1
`lethal.void-method-call` and Tier-2 `lethal.remove-setrange` propose the IDENTICAL deletion, so they
share one dedup identity and section 3.2 precedence keeps the Tier-2 one. That is ONE mutant at that
span, not two.

**No mutant of `flip-filter-literal` displaces anything, and none is displaced.** This is the
coexistence claim the spec makes, and the census confirms it directly rather than by inference: at
every one of the six spans this operator claims, `void-method-call` ALSO survives dedup, because the
splice's replacement text is non-empty and the deletion's is empty, so the two identities differ. Six
spans each carrying two mutants. If the AFTER displacement count arrives as anything other than 19, or
if a displaced row names an operator other than `void-method-call`, dedup precedence has moved and that
is a block.

### The six survivors, listed once, because they are the load-bearing predictions

1. Arm B, `flip-filter-literal`: an existence-only assertion cannot see WHICH group was counted.
2. Arm D, `flip-filter-literal`: with a gap at the boundary, the shifted comparator selects the same
   rows, so the mutant is genuinely equivalent.
3. Arm B, `void-method-call`: deleting the filter still leaves rows, and existence is all that is
   asserted.
4. Arm B, `conditional-boundary`: `Count() >= 0` is a tautology on a row count.
5. Arm G, `void-method-call`: the filter's own two alternatives already cover every row the covering
   test seeds, so deleting the filter counts the same rows.
6. Arm H, `void-method-call`: the closed range already covers both of the arm's own scoped rows.

**Exactly two spans carry two mutants with two DIFFERENT verdicts, and their polarity is opposite.**
This is the evidence no aggregate count can fake, and a report that merged same-span mutants could not
produce it at all. The six spans this operator claims each carry a `flip-filter-literal` and a
`void-method-call`, and the verdict pairing at each was derived per arm, not assumed:

- **Arm D's span: `flip-filter-literal` SURVIVES, `void-method-call` is KILLED.** Deleting the filter
  admits the arm's second row, and shifting the boundary across a gap admits nothing.
- **Arm G's span: `flip-filter-literal` is KILLED, `void-method-call` SURVIVES.** Dropping an
  alternative narrows the count, and deleting the whole filter does not, because the filter was
  excluding nothing the test seeded. The reversed polarity is worth stating separately rather than
  folded into a count of two, because it is the case that shows the Tier-2 rewrite finding something
  the Tier-1 deletion cannot.

The other four spans are uniform: arm B's carries two survivors, and arms A, C and E each carry two
kills. Arm B is therefore NOT one of the discriminating spans, and its own discrimination evidence is
of a different kind: **arms C and D are the sharpest pair in this wave**, identical rule, identical
mutation shape, opposite verdicts, decided purely by whether a row sits at the shifted boundary. Arms A
and B are the same construction for rule 1.

## A census finding this document must record before predicting anything

**The design's collateral list is incomplete, and the census names a fifth operator neither the design
nor the fixture comments mention.** Section 3.3 of the design enumerates the routine Tier-1 collateral
as `empty-block` on the body, `void-method-call` on each statement-position call, and `return-value` on
each `exit`, plus Tier-2 `remove-setrange` on the four scoped arms. The new fixture file's own header
comment repeats that same list. Neither names `lethal.conditional-boundary`, which the census shows
firing at arm B's `exit(Related.Count() > 0)` and rewriting it to `Related.Count() >= 0`.

This is an omission in the design's prose, not a behaviour difference. `conditional-boundary` is a
pre-existing Tier-1 operator that flips `>` to `>=`, and it behaves at arm B exactly as it already does
at the three other comparison sites in this fixture. Arm B is the only new arm that contains a
comparison expression at all, because every other arm returns `Related.Count()` directly, which is why
one arm and only one arm picked up an operator the list forgot.

It is written up here, before the run, for the reason this whole document exists: an unnamed mutant
arriving at the gate would have read as an unexplained key. Its verdict is predicted below as row 9 and
its mechanism is airtight, so nothing about the wave's conclusions changes. What changes is that the
design's section 3.3 should gain the operator when R134 is closed out.

Two smaller reconciliation notes, both settled rather than left open:

- **Arm E's `void-method-call` bucketing is KILLED**, and the disagreement the fixture's arm E comment
  flags is already closed. That comment asks this document to resolve a contradiction between the
  design's section 3.1 arithmetic, which derives KILLED, and its section 3.3 summary bullet, which once
  bucketed arm E under SURVIVED. Section 3.3 was corrected before this document was written and now
  reads "Arms A, C, D and E: predicted KILLED". The fixture comment is therefore stale in describing the
  inconsistency as live, and KILLED is the prediction on both the corrected summary and the arithmetic.
- **The pre-existing `SetFilter` site produces no `flip-filter-literal` mutant**, which is what the
  design predicted. `Data Ops.CountIgnoringMainFilter`'s filter text is the bare placeholder `'%1'`, a
  lone atom that matches no rule in the ladder, so the site refuses by ladder exhaustion rather than by
  parser refusal. Its two existing mutants are byte-identical BEFORE and AFTER, so its frozen verdicts
  must not move.

## Per-mutant prediction

All 32 deployed mutants, grouped by arm in census order. Rows marked NOT DEPLOYED are shown so this
table lines up against the census without a gap; they are not counted in the 32.

Every arm's covering test is the only test that calls that arm's procedure, so coverage filtering runs
each mutant against exactly one test, named per arm. Every count below is derived from the rows that
test itself seeds, and `Data Related` holds only those rows because BC rolls each test's writes back
between tests, which R32 measured.

### Arm A, `CountExcluding`, rule 1, the kill (4 deployed)

Covered by `NegationFlipChangesTheCount`, which seeds one row tagged `FILT-A1` and two tagged
`FILT-A2`, calls `CountExcluding('FILT-A1')`, and asserts 2. Three rows in the table. Baseline filter
`'<>FILT-A1'` matches the two `FILT-A2` rows.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 1 | `lethal.empty-block` | arm A's whole body -> `begin end` | **killed** | the body never runs, so the Integer function returns its type default 0, and 0 is not 2 |
| 2 | `lethal.void-method-call` | `Related.SetFilter("Main No.", '<>%1', MainNo)` -> deleted | **killed** | with no filter the count is the whole table, 3, not 2. Arm A is unscoped, so this is the only place a stray row could matter, and it cannot change the verdict: any extra row raises the count further from 2, never towards it |
| 3 | **`lethal.flip-filter-literal`** | `'<>%1'` -> `'=%1'` | **killed** | the flip counts `FILT-A1`'s own group instead of the other one, 1 rather than 2. This is rule 1's kill. See the platform-rejection note: a kill here could also arrive if BC refused the mutated filter outright, and a matching verdict does not by itself distinguish the two routes |
| 4 | `lethal.return-value` | `exit(Related.Count())` -> `exit(0)` | **killed** | 0 is not 2. The arm's asserted value is non-zero precisely so this collateral is not equivalent |

### Arm B, `AnyExcluding`, rule 1, the weak-assertion survivor (5 deployed)

Covered by `ExistenceOnlyAssertionMissesTheNegationFlip`, which seeds one row tagged `FILT-B1` and one
tagged `FILT-B2`, and asserts only that `AnyExcluding('FILT-B1')` answers true. Two rows in the table.
Baseline filter `'<>FILT-B1|FLT-NONE'` matches the one `FILT-B2` row, so the count is 1 and `1 > 0` is
true. `FLT-NONE` is the hash decoy and matches no row anywhere in the fixture.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 5 | `lethal.empty-block` | arm B's whole body -> `begin end` | **killed** | the Boolean function returns its default false, and the test's `if not ... then Error(...)` fires |
| 6 | `lethal.void-method-call` | `Related.SetFilter("Main No.", '<>%1|FLT-NONE', MainNo)` -> deleted | **survived** | with no filter the count is 2 rather than 1, but the assertion looks only at existence, and 2 is greater than 0 as well. Robust to any stray row, since more rows keep the answer true |
| 7 | **`lethal.flip-filter-literal`** | `'<>%1|FLT-NONE'` -> `'=%1|FLT-NONE'` | **survived** | the flip counts `FILT-B1`'s own group, 1, instead of the other group, also 1. Even had the two group sizes differed, an existence-only assertion cannot see which group was counted. This is the discrimination survivor, and the load-bearing prediction of the whole wave. A platform rejection of the mutated filter would flip it to killed, which is why the row is de-risked explicitly below rather than assumed |
| 8 | `lethal.return-value` | `exit(Related.Count() > 0)` -> `exit(not (Related.Count() > 0))` | **killed** | the baseline answer is true, so the negation returns false and the same assertion fires. This is why the arm asserts true rather than false |
| 9 | `lethal.conditional-boundary` | `Related.Count() > 0` -> `Related.Count() >= 0` | **survived** | a row count is never negative, so `>= 0` is a tautology and the function returns true unconditionally. The baseline also returns true, so nothing the test can seed separates them. **This is the operator the design's collateral list omitted**, recorded in the census finding above |

### Arm C, `CountBelowThreshold`, rule 2, the kill (5 deployed, 1 displaced)

Covered by `BoundaryShiftAdmitsTheThresholdRow`, which seeds three consecutive entries in the `FLT-C`
group at 79160, 79161 and 79162, plus one residue decoy at 79159 in the `FLT-C-RESIDUE` group, calls
the arm with Threshold 79162, and asserts 2. Four rows in the table, three of them in scope. Baseline
scopes to `FLT-C` then filters `'<79162'`, matching 79160 and 79161.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 10 | `lethal.empty-block` | arm C's whole body -> `begin end` | **killed** | returns 0, and 0 is not 2 |
| - | `lethal.void-method-call` | `Related.SetRange("Main No.", 'FLT-C')` -> deleted | NOT DEPLOYED | displaced by row 11, which proposes the identical deletion at a higher tier |
| 11 | `lethal.remove-setrange` | `Related.SetRange("Main No.", 'FLT-C')` -> deleted | **killed** | unscoped, `'<79162'` also admits the residue decoy at 79159, so the count is 3 rather than 2. The decoy is the only reason this collateral is killable rather than equivalent |
| 12 | `lethal.void-method-call` | `Related.SetFilter("Entry No.", '<%1', Threshold)` -> deleted | **killed** | the `SetRange` scope survives, so the count is all three `FLT-C` rows, 3 rather than 2 |
| 13 | **`lethal.flip-filter-literal`** | `'<%1'` -> `'<=%1'` | **killed** | the shift also admits 79162, which sits exactly AT the threshold, so the count is 3 rather than 2. A row sitting exactly at the boundary is the mechanism this arm exists to demonstrate |
| 14 | `lethal.return-value` | `exit(Related.Count())` -> `exit(0)` | **killed** | 0 is not 2 |

### Arm D, `CountBelowThresholdSparse`, rule 2, the equivalence survivor (5 deployed, 1 displaced)

Covered by `GapAtTheBoundaryMakesTheShiftEquivalent`, which seeds a sparse pair in the `FLT-D` group at
79170 and 79172 with a deliberate GAP at 79171, plus one residue decoy at 79169 in the
`FLT-D-RESIDUE` group, calls the arm with Threshold 79171, and asserts 1. Three rows in the table, two
in scope. Baseline scopes to `FLT-D` then filters `'<79171|999999999'`, matching only 79170. The
numeric decoy `999999999` is arm C/D's hash decoy and matches no row.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 15 | `lethal.empty-block` | arm D's whole body -> `begin end` | **killed** | returns 0, and 0 is not 1 |
| - | `lethal.void-method-call` | `Related.SetRange("Main No.", 'FLT-D')` -> deleted | NOT DEPLOYED | displaced by row 16 |
| 16 | `lethal.remove-setrange` | `Related.SetRange("Main No.", 'FLT-D')` -> deleted | **killed** | unscoped, `'<79171'` also admits the residue decoy at 79169, so the count is 2 rather than 1 |
| 17 | `lethal.void-method-call` | `Related.SetFilter("Entry No.", '<%1|999999999', Threshold)` -> deleted | **killed** | the scope survives, so the count is both `FLT-D` rows, 2 rather than 1. This is the KILLED half of the same-span pair with row 18 |
| 18 | **`lethal.flip-filter-literal`** | `'<%1|999999999'` -> `'<=%1|999999999'` | **survived** | no row sits at 79171, so `'<79171'` and `'<=79171'` select the identical single row, 79170. The mutant is genuinely equivalent, not merely unnoticed, and it stays equivalent no matter how much data exists elsewhere. The SURVIVING half of the same-span pair |
| 19 | `lethal.return-value` | `exit(Related.Count())` -> `exit(0)` | **killed** | 0 is not 1 |

### Arm E, `CountUpToBound`, rule 3, the kill (5 deployed, 1 displaced)

Covered by `RangeFlipChangesTheCountRegardlessOfInclusivity`, which seeds `FLT-E` rows strictly below
the bound at 79178 and 79179 and strictly above it at 79181, none exactly AT the bound of 79180, plus
one residue decoy at 79177 in the `FLT-E-RESIDUE` group, and asserts 2. Four rows in the table, three
in scope. Baseline scopes to `FLT-E` then filters `'..79180'`, matching 79178 and 79179.

The seeding is what makes this arm independent of the design's one unmeasured range-inclusivity
premise. Because no row sits at 79180, the baseline count is 2 whether the bound is read as inclusive
or exclusive, and the flipped count is 1 either way. No verdict in this arm depends on that premise.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 20 | `lethal.empty-block` | arm E's whole body -> `begin end` | **killed** | returns 0, and 0 is not 2 |
| - | `lethal.void-method-call` | `Related.SetRange("Main No.", 'FLT-E')` -> deleted | NOT DEPLOYED | displaced by row 21 |
| 21 | `lethal.remove-setrange` | `Related.SetRange("Main No.", 'FLT-E')` -> deleted | **killed** | unscoped, `'..79180'` also admits the residue decoy at 79177, so the count is 3 rather than 2 |
| 22 | `lethal.void-method-call` | `Related.SetFilter("Entry No.", '..%1', Bound)` -> deleted | **killed** | the scope survives, so the count is all three `FLT-E` rows, 3 rather than 2. The filter matches only a SUBSET of this arm's own seeded rows, because 79181 was deliberately placed on the far side of the bound, which is the identical mechanism that kills arms C and D. This is the reading the design's corrected section 3.3 carries |
| 23 | **`lethal.flip-filter-literal`** | `'..%1'` -> `'%1..'` | **killed** | the reversed open range matches only 79181 inside the scope, 1 rather than 2. This is rule 3's kill, and it holds under either inclusivity reading. See the platform-rejection note: `'79180..'` is a filter shape this fixture's baseline never evaluates |
| 24 | `lethal.return-value` | `exit(Related.Count())` -> `exit(0)` | **killed** | 0 is not 2 |

### Arm G, `CountDecoyOrTarget`, rule 4, the kill (4 deployed)

Covered by `DroppedPlaceholderFreeAlternativeChangesTheCount`, which seeds two rows tagged
`FLT-G-DECOY` and three tagged `FLT-G-TARGET`, calls the arm with `'FLT-G-TARGET'`, and asserts 5. Five
rows in the table. Baseline filter `'FLT-G-DECOY|FLT-G-TARGET'` matches all five. Arm G is unscoped,
because both of its tags are alternatives the filter itself matches.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 25 | `lethal.empty-block` | arm G's whole body -> `begin end` | **killed** | returns 0, and 0 is not 5 |
| 26 | `lethal.void-method-call` | `Related.SetFilter("Main No.", 'FLT-G-DECOY\|%1', MainNo)` -> deleted | **survived** | with no filter the count is the whole table, which is the same 5 rows the filter already matched, since this test seeds no others. UNCERTAIN, and the only data-sensitive row in the wave: see uncertainty 1 below |
| 27 | **`lethal.flip-filter-literal`** | `'FLT-G-DECOY\|%1'` -> `'%1'` | **killed** | dropping the placeholder-free alternative leaves only the target tag, matching 3 rather than 5. This is rule 4's kill, and the arm that shows why the rule's placeholder-free restriction keeps the call's own argument list untouched: `FLT-G-DECOY` was never backed by a call argument, so removing it needs no other edit |
| 28 | `lethal.return-value` | `exit(Related.Count())` -> `exit(0)` | **killed** | 0 is not 5 |

### Arm H, `CountInRange`, the closed-range refusal negative (4 deployed, 1 displaced)

Covered by `ClosedRangeCountIsScopedByMainNo`, which seeds `FLT-H` rows at 79190 and 79192 plus one
residue decoy at 79191 in the `FLT-H-RESIDUE` group, deliberately INSIDE the same numeric range but
tagged differently, calls the arm with LowBound 79190, and asserts 2. Three rows in the table, two in
scope. Baseline scopes to `FLT-H` then filters the closed range `'79190..79192'`, matching both.

| # | operator | before -> after | predicted | why |
| --- | --- | --- | --- | --- |
| 29 | `lethal.empty-block` | arm H's whole body -> `begin end` | **killed** | returns 0, and 0 is not 2 |
| - | `lethal.void-method-call` | `Related.SetRange("Main No.", 'FLT-H')` -> deleted | NOT DEPLOYED | displaced by row 30 |
| 30 | `lethal.remove-setrange` | `Related.SetRange("Main No.", 'FLT-H')` -> deleted | **killed** | unscoped, the closed range also admits the residue decoy at 79191, which sits inside it, so the count is 3 rather than 2. Placing the decoy inside the range and outside the tag is what makes this collateral killable |
| 31 | `lethal.void-method-call` | `Related.SetFilter("Entry No.", '%1..%2', LowBound, LowBound + 2)` -> deleted | **survived** | the scope survives and both of the arm's own rows already sit inside the closed range, so deleting the filter counts the same 2. Not data-sensitive: the decoy carries a different tag and the scope excludes it whatever its Entry No. |
| - | **`lethal.flip-filter-literal`** | the closed range `'%1..%2'` | **NOT EMITTED, and this is a prediction** | a closed range CLASSIFIES successfully but no rule in the ladder targets it, so the site refuses by ladder exhaustion rather than by parser refusal. The census confirms it offline: `flip-filter-literal` appears exactly six times in the AFTER run, at rows 3, 7, 13, 18, 23 and 27, and not here. Live, a mis-claim would splice a filter the ladder never validated, and the failure shape would be an aggregate mismatch, not a compiler message in the gate's output |
| - | `lethal.swap-call-arguments` | the two Integer arguments | **NOT EMITTED, and this is a prediction** | the upper bound is a computed expression, `LowBound + 2`, not a second bare identifier, so that operator's same-type-identifier-pair predicate does not match. Two bare identifiers would have produced a mutant whose verdict rested on whether BC normalises a reversed range inside a filter string, a platform question this arm cannot answer either way. The census confirms no such mutant |
| 32 | `lethal.return-value` | `exit(Related.Count())` -> `exit(0)` | **killed** | 0 is not 2 |

## Where this prediction is genuinely uncertain

**One uncertainty that could move a VERDICT**, and **one class that can move only a MECHANISM**. An
honestly flagged uncertainty is worth more than a confident guess, because the gate settles it either
way and a wrong confident guess damages the record. Equally, a flag on something determinable is
padding, so the unflagged rows are listed as a claim at the end of this section rather than left as an
omission.

**1. Arm G's `void-method-call`, row 26, predicted survived.** This is the only row in the wave whose
verdict depends on `Data Related` holding EXACTLY the rows its covering test seeds. Arm G is unscoped,
so deleting its filter counts the whole table, and the prediction that this equals the filter's own 5
requires no other row to be visible. Two things would break it. If R32's write rollback does not hold
within this run, another test's rows would be visible. If a previously aborted run left committed
residue, `ClearRelated` would not reach it, because that helper clears only the two tags this test
names. Either way the count exceeds 5 and the mutant is killed instead. **Settled by** the row's
verdict, and if killed, by `killingTestFailure` naming the count the test actually saw: a number above 5
identifies visible residue and is a platform or harness finding, not a defect in the arm.

Arm A's `void-method-call`, row 2, is the same unscoped shape and is deliberately NOT flagged. Its
prediction is killed at 3 against an asserted 2, and any extra visible row raises the count further from
2, so residue cannot change that verdict. The asymmetry is stated so it does not read as an oversight:
an unscoped deletion predicted KILLED is directionally safe, and one predicted SURVIVED is not.

**2. A mutated filter is DATA handed to BC at runtime, and every `flip-filter-literal` row inherits
that.** If BC rejects a mutated filter expression, the mutant scores `killed` on a platform error with
no assertion earning it, and nothing tags it, because the platform-artifact screen tags only mechanisms
an operator DECLARES and only `lethal.remove-commit` declares one today. This is roadmap R138's shape,
and R86 is why no kill records the cause it died of.

The consequence splits by predicted verdict, and the split is the whole point of naming it:

- **For the four kills, rows 3, 13, 23 and 27, a matching verdict does not prove the assertion caught
  the mutant.** Each is predicted killed on an assertion, with a specific count derived above, but a
  platform rejection of the mutated filter would produce the same word. The mutated filters at risk are
  arm A's `'=FILT-A1'`, arm E's `'79180..'` and arm G's `'FLT-G-TARGET'`, none of which this fixture's
  baseline ever evaluates. Arm C's `'<=79162'` differs from its own green baseline by one character in a
  comparator and is the least exposed of the four. **Settled by** `killingTestFailure` on each: it must
  be the arm's own bare `Error(...)` text naming the count, not a BC filter-evaluation message. A report
  on this run may say these four were killed. It may not say the suite caught them unless those four
  messages say so.
- **For the two survivors, rows 7 and 18, a platform rejection would flip the verdict outright**, so
  this is verdict-relevant rather than mechanism-relevant. Both are de-risked by their own baseline
  rather than by reasoning: arm B's baseline already evaluates `'<>FILT-B1|FLT-NONE'` green, which
  proves BC accepts a two-alternative filter carrying that text atom on a `Code[20]` field, and the
  mutant changes only the comparator token. Arm D's baseline already evaluates `'<79171|999999999'`
  green, and a probe measured the numeric decoy inert on the Integer field, and again only the
  comparator token changes. Neither is flagged as an open uncertainty on that basis, but if either
  arrives killed, `killingTestFailure` is what says whether the cause was a rejected filter or a count.

**The remaining 25 rows are unflagged, and that is a claim rather than an omission.** One row is
verdict-flagged, row 26. Six rows carry the platform-rejection mechanism note, rows 3, 7, 13, 18, 23
and 27, of which two are also verdict-relevant. Counting row 26 once, the flagged set is rows 3, 7, 13,
18, 23, 26 and 27, which is seven, and 32 minus 7 is 25 unflagged. Every unflagged row follows from a
type default, where an emptied body returns 0 or false, from a negation of a value the covering test
asserts is non-zero or true, from a tautology on a row count, or from a count derived from rows the
covering test seeds itself with a scope that excludes everything else.

## What must ALSO hold, and would be a finding if it did not

- **No pre-existing mutant may move.** `assertMatchesBaseline` checks that per mutant. The census makes
  this stronger than usual here: all 207 pre-existing raw specs reappear byte-identical, so every
  pre-existing baseline key is unchanged and the pre-existing verdicts must stay exactly 157 killed, 25
  survived and 10 no-coverage. In particular the pre-existing `SetFilter` site in
  `Data Ops.CountIgnoringMainFilter` must keep both of its mutants and both of its recorded verdicts,
  since a new operator claiming that bare-placeholder site would be the most likely way this wave broke
  something outside its own file.

- **The raw spec count is 243, not 244.** The extra one would be a `flip-filter-literal` mutant at arm
  H's closed range, which the ladder must decline. It is also not 245, which would additionally mean
  `swap-call-arguments` claimed arm H's argument pair.

- **`flip-filter-literal` appears exactly six times, once per arm A, B, C, D, E and G, and never at arm
  H.** Six is the number that says the operator claimed every shape the ladder covers and refused the
  one it defers. A seventh occurrence means the closed-range deferral broke. A fifth means an arm's
  shape stopped classifying.

- **All six of this operator's spans also carry a `void-method-call` mutant.** That is the dedup
  coexistence claim, and it is checkable directly from `report.mutants` by counting two mutants at each
  of the six spans. If any of the six spans carries only one mutant, dedup started treating a splice and
  a deletion as the same identity, which would be a wider regression than this wave.

- **`platformArtifactKills.killedCount` stays exactly 1**, `byMechanism` stays exactly
  `["write-txn-codeunit-run"]`, the screened mutant stays the `lethal.remove-commit` in
  `CommitThenRunValueForm`, and its verdict stays `killed`. Nothing this operator produces is tagged,
  because the screen tags only declared mechanisms and `flip-filter-literal` declares none. So the count
  staying at 1 is not evidence that only one platform artifact exists in the run. It is the measured
  size of the screen's blind spot, which `docs/roadmap/R138.md` holds open, and up to four of this
  wave's own kills could sit inside it, per uncertainty 2.

- **`untargetedTriggerCount` stays 0.** This wave adds no table and no trigger. Every one of the 32 new
  mutants sits inside a procedure of a codeunit, so all 32 take member-level attribution and none can
  reach the trigger fallback that this tally counts. Any non-zero value means a PRE-EXISTING trigger
  stopped attributing, which is a wider regression than this wave and must be diagnosed as one rather
  than attributed to the new arms.

- **The assertion screen still reports itself as `vacuous`.** All 51 tests in
  `fixtures/sandbox-data-tests` raise through bare `Error(...)` and none uses an assertion library,
  including all 7 new ones, so the screen flags every kill that carries failure text and separates
  nothing. Concretely: `assertionScreen.discrimination` is `vacuous`, `flagged` equals `killsWithText`,
  `killsWithText` is greater than 0, and `runnerRefusals` is 0. A `partial` would mean either the
  fixture grew an assertion library or the rule started matching something it was never scored on. The
  gate pins the DISCRIMINATION rather than a count for exactly this reason.

- **Exactly ONE baseline test failure, by name: `Data Tests.PageActionComputesNonZero`**, the TestPage
  test the fenced session refuses. Seven new tests must add none. The one shape that could have added a
  second is arm D's hash decoy, whose spec-stated text value was MEASURED to raise on an Integer field
  and was replaced with a numeric one before the fixture landed. That measurement is the reason this row
  is a prediction rather than a risk.

- **`error` must be 0.** All seven new tests must be green at baseline, because a mutant covered only by
  a non-green test is refused rather than scored, which is exactly what happened to five of the sibling
  wave's rows on its first run. If any row arrives `error`, the FIRST thing to check is whether the
  published test app is the current one, before re-deriving any platform behaviour.

- **The per-mutant review reads `report.mutants`, not baseline rows.** A baseline row carries no `file`,
  `procedureName`, `originalText` or `coveringTests`, and a survivor's killing test is null, so this
  table cannot be checked against the baseline file at all. Doing so would produce a confident, empty
  match, which is this project's signature bug. The same applies to the six spans check above.

- **The hash decoys must keep the arms distinguishable, and this was MEASURED for this document rather
  than reasoned.** Arms A and B were measured to collide in `astSubtreeHash` before their decoy was
  added, both hashing to the same value, and so were arms C and D. Hashing every spec this file produces
  at the committed fixture confirms the fix holds: `flip-filter-literal` has 6 specs and **6 distinct**
  hashes, `void-method-call` 11 and 11, `empty-block` 7 and 7, `remove-setrange` 4 and 4. A unit test
  asserts the same pairwise distinctness durably. If that test passes and the gate still reports a
  repeated baseline key across these arms, the decoy mechanism did not do its job and attribution in the
  diff is unreliable even where the verdicts match.

- **`lethal.return-value` in this codeunit collapses to TWO baseline keys, one of them with multiplicity
  six, and that is expected rather than a defect.** The same hashing run measures 7 `return-value` specs
  and only 2 distinct hashes: six arms end with the byte-identical `exit(Related.Count())`, and
  `astSubtreeHash` canonicalises the identifier text around it, so all six share one key. Only arm B's
  `exit(Related.Count() > 0)` stands alone. **All six are predicted `killed`**, so the multiset for that
  key is six kills with no survivor in it, which is what keeps `--skip-known-survivors` from matching a
  recorded survivor entry against one of them and skipping its execution. A survivor appearing in that
  group would be the hazard, and this table predicts none. Checking these six against baseline rows
  cannot tell them apart at all, which is why the per-mutant review must read `report.mutants`.

## What this wave does NOT prove

- **Any rate on real code.** The census counts syntactic sites, not killable ones, and no fixture turns
  one into the other. The population figures behind this operator, roughly 288 `SetFilter` calls in a
  658-file snapshot, count syntax and say nothing about how often a real suite would notice these
  mutants.
- **That the `<>` population is reachable at the rate its count suggests.** The most common `<>` idiom in
  real AL is `<>''`, which the parser refuses on the embedded quote before the ladder ever runs. Rule 1's
  real reach is materially below its raw site count and this wave does not measure how far below.
- **Anything about the wildcard, case-insensitive, AND-combinator or inner-quoting refusals.** The task
  brief asked this census to confirm that a `CountWild` site emits nothing. **There is no `CountWild`
  anywhere in the fixture**, so there was nothing to confirm. Arm H is this wave's only refusal negative
  and it exercises LADDER EXHAUSTION on a classified closed range, not the cheap character refusal. The
  character refusal is covered by unit tests only, and a live negative for it remains unbuilt. That gap
  is worth a roadmap row rather than an assumption.
- **Anything about closed-range mutation.** Arm H proves the REFUSAL holds. It says nothing about
  whether closed ranges are worth mutating some other way later.
- **Anything about equivalence RATES for the negation-flip or boundary-shift classes.** Arms B and D
  each demonstrate ONE deliberate equivalent survivor. Neither measures how often that class occurs.
- **The bare-atom versus explicit `=` equivalence.** The design flags this as reasoned and not measured,
  and after the corrections it is load-bearing for the emitted SPELLING only. No verdict in this table
  depends on it: arm A's flip is killed because `'=FILT-A1'` selects a different row set from
  `'<>FILT-A1'`, whether or not `'=X'` and `'X'` are interchangeable.
- **The one-sided range inclusivity claim.** Also reasoned and not measured, and arm E's reseeding is
  what removed every verdict's dependence on it. If a verdict in arm E contradicts this table anyway,
  inclusivity is not the explanation and something else must be diagnosed.
- **Anything about the assertion screen's discriminating power.** This fixture is the measured vacuous
  case, by construction, and seven more bare-`Error` tests do not change that.
- **Anything about the other three gates** beyond unchanged. Only `fixtures/sandbox-data` grew.

## The one thing this does NOT prove, stated plainly

**A matching verdict on the four `flip-filter-literal` kills does not prove a test caught them.** Three
of the four hand BC a filter string this fixture has never evaluated, and BC rejecting a filter scores
`killed` just as an assertion does, with nothing recording which happened. The wave's real claim rests
on the two SURVIVORS and on the arm C against arm D pair, because a survivor cannot be manufactured by a
platform error and a pair with identical shape and opposite verdicts cannot be manufactured by an
aggregate. If every kill matched and both survivors did not, this wave would have measured that the
operator claims sites and nothing more.
