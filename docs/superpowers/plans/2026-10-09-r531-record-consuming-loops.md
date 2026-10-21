# R-531 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`. Every widening below is
RE-MEASURED before the build (corpus dumps on the census projects). The orchestrator's line applies: a part that
adds more than about 0.05% on a corpus, or needs a new resolution rule, is split into its own item.

## Consumers widened
- **F1, one hop into same-object callees.** A call in the loop body that passes R (a `var` parameter), or that
  reaches R as a global, the implicit Rec or a table procedure on R, is followed ONE hop into its same-object
  callee, reusing R500's `oneHopReach` resolution.
  - In the callee, the consumer set and the BASE refusal apply to the callee's body: the consumer, the blocks
    holding it, and its guards.
  - Limits, stated in R531: cross-object callees, DotNet, and more than one hop.
  - Concrete site: DC `CDCContiniaConfigSubpage` `ModifyChildRecords` -> `DequeueTempConfigLine`.
- **F2, filter- and mark-changing calls are REFILTER consumers.** Reset, Copy, CopyFilter(s), SetView,
  SetRecFilter, FilterGroup, Mark, MarkedOnly and ClearMarks on R. A receiver that is a variable assigned from R
  (`R2 := R`) or shared by `Copy(R, true)` counts as R, through a same-procedure alias scan. Before the build I read
  the 13 consumer-less cursor loops (BC 10, DC 3), classify them, and record them in R531.
- **F3, `modify-unseen` is stated, and the narrowing is bounded.** A `Modify` of R counts as a consumer when any
  field written before it is filtered. If R is NOT a plain local (a global, a parameter or the implicit Rec), every
  written field counts, because its filters can be set elsewhere.
- **F4, indirect feeds.** R480's `indirectFeeds` runs over each consumer's arguments and guards, and over pre-loop
  filter arguments: a local assigned in the same scope and then used there has its writes refused like the
  consumer. Guards around a pre-loop filter call are refused too.
  - This is the part most likely to cost more, so it is measured alone. If it is over the line it is split off.

## NEG becomes an allowlist of one exemption (F5)
Every operator inside a loop's cursor condition is refused except `swap-find-direction`, which swaps only
FindFirst and FindLast, both of which answer "is the set non-empty". Today this is the same 4 operators at 0
extra cost, and it fails safe for any future operator. The r1 remark about `Find('-')` is dropped.

## Required operator parameter (F6)
`openItemHangRefuses(node, ctx, op)` takes `op` as REQUIRED. The one production caller (orchestrator.ts) passes
the operator name, and tests pass a name or `undefined` explicitly.

## Tests (F7, amending r1)
- **One test per consumer kind** asserts the kind LABEL the classifier returns, and is red-checked by disabling
  that kind alone (Delete, DeleteAll, Rename, refilter, mark, modify-filtered, modify-unseen, delete-reinsert,
  pass-rec, recv-proc, global-call, alias).
- **Delete-then-reinsert:** asserts the refused `remove-assignment` of the KEY-FIELD write.
- **The `or` test:** asserts a refused BODY site.
- **NEG fixtures:** have a consumer in the body.
- **F1:** DC's shape on own-code AL; the callee's `Delete()` void-method-call is refused. Red: no hop.
- **F4:** the `Last := R."No."; R.SetFilter("No.", '>%1', Last)` stepping loop; the feed's `remove-assignment` is
  refused. Red: no indirect feeds.

## Before the build
1. Re-measure with all of r2 in the prototype, F1 to F4 each attributed separately: deployed removed and % per
   corpus, tuples and ordinals (named), BaseApp both legs in one sitting.
2. Read the 13 consumer-less loops.
3. Report to the orchestrator; split off any part over the line.


---

# R-531 plan r1 (lethal-code): refuse the mutants that can hang a record-consuming loop

Base: master d5a1650e (scheme 38). Branch `lethal/r531`. Measurement, census, sample and prototype diff:
`/coord/handoff/R-531/measure.md` (with its addendum) and `prototype.diff` beside it.

Orchestrator rulings:
- refusal only; unknown operations count as consuming;
- (a) no exemption for an `or` operand that is not a cursor test, with the 4 sampled false positives named in
  R531 as the known cost;
- (b) include the pre-loop filter refusal and the negated-condition refusal, both scoped to loops of this shape;
- scheme 39.

## The shape
- **The loop:** a `while`/`repeat` whose condition (the until-condition, for `repeat`) calls a cursor method on a
  record R: `Find`, `FindFirst`, `FindLast`, `FindSet`, `IsEmpty`, or a `Count` comparison. NOT `Next`.
- **The consumer:** the loop's BODY holds at least one consumer of R:
  - `Delete`;
  - `DeleteAll`;
  - `Rename`;
  - a `Modify` after writing a field R's filters read;
  - `ModifyAll`;
  - a delete-then-re-`Insert` with a filtered field changed;
  - a REFILTER (`SetRange`/`SetFilter` on R inside the loop);
  - a call passing R;
  - a same-object call;
  - an unknown method on R. Unknown counts as consuming.
- **Not the shape:** `repeat ... until R.Next() = 0` with a consumer inside (4,760 such loops in BC.History).
  `Next` advances regardless of the consumer, so these are never refused.

## Change: three refusals, in R501's dispatch check (`openItemHangRefuses`, every operator)

