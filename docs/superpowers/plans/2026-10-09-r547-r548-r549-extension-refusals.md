# R-547 plan r3 (lethal-code): r2 plus the adversary-r2 fixes

`plan.r1.md` and `plan.r2.md` hold except as changed here. F-numbers refer to `adversary-r2.md`.

1. **F1, split-header base objects.** `baseCandidatesOf` also reads `symbols.splitObjects` through the same
   conservative token rule `projectDeclaresProcedureOnTable` uses for them (R494): the object text names the base and
   declares the procedure, or the protected var, or `Commit`. So a base report or page whose header is split by
   `#if` is a candidate, never "a dependency".
   - Test: a split-header base report whose `BaseProc` is called bare from an open extension block; BaseProc's
     mutants are refused. Red: drop `splitObjects` from the candidates.
2. **F2, the by-value control.** `BaseRead(Continue)`, with Continue passed BY VALUE to a base procedure, from the
   extension's OnPreReport: NOT refused. Red: answer `unknown` for every base callee in `argWritten`. Together with
   r2's F4 refuse test, both directions of the base-procedure parameter lookup are pinned.
3. **F3, filed rather than fixed.** "Deleting a call to a procedure that writes a preset exit name without a `var`
   argument (`InitContinue();`) is not refused, in a report or an extension" (R500 shape 1, pre-existing). It is
   filed as its own roadmap item at build time (the next id is checked immediately before writing), and R548
   points to it.


---

# R-547 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`.

## Base lookup: every candidate (F2)
`baseCandidatesOf(ext)` returns EVERY project object of the right kind (report for a reportextension, page for a
pageextension) whose name equals the `extends` name's last segment. That includes `#if`-wrapped objects
(`objectDeclarationsOf`) and the symbol table's `unindexedObjects`. An object the grammar could not parse
(`unparsedObjects`) counts by the same conservative token rule `projectDeclaresProcedureOnTable` uses: its text
names the object and declares the procedure.

- **R547:** follow the member on EVERY candidate that declares it.
- **R548:** take the union of the candidates' protected preset names.
- **R549:** REFUSE if ANY candidate declares a visible `Commit`.

So "ambiguous" now leans to refusal everywhere, like `modifiedItemOpen`. No candidates (a dependency base) keeps
r1: R547 and R548 are unchanged (the block is already open), and R549 keeps the claim (the named residual).

## R548, wider (F3, F4)
- **Exit names.** Inside a reportextension the exit names are `presetExitNames(ext) ∪ (presetExitNames(base) ∩
  protected(base))`.
  - `presetExitNames(ext)` reads the guards of the extension's own blocks, both `modify(X)` triggers on base items
    (F3a) and added items (F3b), against the extension's globals plus the base's protected names.
  - `presetExitNames` must therefore accept a `reportextension_declaration`. The builder confirms its open-item
    walk handles extension blocks the way `insideOpenItem` does, and reuses that rather than writing a second walk.
- **Residual (F3c), stated in R548:** a write in the BASE report of a protected var that only an EXTENSION's exit
  guard reads. Closing it needs the report-side rule to look at every extension, which is out of R548's scope.
  Measured cost: none known.
- **F4, a `var` argument to a base procedure.** In `argWritten`'s bare branch inside a reportextension, look the
  callee up on the base candidates and use their `var`-parameter positions before the builtins fallback. If several
  candidates disagree, or one cannot be read, answer `unknown`, which refuses.

## R547 call shapes (F5)
- The build MEASURES with alc whether `CurrReport.BaseProc()` inside a reportextension binds the base report's
  procedure.
  - If it binds: `callTargets`' member branch maps a `CurrReport` receiver inside a reportextension to the base
    candidates.
  - If it does not compile or binds nothing: state it in R547.
- **Paren-less calls** (`if BaseIsDone then`): stated in R547 as a residual. It is the grammar gap shared by every
  call-based rule here; `claimsRecordMethod`'s header documents it.

## R549 residuals stated, not built (F6)
In R549, each measured at 0 in every corpus (no procedure named Commit anywhere):
- a `Commit` declared on the base page's SourceTable or its tableextensions;
- a sibling pageextension's public `Commit`.

