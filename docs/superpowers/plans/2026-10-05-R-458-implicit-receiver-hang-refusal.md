# R-458 plan (r3, complete; ready for sol review)

r2 kept at plan-r2.md (everything not restated here stands: scope A only, loop-hazard.ts only,
tests in `implicit-hang.test.ts`, close-out, R464/R465/R466). sol's r2 review:
review-r2-gpt-6.1-sol.md (REVISE). Base master 001d5c1b; branch lethal/r458 = 8a948c3a +
b389c4f6 (R464-R466) + db75ec62 (R468). `IDENTITY_SCHEME` 18 (R-254 takes 17).
Scratch .../scratchpad/r458/: protoA = r3 prototype (r2 copy: protoA-r2-loop-hazard.ts),
probe protoA/packages/builtin-tier1/tests/r458-probe.test.ts, run5.sh, cmp5.out, cmp5-r2.out.

## 1. Rule changes over r2 (still loop-hazard.ts only; no engine/receiver.ts change)
- **Critical (global shadowed).** `byNameRefusal(node, target, ctx, binding)`, binding =
  "none" (no declaration) | "global" | "local". A resolved bare target is "local" when its
  declaration sits inside a procedure/trigger (`isScope` ancestor), else "global".
  - none: `with` subjects + implicit records (as r2).
  - global: `with` subjects + implicit records of the scopes where R294 measured the field winning
    over a GLOBAL: page with SourceTable (procedures too), pageextension, TableNo `OnRun`, report
    dataitem triggers (every enclosing dataitem), request page with SourceTable / any
    reportextension request page, reportextension `modify` triggers. NOT table/tableextension
    (there the global wins, R294) and not report procedures (no dataitem).
  - local (locals, parameters; and a resolved member receiver `R.F`): `with` subjects only (r2).
- **Important 1 (`#if` properties).** `hasProperty` descends `preproc_conditional` and counts a
  property unless `armOfNode` says "inactive": active arm = present, inactive = absent,
  undecided file or no arm map = present (safe direction).
- **Important 2 (reportextension).** A `modify_modification`'s `target` (e.g. `Header`) is an
  implicit candidate for triggers inside it, and the walk continues outward.
  Known ceiling: in `modify(Line)` the BASE report's outer dataitems (`Header`) are not candidates
  (the base report's structure is not read). See open question 2.
- **R-254 dependency: none for the tests.** R-254 gates at the schemata level (`CARRIER_KINDS`,
  symbol arrays); the operators' `targets`/`refusesHangCapable` run on any parsed AL, so the
  reportextension tests pass on master. The live effect for reportextension sites appears only once
  R-254 merges. No merge-order requirement; both bump `IDENTITY_SCHEME` (17 vs 18).
- **Minor.** (b1) stays as an accepted conservative over-refusal (S's own Done is written; the
  original already hangs). Added (b1') with `S: Record L` (L has no Done): the write binds R.Done.

## 2. Tests (added to r2's list; all in `implicit-hang.test.ts`)
Positives (refused for remove-assignment and flip-boolean-literal): g1 page SourceTable procedure,
GLOBAL Done, `until Rec.Done`; g3 TableNo OnRun GLOBAL; g4 report dataitem trigger, report
GLOBAL, `until Header.Done`; g5 pageextension GLOBAL; c1 `#if` TableNo active arm, c1'' undecided,
c1''' no arm map; c2 `#if` SourceTable active, c2'' undecided; r1 reportextension modify(Header)
`until Header.Done`; b1' nested with over L.
Controls (claimed): g2 page LOCAL Done; g2' page PARAMETER Done; g3' TableNo codeunit procedure
other than OnRun, GLOBAL; g4' report procedure, GLOBAL; g6 table GLOBAL beside field Done; g7
tableextension GLOBAL; c1' / c2' inactive arm; r1' modify(Header) `until Header.Other`.
Probe: 33/33 green on protoA; on b364 (master packages) all 18 positives red, all 15 controls green.

Red-checks (protoA, one change reverted at a time, restored green after each):
| reverted | goes red (only) |
| --- | --- |
| every resolved target "local" (drop global) | g1 g3 g4 g5 |
| every resolved target "global" | g2 g2' |
| table/tableextension give Rec for globals too | g6 g7 |
| `#if` arm check removed | c1' c2' |
| undecided counted as absent (`=== "active"`) | c1'' c2'' |
| no descent into `#if` | c1 c1'' c1''' c2 c2'' |
| modify target not a candidate | r1 |
| innermost `with` only | b1 b1' |
builtin-tier1 suite on protoA: 313 pass, 0 fail.

## 3. Exact site diff (run5.sh, one job at a time; before = b364 = master packages, after = protoA r3)
92 labels, 0 operator exceptions (4 FAIL = BC.History dirs with no .al files, as r1/r2).
Arm map: none (as r1/r2), so conditional properties count as present: an upper bound.
| | BaseApp | CDO | other BC.History | fixtures+examples | total |
| --- | --- | --- | --- | --- | --- |
| hang-refused added | 37 | 2 | 4 | 0 | **43** |
| specs removed (all hang-refused: 34 remove-assignment, 9 shift-integer) | 37 | 2 | 4 | 0 | 43 |
| anything else (T2, flips, tags, targets added, hang removed) | 0 | 0 | 0 | 0 | 0 |
r3 vs r2 (A vs A3): **empty diff** on every label. The new candidates close sol's shapes without
moving any measured row. Fixtures empty: no itest baseline moves.

Census reconcile (52 rows) unchanged from r2, except the SuggestVendorPayments row now has a cause.

## 4. SuggestVendorPayments.Report :1078 -> filed R468 (commit db75ec62, roadmap only, not pushed)
`TempPayableVendorLedgerEntry` is a report GLOBAL declared in the report's SECOND direct var
section (`protected var` first, then `var`). `indexMembers` in symbol-table.ts indexes only the
first direct var section (+ active `#if` sections), so the name resolves to nothing; the report
is indexed (R-364's gate closed) and no implicit record / `with` applies (R-458's gate closed).
Minimal repro in R468 (`while B do B := false;` with B in the second section: not refused).
~655 BaseApp files have the two-section shape (grep). Not R-458's to fix (engine change).

## Open questions
1. Engine `types.ts` `hasProperty` has the same `#if` blind spot for SourceTable/TableNo (a type
   reader, not a hang path; could type a name by the global under a conditional SourceTable).
   File it as its own item?
2. reportextension `modify(Line)` where the base report nests Line in Header: Header's fields are
   not candidates (base report not read). Accept as a stated ceiling, or file?
3. If R-254 slips, does R-458 take 17? (carried from r2)
