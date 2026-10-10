# R-562 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`. Findings 1 and 3 change what
the census counts, so the census and the dumps are RE-RUN before the build.

1. **F1, modify-unseen joins.** In the modify-unseen branch (R has no direct filter in scope) each written field
   becomes a dependency (`dep(m.r, w.field)`, and `m.all`), so a loop whose only filter comes from a helper is
   followed. The census is re-run with this.
2. **F2, the callee's early exits.** In a qualifying callee, every early-exit statement (`exit`, `Error`, the
   `isEarlyExit` set) that comes BEFORE a qualifying filter call in the same body, together with its guard, is
   refused. A mutant that takes such an exit skips the filter while the caller's loop still runs.
3. **F3, unresolved callees, defined exactly and measured.** Refuse the CALL (only the call, its arguments and its
   guards, as preFilters) when ALL hold:
   - it ends before a filter-dependent loop in the same scope; and
   - it is a call on R (`R.P(...)`) or passes R in a `var` position; and
   - its callee cannot be resolved to a body. That covers a recv-proc whose `declaredType`/`objectsOfType` finds
     nothing (a symbol-only dependency table), a same-object name with no arity-fitting overload, or a
     `pass-other` call into another object.

   The predicate is counted on EVERY corpus, and every project where it is non-zero is re-dumped against the
   master legs. If the cost is more than about 0.05% anywhere, it goes back to the orchestrator before the build.
   `RecRef.GetTable(R)` and `Codeunit.Run(.., R)` are excluded: `GetTable` reads R, and `Codeunit.Run` with a
   record runs `OnRun` on a COPY unless the codeunit's TableNo is set and `var` is used. If the census finds them,
   they are named.
4. **F4, in-project cross-object callees.** A codeunit-typed receiver or argument target is resolved through
   `declaredType`/`objectsOfType`, the existing machinery recv-proc uses for tables, IF `objectsOfType` already
   returns codeunits. The build checks that. If it does, the callee is followed exactly as recv-proc is. If it does
   not, it is NOT built; the limit is stated in R562 and filed. Either way it is measured.
5. **F5, a working dependency control.** A Modify loop with a DIRECT filter on a written field, plus a callee that
   filters a DIFFERENT field: the callee's filter is not refused. Red: count every callee filter.
6. **F6, tests added:**
   - global-call: a same-object procedure via the implicit Rec;
   - `preGuards`: the `if` around the call is refused;
   - FEEDS on the call's argument: `T := xRec."Template Code"; R.SetTplFilter(T)` refuses the feed's
     remove-assignment;
   - the guard around the filter inside the callee is refused;
   - F2: the callee's early exit;
   - F3: an unresolved recv-proc call is refused.

   Each is red-checked one direction at a time.
7. **F7, stated in R562 as limits shared with direct FILTER:** two hops; event publishers and their subscribers;
   a filter on a local copy moved over with `CopyFilters`/`SetView`; a call between nested loops; the callee's own
   FEEDS.

The scheme claim (0 tuples, 0 ordinals, so no bump) is re-checked on the re-run and again on the built branch. If
an ordinal moves, I ask the orchestrator for the next free scheme.


---

# R-562 plan r1 (lethal-code): follow a pre-loop filter-setting call one hop (refusal only)

Base: master 1d49fa1b (R-531 merged, scheme 39). Branch `lethal/r562`. Measurement: `/coord/handoff/R-562/measure.md`.
Prototype diff (LethAL code): session scratchpad `r562/out/proto.diff`, about 90 lines in `r531AnalyzeOnce`.

Orchestrator rulings 2026-10-10:
- (a) keep arity-only overloads, name DO's 8 over-refusals in R562 as the known cost, and file "choose overloads
  by argument type" as one item covering R-531's HOP and R-562, with those 8 as its payoff;
- (b) accept DO's 0.079%: the 0.05% line triggers a closer look and is not a cap; it is one project and one
  certain-hang shape that R-531 already sampled, and 8 of the 35 are (a)'s over-refusal;
- no scheme bump (0 tuples, 0 ordinals), so 39 stands.

## Change (`packages/builtin-tier1/src/loop-hazard.ts`, R-531's FILTER in `r531AnalyzeOnce`)

