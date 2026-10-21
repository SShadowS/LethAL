# R-570 plan r2: refuse cursor-shaped callees in another object that end an ordinary loop (lethal-preproc, 2026-10-10)

**r2 changes** (opus plan review r1, `review-opus-plan-r1.md`; the orchestrator gave GO on r1 after review; these
override r1 where they differ):
- **Delegation (I1):** a call resolving to a PROJECT procedure is always followed along the chain, up to 4 hops,
  with cycles cut. Only built-in record and list methods end it.
- **`guard-cursor` (I2):** skipped ONLY when the guard call neither has the condition's cursor receiver as its
  receiver nor passes it to a `var` parameter.
- **(I3a) a flag fed by the callee, and (I3b) a same-object first hop:** measured in the build. Built if each is
  below about 0.05% per corpus, otherwise filed.
- **NOT built, stated:**
  - the callee's same-object helper closure (DC 31 → 737, 0.38%);
  - `Codeunit.Run` targets;
  - delegation through a named return value;
  - event subscribers of an exit callee;
  - non-cursor callees.
- **Matching by name** refuses every overload of that name (R564 narrowing has no effect here).
- **Hook:** a precomputed per-context map (the `oneHopReach` pattern), checked through an OR term in
  `openItemHangRefuses`.
- **R500's header (the shape 8 ruling)** is updated: R570 also applies inside report items.
- **More tests** (each red-checked):
  - a wrapper over a `Next`-named project procedure;
  - the `var` and table-procedure guard;
  - a 5-hop chain NOT followed, and a cycle;
  - an interface implementer callee;
  - `exit`, `break` and `Error` guards separately, plus an inner-loop `break` that does not count for the outer loop;
  - one dispatch-level test (`r500-dispatch.test.ts` style).
- **Identity** on EVERY project with an in-scope loop.

---


Branch `lethal/r570` from master b163c255. Measurement: `measure.md`, on fresh production keys.

**Result:** 10 of 15 sampled sites can hang (Create Pick's FEFO, Business Chart Buffer, Sales Tax Calculate, Document
Attachment Mgmt, TempStack, Power BI Report Aggregator, Price Source/Asset List, Workflow Step, Job Queue Entry, DC's
Message Bus Socket), 1 plausibly can, and 4 cannot. The recommended scope costs DC 31 (0.016%), DO 0, CDO 0,
BC.History 346 (0.016%; BaseApp 272, 0.038%), fixtures 0.

## Rule (refusal only)
For every `while`/`repeat` loop in ANY object kind (a report data-item walk is R500's own case and is not changed):
1. **Exit calls:** the calls in the loop's condition (`cond`), and the calls in a body exit guard (`if ... then
   exit/break/Error`) when the loop's condition steps no cursor itself (`guard-free`). A guard call is skipped when
   the condition already steps a cursor (R480's `namesCursorMethod`): such a callee can only end the loop early
   (`guard-cursor`, measured as no hang).
2. **Resolve** each exit call to project procedures in ANOTHER object, with the existing resolvers: `callTargets`,
   `objectsOfType`, `r531TableProcs`, and R564's `r531ProcsIn` with its overload rule. An uncertain call (R567)
   follows all candidates.
3. **Cursor-shaped:** the callee calls `Find*`, `Next`, `IsEmpty` or `Count` on anything, or contains a loop. Matching
   by method name is deliberately broad: list and dictionary `Count` catch the index-based iterators the sample found
   hanging.
4. **Delegation:** a callee that exits with another procedure's call (`exit(X.P(...))`) is followed along that chain,
   up to 4 hops, through the same resolvers, and the chain's cursor-shaped end is taken. Each procedure on the chain
   is refused. This is needed for GetNextGLAcc's chain, the BOM Tree MoveNext wrappers, and
   GetNextPutAwayDocument.
5. **Refuse every deployed site** in each in-scope callee (and in each chain procedure) as hang-capable, through the
   same hang-refusal path R500 and R531 use. "Every site", not only return-affecting ones: the sample's hangs include
   index increments, row Deletes and flag assignments.

## Not done (stated, each errs toward deploying, with no false kill)
- Non-cursor callees (for example, pagination by a "has next page" Boolean from JSON).
- Delegation through a named return value.
- Event subscribers of an exit callee.
- The R531-side twin, a record consumer in another object (for example `CDC Message Bus Socket`.Pop deleting a row
  in a page loop's body): FILED as a new item, not built here.

## Identity and scheme
Refusing removes deployed keys. Removing one can shift the ordinal of a same-tuple sibling. Measure with the prod500
identity dumps, master vs built, on every project with an in-scope loop (DC and BC.History), by key and ordinal. If
an existing key's tuple or ordinal MOVES, I ask the orchestrator for scheme 40 (R-569 may claim it).

## Tests (packages/builtin-tier1/tests, each red-checked)
- **`cond`:** a codeunit loop `until not Other.FindNext(...)`. FindNext's sites are refused. Revert: deployed (red).
- **`guard-free`:** `while true do begin if not Other.NextX() then break; ... end`. Refused.
- **`guard-cursor` skipped:** `repeat if not Other.IsValid(Rec) then exit; until Rec.Next() = 0`. IsValid is NOT
  refused (control). Revert to refusing guard-cursor: red.
- **Not cursor-shaped:** the callee has no Find/Next/IsEmpty/Count and no loop, so it is not refused.
- **Delegation:** `until A.Next() = 0` where A.Next exits B.Next, which steps a cursor. Both A.Next and B.Next are
  refused. Revert the chain: B deployed (red).
- **A table and a page loop:** the same `cond` shape in a table procedure and a page trigger.
- **A report data item** is unchanged (R500's own rule; pin that this rule does not double-apply or conflict).
- **Overload and uncertain:** the callee resolved through R564's rule; an uncertain call follows all candidates.
- **The R570 examples** in synthetic form: a FEFO-like `until not X.FindNext() or Qty = 0` (a mixed condition, so the
  callee is still refused).
