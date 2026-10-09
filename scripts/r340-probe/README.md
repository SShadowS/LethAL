# R340 probe: trigger header names vs implicit-record fields

Evidence for [R340](../../docs/roadmap/R340.md) (plan review I1). Synthetic AL only (written for this probe; no corpus
text).

`alcp/` declares a table `PT` with a field `Z: Text[30]`, and in each context below a trigger declares its own
`Z: Integer` (a `var` local, a parameter, or a named return) and uses it as an Integer (`TakeInts(Q, Z)`, `Z + Z`):
table trigger and field trigger, page trigger / field trigger / parameter / named return, page action `OnAction` (the
most common header-declaring trigger in BaseApp) and a usercontrol event trigger's parameter (added after the build
review, M2; `CA.al` and `script.js` are the control add-in it needs), pageextension field and page trigger,
tableextension field trigger, report data item and nested data item, request page with a SourceTable, xmlport table
element, and a TableNo codeunit's `OnRun` (alc warns AL0557 there, "will shadow that table field").

- **Precedence (measured with alc 18.0.2819426, plan review r1):** the header name wins in every context and the
  original compiles; with the local removed (two negative controls, since dropped from `alcp/`) the field is in scope and
  an Integer-only use fails AL0133. So: header name > implicit-record field > global, for triggers as for procedures.
- **Mutant-level proof (`compile-mutants.ts`):** LethAL types `Z` by the header, so `swap-additive` emits `Z - Z`.
  Instrumenting every emitted mutant into one project (completed by the runner's own `prepareBatchProject`) and
  compiling it with alc succeeds (14 `Z - Z` mutants, 2026-10-09; the xmlport is not instrumented). Had alc resolved
  `Z` to the Text field, `Z - Z` would fail AL0175. The precedence for the two contexts added after the review (action,
  usercontrol) rests on this mutant-level compile only.

Run (repo root): `bun scripts/r340-probe/compile-mutants.ts <out dir> fixtures/sandbox-app/lethal.config.local.json`
(the gitignored bcdev config, read only for its symbol cache and LethAL Control symbol paths).
