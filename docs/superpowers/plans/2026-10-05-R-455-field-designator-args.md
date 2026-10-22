# R-455: field-name arguments are never swapped; unqualified calls in record scope are untyped; case-insensitive pairs (short plan, r2)

**r2: gpt-6.1-sol round 1 (`/coord/handoff/R-455/sol-review-r1.md`), applied on top of the r1 body below:**
1. **The field table is complete for the measured names.** It adds `ModifyAll` (position 1), `FieldName` (1), `FieldActive` (1), `SetAutoCalcFields` (all), and `CopyFilter` at positions 1 AND 3 (`R.CopyFilter(SourceField, DestRecord, DestField)`). No speculative names: no TransferFields, report or XmlPort methods without binding evidence. RecordRef's `Field`/`FieldIndex` take numbers, so they are not listed. Name-only exclusion is stated as conservative: a custom procedure or value-taking overload with one of these names loses swap sites at those positions; it never gains a wrong one.
2. **Positions.** Comment children are removed first; then ALL argument expressions are numbered (literals, quoted identifiers and nested calls advance the count); then the eligible identifiers are filtered. The method name comes from the call's `function` field, and for a member call from its `member` field, as `callType` reads it; never from the whole call's text.
3. **Unmasked tests.**
   - The wrong-mutant pin uses SAME-typed names: `R.Validate(Name, Other)` with Integer locals `Name, Other` and a Text field `Name`. Today it is swapped; after the fix it is not. The r1 `Validate(Name, T)` case already fails the same-type check, so it stays only as documentation of the binding.
   - The case fold is tested on a NON-builtin call, `Take(ID, Id)`, so the field table cannot mask it.
   - The position test uses `R.SetRange("Field Name", A, B)` (a quoted first argument advances the count), plus a comment-inside-arguments control and a nested-expression control.
   - Item 2 starts from VALID AL: `F() + F()` inside `with R do`, where the table's `F(): Text` shadows the object's `F(): Integer` (Text + Text is concatenation). The assertion is that no `swap-additive` mutant turns it into `-`. Plus a request-page/report-dataitem case. Typing outside these scopes is kept (control).
4. **`callType`'s refusal** reuses the CONTEXT predicate behind `implicitRecordShadowsGlobals` (report dataitems and dataset sections, request pages with `SourceTable`, pageextensions, `TableNo` OnRun) and `insideWithBody`, not `resolveIdentifierType`'s locals-first flow. It also covers a quoted unqualified callee (checked for its raw kind).
5. **Quotes:** `normalize` only collapses whitespace. Quoted arguments stay ineligible for swapping, as today, with a test that pins it. The case fold is for unquoted identifiers.
6. **Scheme 13 with a behavioural test:** removing an earlier identical `F() + F()` mutant inside `with` moves a surviving twin's ordinal outside it. The test shows the key moves; the constant pin is kept as well.

Task: `/coord/tasks/R-455/task.md`. Item: `docs/roadmap/R455.md`. Measurement: `/coord/handoff/R-455/measurement.md`. Worktree `/work/lethal-wt/r455`, branch `lethal/r455`, from master 191586db. Orchestrator rulings: (1), (2), (3) and (4) approved; `IDENTITY_SCHEME` 13 (R-254 holds 12 and is blocked; if I am ready first, the orchestrator orders the merges and nobody renumbers).

## 1. Measured (alc 18.0.43)
- **The binding.** In a record builtin's field-designator argument, the record's FIELD wins over a same-named local: `R.SetRange(Amount, Value)` compiles; the swapped `R.SetRange(Value, Amount)` fails with AL0166 ("must be a member ..."). `R.Validate(Name, T)` compiles with an Integer local `Name`, because `Name` binds to the Text field. The same holds for SetFilter, Validate, TestField, FieldError and `Query.SetRange`. Value arguments do not see fields (AL0118).
- **Item 1: WRONG mutants.** BaseApp: 28 swaps alc rejects (AL0166): Validate 16, SetRange 5, TestField 4, SetFilter 2, Query SetRange 1. Plus 1 swap that filters a different field, and 4 equivalent swaps. CDO: 0.
- **Item 2:** inside `with R do`, and in R-294's implicit-record scopes, an unqualified `F()` calls the TABLE's method (AL0122, AL0175). Today's engine types it from the enclosing object. 0 wrong in either corpus; shown by synthetic shapes only.
- **Side defect (3):** `swappablePair` can emit a case-only swap (`SetRange(ID, Id)`), an equivalent mutant: 1 in BaseApp.

