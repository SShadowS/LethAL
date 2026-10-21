# R-574 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`.

1. **`break` (F1) is fixed in R-571 before it submits**, because the gap is in `r571Hop` itself.
   - `isExit` also counts a `break` statement whose nearest enclosing loop is one of the consumer loops.
   - It gets a red-checked test in R-571's test file, built on the probe's Blocked/break shape.
   - R-571 is re-measured on DC, E-Document Core and BaseApp before it submits.
   - R-574 inherits the fix by calling `r571Hop`. R-574 adds a SAME-object test for the same shape, and its price is
     re-measured after R-571 merges.
2. **Same-object helper chain (F2).** R576 (on lethal/r571) is widened, in R-571's branch, to cover the same-object
   hop: a callee's bare helper call is not counted as a consumer in either hop, except in the cross hop's globals
   mode. R574 names it as a stated limit with that link. It is not built here.
3. **Test 2 (F3)** uses `repeat Buf.Delete(); if X then exit; until Buf.Next() = 0;`. That is an exit after the last
   consumer, inside the consumer loop, so only the loop rule refuses it. Red: textual order only.
4. **Scheme (F4).** R574 records that R562's precedent was applied: "0 tuples and 0 ordinals measured on every
   project the census flags, so there is no bump". It also records that the census compares hop guard sets with
   the seam on and off, which is the only way this change can refuse a site.
5. **Test 4 (F5).** The red check for the feeds also turns R571's feed test red. Both are reported.


---

# R-574 plan r1 (lethal-code): R531's same-object hop refuses early exits before the last consumer

Base: R-571 merged. R-574 reuses R-571's `r571Hop` and cannot land before it. Branch `lethal/r574`. The
prototype is local WIP: 4aae0ea1 is the code, a copy of r571Hop as `r574Hop`; 1f6cadc9 is a unit test.
Measurement: `/coord/handoff/R-574/measure.md`. Item: R574 (filed on lethal/r571).

## Orchestrator ruling, 2026-10-10
- Ship AS IS (-24), reusing `r571Hop` wholesale: one rule in one function.
- Refusal only. No scheme bump: 0 ordinals moved.
- R574 names the 19 BaseApp over-refusals with the reason they cannot hang, and names the Data Search hang as the
  measured catch.

## Change (`packages/builtin-tier1/src/loop-hazard.ts`)
In `r531AnalyzeOnce`, every SAME-object hop (a same-object callee, or a table procedure on R) is built by R-571's
`r571Hop`, the same function the cross-object hop uses. So a same-object callee's refused set gains three things:
- every `exit` or `Error` textually before its last consumer, or inside a callee loop that holds a consumer;
- the guards of those exits;
- the assignments that feed any of the hop's guards (`r531Feeds`).

The prototype's `r574Hop` copy is deleted, and `r571Hop` is called instead. A test seam, `r574Seam = { on: true }`,
switches the same-object use alone. R562's FILTER HOP (`r562FilterHop`) already refuses its own early exits and
is unchanged.

## Expected price (re-measured on the built branch, against fresh master legs taken after R-571 merges)
- **Data Search: -5.** `StartSearchInBackground`. This is the measured catch: `negate-conditional` on
  `TableTypeID = 0` makes the callee exit for every real id, so the queue never empties.
- **BaseApp: -19, all named over-refusals:**
  - 6 in `Date Compress GL`.DeleteCompressedEntries: `Error` calls and their guards. A raised Error ends the loop
    (no TryFunction in the path), so they cannot hang.
  - 13 guard feeds on the Apply Vendor, Customer, Serv. Customer and Employee Entries pages
    (ExchangeLedgerEntryAmounts, CalcOppositeEntriesAmount): remove-assignment 11, flip-boolean-literal 2. The
    caller deletes the row on every pass anyway, so the loop advances without the callee.
- **0 everywhere else:** OCR Service Mgt.FindDocumentFromList changes no key (its loop is counter-bounded), and the
  fixtures, DC, DO, CDO and the other BC.History projects have no changed hop.
- **0 tuples and 0 ordinals moved.**

## Tests (`packages/builtin-tier1/tests/r574-same-object-early-exit.test.ts`; each red-checked alone, full output read)
1. A same-object callee with `if not Rec.FindLast() then exit; Rec.Delete();`, called in an R531 loop body. The
   remove-not is emitted with the seam off and refused with it on. Red: the seam off.
2. An `exit` inside a callee loop that holds a consumer: refused. Red: textual order only.
3. Control: an `exit` AFTER the last consumer stays emitted. Red: refuse every exit.
4. Feeds: `Found := Rec.FindLast(); if not Found then exit; Rec.Delete();` refuses the remove-assignment of
   `Found := ...`. Red: drop the feeds. This is the red check the measurement lacked.
5. A table procedure on R, the same shapes through `Rec.Proc()`: refused. Red: same-object callees only.
6. `Error` before the last consumer: refused. This pins the Date Compress shape as a stated over-refusal. Red: exits
   only.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-measure BaseApp and Data Search against fresh master legs (after R-571). Expect -24, 0 tuples, 0 ordinals,
  every site named.
- Opus build review; one CI push; R574 `done (<commit>)`; submit.


---

