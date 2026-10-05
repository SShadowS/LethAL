# R-454 plan r2: refuse three more hang-capable shapes, rule on the fourth, fix two weak tests

## Changelog (r1 -> r2), answering `/coord/handoff/R-454/review-gpt-6.1-sol.md`

1. **Member-key collision (Important 1): fixed.** Shape 3 no longer joins the receiver and the member
   into one string. The prototype keeps a `MemberRef { receiver, member }` and compares the two parts
   separately (`sameDeclaration` on the receiver, then the member name). The review's control
   (`"A.B".C` vs `A."B.C"` in one declaration list) is a test: red on the r1 joined key, green on the fix.
2. **Shape 2 hang judgement (Important 2): reclassified.** All 28 loop-condition sites re-read, and the
   test setup checked where it decides the outcome. r1's "22 really hang (21 test hangs)" is withdrawn.
   No site is an established hang. 13 are data-dependent (one-row page or similar), 15 end on any
   data. The refusal stays, on the conservative rule. Table in section 1.
3. **Shape 4 (Important 3): ruling narrowed.** The general claim "a bound change only changes the
   trip count" is withdrawn; the review's counterexample is false for it. Section 3 now proposes a
   ruling for the 7 inspected sites only, states the counterexample as the remaining risk, and keeps
   the narrow alternative.
4. **Collateral evidence (Important 4): replaced.** New exact diff: fails on any operator exception;
   lists every site keyed by file + span + operator, for `targets()` AND for `generate()` (with a hash
   of each generated text); attributes refusals (counted in hang-refused vs silent); and checks the
   removed set against the census's own expected set. Result on BaseApp, CDO and all 21 fixture
   projects: **removed set == expected set: yes**, nothing else moved. Section 2.
5. **Minor: added.** The member-branch outer-loop test (`while not R.Done` with an inner loop writing
   `R.Done`), and member refusals through all four operators, each checking generated-spec absence
   and the hang-refused count.

Worktree `/work/lethal-wt/r454`, branch `lethal/r454` off master `52b095ec`. Measured 2026-10-05,
offline. Scratch: `/tmp/claude-1000/-work-lethal-wt-lane-bugs/42bbe1d1-6c93-426d-bdfa-21fd7ce46008/scratchpad/r454/`
(`census-r454.ts`, `exact-sites.ts`, `compare.ts`, `run-diff.sh`, `proto/`). Nothing is committed.

## 1. Measurement (sites the current operators EMIT, untagged and not refused)

Corpora: BaseApp = `/work/src/BC.History/BaseApp` Source + Test (9,707 files, one semantic context).
CDO = `/work/src/do-lethal` Cloud + Test (658 files). Fixtures = every `fixtures/*` and `examples/*`
project with an `app.json` (21). Preprocessor arms not evaluated (every arm read as active), so the
counts are an upper bound.

| shape | BaseApp Source | BaseApp Test | CDO | fixtures |
| --- | ---: | ---: | ---: | ---: |
| 1 `shift-integer`, literal in a loop's `#if` condition tail | 0 | 0 | 0 | 0 |
| 2 `flip-boolean-literal`, literal inside a comparison in a loop condition | 3 | 25 | 0 | 0 |
| 2 same, in-loop `if` guard (R239 already refuses every in-loop `if`) | 4 | 0 | 1 | 0 |
| 3 member-target loop write, sites (mutants) | 11 (15) | 0 | 0 | 0 |
| 4 `swap-additive` on a loop-condition bound | 6 | 1 | 0 | 0 |

Shape 3's 15 mutants: `remove-assignment` 11, `swap-additive` 2, `flip-boolean-literal` 1,
`shift-integer` 1. The r2 key fix changes none of these counts: no corpus has the collision shape.

### Shape 2, reclassified (the 28 loop-condition sites)

The mutant turns `until X.Next() = false` into `until X.Next() = true`. After the first pass, if a
next row exists, `Next()` moves and returns true, and the mutant EXITS at once. Only when the page
starts on its last row (one row, for a `First()` loop) does `Next()` return false and the body run
again on the same row. Whether it then ends depends on the body: a queue read fails when the queue
is empty, a queue write fails past 25 items (`Library Variable Storage`), an array index fails past
its bound, and a counter fails on Integer overflow, but only after about 2^31 passes.

