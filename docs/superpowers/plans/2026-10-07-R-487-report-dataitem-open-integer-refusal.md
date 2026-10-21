# R-487 plan r7: the blanket rule (option A), with sol-r5's and sol-r6's extension fixes

Evidence: `survey.md` section "r7" (r3 to r6 are kept there). Prototype: `scratch/r5-*.proto.diff`, then
`r6-on-r5.proto.diff`, then `r7-on-r6.proto.diff`, on base **22661114** (README). IDENTITY_SCHEME **30**.

## Rule
In an OPEN data item, refuse EVERY site the four hang-capable operators mutate (remove-assignment,
shift-integer, flip-boolean-literal and swap-additive), whatever it writes or reads.

**Scope.** The rule covers:
- the item's triggers;
- its child items' triggers and columns;
- every same-object procedure reachable from that code.

Reachability is by name and transitive. It covers `P()`, `P;`, `this.P()` and column sources, and both
split-header procedure kinds, matching any arm name.

**Open.** R484's certificates decide, with two changes:
- An unqualified `Number :=` is a mention, so it voids them (item 7).
- **New in r6:** take an `Integer` item of a report that ANY reportextension in the project extends. Only
  `MaxIteration` bounds it; its view and SetRange certificates do not hold. This applies to the base report's own
  triggers and callees too.
  - An extension names its base by the last name segment, so `extends N.P` and `"N"."P"` match report `P`. The
    vendored grammar already puts only that segment in `base_object`; a test pins this.
  - **New in r7:** an extension with NO base name counts as extending every report.

A child of an open item counts as open, even when the child is bounded.

**Extension blocks.** This covers `modify(D)` and, **new in r6**, `add(D)`, `addfirst(D)`, `addlast(D)` and every
other `*_dataset_modification`. Such a block runs under base item `D`. It is open UNLESS both of these hold:
- the base report is in the project, and so are `D` and every base item enclosing it;
- none of them is open, and every one that is an `Integer` item has a `MaxIteration` bound.

An item the extension adds is checked itself first, and then its anchor.

## sol-r5, finding by finding
1. **Base code trusted voided certificates.** Fixed with blunt option (a), as described under "Open" above.
   - The list of extended reports comes from a new optional `SemanticContext.files`. That is the only engine
     change; a context without `files` answers "extended", the safe direction.
   - Measured: +324 sites over r5 on BC.History.
   - The blunter option voids these certificates in EVERY report. That costs +1,727 over this plan (6,737 vs
     master) and also covers extensions outside the project. I chose (a) and list the outside extensions as an
     exclusion.
2. **add/addlast columns and children.** All dataset blocks are now anchored like `modify`, including a bounded
   item added under an open base. Tests: `add`, `addfirst` and `addlast` columns that call an extension
   procedure, a bounded added item, and an absent base, each with a bounded twin.
3. **Red-checks against the final code.**
   - All 27 R484 certificate tests go red under their named reverts. Three of those reverts are a narrower, fair
     form, stated in `survey.md`.
   - One test title was corrected: the CopyFilter-destination test survives "count only method receivers",
     because `D.Number` is itself a member object. It goes red under "count only the receiver of a called method".
   - Every r5 and r6 regression revert (A-J) goes red.
   - **The build re-runs all of these against the final code AFTER the guard-collection deletion, before merge.**

## sol-r6, finding by finding
1. **Qualified base names. Measured first:** the grammar parses the qualifier as an ERROR sibling, and
   `base_object` already holds only the last segment.
   - The new regression keeps the base report and a namespace-qualified extension in separate files, and its
     mutant is the BASE assignment. It PASSES on r6's code, so r6 was not blind to qualified names.
   - The real gap was an extension with no base name (a MISSING node). It is now read as "extends every report".
   - No text splitter was added: no test could turn it red. The test goes red if the name is read from the whole
     `extends` clause.
   - Also tested: the `files` fallback (absent means "extended"), and `#if`-wrapped extensions in another file.
   - The four reverts were each red-checked: whole clause, `ANY_REPORT`, the fallback, and wrapped discovery.
