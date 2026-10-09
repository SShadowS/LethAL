# R-555 plan r3 (lethal-code): r2 plus the adversary-r2 fixes

`plan.r1.md` and `plan.r2.md` hold except as changed here. F-numbers refer to `adversary-r2.md`.

1. **F1, extension writers.**
   - First an alc probe (own-code scratch project): is a procedure declared in a project reportextension of X
     callable through a `Report X` variable from a codeunit? The R-547 `[Obsolete]` marker shows the binding.
   - If yes: the cross-object rule's writer set for X is `presetWriters(X)` ∪ `presetWriters(ext)` for EVERY
     project reportextension of X. The extension writers are computed against the extension's names, so they
     include R548's protected base names. Concrete site: `ProductionOrder.Table.al` `RunCreatePickFromWhseSource`
     -> `SetProdOrder`.
   - If no: R555 records the probe and the site, and explains why it is not a hole.
   - Test: a codeunit calls an extension writer through `Rep: Report X`; refused. Red: base writers only.
2. **F2, the scope stated exactly.** The cross-object branch runs in EVERY object, reports and reportextensions
   included, for a call whose receiver is a typed `Report X` (another instance, not `CurrReport`).
   - It runs before the `names.size === 0` early return.
   - `inOpenItemCode` is irrelevant to it: open-item sites are already refused by `openItemHangRefuses`' first
     part.
   - This matches the measured 86, which include `AccountSchedule.Report` OnPreRendering and
     `UpdateContractPrices.Report` OnPreDataItem.
3. **F4.** The new roadmap item says the Application Test Library's 5 calls are not sites "unless that library is
   itself the run's target (`--project`)".
4. **F5, tests.**
   - **The F5 narrowing also applies to `argWritten`'s unread rule** (`procedure <name>`, not the bare token), so
     the two unread rules agree. The test passes a literal to `Error(...)` anyway, so it isolates the
     callee-writer rule.
   - **`objectsOfType` is exported** (internal, for the pin test), with its comment naming R500 shape 2.
   - **The F2 test** keeps the var section and the open guard OUTSIDE the ERROR region and asserts
     `presetExitNames(report).size > 0` before checking the refusal.
5. **Re-measure.** The final BaseApp diff (both legs on 9ff74df7) is expected at about 483 plus the extension-writer
   sites (at least the `ProductionOrder` one).
   - Every site beyond the measured set is named in R555, and so is every ordinal move.
   - If an ordinal moves beyond the measured 5, it is still scheme 38: no tuple moves, the same reason.


---