"Established hang" would need: no exit in the body, no progress, AND the test's own data reaching
that path. **No site meets all three.** Row counts were read from the calling tests, offline.

| class | sites | why |
| --- | ---: | --- |
| **Ends on any data** | **15** | |
| counter bound in the condition | 3 | `ResourceLabels` `VerifyAlternativeAddress`, `VerifyContactLabels`, `VerifyEmployeeLabels` (`and (Column <= 3)`) |
| `or <rec>.Next() = 0` arm still advances | 2 | `Rating.Table` `RatingDeadlock`, `ResAvailServiceMatrix.Page` `OnAfterGetRecord` (Source) |
| queue read in the body, fails when empty | 7 | `ItemReferenceListModalPageHandler` x4 (`ERMItemReferenceOther`, `-Purchase`, `-Sales`, `ServiceItemReference`), `SCMProdWhseHandling` `ProductionJournalHandlerWithQtyCheck` and `...AndPost`, `ServiceOrders` `ServiceLinesSequenceHandler` (here the flip gives the ordinary `= false` loop) |
| queue write in the body, fails past 25 | 2 | `SCMItemTracking` `ItemTrackingSummaryModalPageHandlerWithEnqueueLotNoAndQtys`, `UTItemTable` `CounStoretItemsFilteredOnPage` |
| array index in the body, fails past 10 | 1 | `SCMInvtItemTrackingIII` `GetNosFromItemTrackingEntries` |
| **Data-dependent hang-capable** | **13** | |
| body only counts; ends only on Integer overflow (~2^31 passes) on a one-row page | 6 | `CRMStatisticsFactBoxTest` x3 (test data 2, 2, 3 rows: the mutant exits after one pass and the assert kills it); `SCMItemCategories` `CountItemsFilteredOnPage` (test data 3, 2, 3 rows: exits); `SCMProductionOrders` `CountDemandForecastRows` (row counts not established); `ERMRSWizardWorksheet` `ConfigPackFieldsHandler` (test `OpenPageConfigPackageFieldWithFilters` shows exactly ONE row, so this test does reach the repeat path; it ends only by overflow, which no timeout waits for) |
| no progress, no other exit; never ends on a one-row page | 6 | `IncomingDocToDataExchUT` `AssertExpectedErrorSubstring` (one import error is likely, not established), `PaymentReconE2ETests1` `TestToggleShowNonMatchedLines` x2, `JobItemTracking` `SplitAndPostInventoryPickFromPage` (a split adds a row, so only a quantity-1 last line repeats), `PaymentServicesTest` `SelectPaymentServiceModalPageHandler` (`Previous() = false`), `WorkflowUITests` `FieldListWithFieldNameCheckPageHandler` (filter is a 2-letter caption prefix on Customer, several rows likely) |
| outer fixpoint loop | 1 | `UpdateContactClassification.Report` `UpdateRating` (Source): `until Changed = false` becomes "until something changed". The first pass changes something whenever any marked rating line is a leaf; it repeats forever only when none is (a rating cycle, which `Rating.Table`'s `RatingDeadlock` refuses on insert) |

So on the measured tests, one site (`ConfigPackFieldsHandler` under its one-row test) reaches the
repeat path, and it ends only by Integer overflow. Everything else either ends on any data or needs
data its tests do not obviously supply.

**Ruling kept: refuse all 28, silently, as R239 does.** The reason is the conservative rule, not a
measured hang: a flipped literal inside a loop's exit comparison removes or inverts the exit, and
whether that hangs depends on runtime data the tool cannot see. 7 of the 28 are in production code
or are page loops whose single-row case is ordinary data. The cost is 28 mutants in 9,707 files
(none on CDO or fixtures). The 4 + 1 in-loop `if` sites are R239's existing rule, not a hang claim.

### Shape 3 (unchanged from r1)

Hang when the write is the loop's only exit: `AccountingPeriodMgt` `AccPeriodStartEnd` (both the
deletion and the `true -> false` flip), `CalcItemAvailability` `FindForecastPeriodEndDate`,
`InventoryProfileOffsetting` `ForecastConsumption`, `WorkflowBuffer` `CopyWorkflow`. No hang: six
writes in loops that also end on `<rec>.Next() = 0` (`ItemTrackingManagement` x2,
`LateBindingManagement`, `CopyDocumentMgt` x3), and `Check.Report` `OnPostDataItem` (the body
reassigns the bound). These are also data-dependent in the same sense as shape 2: the "hang" ones
hang when the data reaches the write as the only exit, which is their normal path.