**Visibility per arm:** a procedure split across `#if` arms is visible if ANY live or undecided arm is non-local.
That is the conservative reading, built.

## Tests (r1 section amended; F1, F7, F8)
**R548:**
- **refuse:** the base report has an open `Integer` item, asserted open (one of its own trigger's mutants is
  refused); its exit guard reads `protected var Continue`; the extension's OnPreReport writes `Continue := true`;
  that write's mutants are refused. Red: drop the reportextension branch.
- **control (F1):** the base has a NON-protected `Continue` read by the open guard; the extension declares its own
  `Continue` (legal, the base one is invisible) and writes it; NOT refused. Red: drop the `protected` filter.
- **F3a:** an extension `modify(Loop)` trigger guard reads an extension global that the extension's OnPreReport
  writes; refused. Red: drop `presetExitNames(ext)`.
- **F4:** `BaseInit(Continue)` with a `var` parameter, from the extension; refused. Red: drop the base lookup in
  `argWritten`.

**R547:**
- **refuse:** covers both a trigger caller and an extension PROCEDURE caller reached from the open block, and a
  callee of `BaseProc` inside the base report (closure).
- **control (F8):** the anchor is a data item over an ordinary table, NOT inside an unbounded `Integer` item; the
  base report never reaches `BaseProc` from its own open items. Red: `modifiedItemOpen` always true.
- **ambiguity (F2):** two same-named base reports, one in an undecided `#if` arm; BaseProc's mutants are refused.
  Red: return the candidates only when unique.

**R549** (adds to r1's tests):
- `internal procedure Commit` -> not claimed (red: treat internal as invisible);
- an ambiguous base page where one candidate declares it -> not claimed (red: unique-only);
- a base page `#if`-wrapped in an undecided arm that declares it -> not claimed.

## Expected corpus effect
Unchanged from r1 for R547 and R549: 0. R548 may now refuse MORE than the 2 measured BaseApp sites (F3a/F4 widen
it). It is re-measured on the built branch, with both BaseApp legs in one sitting. 0 keys and ordinals are expected
to move; if anything moves, scheme 37 is asked for.


---

# R-547 plan r1 (lethal-code): R547 + R548 + R549, refusal only

Base: master 0e017cb5. Branch `lethal/r547`. Measurement: `/coord/handoff/R-547/measure.md`. Orchestrator rulings
2026-10-09 (in the lane handoff): R547 and R548 as prototyped; R549 half the filed rule; no scheme bump.

## Measured (step 1)
- **R547:** 0 deployed mutants removed on any corpus. The hole is real: on own-code AL, an open block's bare
  `BaseProc()` loses BaseProc's 5 mutants with the prototype.
- **R548:** 2 newly refused deployed sites, BaseApp `MfgWhseSourceCreateDocument.ReportExt.al`, procedure
  `SetProdOrder`: an `empty-block` and a `remove-assignment` of `WhseDoc`, a base-report `protected var`.
  Hang-refused goes from 44,207 to 44,209.
- **Both together:** 0 keys moved, 0 ordinals moved, 0 of 4,259 kill tags changed, `skipped` equal. Only BaseApp
  can change: its reportextensions extend in-project reports. E-Document Core, SubscriptionBilling and
  Sustainability extend dependency reports. CDO, DC and DO have no reportextension.
- **R549:** alc 18.0.43 shows that a bare `Commit()` in a pageextension BINDS a visible base page's
  `procedure Commit` (with or without a return value), across apps too. A `local` base procedure is invisible.
  - Corpus: all 6 bare `Commit()` in pageextensions are claimed `remove-commit` by master, and all are correct.
    No procedure named Commit exists in any corpus.

## Change

### 1. R547 (`loop-hazard.ts`, `callTargets` bare branch)
- Inside a `reportextension_declaration`, when the base report is in the project and UNIQUE by name
  (`baseReportOf`: `extendedBaseName`, same last-segment rule as `modifiedItemOpen`) and declares a procedure named
  `member` (`procedureNamesOf`), the call ALSO targets the base report. The table target found by
  `resolveReceiverTable` is kept, so both are followed.
- This only ADDS a callee to follow, so it can only add refusals.
- If the base report is not found, or not unique: unchanged. The extension block of a dependency report already
  counts as open (`modifiedItemOpen`).

### 2. R548 (`loop-hazard.ts`, `writesPresetExitName`)
- For a site inside a `reportextension_declaration` whose base report is in the project and unique, the preset exit
  names are `presetExitNames(base)` restricted to the base report's `protected var` names (`protectedVarNames`: a
  `var_section` carrying `protected_keyword`, measured on the vendored grammar). They are refused the same way as
  inside the report.
