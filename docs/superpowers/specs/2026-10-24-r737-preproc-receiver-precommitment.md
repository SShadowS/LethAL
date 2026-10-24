# R737: callee receivers declared inside a var-section `#if`: corpus cost pre-commitment (lane bugs, R-737, 2026-10-24)

Committed after the parse-only reach census and before the build and the cost run. Never edited after;
changes go in a dated addendum file. Plan: `/coord/handoff/R-737/plan.md`.

## The change
`declaredType`'s text fallback in `packages/builtin-tier1/src/loop-hazard.ts` will descend preprocessor nodes
inside var sections (live arms only in a decided file; every arm in an undecided file), so a callee receiver
declared inside a var-section `#if` gets its type. Follow readers then follow the call; a receiver with two
or more types follows every type's targets (or, in stop/written readers, never stops / reads `unknown`). A
newly certain type can also let certificate readers prove a loop safe, so the cost can go both ways.

## Reach census (parse only, master e8b22a4f; `/coord/handoff/R-737/reach/`)
Script `scripts/r737/reach.ts` (app.json symbols). R = member-call receivers that `resolveVarRef` cannot
resolve and that bind to a preprocessor-wrapped declaration in declaredType's scope order; R_loop = those
inside a `while`/`repeat` (`hasEnclosingLoop`); R_target = type names a project object; R_amb = two or more
types.

| set | projects | R | R_loop | R_target | R_amb |
|---|---|---|---|---|---|
| fixtures | 23 | 0 | 0 | 0 | 0 |
| do | 7 | 0 | 0 | 0 | 0 |
| cdo | 6 | 0 | 0 | 0 | 0 |
| dc | 14 | 30 | 1 | 5 | 0 |
| baseapp (Base Application) | 1 | 236 | 23 | 228 | 0 |

R_loop files: dc `Al/Overrides/CDCAllocationAccountMgt.Codeunit.al` (project Cloud); baseapp
`Assembly/Costing/CalculateAssemblyCost.Codeunit.al`, `Assembly/Document/AssemblyLinePlanning.Codeunit.al`,
`Assembly/Inventory/Requisition/AsmCarryOutAction.Codeunit.al`, `Inventory/Item/Substitution/ItemSubst.Codeunit.al`,
`Manufacturing/Document/ProdOrderAvailabilityMgt.Codeunit.al`, `Manufacturing/Document/ProdOrderLinePlanning.Codeunit.al`,
`Manufacturing/Inventory/Planning/MfgPlanningLineManagement.Codeunit.al`,
`Manufacturing/Inventory/Requisition/MfgCarryOutAction.Codeunit.al`, `Manufacturing/MfgCreateInventoryPutaway.Codeunit.al`,
`Manufacturing/Warehouse/Activity/MfgCreateInvtPickMovement.Codeunit.al`.

## Predictions for the cost run (`scripts/r737/cost.ts`: `generateMutationSet` with `r737Seam` off, then on,
per project, per file; specs removed and added counted separately). Any miss is a BLOCK until explained.
- C1. fixtures, do, cdo: exactly 0 specs removed, 0 added, no changed file.
- C2. dc: every changed file is `Al/Overrides/CDCAllocationAccountMgt.Codeunit.al` (project Cloud); specs
  removed <= that file's spec count; no other dc project changes.
- C3. baseapp: every changed file is one of the ten R_loop files above; specs removed <= the sum of their spec
  counts.
- C4. Every spec ADDED (fewer refusals) is in a C2/C3 file and is traced to a receiver whose type is certain
  (live arm of a decided file); no spec is added anywhere else.
- C5. R_amb is 0 everywhere, so no ambiguous receiver reaches a stop/written reader: those guards are
  unreachable on these corpora (a `ponytail:` comment names that ceiling; no guard-specific test).
- C6. `corpus-snapshot diff fixtures` against master is identical; R725's tests stay green; the R402 shape
  sweep reports 0 problems.

## Not claimed
No exact removed/added counts (the census counts call sites, not mutants). Nothing about BC.History projects
other than the Base Application (the same scope as R-725's cost run). Wall time is recorded, not predicted.
