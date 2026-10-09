# R-340 plan r2: type a trigger's header names (lethal-preproc, 2026-10-09)

**r2 (opus plan review r1, `review-opus-plan-r1.md`, all adopted). Supersedes r1 below where they differ.**
1. **Hang refusal for trigger header names (C1).** r1 §5 was true only for plain `var` locals. A trigger PARAMETER or
   NAMED RETURN is not resolved by `classifyHangCapable`'s path (`resolveVarRef` -> `lookupDeclaredState` ->
   `triggerScopeVar` reads only the plain `var` section), so a loop over it is not seen: the prototype emits
   hang-capable `swap-additive` (h1 `OnNextRecord(Steps)`, h3 named return `Moved`, h6 usercontrol `Ready(Count)`),
   and MASTER already emits hang-capable `remove-assignment` at those writes. Fix: in `classifyHangCapable`, when the
   target resolves to nothing and its name is a header name of the enclosing trigger (`triggerLocalNames`), refuse by
   name through `loopConditionReadsByName` (R-364's unindexed-object pattern). Adds refusals only, and closes master's
   door in the same change (measured and reported as REMOVED sites, by operator). Pipeline tests h1, h3, h6: no swap or
   remove at the loop write, while a safe additive in the same trigger IS emitted; red-check by reverting.
2. **IDENTITY_SCHEME 37, unconditionally (C2).** A swap can change pair under an unchanged identity key (measured: a
   header local typed now makes `swap-call-arguments` pick another pair at the same call), so a scheme-36 verdict or
   mark would carry to a mutant that never ran. Bump with R325's procedure (project.ts, identity tests, resume PINNED,
   report-equality snapshot, sandbox-harden marks, agent doc), as R468 did for scheme 19.
3. **Precedence pinned (I1).** Measured with alc (the review's `alcp/` probe): a trigger header name beats a same-named
   field of the implicit record in 11 contexts, and the negative controls fail AL0133. That collision matrix becomes
   the build's alc repro; unit tests pin a page with a SourceTable, a TableNo `OnRun` and a report dataitem typing the
   LOCAL while a same-named field of another type exists.
4. **Tests that cannot pass either way (I2).** The hang test also asserts the safe additive IS emitted; the `#if` red
   check uses a `#if` INSIDE a plain var section (`Oth: Integer` / `Oth: Text` arms).
5. **Error-parsed trigger (M1).** In the trigger branch, a trigger with `hasError` types nothing (as an unindexed
   procedure does since R331).
6. **Census blind spot (M2).** The site diff and identity keys cannot see a changed swap pair; the closing note says so,
   and the scheme bump is what covers it.
7. The BaseApp census (running) measures the prototype; after the build, the site diff is re-run on all corpora with
   the FINAL build, reporting added (typed) and removed (hang-refused) sites per operator.

---

(r1 text, kept for the record)

# R-340 plan r1: type a trigger's header names (lethal-preproc, 2026-10-09)

Claim: run 001, token 5db60bf4-a481-40e9-902d-4062ed9d402c. Branch `lethal/r340` from master 97d295c7. A prototype
(3ee87b02, [skip ci]) exists only to measure; the build replaces it test-first.

## 1. What is lost today, and why
Since R330 every name a trigger declares in its own header (parameters, plain `var` locals, `#if` locals) is UNKNOWN to
type resolution (`types.ts` `resolveIdentifierType`: `triggerLocalNames(trigger).has(name)` -> no type), and since
R323 so is a trigger's named return. Unknown is safe (no type, and it still hides a same-named global) but typed
operators (`swap-additive`, `swap-call-arguments`) find no site involving those names.

## 2. Measured (`scratch/census340.ts`, `cmp340.ts`, `id340.ts`; master 97d295c7 vs the prototype; files holding a
trigger that declares header names, generation narrowed to them with `only`; keys are file|operator|span)

