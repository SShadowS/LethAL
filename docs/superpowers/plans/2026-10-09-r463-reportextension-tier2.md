# R-463 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

Everything in `plan.r1.md` holds except as changed here. Finding numbers refer to `adversary-r1.md`.

## Changes to section 1 (receiver.ts)
- **F1 `claimsSystemCall`:** inside a reportextension it REFUSES every site (a new guard: `enclosingObject` is a
  reportextension -> false). That keeps master's behaviour exactly, because master never claimed there (no object).
  Measured: the m -> p dump moved no `remove-commit` key, so this costs 0 sites. The narrower "base report visible,
  unique, no namesake, no null-table scope" rule is not built (YAGNI; nothing gains from it).
  The same hole for a pageextension (base page procedures, null-table `Rec`) is filed as its own roadmap item,
  not fixed here.
- **F6:** section 1.4's removals stop short of the tag. `receiverUnresolved` returns `true` for a reportextension
  whose `object_name` did not parse. Simplest form: keep the existing parent loop as the `objectName === null`
  fallback. Every other dead special case is removed only if the tests and the BaseApp dump stay equal.
- **F4:** "added dataitem" means `addfirst(X)`/`addlast(X)` (and `addafter`/`addbefore`) holding
  `dataitem(D; T)`; `add(X)` is not compilable AL.

## Changes to section 2 (hang coverage): stated ceilings, not "complete"
- R463 names, as known ceilings that R463 does not change: (a) a base table's procedures called from `modify(X)` are
  not followed (null table, ruling 1); (b) a base OUTER dataitem named from inside an added dataitem
  (`Outer.Proc()`) is not followed.
- New roadmap items (next free ids re-checked immediately before writing):
  - base-report procedures called bare from an open extension block are looked up on the dataitem's table and never
    on the base report, so their hang-capable mutants stay deployed (F5c);
  - a `protected var` written by an extension is not seen by `writesPresetExitName` (F5d);
  - the pageextension `claimsSystemCall` hole (F1).
- The 62-mutant correctness gain comes from UNTYPED receivers (a bare `Proc()`, or `D.Proc()` with D an added
  dataitem), not from typed `Record` variables, which loop-hazard's `declaredType` already followed (F2). R463 and
  the CHANGELOG say so.

## Changes to section 3 (tests)
- **T4 (F3):** the refusal applies to the BARE form only: the extension declares `procedure SetRange`, and a bare
  `SetRange(...)` in an added dataitem is not claimed (red: drop `declaresProcedure`). The QUALIFIED `Rel.SetRange`
  IS claimed, and a positive test pins that (it binds the record method).
- **T5 (F3):** the collision is built on purpose. A reportextension and a codeunit (or report) share one NAME, and a
  `Rel` declared only in the other object is unresolved inside the extension. Red: key the scope by name alone.
- **T5b (F3):** the base report has `protected var G: Record T`; `G.SetRange(...)` in the extension is not claimed, and
  `receiverUnresolved` says true (tag kept).
- **T6 (F2):** an `addfirst(I)` block (I an open `Integer` item in a project base report) holds `dataitem(D; T)`, whose
  trigger calls `D.Proc()` and a bare `Proc()`, where table T declares `Proc` with a body. Every mutant in `Proc` is
  hang-refused. Red: revert OBJECT_KINDS (both calls then type to nothing).
- **T7:** the same `D.Proc()` from a block anchored on a bounded table item: `Proc`'s mutants are generated. It is the
  not-vacuous control for T6; red: make `modifiedItemOpen` return true.
- **T8 (F1):** a reportextension trigger's bare `Commit()` is not claimed by `claimsSystemCall`. Red: drop the new
  guard. The other direction (a table or codeunit `Commit()` is claimed) is pinned by existing tests, named in the
  build record.

## Changes to section 4 (BaseApp re-dump, F7)
The re-dump also diffs each spec's `platformKillMechanism` tag per key. `skipCanRaise`, `forceCanRaise` and
`insertSkipCanRaise` read `resolveReceiverTable`, so a tag may drop in an added dataitem or on an extension-typed
record. The tag diff is reported in R463 next to +7 / -67 / 0 moved.