2. **Exclusion cost corrected:** voidall costs +1,727 over r6/r7, not 2,051 (2,051 was relative to r5).

## Measured (exact dumps, every operator)
- **BC.History: 5,010** sites move emitted -> hang-refused.
  - By operator: remove-assignment 3,417, shift-integer 919, flip-boolean-literal 557, swap-additive 117.
  - 0 changed, 0 appeared.
- **Against r5:** +324 sites, **0 released**, every key matching.
  - Where: BaseApp 323, SubscriptionBilling 1.
  - What: the certificate-bounded items of extended base reports, plus the extensions' add/modify code. Examples:
    WhseSourceCreateDocument and its ReportExt, PlanningAvailability and its ReportExt, GetDemandToReserve.
- CDO, DC, DO, fixtures and examples are identical to master and to r5, so no gate moves.
  - sandbox-data's R254 `DataBandExt` mutant does not move: its base item walks a real table.
  - The blunter voidall option leaves fixtures identical too.
- **Keys: 203** move (r5: 204). Keys are counted over mutants emitted on both sides, so the 324 newly refused ones
  drop out.
- **r7 vs r6: identical exact dumps on every set**, keys re-run at 203. No corpus has an extension with a missing
  base name, so the r7 change moves nothing measured; its tests pin it.
- Over-refusal: 1.11% of BC.History's sites for these four operators.

## Known exclusions (none shown safe)
- **Bounded-item code keeps master's exclusions.** `MaxIteration` caps BC's record loop, not an AL `while` or
  `repeat` inside a trigger or callee; those get only R196/R446/R480's loop rules.
- **Reportextensions outside the project** (another app that extends the report). A view or SetRange certificate
  is trusted when no project extension exists. Voiding them everywhere would cost 1,727 more sites. This plan
  never treats a report as proven bounded in deployment.
- A reportextension inside an ERROR node (unparsed) is not found.
- Code that runs before an item, outside it: OnPreReport, and an earlier sibling's flag that a later item reads
  (R196's preheader exclusion). File it at build.
- Procedures in OTHER objects.
- Items over ordinary tables (item 3), `Date` items (4a) and XMLport Integer elements (4d).
- Condition-side mutants (item 6). File it at build.
- The census zeros are qualified: `census8.ts` follows calls by name, not aliases.

## Build
1. Apply the r5 diffs, then r6 (`loop-hazard.ts` and `context.ts`), then r7, without the `off-lit` and `voidall`
   switches.
2. Delete the dead data-item exit-guard collection: R484's guard parts, the nested Quit/Error collection, and
   `endsDataItem`/`endsReport` where unused. Keep the certificate logic. The re-dump must equal the prototype's.
3. Tests: r5, r6 and r7.
4. Scheme 30. Update R487.md, R493.md and the header. File item 6, the sibling-preheader item and the
   outside-extension exclusion. Regenerate ROADMAP.md.
5. **Before merge:**
   - re-run the 27 certificate reverts, the A-J regression reverts and r7's four reverts against the final code;
   - run `bun scripts/verify.ts` green in a real worktree;
   - fresh dumps and keydiff: expect 5,010, 0 changed, 0 appeared, 203 keys, and explain any difference;
   - run `itest:hang` live, keeping its baseline.

## Changes since r6
- sol-r6 #1: measured that the grammar already reduces a qualified base name to its last segment, and r6 passes
  the qualified regression. Closed the real gap: a missing base name now extends every report. Four new
  separate-file tests, each red-checked.
- sol-r6 #2: the voidall cost is corrected to +1,727 over r6/r7.
- Measured: identical to r6 on every set. That is 5,010 / 0 changed / 0 appeared / 0 released / 203 keys.