- A non-protected base global is not accessible from an extension (AL0161, measured in R-463), so it cannot be
  written there.
- **Named residual (ruling 1):** an open data item ADDED by the extension has its own exit guards, and these are not
  read. Only the base report's guards are. Recorded in R548.
- The `"outside open-item code"` condition is the existing function's own rule, unchanged.

### 3. R549 (`receiver.ts`, `claimsSystemCall`)
- Inside a `pageextension`: find the base page by the extension's `extends` name (last segment, as above). Then:
  - **in the project and unique:** refuse when it declares a NON-LOCAL procedure named `Commit` (the claimed name,
    case-insensitive, arm-aware through the existing `declaresProcedure`-style check), else keep the claim;
  - **not in the project, or ambiguous:** KEEP the claim. Named residual in R549: "a public procedure named Commit
    on a dependency base page would be mis-claimed; measured 0 in every corpus". Ruling: a mis-claim there removes
    a call to a page procedure. That is still a real mutant, at worst with a wrong `write-txn-codeunit-run` tag, and
    never a false kill.
- `local` means the base declaration carries the `local` modifier. An `internal` procedure is visible within the
  same app. The base page is in the project, so it is the same app, so `internal` counts as visible.
- Expected corpus effect: 0 (no procedure named Commit anywhere). To be confirmed by the re-dump.

## Tests (red-checked one direction at a time)
- **R547 refuse:** an open extension block (an `addfirst` into an open `Integer` item of a project base report, or
  a `modify` of such an item) calls a bare `BaseProc()` that the base report declares with a body. Every
  BaseProc mutant is hang-refused. Red: drop the base-report follow.
- **R547 control:** the same call from a CLOSED block (anchor on an ordinary table item) keeps BaseProc's mutants.
  Red: make the follow ignore openness, i.e. `modifiedItemOpen` always true.
- **R548 refuse:** the base report has `protected var Continue: Boolean`, an open `Integer` item's exit guard reads
  it, and the extension's `OnPreReport` writes `Continue := true`. That write's mutants are refused. Red: drop the
  reportextension branch.
- **R548 controls:**
  - a write of the extension's OWN global of the same name, not readable by the base guard, is not refused;
  - a non-protected base global cannot appear (alc AL0161), so there is no test for it.
- **R549 refuse:** a project base page declares `procedure Commit(): Integer`, and a pageextension's bare
  `Commit()` is NOT claimed. Red: drop the new guard.
- **R549 keep:**
  - the same base page without that procedure: claimed;
  - with a `local procedure Commit`: claimed (the local is invisible);
  - a base page that is not in the project: claimed.

  Red for the local case: treat local as visible.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- **Re-dump** BaseApp, master leg and branch leg in ONE sitting (about 34 min each; at most 2 corpus jobs), plus the
  6 R549 projects (expect 0 change). Expected:
  - BaseApp -2 deployed (the two R548 sites), 0 keys, ordinals or tags moved;
  - every other project 0.
- Opus build review, one CI push with both jobs green, the three roadmap items set to done in the branch, submit.
- No live gate: no fixture moves. The tables fixture's reportextension extends an in-project report with no
  protected var and no bare base call, measured 0/0.

## Scheme
None (ruling 3): 0 keys, 0 ordinals, 0 tags moved in the prototype measurement. It is re-checked on the built branch.


---

