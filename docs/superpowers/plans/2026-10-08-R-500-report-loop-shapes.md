# R-500 plan (r3): close R500 shape by shape

Base: master `26b7aa66` (IDENTITY_SCHEME 33). **Scheme: 35** (the orchestrator's number; R-343 holds 34; if 35 is
taken at merge, take the next free number, never lower). Evidence: `/coord/handoff/R-500/survey.md` (r1, r2 and
r3 sections). Earlier plans: `scratch/plan.r1.md`, `scratch/plan.r2.md`. Prototype: `scratch/r3-prototype.diff`
(loop-hazard.ts and the dispatch line in orchestrator.ts; the scratch switch `R500_MODE=A|B` and the scratch export
`r500ReasonForScratch` do not go in the build). Reviews: `/coord/reviews/R-500-plan/adversary-r1.md`,
`adversary-r2.md` (REVISE, convergent).

## Acceptance line (fixed in `state.md` before the r3 measurement)
Keep option A unless A's BC.History deployed cost exceeds **1.5%** of BC.History's deployed mutants on master
(2,249,668, so 33,745), OR exceeds option B's by more than **50%**.
**Result: A is kept.** A removes 23,848 (1.06%, under 33,745). B removes 16,246, so A exceeds B by 46.8%, under
50%. The ratio test passes narrowly.

## Changes since r2 (adversary r2)
| finding | r3 |
|---|---|
| 1 HIGH dotted names | No hand-rolled name splitting. A receiver's type is read from its declaration's type NODE (`record_type` / `object_reference_type`, last `reference` segment via `lastFieldChild`), as the engine's `classifyDeclaredType` does. Object names, tableextension bases and `implements` names go through `lastFieldChild` + `normalizeAlName`, so both sides compare the same full normalized name. `lastSegment` is gone. |
| 2 HIGH bare event names | The `EventSubscriber` attribute is read from its argument NODES: `qualified_enum_value` (object type), `database_reference` (last `table_name` segment), and the event as a string literal or a bare identifier. Publisher attributes are read by node name too. |
| 3 MED-HIGH shape 1 gaps | Also refused: the condition of an if/while/repeat/case whose body holds a preset write (ReminderTest's scan). Exit-read names are read in every open-item scope (reached same-object procedures, open Date items). An argument counts as a write only for a `var` parameter of a resolved project procedure or a writing built-in (`Clear`, `Evaluate`); an unresolved callee counts as no write on the open side and as a write on the pre-item side (both the safe direction). |
| 4 MED option A gaps | (a) every call anywhere in the object on a receiver that open-item code also calls is a seed; (b) data-item and implicit records typed through the engine's `resolveReceiverTable`; (c) the callee-object closure also follows the `hiddenCallee` forms. (d) `interface B extends A` and (e) `Codeunit.Run`/`Report.Run` targets and tableextension-published events: named, filed exclusions. |
| 5 cost | Acceptance line above, set before measuring; both options re-measured. |

## Decisions and production cost (option A; production `prod500`, master `pm2` vs prototype `pA3`)

| # | shape | decision | BC.History deployed removed |
|---|---|---|---:|
| 1 | code before the item | LIMIT: writes (and the conditions guarding them) to a global an open item's exit or bound reads and open-item code never writes | 707 |
| 2 | other-object callees | option A (blunt), one hop | 22,714 |
| | of which codeunit callees | | 17,438 |
| | of which RECORD callees (tables plus their tableextensions) | | 3,620 |
| | of which interface implementers | | 605 |
| | of which event subscribers | | 1,051 |
| 3 | ordinary-table items | LIMIT: own-filter calls in OnPreDataItem of a self-inserting item | 41 (CDO 2, DO 2) |
| 4 | `Date` items | REFUSE: open unless `MaxIteration` | 241 |
| 5 | XMLport Integer elements | REFUSE (dormant while xmlport is not a carrier); seeds shape 2 | 0 |
| 5b | outside filter calls on an open item | REFUSE | 0 |
| 6 | outside reportextensions | RULE | 0 |
| 7 | reportextension in ERROR | REFUSE | 0 |
| 8 | loop in a bounded item | RULE here; product-wide item filed | 0 |
| 9 | hidden call shapes | REFUSE | 0 |
| | not attributed (in production's diff, missed by the scratch attribution's file walk) | | 145 |
| | **total** | | **23,848** |

The per-rule split comes from the prototype's own predicates run on every removed mutant (`attr3.ts`,
`scratch/attr-r3-A.log`); only the total is the production diff itself. A procedure is counted under the target
kind that first reached it.