### Out of scope, found on the way (to file as a new roadmap item)

Writes to a target `resolveVarRef` cannot resolve, where the loop condition reads the same name:
BaseApp 38 sites / 50 mutants, CDO 2 / 2. Mostly implicit-`Rec` fields (13 table
`OnInsert`/`InitInsert` number-series loops, which hang on a number collision), plus report globals
and xmlport procedure locals (a probe confirms an xmlport local does not resolve; R127 says xmlports
deploy nothing, so those may be moot). `with` writes are the same unresolved case. R196 declines
unresolved targets on purpose (spec 3.1); widening that needs field resolution, not this task.

## 2. Changes (one detector, the existing walks)

1. **Shape 1.** Export `loopConditionParts(loop)` from `loop-hazard.ts` (the `condition` field plus
   direct `preproc_conditional_expression_tail` children, which `conditionIdentifiers` already reads)
   and use it in both `conditionIdentifiers` and `shift-integer.ts`'s `inLoopCondition`. An
   inactive-arm literal is never generated anyway, so the refusal needs no arm check. Loop-condition
   literal refusal (R164/R239 style): **silent**, not in the hang-refused row.
2. **Shape 2.** Add `comparison_expression` to `flip-boolean-literal.ts`'s `CONDITION_WRAPPERS`, so
   `isLoopCondition` walks up through a comparison. Same walk, same rule, so loop conditions and
   in-loop `if` conditions both. **Silent** (R239 scope), not counted.
3. **Shape 3.** In `classifyHangCapable`, when `assignmentTargetOf` returns null and the assignment's
   left side is a `member_expression` whose receiver is a bare or quoted identifier that
   `resolveVarRef` resolves, build a `MemberRef { receiver: <resolved symbol>, member: <normalised
   member name> }`. A condition read matches when **the member names are equal AND
   `sameDeclaration(receiver, receiver)` holds** — two separate comparisons, never a joined string.
   Walk every enclosing loop's condition plus tails (inactive arms and directive markers skipped).
   An unresolved receiver (`with`, implicit `Rec`) still declines. `assignmentTargetOf` is unchanged,
   because `census-hang-capable.ts` and `sample-declined-hang-capable.ts` assert it only returns
   identifiers. This IS the hang check, so all four operators' `refusesHangCapable` return true and
   the sites **count into R-447's hang-refused row**.

### Exact before/after diff (r2 evidence)

