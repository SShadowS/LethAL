# R752 + R751: pre-commitment (lane bugs, R-752, 2026-10-25)

Committed before the build and before any measuring run. Never edited after; changes go in a dated addendum.
Plan: `/coord/handoff/R-752/plan.md`. Trace: `/coord/handoff/R-752/trace.md`.

## The changes
- **R752 (part A):** R731 (69478059) made `lethal.toggle-blank-string` refuse to blank a one-character literal
  whose target types as Char OR unknown. A bare field of the implicit record (`"No." := 'Z';` in a table trigger)
  types as unknown, so it was refused, and the R402 sweep's `w6_var_swallowed_table` fell from 29 to 28 specs
  (R731 re-ran only its new x1/x2 shapes). The fix exempts a bare name that provably binds a field of a PROJECT
  table in the innermost record scope (table, tableextension on a project table, page with a project SourceTable,
  TableNo codeunit OnRun, report data item); a table field can never be Char (AL0156). A local, parameter or
  global with that name still wins and is still refused; anything unresolvable stays refused.
- **R751 (part B):** `r737Partial` counts a type as unresolved when it yields no procedure for the called member
  (not only when it names no project object).

## Predictions (any miss is a BLOCK until explained)
Measured with `corpus-snapshot diff`, branch head vs master c1034f7c.
- P1. No spec is REMOVED on any corpus; tuples moved 0 and tags changed 0; ordinals move only in files that gained
  a spec.
- P2. Every ADDED spec is a `lethal.toggle-blank-string` on a one-character literal assigned to a bare
  implicit-record field, in a table, tableextension, page, TableNo-codeunit or report file. Part B adds 0.
- P3. fixtures: 0 added (R731's fixtures diff was identical).
- P4. dc: at most 100 added in total and, per project, at most the toggle-blank-string specs R731 removed there
  (`/coord/handoff/R-731/dump-diff-dc.txt`: Cloud 23, Cloud/Modules/Purchase Contracts/Base 1, Test 76);
  `.dependencies/DC/Table/CDCAIField.Table.al` adds 0 (its R731 site is a `T[i]` subscript, still refused).
- P5. do, cdo, baseapp (the Base Application): R731 never measured them, so the bound is P1 + P2 only.
- P6. The hang count rises only by hang-tagged added specs, each named.
- P7. The R402 shape sweep exits 0 with `w6_var_swallowed_table` at 29 (`[29, 15, 29, 15]` unchanged).
- P8. `scripts/r315-dc-compile.ts` on the DC/Cloud scratch copy: 0 errors (in particular 0 AL0122).
- P9. The R737 reach census re-run is identical to R-737's (R_amb = 0 on every corpus), so part B has no reach.
- P10. Every selected gate (bcdev, tables, chunked, alrunner-v3) passes with its per-mutant table unchanged.