**By operator** (all rules, the 23,703 attributed): void-method-call 5,166, remove-assignment 4,861, empty-block
2,947, negate-conditional 2,116, negate-guard 1,254, flip-boolean-literal 1,064, swap-call-arguments 957,
remove-setrange 849, shift-integer 741, toggle-blank-string 735, return-value 611, swap-additive 540, remove-not 532,
conditional-boundary 292, loop-truncate 280, swap-modify-flag 117, remove-testfield 117, flip-filter-literal 112,
swap-find-direction 107, validate-to-assign 89, swap-enum-member 89, remove-calcfields 63, toggle-blank-temporal 44,
loop-skip 16, remove-commit 4. Per rule x operator: `scratch/attr-r3-A.log`.

**Totals, every set** (`scratch/prodcmp-r3.log`):

| set | A: deployed removed | A: keys moved | B: deployed removed | B: keys moved |
|---|---:|---:|---:|---:|
| BC.History | 23,848 (BaseApp 22,935, Quality Management 358, PEPPOL 329, SubscriptionBilling 203, Sustainability 13, Withholding Tax 6, Tests-TestLibraries 4) | 167 of 2,225,820 | 16,246 | 167 of 2,233,422 |
| CDO | 2 | 0 | 2 | 0 |
| DC | 0 | 0 | 0 | 0 |
| DO | 2 | 0 | 2 | 0 |
| fixtures + examples | 0 | 0 | 0 | 0 |

The hang-refused delta equals the emitted-spec delta on every project (A: 24,881 both; B: 16,957 both), and
`skipped` equals master's on every project of every set, for A and for B. No gate can move.

**Why A.** It is under both parts of the line. B costs 68% of A and still rests on a dataflow chase that leaked in
r1 and r2. A's remaining blind paths are filed (below), not hidden.

## Build
1. `loop-hazard.ts` from `r3-prototype.diff`, option A only (drop `R500_MODE`, `guardFedCalls`, `guardFedB`,
   `r500ReasonForScratch` and `guardKinds`; rename `guardCalleeReach`/`inGuardCallee`, which are no longer about
   guards; flatten the two empty nested blocks in `presetExitNames`). Header: R500 closed, the rulings (6, 8), each
   LIMIT's blind spots.
2. `orchestrator.ts`: `carrierFile` gates the dispatch refusal; the `CARRIER_KINDS` comment names the dormant
   XMLport test.
3. IDENTITY_SCHEME 35 (see above), with the constructed twin test (`scratch/probe3`: a `Date` item and a
   `MaxIteration = 1` item with the same assignment; master numbers them 0 and 1, the build refuses the first and the
   second becomes 0). `--resume` and skip-known-survivors refuse across the bump.
4. R501's test "a context without `files` answers 'extended'" becomes "a context without `files` throws" (r1
   finding 10). It is the only builtin-tier1 test that changes: on the prototype 508 of 509 pass and this one fails
   as expected; the r447/r501 dispatch tests pass (25).
5. Tests, each with an emitting twin; one red-check per direction (R-427):
   - dotted names (finding 1): a dotted codeunit, a dotted table, a tableextension whose base is dotted, a dotted
     interface, a subscriber whose object is dotted, and a Date Compress report over a dotted table; twin: an
     undotted look-alike that must NOT match (`"Calculate BOM Tree"` against `"Mfg. Calculate BOM Tree"`);
   - an unquoted subscriber event name, and its quoted twin (finding 2);
   - shape 1: a guard around a preset write (refused) and a by-value argument twin (emitted); an exit guard in a
     reached procedure; an open Date item's guard;
   - shape 2: a receiver initialized outside the item (seeded), a data-item record receiver and an implicit-record
     call (typed through `resolveReceiverTable`), a `CurrReport.P()` or bare-name call inside a callee object;
     twins not reached from open-item code;
   - and the r2 list: step 7 (`skipped` unchanged, the dormant XMLport pin), XMLport certificates, the `source` skip
     only under `xmlport_element`, Date items and their child items, shape 9's three shapes, the Continue shape,
     finding 5, the missing-`files` throw.
   `scratch/probe4` holds the dotted cases: r2's prototype emitted 9 of its sites that r3 refuses.
6. Re-measure with `prod500` on all five sets against the totals above; `skipped` equal on every project.
7. Roadmap: R500 closed with the per-shape and per-operator tables above and the two rulings; the CHANGELOG carries
   the same tables. File, one item each: the consume-to-end loop (shape 8, product-wide); shape 2's blind paths
   (deeper hops; RecordRef and untyped receivers; objects in `#if` wrappers; table triggers reached by `Insert(true)`
   and similar; events raised deeper than one hop); `interface B extends A`; `Codeunit.Run`/`Report.Run` targets;
   tableextension-published table events; cross-app interfaces and events; shape 3 (a) inserts from another object
   and (b) a bound set elsewhere; shape 1's write in another object. The latent BaseApp DimensionLoop hazard is noted
   in R500's closing text.
