# R-568 plan r2 (lethal-code): r1 plus the adversary-r1 fixes (verdict APPROVE)

`plan.r1.md` holds except as changed here.

1. **Tests and reds (F1, F2).** Each test has its own red:
   - T1 `KeyVal := ...; Continue := Cust.Get(KeyVal)` (renamed from `Key`): red `t.kind !== "table"` -> `t !== null`.
   - T2 `Continue := Txt.Contains(Tmp)` and T5 undeclared receiver pin ONE branch (`declaredType` null): shared red
     "a null `declaredType` stops", stated as one branch.
   - T3 project table procedure `Buf.Check(Tmp)`: red drop the table-procedure half.
   - T6 (new) tableextension-only procedure `Buf2.ExtCheck(Tmp)`, emitted on and off: red restrict
     `objectsOfType`'s table branch to `table_declaration` (temporary Edit in `objectsOfType`, restored).
   - T4 BOUNDARY-RHS (existing codeunit receiver): red drop the non-record-object half.
2. **Wording (F3).** The docstring, R568 and R532's residual say: arguments feed unless the receiver is typed as
   an object (codeunit, report, page, query, xmlport, testpage, interface) or is a record whose table or a project
   tableextension declares the member. So platform methods on object-typed variables (`Rpt.SaveAsPdf(F)`,
   `Cu.Run(Rec)`) still stop: a stated residual, not a practical hang door (Run/RunModal/SaveAs run the other
   object's code, which the ruling covers; pure setters are statements, not right sides).
3. **Mechanism (F4).** R568 records that the AccountSchedule site's new fed name is the field identifier
   `"Date Filter"`, refused because the dataitem receiver of `SetFilter` does not resolve (unknown counts as a
   write); a resolved record receiver would not be refused (R532's record-method residual). Field-name arguments
   can also match `X.<Field> := ...` by member name: safe-direction over-refusal, measured at -1 total.
4. **Basis (F5).** "CDO, DC, DO cannot move" because `r568StopsAt` runs only inside `presetFeeds`, only for a
   scope with preset names or project preset writers; the R532 census found none there, and their
   reportextensions extend dependency reports, so `w.procs` is empty.


---

# R-568 plan r1 (lethal-code): preset feeds pass through platform-method arguments

Base: master 35d37060 (R532 merged, scheme 39). Branch `lethal/r568`, worktree /work/lethal-wt/r568. Item:
`docs/roadmap/R568.md` (filed by R532's build review r2, finding 2). Refusal only.

## Problem
R532's feed search (`r531Feeds` in `fed` mode, `loop-hazard.ts`) does not take a name that the preset write's
right side reads only as an argument of a NON-BARE call (`X.Proc(A)` feeds `X`, not `A`). That keeps R532's ruling
(a value through another object's function is not followed), but it also stops at platform methods, which are not
another object's code: `Key := ...; Continue := Cust.Get(Key)`, `Continue := Txt.Contains(Tmp)`,
`CurrReport.X(Tmp)`. Master missed these too, so nothing regressed; it is an under-refusal.

## Change (prototype in the worktree, uncommitted)
A new predicate `r568StopsAt(call, ctx)` gates the existing `bareCallee(n) === null` branch. The search stops at a
non-bare call's arguments only for ANOTHER OBJECT'S FUNCTION:
- the receiver is declared as a non-record object (`declaredType` kind codeunit, report, page, query, xmlport,
  interface, ...), whether or not that object is in the project; or
- the receiver is a record (or resolves to a table, `callTargets`) whose table declares the member as a procedure.
Otherwise the arguments feed as in a bare call: record built-ins (`Get`, `IsEmpty`, `GetFilter`), text and other
primitive methods, `CurrReport.X`, and any receiver nothing resolves (the safe direction for a refusal).
The receiver itself still feeds in every case (unchanged). R-531's own use (no `fed`) is unchanged: the branch is
inside `fed !== undefined`.

Why "any non-record object, project or not": R532's ruling covers a value passing through another object's
function; for a codeunit outside the project there is no code to follow at all, and R532's BOUNDARY-RHS test
(`FormatAddr.ShipTo(...)` with `FormatAddr: Codeunit "..."`) pins exactly that shape.

## Measured (prototype tree vs master legs, fresh, one corpus job at a time)
Master legs: `scratchpad/r532/fin2/*-b.json` (the a6b08d50 tree, byte-identical to master 35d37060's).
- **BaseApp: -1 deployed**, 0 added, 0 tuples, 0 ordinals, `skipped` equal: `Account Schedule`
  `ValidateDateFilter`, `void-method-call` of `"Acc. Schedule Line".SetFilter("Date Filter", NewDateFilter)`.
  Mechanism: the preset write `DateFilter := CopyStr("Acc. Schedule Line".GetFilter("Date Filter"), ...)` now feeds
  `GetFilter`'s argument; the `SetFilter` call on the dataitem receiver does not resolve, so R532's "unknown counts
  as a write" makes it a feed. It is a genuine same-scope feed (the filter it sets is the one `GetFilter` reads).
- Withholding Tax, Tests-TestLibraries, all 19 fixtures: 0. CDO, DC, DO have no preset writes (R532 census), so
  they cannot move.
- No scheme bump needed (0 tuples, 0 ordinals).

## Tests (`packages/builtin-tier1/tests/r532-preset-feeds.test.ts`, off/on per mutant, each red-checked alone)
1. `Key := Txt + 'k'; Continue := Cust.Get(Key);` (`Cust: Record Customer`, table not in project): `Key := ...`
   refused (refusedByFeeds). Red: `r568StopsAt` returns true always.
2. `Tmp := Txt + 'q'; Continue := Txt.Contains(Tmp);`: refused. Same red.
3. A project table procedure: `Buf: Record "Feed Buf"` with table `Feed Buf` declaring `procedure Check(T: Text):
   Boolean`; `Continue := Buf.Check(Tmp)` leaves `Tmp := ...` EMITTED on and off. Red: drop the table-procedure
   half of `r568StopsAt`.
4. BOUNDARY-RHS (existing, codeunit receiver) stays green. Red: drop the non-record-object half.
5. Unresolved receiver: `Continue := Unknown.M(Tmp)` with `Unknown` not declared: `Tmp := ...` refused.
   Red: an unresolved receiver stops.
The R532 tests stay green (21).

## Gates
typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations,
roadmap-index. Re-measure the built branch against the same master legs (expect -1, 0 tuples, 0 ordinals).
Opus build review; one CI push; R568 `done (<commit>)`; R532's residual line updated to point at the fix.


---

