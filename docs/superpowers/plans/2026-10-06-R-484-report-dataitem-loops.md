# R-484 plan r5: a report data item over `Integer` counts as a loop for the hang refusal

Evidence: `survey.md` (r2 to r5). Base: master `8e1c27fa`, scheme 27. Reviews: sol r1 to r4. Prototype: scratch `proto/`.

## The rule
A data item is a loop: BC calls `OnAfterGetRecord` once per record. Over `Integer`, the item ends only when
something inside it ends it. CAP is 1,000,000 records. Run `bun scripts/verify.ts` at build time.

**Mention scan** (`mentionScan`). An operational mention of the item's record is either:
- the item's name used anywhere in the WHOLE report object: any trigger, request page, procedure or property, inactive
  arms included, as a receiver, an argument, a field-access object or a `with` subject. A declared name, a source
  table and a member half do not count; or
- ANY unqualified call in one of the item's own triggers, because its receiver may be the implicit record.

There is no list of methods. `Src.CopyFilter(Number, D.Number)`, `D.Copy(Src)`, `Clear(D)`, `Widen(D)` and a child
trigger's `D.SetRange(...)` are all mentions.

1. **Bounded** (not a loop) ONLY when one of these holds:
   - `MaxIteration` is a literal from 1 to CAP. 0 means no limit. This is a report-engine limit that no filter can
     replace, so it counts no matter what the mention scan finds;
   - `DataItemTableView` filters `Number`, AND the scan finds ZERO mentions. The filter is either `const(...)`, or
     `filter(...)` where every `|` item is an integer or an `a..b` range with a <= b, and the inclusive sum is at
     most CAP. A reversed range voids it;
   - the SINGLE-MENTION certificate: the scan finds EXACTLY ONE mention, `SetRange(Number, v)` or
     `SetRange(Number, lo, hi)`. It needs integer literals, lo <= hi and hi - lo + 1 <= CAP. It must sit in the item's
     own `OnPreDataItem`, unconditionally (only `begin`, `end` or `#if` above it, and no `exit` before it), in an
     ACTIVE arm.

   A variable bound is not a bound. Known cost: an unqualified `Error(...)` or any other call in the item's own
   triggers voids the view and SetRange certificates. That is the safe direction.
2. **Exit parts of an open item** (read with R446's ANY-guard walk):
   - the guards of `Break`, `Quit` and `Error` (outside `asserterror`) in the item's own `OnPreDataItem` and
     `OnAfterGetRecord`;
   - the guards of `Quit` and `Error` in every trigger of every nested item. A nested `Break` is not an exit;
   - the arguments of every `SetRange` and `SetFilter` on the item in its own triggers, so writes to a variable
     bound are refused.

   Not exits: `exit`, AL `break`, `Skip`, and guards in the item's own `OnPostDataItem`.
3. **Refused:** a value-operator write in any trigger of the item, or of a nested item, whose target an exit part
   reads. The match uses `sameDeclaration` plus the unchanged R-364 and R-458 name paths. Each refusal is counted
   through `refusesHangCapable`.
   - All four operators share this rule. swap-additive only emits where its operands resolve: a literal resolves, a
     bare global does not (R294).
   - Stated over-refusal: nested writes that cannot reach the parent, and the item's own OnPostDataItem reset
     (`ErrorCounter := 0`, 74 sites).

## Code
- `packages/builtin-tier1/src/loop-hazard.ts`, about 230 lines:
  - add `enclosingExitParts`, `dataItemExitParts`, `mentionScan`, `certified`, `rangeCallOf`, `unconditional`,
    `closedFilter`, `endsReport`, `ITERATION_CAP` and small helpers;
  - split `exitGuards` out of `bodyExitGuards`, and `isReportExit` and `isRaisedError` out of `exitsLoop`;
  - drop the `R484_CAP` env switch.
- `IDENTITY_SCHEME` 27 -> **28** in `packages/schemata/src/project.ts`, plus the tests that pin it.

## Measured diff vs 8e1c27fa (complete identity-keyed dumps, all operators)
- BC.History: **609** sites move from emitted to hang-refused. 0 changed, 0 appeared.
  - By operator: remove-assignment 362, flip 172, shift 75, swap-additive 0.
  - By project: BaseApp 589, Withholding Tax 18, BankDeposits 2.
- That is 8 more than r4, all view items that now have mentions: `WorkDescriptionLine` writes in 6 Standard Sales
  reports, and `IsHandled` twice in `CreatePick`. 457 of the 762 `Integer` items are now loops.
- CDO, DO, DC, fixtures and examples: identical.
- **216 keys move**, so the scheme goes to 28. Branch check: the same 609 sites and 216 key moves.

## Gates
No fixture has an `Integer` data item, and every fixture dump is identical. No gate figure moves, so no
pre-commitment is needed.

## Tests (51 in `loop-exit-refusal.test.ts` "R484", 5 in `refuses-hang-capable.test.ts`)
Each goes red under its own named revert (survey r2.4, r3.3, r4.3, r5.3). New in r5:
- a const view replaced by `D.SetRange`;
- a closed view replaced by `D.SetFilter`;
- a closed view replaced through a CopyFilter destination;
- a const view replaced in a child trigger;
- a control: MaxIteration plus a widening `D.SetRange` stays bounded.

The view and SetRange controls without mentions still pass.

## Exclusion item (draft; placeholder R4xx, file at build time)
> **R4xx: hang shapes R484's data-item refusal does not see: measure each, then refuse or rule.**
> Found 2026-10-06 building R484 (plan r5; sol reviews r1 to r4). R484 refuses writes read by an `Integer` data
> item's Break, Quit and Error guards and by its own SetRange and SetFilter bounds. These shapes are not seen, and
> none is shown safe:
> 1. An exit behind a call (`if Done then Fail()`).
> 2. An indirect feed: there is no R480 closure (`I += 1; Done := I > 3; if Done then Break`).
> 3. Items over ordinary tables, including a trigger that inserts into the temporary set it walks.
> 4. `Date` items; writes in called procedures; reportextension `modify(...)` triggers; XMLport `tableelement`
>    over `Integer`.
> 5. A bound variable set through another record (`Src.SetRange(Number, 1, N); Src.CopyFilter(Number,
>    D.Number)`): the item is open, but writes to `N` are not refused.
> 6. Condition-side mutants of a data-item Break guard.
> Measure each first on BaseApp, CDO, DC and DO with the R-484 dumps and read a sample. Then refuse it or rule on it.

Then mark R484 `done (<commit>)` and regenerate `ROADMAP.md`. Other tables are out of scope (item 3).

## Changes since r4
1. HIGH: the mention scan is extracted. A const or closed view now counts as a bound only when the scan finds ZERO
   mentions. Red-checked: direct `D.SetRange` and `D.SetFilter`, a CopyFilter destination, and a child-trigger
   replacement.
2. MaxIteration from 1 to CAP is an independent certificate. A control pins that it holds under a widening filter,
   and "or MaxIteration" is gone from the exclusion item.
3. Re-measured: 609 sites (8 more than r4), and keys still move 216.
