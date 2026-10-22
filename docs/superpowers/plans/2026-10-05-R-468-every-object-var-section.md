# R-468: index every direct object-level `var` section as globals (short plan, r3)

**r3, on the merged base (master c5e39fed with R-254, branch ffb8229d; `measurement-r3.md`):**

- The site diff is IDENTICAL to r2 in every sorted row file.
  - The baseline grew by 723 BaseApp rows in reportextensions (now instrumentable). None of those
    rows differs between master and branch: Tier 2 does not claim inside a reportextension (R463).
- All 25 fixture and example jobs are byte-identical on both sides (1,756 rows; sandbox-data
  included), so `itest:tables` and every other frozen gate cannot move.
- Sol r2's one blocker, the B1 bounds, is closed (`measurement-r2-bounds.md`). Each of these has 0
  hits, so nothing is reclassified as unchecked:
  - a `SourceTable` or `TableNo` that appears only under `#if`;
  - a clash with a conditional field;
  - a field map built only from a tableextension.
- B1 now includes reportextensions:
  - 2 objects with a second direct section, 3 names, 38 uses, 27 in a `modify`/`add` scope.
  - 0 clashes. The 24 uses against `System.Utilities.Integer`, whose only field is `Number`, are
    checked by hand.
  - Unknown platform-table uses fall from 92 to 72.
- Pre-existing first-section clashes: the same 39 as before (on R464).
- One BaseApp reportextension file (`MfgWhseSourceCreateDocument.ReportExt.al`) was not indexed by
  the scan. It has a single object-level var section; its other `var` lines are trigger and
  procedure locals, one under `#if`. It holds no second-section global, so it is irrelevant here.
- R469 is FILED (sol r2): the selector variable is inserted into a first `protected var` section.
- The other wording notes are applied:
  - the 712 are absent-key OCCURRENCES;
  - the inactive-arm test goes red when "inactive-arm filtering is ignored";
  - r1's eight changed swap rows and r2's eight cross-span key matches are different sets.
- `IDENTITY_SCHEME` stays 19 (master is now 17; R-458 holds 18).

# (r2 body below; r3 notes above supersede it where they differ)

Task: `/coord/tasks/R-468/task.md`. Measurement: r1 `/coord/handoff/R-468/measurement.md`, r2
`/coord/handoff/R-468/measurement-r2.md` (r2 supersedes r1 where they differ; scripts in
`/coord/handoff/R-468/tools/`). Worktree `/work/lethal-wt/r468`, branch `lethal/r468`, prototype
10f35447 on master 51ac59a1. `IDENTITY_SCHEME` 19 (master 16; R-254 holds 17, R-458 18).

**r2 changes, from sol r1 (`sol-review-r1.md`) and the orchestrator's rulings:**
- B1: the "no wrong mutants" claim is now bounded by what was checked (section 1).
- B2: the flip account is corrected; all 25 literals are `true`.
- B3: the controls are replaced with load-bearing ones (section 3).
- The key accounting is corrected.
- The orchestrator ruled to keep R-468 narrow. The pre-existing `lookupVar` field-shadowing gap is
  recorded on R464 (one implicit-record resolver), with a warning against copying `types.ts`'s
  blanket guard.

## 1. What was measured (wrong bindings first)
- **Wrong bindings created by this fix: none found, within these bounds.**
  - Checked: every use, inside a procedure or trigger, of a name declared in a second-or-later
    direct section that `lookupVar` now resolves:
    - BaseApp history: 4,807 names, 27,998 uses.
    - CDO: 174 names, 727 uses.
  - Of those, 17,830 BaseApp and 62 CDO uses sit in an implicit-record scope:
    - page with `SourceTable`;
    - pageextension through its base page;
    - TableNo `OnRun`;
    - the report dataitem chain;
    - request pages;
    - reportextension `modify`;
    - `with` bodies.
  - In each, the implicit table was resolved by name over the whole corpus, and none has a
    same-named field.
  - **Unchecked, not clean:**
    - 92 BaseApp uses against platform system tables not in the corpus;
    - declarative uses (no mutant sits there);
    - reportextension objects (not indexed at all).
  - A self-check project with planted clashes is flagged exactly.
- **The same gap exists on master for FIRST-section globals:** 39 BaseApp uses, 11 name+file pairs
  in 6 files; CDO 0. It is now recorded on R464 (the orchestrator ruled: no new item, and no fix
  here). This fix adds no such use.
- **Locals made global: none.**
  - 690 objects have more than one direct `var_section` (BaseApp 686, CDO 4, fixtures 0): 704 extra
    sections, 621 `protected var` and 83 `var`.
  - Every one is a real object-level section (r1).
- **Site diff** (BaseApp / CDO; fixtures identical, 25 jobs):

| | BaseApp | CDO |
|---|---|---|
| ADDED | 1,370 | 2 |
| REMOVED | 736 | 2 |
| RETAGGED | 1 | 0 |
| `hang-refused` | +7 in 6 files | 0 |