## Changes to section 5 (fixture, F8)
The test seeds BAND rows with Entry No. 1..4 plus a decoy `Entry No. 5, Main No. 'OTHER'`. The decoy lies in
[3, 99], so removing the first SetRange counts it (3, not 2) and is killed. Entry No. is the primary key, so the
decoy cannot reuse 1..4. The pre-commitment names the decoy's number. Expected survivor: `shift-integer` on 99, to
be confirmed against the built list. The verdicts are pre-committed only after the build generates the list.

---

# R-463 plan r1 (lethal-code): Tier 2 claims record calls inside a `reportextension`

Base: master 2e40f73f (R-500 scheme 35, R-497 scheme 36). Branch `lethal/r463`. Measurement: `/coord/handoff/R-463/state.md`.

## 1. Change (packages/engine/src/semantic/receiver.ts only)
1. Add `ALNodeKind.reportextension` to `OBJECT_KINDS`. `enclosingObject` then returns the extension node for
   every site inside one, so `claimsRecordMethod`, `resolveReceiverTable`, `claimsSystemCall`,
   `receiverUnresolved` and `declarationAt` stop treating it as "no object".
2. `scopeOwnerOf`: a reportextension maps to `extensionScopeKey("reportextension", name)`, the key R254 already
   indexes its globals, procedure locals and parameters under (`symbol-table.ts` `parseExtensionHeader`). So a
   typed `Rec2: Record X` declared in the extension resolves like a tableextension's.
3. Implicit records keep R-464's `recordScopesAt` unchanged:
   - an ADDED dataitem (`add(X) { dataitem(D; T) }`) is a `report_dataitem` scope with table `T`, so a bare or
     `D.`-qualified call there is claimed;
   - **Named refusal (ruling 1): `modify(X)`.** The implicit record IS the base report's dataitem X's table, but it
     stays `table: null` (unresolved, refused). Reason, measured: resolving X through the base report (unique
     report by name, unique dataitem) adds 0 claimed sites on every corpus (BC.History's four projects with
     reportextensions, the fixture; CDO/DC/DO have none). Documented on the `modify_modification` case and in R463.
   - a reportextension request page: `table: null`, refused (unchanged).
4. Remove the now-dead `objectNode === null` reportextension special cases, since `enclosingObject` finds the extension:
   `receiverUnresolved` (the parent loop that returns `true`), `implicitRecordUnresolved` (the `owner` loop and
   the `objectNode === null` return) and `withSubjectIsNonRecord`'s reportextension branch (the general
   `resolveReceiverName` now reads the extension scope). Each removal is kept only if the tests in section 3 stay
   green and the BaseApp dump stays equal. Otherwise it stays, as a comment-free no-op.
   Behaviour to preserve: R-254's Tier-1 RunTrigger tag in a reportextension. A qualified receiver that now
   RESOLVES to a declared record loses the "unresolved" tag. That is correct (it is resolved) and is the same rule
   as everywhere else. A `modify(X)` bare call stays unresolved, so it is still tagged.
5. Doc comments: OBJECT_KINDS block (a reportextension bullet), `receiverUnresolved`'s R-254 paragraph, the
   `RecordScope.table` comment, and the four Tier-2 operator headers that say "tableextension/pageextension" only
   (remove-setrange, remove-calcfields, remove-testfield, validate-to-assign, swap-modify-flag). Names, not file:line.

No change to loop-hazard.ts. Its R-500 shape 2 (typed one-hop callees) reads `resolveReceiverTable`, so it
widens by itself (section 2).

## 2. Hang coverage (why claiming here cannot deploy a hang-capable mutant)
- R-501's dispatch check refuses every operator, Tier 2 included, at a site in open-item scope. A reportextension
  block's openness is `insideOpenItem` -> `modifiedItemOpen`: a `modify`/`add*` block counts as OPEN unless the base
  report is in the project (unique by name), the anchor item is found there (unique), neither it nor an
  enclosing base item is open, and every enclosing `Integer` item has `MaxIteration`. An item the extension adds is
  checked itself first, then its anchor. Same-object procedures reached from an open block are in scope (R-487/R-500
  same-object closure).