**When it applies.** For a loop of R-531's shape whose ending depends on a filter (R-531's `depends` map, or a
`Mark` consumer), every call in the same scope that ENDS BEFORE THE LOOP is followed ONE hop, with R-531's HOP
resolution:
- **recv-proc:** a table procedure on R (`declaredType` + `objectsOfType`), every overload that fits by arity;
- **global-call:** a same-object procedure while R is the implicit Rec, or a global the callee does not shadow;
- **pass-rec:** ONLY through a `var` parameter. A by-value copy's filters change only the copy, never the
  caller's R. This is the reverse of R-531's consumer HOP, and on purpose: a filter is variable state, while a
  Delete hits the table.

**What counts in the callee.** `SetRange`/`SetFilter` on the callee's R pass FILTER's own dependency test: any
filter for a `Rename` consumer, otherwise a field the consumer changes. `MarkedOnly` counts for a `Mark` consumer.
Reset, SetView and CopyFilters are not counted, as in direct FILTER.

**What is refused when a callee qualifies:**
- every site inside the callee's qualifying filter calls, the statements and blocks containing them, and the
  guards around them;
- the CALL itself, added to `preFilters`. That reuses the existing rules for its arguments, its
  `void-method-call`, the guards around it, and FEEDS on its arguments.

**Unresolvable callees** (a call on R that the HOP resolution cannot find) are refused, in the refusal direction.
Measured: 0 on every corpus, so the cost is 0.

## Measured (prototype vs master legs; the switch-off control was equal)
- Census: 118 R-531-shaped loops, 24 pre-loop calls, 4 qualifying, all OnRename:
  - CDO `CDO E-Mail Template Line` (Table 6175284) OnRename -> `SetTemplateFilter`, `SetEMailTemplateLineFilter`;
  - DO `CDOEMailTemplateLine.Table.al` OnRename -> the same two.

  BC.History, DC and the fixtures: 0.
- **CDO Cloud** -15 deployed keys (0.055% of specs); **DO Cloud** -23 (0.079%). 0 added, 0 tuples, 0 ordinals, 0
  kill tags.
- Named:
  - OnRename: `void-method-call` x2 (the two calls), `negate-conditional` x3 and `swap-rec-xrec` x2 in the guarding
    `if`;
  - the callees' `remove-setrange` and `empty-block` (CDO 3 + 1 each callee; DO 6 + 2 each, of which 8 are the
    over-refused second overload).
- Not refused, by design: the trigger body's and the `then` block's `empty-block`. Removing either removes the
  loop with the filter, so it cannot hang; direct FILTER behaves the same.
- No `swap-rec-xrec` exists on the bare `xRec` argument: that operator mutates only `xRec.Field`.

## Tests (red-checked one direction at a time; full output, never a tail)
- **recv-proc refuse:** `R.SetTplFilter(xRec)` before a `while R.FindFirst() do R.Rename(...)` loop, where the table
  procedure does `SetRange(Tpl, X.Tpl)`. The call's `void-method-call` and the callee's `remove-setrange` are
  refused. Red: drop the hop.
- **var pass-rec refuse:** `SetFilters(R)` with a `var` parameter doing `R.SetRange(...)`; refused. Red: drop the
  pass-rec branch.
- **By-value control:** the same callee taking R BY VALUE; NOT refused. Red: follow by-value too.
- **Dependency control:** a callee filtering a field a Delete-loop's consumer does not change (not Rename); NOT
  refused. Red: count every callee filter.
- **Post-loop control:** the same call AFTER the loop; NOT refused. Red: ignore "ends before the loop".
- **Overload (arity):** two 1-parameter overloads; both callees' filters are refused (pins the stated
  over-refusal). Red: first match only.
- **Mark:** a callee doing `MarkedOnly(true)` before a `Mark(false)` loop; refused. Red: drop the Mark case.

## Roadmap
- R562: what was built, the 4 sites, the cost, the 8 DO over-refusals named as the known cost, and ruling (b)'s
  reasoning for accepting 0.079%. Status `done (<commit>)` at submit.
- File ONE new item, "choose overloads by argument type", covering R-531's HOP and R-562's hop, with DO's 8 as
  its measured payoff (next id checked immediately before writing).

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-dump CDO Cloud and DO Cloud on the built branch against the master legs (one job at a time), expecting
  exactly -15 and -23, 0 tuples and 0 ordinals. The other census projects can be skipped: 0 sites each, by the
  census.
- Opus build review, one CI push, submit. No scheme bump.


---