# R-555 plan r2 (lethal-code): r1 plus the adversary-r1 fixes and the orchestrator's fold rulings

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`. Numbers come from
`/coord/handoff/R-555/measure.md` (with its addendum), measured on 48d5534f. The branch now sits on 9ff74df7
(R-340, scheme 37), and the final BaseApp diff is re-run with BOTH legs on that base.

## F1, cross-object writer calls: the RESOLVABLE ones fold in (ruling)
- A call in ANY object whose receiver is declared `Report X` (a variable or a parameter), where X is a project
  report (unique by name, or every same-named candidate, as R-547 does) and the member is in `presetWriters(X)`,
  gets the full shape-1 treatment: the call, its guards, the enclosing blocks and an early exit before it.
  - It is a new branch in the dispatch for objects that are not reports, reusing `presetWriters(targetReport)`
    and `writesPresetExitName`'s refusal walk.
  - "Outside open-item code" applies only within a report, so it does not apply here: the call is in another
    object.
- **The report lookup is LOCAL to this rule** (a report-by-name lookup). `objectsOfType` keeps returning `[]` for
  kind `report`, with a comment naming why: widening it would also widen R500 shape 2's callee follow, which is a
  separate decision.
  - A unit test pins `objectsOfType("report")` returning `[]`, so a later change is deliberate.
- **Measured** (BaseApp; CDO, DC and DO have 0 resolvable sites):
  - +86 refused for this rule;
  - 483 in total with the in-report rule (0.064% of BaseApp), 0 added;
  - 0 tuples moved, 5 ordinals moved (the in-report 3, plus AssemblyHeader `RunWhseSourceCreateDocument`
    remove-not and GraphMgtTimeRegistration `CreateTimeSheetHeader` flip-boolean-literal);
  - kill tags unchanged.
- **The unresolvable groups are filed as ONE new roadmap item** (next id checked right before writing), with the
  table:

  | receiver group | count | notes |
  |---|---:|---|
  | outside the project | 85 | 80 in BaseApp TEST apps (Tests-Report 31), 5 in Application Test Library, 2 in Quality Management |
  | interface | 17 | name match only: upper bound, mostly coincidences |
  | untyped | 6 | includes `MfgWhseSourceCreateDocument.ReportExt` `?.SetParameters` |
  | complex | 15 | name match only |

  The item states that LethAL mutates only the run's TARGET project (`--project`); the test app (`--tests`) is
  never mutated. So the 80 test-app calls, and the 5 in the Application Test Library (test-side code), are NOT
  mutation sites in a normal run and NOT a hole. The real outside-project exposure is the 2 calls in Quality
  Management, a real app calling a BaseApp report. The interface, untyped and complex groups are upper bounds.

## F2, parse-damaged reports: folded in (ruling)
In a report with `hasError` and preset names, an unknown bare callee whose name is a token inside an ERROR
descendant counts as a writer. Measured: 0 damaged reports on any corpus (BaseApp: 0 parse errors in 8,098
files), so the cost is 0. A report swallowed WHOLE into ERROR is the separate `unparsedObjects` case, which this
does not cover; that is stated in R555.

## F5, the unread-base token rule narrowed
In a reportextension with an unparsed base candidate, an unknown callee counts as a writer only when the unread
text holds `procedure <name>` (two tokens in sequence), not merely the name. This stops `Error`, `Message` and
`Format` from matching. The same narrowing applies to F2's ERROR-descendant rule. Measured cost: 0 either way.

## F4, scheme 38 on top of 37
- `IDENTITY_SCHEME` 37 -> 38. The chain comment: "37 R-340, 38 R-555 (five BaseApp ordinals renumber; no tuple
  moves)".
- The pins are the NINE places: the EIGHT identity tests (r500-dispatch.test.ts included), `resume.test.ts`
  (the pin and the PINNED digest, recomputed on the merged base), the report-equality snapshot, the
  sandbox-harden marks file, and the agent guide.

## F3, tests added (each red-checked one direction at a time)
- **hiddenCallee:** OnPreReport calls `CurrReport.Setup()`, and separately a paren-less bare writer
  (`if Ready then`), where `Setup` and `Ready` write the preset name. Both are refused. Red: drop `hiddenCallee`
  from the fixpoint and from `callsPresetWriter`.
- **names.size === 0 bypass:** the base-private extension test's extension declares NO preset names of its own,
  and its call to the base writer is still refused. Red: keep the early return.
- **Unknown, with no arguments:** the unparsed-base call passes no argument, so `argWritten` cannot refuse it on
  master. Red: treat unread as not a writer.
- **Cross-object:** `Rep.SetContinue(true)` in a codeunit, with `Rep: Report X` and X's `SetContinue` a writer,
  is refused, and so is its guard. Control: `Rep.Other()` stays deployed. Red: drop the cross-object branch.
- **Pin:** `objectsOfType("report")` returns `[]`.
- **F2:** a broken report with a swallowed writer, whose bare call is refused. Red: drop the ERROR-token rule.
- **F5:** an unparsed base whose text mentions `Error` but declares no `procedure Error`; a bare `Error(...)`
  call is NOT counted as a writer. Red: match the bare token instead of `procedure <name>`.

## Gates (r1, amended)
- Final BaseApp diff with BOTH legs on the merged base 9ff74df7 (R-340 changed hang-check code), in one sitting.
  Expected about 483 refused, 5 ordinals, 0 tuples and 0 tags; any difference from the measured set is explained
  site by site before submitting.
- Then the opus build review, one CI push, R555 done in the branch, and the new item filed.


---

# R-555 plan r1 (lethal-code): a call to a preset-exit-name writer counts as a write (refusal only)

Base: master 48d5534f. Branch `lethal/r555`. Measurement and prototype diff: `/coord/handoff/R-555/measure.md`.
Orchestrator rulings 2026-10-09: GO as measured, with the full shape-1 treatment; scheme 38 (pinned in the branch
now; the submit waits for R-340's 37 to merge unless told otherwise).

## Measured (step 1)
- Parse-only scan of 569 projects: preset WRITER procedures exist only in BaseApp (85 objects). 34 reports call a
  writer outside open-item code. 7 reportextensions have writers and make 0 such calls.
- BaseApp production run, both legs in one sitting:
  - deployed 751,360 -> 750,963 (**-397**, 0 added); hang-refused 44,209 -> 44,606; `skipped` 5,097 on both
    sides;
  - 0 identity tuples moved; 0 of 4,259 kill tags changed;
  - **3 ordinals moved**, each a same-tuple twin renumbered down because its sibling was refused:
    `AccountSchedule.Report.al` `OnValidate` `toggle-blank-string` twice, and `FAPostingGroupNetChange.Report.al`
    `CalculateAccount` `negate-guard`.
- The dominant cost is `CostingErrorsDetection` with **244**: `AddError` writes a preset name and is called in
  every check procedure, so every guard around those calls is refused.
- Every other project and the fixtures: unchanged.

## Change (`packages/builtin-tier1/src/loop-hazard.ts`, `writesPresetExitName`)
1. **Split out the old predicate.** Today's assignment and `var`-argument write predicate moves unchanged into
   `directWrite(n, names, ctx)`.
2. **`presetWriters(obj, names, ctx)`** (cached per object). A procedure is a WRITER when:
   - it contains a `directWrite` of a preset name; or
   - it calls a writer.

   This is computed to a fixpoint over the call shapes `openReachable` follows (`bareCallee`, `hiddenCallee`).
   Inside a reportextension the base candidates' procedures are included (`baseCandidatesOf`, R-547). Each base
   procedure is checked against the extension's names plus that base's own `presetExitNames`, because a base
   procedure can write a base-private name the extension cannot spell.
3. **`writes(n)`** becomes `directWrite(n) || callsPresetWriter(n)`. The early return on `names.size === 0` is
   skipped when writers exist.

   Shape 1's existing machinery then gives a writer call exactly what a direct write gets:
   - the call and everything inside it;
   - every enclosing statement or block, up to the body;
   - the condition of an `if`/`while`/`repeat`/`case` holding it;
   - an early exit before it in the same scope.

   No new refusal kind is invented.
4. **Unknown callees refuse (ruling).**
   - In a report, a bare name that is neither its own procedure nor a known writer is a builtin: not a writer, the
     same as today's `argWritten` treatment of builtins.
   - In a reportextension, a name found only in an UNPARSED base candidate (`baseCandidatesOf(...).unread`)
     counts as a writer: refuse.
   - Measured: no corpus reportextension has an unparsed base, so this costs 0.
   - The env switches of the prototype (`R555_ON`, `R555_UNKNOWN`) are NOT kept.

## Scheme 38 (ruling)
`IDENTITY_SCHEME` 36 -> 38 in `packages/schemata/src/project.ts`. The chain comment records 37 as R-340's
(pending) and 38 as R-555's: three BaseApp ordinals renumber, and no tuple moves. The pins follow the R-500 / R-343
list:
- the seven identity tests;
- `resume.test.ts`: the pin and the PINNED digest;
- the report-equality snapshot (`--update-snapshots` on that file only);
- the `fixtures/sandbox-harden` marks file;
- `docs/using-lethal-from-an-agent.md`.

R325 refuses resume across the bump, which is the intended behaviour. At merge, if R-340 has landed with 37, the
chain keeps both entries.

## Tests (red-checked one direction at a time; full output read, never a tail)
- **Refuse:** a report with an open `Integer` item (asserted open) whose exit guard reads `Continue`. OnPreReport
  does `if Counter = 0 then InitContinue();`, and `InitContinue` sets `Continue := true`. The call, the guard
  condition and the enclosing block are refused. Red: `writes` reverts to `directWrite` only.
- **Transitive:** OnPreReport calls `Setup()`, and `Setup` calls `InitContinue()`. The `Setup()` call is refused.
  Red: no fixpoint (direct writers only).
- **Control:** `Other();`, which writes no preset name, together with its body stays deployed. Red: count every
  call as a writer.
- **Extension:** a reportextension's OnPreReport calls a base procedure that writes a base-private preset name;
  refused. Red: drop the base candidates from `presetWriters`.
- **Unknown:** a reportextension whose base candidate is unparsed and declares the name; the call is refused. Red:
  treat unread as not a writer.
- **Builtin control:** a bare builtin (`Clear(X)` on a non-preset name, or `Commit()`) is not a writer. Red: treat
  unknown bare names as writers in a report.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- **BaseApp re-dump on the built branch** against the master leg from step 1 (one leg, about 34 min). Expect
  exactly the 397 removals, the same 3 ordinal moves, 0 tuples and 0 tags.
- Opus build review, one CI push with both jobs green, R555 done in the branch.
- R555 names CostingErrorsDetection's 244 (the AddError reason) and the 3 renumbered twins by file and procedure.
- The submit waits for R-340.


---