- Measured: every claim on an extension of a DEPENDENCY report (SubscriptionBilling +14, Sustainability +4) is
  hang-refused. 0 deployed.
- **Correctness gain (ruling 2):** R-500 shape 2 follows typed one-hop callees through `resolveReceiverTable`.
  Inside a reportextension that returned null, so a call from an open extension block into a TABLE procedure was not
  followed. On master, 62 BaseApp table mutants that are hang-capable this way are DEPLOYED
  (ProdOrderComponent.Table.al 30, ServiceLine.Table.al 32). With the change they are refused: hang-refused
  44,126 -> 44,207. Stated in R463 and the CHANGELOG.

## 3. Tests (red-checked, one direction at a time)
In `packages/engine/tests/` (receiver) and `packages/builtin-tier1/tests/` (hang):
- T1 claim: a typed `Rel: Record T` (T declared in project) in a reportextension procedure, `Rel.SetRange(...)`,
  is claimed by `claimsRecordMethod`. Red: drop reportextension from OBJECT_KINDS.
- T2 claim, added dataitem: a bare `SetRange(...)` inside an `add(X) { dataitem(D; T) }` trigger is claimed.
  Red: the same.
- T3 refusal, modify: a bare `SetRange(...)` in a `modify(X)` trigger whose base report IS in the project is NOT
  claimed, and `receiverUnresolved` says true (tag kept). Red: give `modify` the base item's table.
- T4 refusal, rule 3: the extension declares `procedure SetRange(...)`, and a bare or `Rel.` call is not claimed (or
  the table declares it). Red: drop the `declaresProcedure` guard.
- T5 scope: a `Rel` declared in ANOTHER reportextension of the same name scope / in the base report is not
  visible (unresolved). Red: scope key without kind.
- T6 hang, refused: an open reportextension block (`modify(I)` on an `Integer` item without bound) calls
  `Rel.Proc()`, where table T declares `Proc` with a body. Every mutant in `Proc` is hang-refused. Red: revert
  the OBJECT_KINDS change (`resolveReceiverTable` -> null).
- T7 hang, not refused: the same call from a reportextension trigger that is NOT open (the anchor is a bounded
  table item in a project base report). `Proc`'s mutants are generated. Red: make `modifiedItemOpen` return true
  (proves T7 is not vacuous).
- Existing R-254 and R-479 tests that pin "reportextension never claimed" are updated deliberately, each one named in
  the build record.

## 4. Identity and scheme
On 2e40f73f the dump shows 0 keys moved and 0 `tuple|ordinal` values moved on every project (the key diff compares
`tuple|ordinal` per site). So no scheme bump (ruling 3). Re-checked on the built branch for BaseApp, ordinals
explicitly. If anything moves, ask the orchestrator (next free 37).

## 5. Fixture arm (tables gate)
`DataBandExt.ReportExt.al` gains `procedure CountBand(Low: Integer): Integer` with a typed
`Rel: Record "Data Related"`: `Rel.SetRange("Main No.", 'BAND'); Rel.SetRange("Entry No.", Low, 99); exit(Rel.Count());`.
A new test `BandCountsFromLow` seeds BAND rows 1..4 plus a non-BAND row and asserts `Rep.CountBand(3) = 2`
(through the base report variable, like `BandClassifiesDirectly`). Fixture version bumps (sandbox-data
1.0.0.12, tests 1.0.0.20), `compile:fixtures`. The arm's mutant list comes from the built generator. I pre-commit
each verdict and killing test in `docs/superpowers/specs/2026-10-09-r463-reportext-precommitment.md`, pushed to
master as specs-only [skip ci] BEFORE the live run. Live: `itest:tables` under a Cronus28 lease, baseline
re-recorded per R332 (delete, record, re-run).
The 4-line header the R254 pre-commitment cites by line number stays as it is. CountBand goes after the existing
procedures.

## 6. Gates
typecheck, `rm -rf packages/*/dist`, `bun scripts/verify.ts`, biome on touched files, line-citations +
roadmap-index tests, BaseApp production re-dump against the master `m` dump (expect +7 / -67 / 0 moved), opus build
review, one CI push with both jobs green, R463 `status: done (<sha>)` in the branch, submit.