## 2. Changes
1. **Field-designator arguments are never swapped** (`swap-call-arguments.ts`). A table of field-designator methods (case-insensitive), each mapped to the argument POSITIONS that name fields:
   - every position for `CalcFields`, `CalcSums`, `SetLoadFields`, `SetCurrentKey`, `AddLoadFields`;
   - position 1 for `SetRange`, `SetFilter`, `Validate`, `TestField`, `FieldError`, `FieldNo`, `FieldCaption`, `GetFilter`, `GetRangeMin`, `GetRangeMax`, `CopyFilter`.
   The exact list is taken from the measurement's 20 names, checked against BC's record/query method list.
   - The rule applies by METHOD NAME, to a member call (`R.SetRange(...)`) AND to an unqualified call (an implicit record). That is the safe direction: a custom codeunit procedure named `Validate` only loses swap sites at those positions.
   - Positions count in the FULL argument list, not among identifier arguments: `swappablePair` filters arguments to identifiers today, so the original position has to be kept alongside.
   - Swaps between the remaining VALUE arguments stay, e.g. `R.SetRange(F, A, B)` -> `R.SetRange(F, B, A)`.
2. **Unqualified calls in a record scope are untyped** (`callType` in `types.ts`). An unqualified call inside an explicit `with` body, or in one of R-294's implicit-record contexts, gets no type. The rule reuses R-294's existing predicates (`insideWithBody`, and the context test behind `implicitRecordShadowsGlobals`), so the two rules cannot drift apart.
3. **Case-insensitive pairs.** `swappablePair` compares the two argument texts case-insensitively (AL names are case-insensitive), so `ID`/`Id` is not a pair.
4. **Point 4's weak tests.**
   - `r294-implicit-with.test.ts` "reportextension modify: no swap" passes either way, because reportextension has no indexed scope. It is relabelled as a non-load-bearing pin and kept, or replaced by a case that can fail, if one exists.
   - `types.test.ts` n9 gets an isolated twin on a page WITHOUT `SourceTable`, so it fails if named-return blocking breaks.
5. **`IDENTITY_SCHEME` 13**, with every literal bumped in one commit (as R-405a did) and a doc-comment line citing R455: removed swaps move later same-tuple ordinals.
6. **R455 text:** the item's text says "WRONG mutants found", with the counts above.

## 3. Tests (test-first; each red-checked with the `mutation-red-checker`)
- **Wrong-mutant pins:** `R.Validate(Name, T)` with an Integer local `Name` gives no swap; `R.SetRange(Amount, Value)` with Integer locals `Amount, Value` and a Decimal field `Amount` gives no swap.
- **Controls:**
  - `R.SetRange(F, A, B)` with A and B the same type IS swapped to `(F, B, A)`, the value-argument direction;
  - a non-builtin call `Take(A, B)` still swaps;
  - an unqualified `SetRange(Amount, Value)` in a page with `SourceTable` is not swapped at position 1.
- **Item 2:** `F() - F()` inside `with R do`, where the table's `F(): Text` shadows the codeunit's `F(): Integer`, gives no swap-additive mutant; the same in a page with `SourceTable`. Control: outside `with` it is typed and mutated.
- **Item 3:** `SetRange(ID, Id)` gives no swap. Control: two different names of the same type swap.
- **Red-checks, each against a specific wrong fix:**
  - drop the field-position table (the pins go red);
  - exclude the whole call instead of its positions (the value control goes red);
  - count positions among identifiers only (a shape with a literal first argument goes red);
  - drop the `callType` refusal (item 2 goes red);
  - drop the case fold (item 3 goes red);
  - leave the scheme at 11 or 12 (the scheme pin goes red).

## 4. Measure and gates
- **Gate capture diff,** master vs branch, every gate project under its sets. A tables-fixture site at one of these positions would move a frozen figure: pre-commit it, or STOP, before any gate.
- **Corpus re-run:** confirm the 28 wrong swaps are gone and record the removed and kept sites.
- **Then:** `itest:alrunner`; bcdev and tables only if the capture diff is non-empty; branch CI green on both jobs.