- **Key accounting.** 712 master identity keys are absent on the branch (BaseApp 710, CDO 2):
  - **680 REPLACED**: `void-method-call` gives way to `remove-setrange` (445), `remove-testfield`
    (150) or `remove-calcfields` (85). Same span, same mutated text: the receiver now resolves to a
    Record, so Tier 2 claims the call.
  - **25 CEDED**: a `true` RunTrigger `flip-boolean-literal` at `Insert` (14), `Delete` (7) or
    `Modify` (4) goes to `swap-modify-flag` on the whole call. All 25 literals are `true`, so this
    is the designed cession; 16 of the replacements carry a `run-trigger-skipped-*` tag.
  - **7 REMOVED** as new hang refusals (6 `remove-assignment`, 1 `shift-integer`), including
    R468's `SuggestVendorPayments.Report.al:1078`.
  - **26 SAME KEY, CHANGED BEHAVIOUR**, which a key-based "moved" count misses:
    - All are `swap-call-arguments` at the same call, now swapping a different, correctly typed
      pair.
    - None sits in an implicit-record scope.
    - Only the scheme bump separates their old and new history, which is why scheme 19 is
      warranted beyond the 712.
  - Sol's "8 argument-changed rows" was a key-collision artifact: identical statements in
    same-named triggers share a key, so pairs must be made by span.
- **Retagged:** `CreateUsageDataBilling.Codeunit.al:121`, `Modify(false)`, loses `run-trigger-forced`.
  Its receiver now resolves to a table with no `OnModify`, so the tag is dropped under R143's rule:
  a precision gain.

## 2. Change
1. In `packages/engine/src/semantic/symbol-table.ts`, `indexMembers` takes as globals every
   `var_section` that is a direct member, plus (R405 a) those inside an active member-level `#if`, in
   source order. This is the prototype, one condition; its comment says why first-only was wrong.
2. `IDENTITY_SCHEME` 19: every literal bumped in one commit, plus the constant pin.
3. R468 is closed with this measurement. R464 gains the B1 evidence (the orchestrator's ruling).
   CHANGELOG: Fixed (second sections are globals: the 7 hang refusals, the Tier-2 sites) and Changed
   (scheme 19).
4. **Out of scope, filed if you agree:** schemata inserts its `MutationSelector` variable into the
   object's FIRST var section (`compile-plan.ts`, `existingVar`). When that section is
   `protected var`, the variable becomes visible to extensions of that table or codeunit. That is
   emission, not reading, and it predates this change. Sol: "document and track, not dismiss".

## 3. Tests (test-first; each red-checked; each direction has its own red test)
**Missing-fix direction** (each goes red if the fix is reverted to first-only):
- `globalsOf` holds every name of `protected var A; var B;` and of a 3-section object;
  `resolveVarRef(B)` resolves.
- R468's repro `while B do B := false;`, with B in section 2, is refused: no `remove-assignment`
  mutant, and `classifyHangCapable` is `loop-condition-target`.
- Through the FULL pipeline (`generateMutationSet`, i.e. final dedupe), with a section-2 `Record`
  global R:
  - at `R.SetRange(...)` exactly one mutant, `remove-setrange`, survives (no `void-method-call`);
  - at `R.Modify(true)`, `swap-modify-flag` is emitted and there is no `flip-boolean-literal`.

**Over-applied direction** (each goes red if the fix reads more than direct and active-`#if`
sections):
- A procedure-only local `L` is absent from `globalsOf` and unresolved in another procedure. Red if
  sections are collected recursively.
- A split procedure's locals and an R327 swallowed member's locals are absent from `globalsOf`.
  Red if the swallowed var bodies or split arms are read as globals.
- A section inside an INACTIVE `#if` arm stays unindexed under an arm map. Red if `place` is
  ignored.
- A section-2 global that NO loop condition reads stays mutable (`remove-assignment` emitted). Red
  under a wrong fix that refuses every section-2 write.

**Precision:**
- `R.Modify(false)` on a section-2 record of a table WITHOUT `OnModify` is untagged.
- `R.Modify(false)` with `OnModify` is tagged `run-trigger-forced`.

**Scheme pin** at 19.

## 4. Gates
- No gate fixture changes (25 jobs identical), so no frozen figure can move.
- No fixture arm now: sandbox-data's gates belong to R-254 until it merges. Sol notes that unit
  tests are not live coverage. A pre-committed live arm can follow as its own task after R-254 if
  you want one.
- Branch CI green on both jobs; verify on the final head; the exact site diff is re-run on the final
  head if the code differs from the prototype beyond the scheme literal.

## 5. Order with R-458 (agreed with lethal-bugs)
Whichever of R-458 (scheme 18) and R-468 lands SECOND re-runs its exact site diff on top of the
other.