1. **BASE: inside the loop body.** Refuse a site that:
   - lies inside a consumer (the call and its arguments, or the filtered-field write and its value); or
   - contains a consumer (its statement or block, `empty-block` of the body or a branch, `loop-skip`/`loop-truncate`
     of an inner loop holding it); or
   - lies in a guard between the consumer and the loop, collected by R446's `exitGuards` climb (`continue` guards
     included).

   Not refused: the loop condition (see 3), exit/break/`Error` (each ends the loop), anything outside the loop.
2. **FILTER: before the loop.** Refuse every site inside a `SetRange`/`SetFilter` on R that ends before the loop
   in the same procedure or trigger, when the loop's termination depends on that field. That means:
   - the consumer modifies the field (a write before `Modify`, or before a delete-then-re-`Insert`, or a
     `ModifyAll` field); or
   - the consumer is a `Rename`, where every filter on R in that scope counts, since the renamed key fields are
     unknown without the table's key.

   The refused sites include `remove-setrange`, `void-method-call`, `flip-filter-literal`, `swap-call-arguments`
   and `swap-rec-xrec`. The last is a real hang: in an OnRename loop, `xRec.Name` becoming `Rec.Name` finds the
   renamed lines for ever.

   Not refused: guards around the filter call; filters in another scope; filters set through a procedure. The
   last is the CDO/DO miss below, filed separately.
3. **NEG: the loop's own condition.** Refuse exactly `negate-conditional`, `remove-not`, `negate-guard` and
   `conditional-boundary` inside the cursor condition: each can leave the test true on an empty set.
   - `swap-find-direction` is not refused: `Find('-')`, `FindFirst` and `FindLast` all answer "is the set
     non-empty".
   - `loop-skip` and `loop-truncate` are not refused: they end the loop.
   - Plumbing: `openItemHangRefuses` gains an optional third parameter, the operator name, passed from the dispatch
     call. Callers that pass none keep today's behaviour.

## Measured (master d5a1650e vs the prototype with all three on)

| corpus | deployed removed | % of corpus | tuples moved | ordinals moved |
|---|---:|---:|---:|---:|
| BC.History | 591 (base 447 + FILTER 84 + NEG 62) | 0.026% | 0 | 35 (all BaseApp: base 31 + FILTER 4) |
| CDO | 6 | 0.011% | 0 | 0 |
| DC | 17 | 0.009% | 0 | 0 |
| DO | 6 | 0.008% | 0 | 0 |
| fixtures (19 projects) | 0 | 0 | 0 | 0 |

- 0 added; `skipped` equal everywhere; hang-refused delta equals the spec delta.
- 5 kill tags go with removed sites, and none changes. No live gate can move.
- Every BaseApp procedure and every ordinal move is named in `measure.md`. The R531 text names the largest
  (DateCompressGeneralLedger, Apply*Entries HandleChosenEntries, SuggestVendorPayments) and all 35 ordinals.

## The miss, filed as its own item
In CDO and DO the OnRename loops take their filter from a TABLE PROCEDURE (`SetTemplateFilter(xRec)`,
`SetEMailTemplateLineFilter(xRec)`), not from a direct `SetRange`. FILTER does not see them; catching them needs a
call-following resolution rule. File it with the sites (next id checked immediately before writing).

## Scheme 39
`IDENTITY_SCHEME` 38 -> 39. The chain comment says: "39 R-531 (35 BaseApp ordinals renumber; no tuple moves)".
The pins are the same nine places as R-555:
- the eight identity tests;
- `resume.test.ts` (the pin, and the PINNED digest recomputed);
- the report-equality snapshot;
- the sandbox-harden marks file;
- the agent guide.

## Tests (red-checked one direction at a time; read the full output, never a tail)
- **BASE refuse, per consumer kind:** `while R.FindFirst() do begin ...; R.Delete(); end`, and likewise for
  DeleteAll, Rename, Modify of a filtered field, delete-then-re-Insert, refilter, a call passing R, and an unknown
  method. The consumer, its block and its guard are refused. Red: drop the base rule.
- **BASE controls:**
  - `repeat ... until R.Next() = 0` with a Delete: not refused. Red: count `Next` as a cursor condition.
  - An exit/`Error` inside the body: not refused. Red: refuse every body site.
  - A site after the loop: not refused.
- **FILTER refuse:** an OnRename loop whose `SetRange(..., xRec.Name)` sits before it; `remove-setrange` and
  `swap-rec-xrec` are refused. Red: drop FILTER.
- **FILTER control:** a SetRange on a field the consumer does not modify (a Delete loop): not refused. Red: count
  every pre-loop filter.
- **NEG refuse:** `while not R.IsEmpty do` gets `remove-not` refused, and `Count > 0` gets `conditional-boundary`
  refused. Red: drop NEG.
- **NEG control:** `swap-find-direction` on `FindFirst` is not refused. Red: add it to the set.
- **The `or` false-positive shape:** a counter in an `or` condition is STILL refused (ruling a). This pins that no
  exemption creeps in.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-dump on the built branch against master on the census projects: BaseApp both legs in one sitting, plus the
  CDO, DC and DO projects. Expect the measured set; explain any difference site by site.
- Opus build review, one CI push, R531 done in the branch, the new item filed, submit.


---