`run-diff.sh` runs `exact-sites.ts` twice per corpus (master `52b095ec`, then the prototype). It walks
every node as the orchestrator does (`visit`) and asks **every tier-1 and tier-2 operator**, with no
try/catch around the operator: any exception exits 1. It writes three key sets:
targets `<file>|<op>|<span>`, specs `<file>|<op>|<node span>|<before span>|<sha1 of generated text>`,
hang-refused `<file>|<op>|<span>` (`targets()` false and `refusesHangCapable()` true). The census
(also fail-on-exception now) writes the expected set from the shape rules on master: shapes 1-2 as
silent, shape 3 as counted. `compare.ts` then requires all of: targets removed == expected; no target
added; removed specs belong exactly to the removed targets; no spec added; hang-refused added ==
expected counted; no hang-refused removed; no shape 1-2 site in hang-refused. A sanity run with the
wrong expected set (CDO's against BaseApp) answers "no" and exits 1.

| corpus | targets before -> after | specs before -> after | hang-refused before -> after | expected silent / counted | removed by operator | removed set == expected set |
| --- | --- | --- | --- | --- | --- | --- |
| BaseApp | 1,815,104 -> 1,815,057 | 1,815,104 -> 1,815,057 | 1,772 -> 1,787 | 32 / 15 | flip 33, remove-assignment 11, swap-additive 2, shift-integer 1 | **yes** |
| CDO | 56,914 -> 56,913 | 56,914 -> 56,913 | 143 -> 143 | 1 / 0 | flip 1 | **yes** |
| 21 fixture/example projects | identical, every project | identical | identical (sandbox-hang 2 -> 2) | 0 / 0 | none | **yes**, all 21 |

Hang-refused added on BaseApp: remove-assignment 11, swap-additive 2, flip 1, shift-integer 1 (the
shape 3 mutants, exactly). **Nothing else moved**: no added site, no changed generated text, no other
operator. Note the diff counts sites before arm filtering (the orchestrator drops inactive-arm specs
later), so it is a superset of what a run emits; equality on the superset implies it on the run.

The existing `builtin-tier1` suite plus the new tests pass on the prototype (153 / 0).

### Red test per direction (conformance cases plus `loop-hazard.test.ts` and `refuses-hang-capable.test.ts`)

- Shape 1: refused `while false #if X or (Cust.Next() <> 0) #endif do;`; control in the same loop, an
  integer assignment in the body the condition does not read, still emitted. Red: drop the tail from
  `inLoopCondition`.
- Shape 2: refused `repeat ... until Done = true` and an in-loop `if Done = true then exit`; control
  in the same loop, `Flag := X = true`, still emitted. Red: remove `comparison_expression` from the
  wrappers.
- Shape 3, all red-checked on the prototype (each revert, the named test red, restored, 153 green):
  - `repeat R.Done := true; R.Other := true; R2.Done := true; until R.Done`: refused at `R.Done`,
    controls `R.Other` (other member) and `R2.Done` (other receiver) not. Red: compare the member name
    only -> the `R2.Done` control fails.
  - **Collision control** `var A, "A.B": Record ...; repeat "A.B".C := true; A."B.C" := true; until A."B.C"`:
    `A."B.C"` refused, `"A.B".C` not. Red: the r1 joined key -> `Received: "loop-condition-target"`.
  - **Outer loop, member branch** `while not R.Done do while I < 1 do begin I += 1; R.Done := true; end;`:
    refused. Red: stop the member walk at the nearest loop -> `Expected "loop-condition-target",
    Received null`.
  - **All four operators** on a table with typed fields: `remove-assignment` (`R.Done := true` vs
    `R.Flag := true`), `flip-boolean-literal` (the `true` in each), `shift-integer` (`R.Qty := 5` vs
    `R.Other := 5` under `while R.Qty <> 7`), `swap-additive` (`R.Qty - 1` vs `R.Other + 1` under
    `while R.Qty > 0`). Each asserts `targets` false and `refusesHangCapable` true at the refused node
    (counted), the reverse at the sibling, NO generated spec inside the refused node over a whole-file
    walk, and at least one inside the sibling. Red: delete the member branch -> all 4 fail (7 tests
    fail in total with the three above).
  - Pin that shapes 1 and 2 are NOT counted (`refusesHangCapable` false), since a counted silent
    refusal would be the opposite error.

## 3. Shape 4: ruling proposal, LEAVE these 7 (do not refuse)

**Withdrawn from r1:** "changing a bound only changes the trip count while the counter advances" and
"a hang needs a loop that was hang-prone before mutation". Both are false. The review's counterexample:

```al
I := 0; N := 3;
while I < N - 1 do
    if I < 2 then
        I += 1;
```

The original ends (I reaches 2). Mutating only the bound to `N + 1` lets the loop run at `I = 2`, where
the body no longer advances, and it never ends. A bound mutation can ADD iterations on which the body
does not advance, and the original never ran those.

**Proposed ruling text** (for the R454 closing note and `swap-additive.ts`'s doc comment):

> R454 point 4, closed 2026-10-05 by ruling: `swap-additive` keeps loop-condition bounds. Corpus
> evidence, not a general rule: the 7 such sites on BaseApp (6 Source, 1 Test; 0 on CDO, 0 on
> fixtures) were each read and none can loop forever: `RecordMatchMgt`
> `GetLongestCommonSubstring` x2 (inner loop, `j += 1`), `UserTask` `CreateRecurrence`
> (`Counter := Counter + 1`) and the Test site (`SCMItemAttributes`, `I += 1`) advance their counter
> unconditionally on every pass; `ServiceCalcDiscount` `GetNewServiceLineNoBias` has a
> halving second conjunct that ends it; `PhysInvtCountManagement` `CalcPeriod` errors on an array
> index past its bound (its `repeat` steps `i` unconditionally); `OpenXMLManagement`
> `CopyDataToExcelTable` (the one equality bound, `until ColumnsCount = DataTableColumnsCount - 1`)
> steps by 1 from 0, so the `+ 1` mutant reads `DataTable.Columns.Item(<column count>)` and ends on a
> .NET index error before it reaches its new target. Remaining risk, accepted: a bound mutation can add iterations on
> which the body does not advance (a conditional step, as in `while I < N - 1 do if I < 2 then
> I += 1`), so on another codebase such a site can hang. The run's existing hang handling (timeout,
> strand, quarantine) is what catches it. Revisit if a hang from this operator is ever measured.

**Residual risk filing:** state it in the R454 closing note (above). If the orchestrator prefers a
standing record, file it as its own roadmap item ("`swap-additive` loop-bound mutation can add
non-advancing iterations; conditional-step loops are not refused"), status open, evidence this plan.

**Narrow alternative**, if the owner prefers caution: refuse a loop-bound `swap-additive` only where
the loop body's step on the condition variable is conditional or absent (the counterexample's
shape), or, simpler and blunter, refuse equality bounds only (1 site). Neither is proposed by default.

## 4. The two weak tests (both strengthened and red-checked in the prototype)

- `loop-hazard.test.ts` "CLAIMS through an OUTER loop, not only the nearest one": move `Outer += 1`
  inside the inner loop's body (`while Inner < 3 do begin Inner += 1; Outer += 1; end;`), so the
  nearest loop's condition does not read it. Red-checked: making the walk stop after the nearest loop
  fails it (`Expected "loop-condition-target", Received null`); restored, green. The member branch
  has its own copy of this test (section 2).
- `orchestrator.test.ts` "built-in operators REFUSE the loop's step...": add
  `expect(texts).not.toContain("Remaining - 1")` (swap-additive's `before` is the expression, not the
  statement), plus the control `expect(texts).toContain("Remaining + 1")`. Red-checked: dropping only
  swap-additive's hang refusal fails the new assertion; restored, green.

## 5. Fixtures, gates, identity

- **Fixtures:** byte-identical, re-confirmed by the exact diff above (all 21 projects: targets, specs
  with generated-text hashes, and hang-refused identical). r1's `lethal run --dry-run` listings were
  also identical. No fixture loses a mutant, so no frozen gate figure moves (itest:hang included) and
  no pre-commitment is needed. Re-run `run-diff.sh` (fixtures part) on the real change before submit.
- **Identity:** on real projects sites disappear (BaseApp 47 mutants, CDO 1), so a later same-tuple
  twin can take a refused mutant's ordinal and key. Bump `IDENTITY_SCHEME` to **S (assigned by the
  orchestrator)** (master is 11, R-254 holds 12) with a doc-comment entry in `project.ts`. Operator
  versions stay 1.0.0, as R196 and R239 left them.
- **Roadmap:** R454 points 1-3 done, point 4 closed by the ruling in section 3 (residual risk stated
  there, or filed separately if the orchestrator prefers), and the unresolved-target finding filed as
  a new item (re-check the next free id first; R455 is the highest today).
- Loop: typecheck, `rm -rf packages/*/dist`, `bun scripts/verify.ts`, biome on touched files,
  `bun test scripts/line-citations.test.ts` for the roadmap edit, then branch CI green on both jobs.