| corpus | files with header-declaring triggers | header shapes (p param, v var, r named return, i #if) | sites ADDED | REMOVED | identity keys MOVED |
|---|---|---|---|---|---|
| DC | 435 | v 904, p 237, pv 77, vi 2 | 59 (swap-call-arguments 34, swap-additive 25) | 0 | 0 |
| DO | 255 | v 770, p 56, pv 29 | 5 (swap-additive) | 0 | 0 |
| CDO | 239 | v 736, p 55, pv 26 | 5 (swap-additive) | 0 | 0 |
| fixtures | 5 | v 5 | 0 | 0 | 0 |
| BaseApp | (running) | | | | |

Trigger kinds carrying headers (DC top): `OnAction`(v), `OnLookup`(p, pv), `OnValidate`(v), `OnRun`(v), `OnOpenPage`(v),
`OnAfterGetRecord`(v), `OnNewRecord`(p), `OnDelete`(v), `OnDrillDown`(v), `OnQueryClosePage`(p), `OnFindRecord`(p),
`OnControlAddIn`(p), `OnInsertRecord`(p). DO/CDO add control add-in event triggers (p). No named-return trigger
outside BaseApp (R-323 counted 46 there).

No fixture changes, so no gate figure moves.

## 3. The change (small; the prototype's shape)
- `symbol-table.ts`: `triggerHeaderSymbols(trigger)`, `parseProcedure`'s rules applied to the trigger NODE (parameters,
  plain `var` locals, the named return with its `return_type`) plus `conditionallyDeclared(trigger)` for names in a
  `#if` region of the header.
- `types.ts` `resolveIdentifierType`: inside a trigger, a header name is typed by its own declaration; a `#if`-declared
  header name stays unknown; a header name not parsed as one of those stays unknown (and still hides the global).
- Unchanged and kept refused/unknown by name: `#if` header names (R330), the receiver path (`receiver.ts`
  `triggerScopeVar` already reads plain `var` locals; parameters and named returns stay "unknown" as Tier-2
  receivers: out of scope, no record-typed trigger parameter measured), `trigger-skip.ts`'s header-name rule (it only
  asks whether a name is declared, which is unchanged).

## 4. Why R330's and R323's reasons no longer hold
- **R330** made trigger header names unknown because triggers are not in the symbol table (their names repeat across an
  object), so a name LOOKUP could answer with another trigger's declarations or fall through to the globals (an
  `alc`-failing swap, AL0175). R340 does no name lookup: it reads the declarations from the ENCLOSING trigger node
  (`enclosingTrigger`, by position), so repetition cannot mix triggers, and a header name is found before the globals,
  so it still hides them. The part of R330 that is about `#if` regions is kept as is (unknown).
- **R323** made a trigger's named return unknown only for parity with R330 ("like every other trigger header name").
  With R340 the trigger's named return is typed exactly as a procedure's (R323's own rule: a local of its member,
  typed by its declaration, hiding a global).

## 5. Hang refusals see the newly typed sites (measured, `scratch/hang/`, `hang340.ts`)
A trigger whose `var` local drives a loop (`repeat I := I + 1; Total := Total + I; until I > 10`): on the prototype the
trigger's `I + 1` swap-additive is NOT emitted (hang-refused, file count 3 -> 4), exactly as the same loop in a procedure
(the control) is refused on master and the prototype; the safe `Total + I` is newly emitted. The hang check reads the
loop by name and position, not by type, so it already sees these sites. The build pins this as a test.

## 6. Tests (test-first, a red check per direction)
- The 7 existing tests that pin "unknown" for trigger header names (R330 locals/params, R323 n9/n9b, R295's later name)
  flip to the declared type, each asserting the LOCAL's type where a global of another type exists (so typing by the
  global would still fail them).
- New: a `#if`-declared trigger header name stays unknown and still hides a global; a trigger named return types by its
  `return_type`; the same trigger name in two triggers of one object types each by its own header; `swap-additive` and
  `swap-call-arguments` reach a trigger parameter/local through the pipeline, and `alc` compiles each emitted mutant
  (repros for parameter, local and named return, as R340 asks); the hang probe above as a pipeline test.
- Red checks: revert the header lookup (back to unknown) -> the flipped tests go red; type by name lookup instead of the
  node -> the two-triggers test goes red; drop the `#if` rule -> the `#if` test goes red.

## 7. Identity and scheme
Measured on DC, DO, CDO: 0 moved keys (every change is a new site). If BaseApp also shows 0 moved keys, no scheme bump
is needed (R325's rule bumps only when an unchanged source's keys move); if any key moves, IDENTITY_SCHEME 37 (the
orchestrator's number) with R325's procedure. Decided after the BaseApp result.

## 8. Docs and gates
R340 closes `done (<commit>)` with the per-corpus counts; CHANGELOG "Changed" (typed operators reach trigger header
names; counts). No live gate figure moves (fixtures 0); `itest:alrunner` and `itest:tables` are not re-run unless the
fixture census changes. Opus review of this plan; opus build review filed before submit.
