# R684: fold a test-app report, page, xmlport or query that reached code names by id (plan r1)

Task: `/coord/tasks/R-431/task.md`, under the orchestrator's ruling of 2026-10-23 (build R684 in R-431's branch
`lethal/r431`). Item: `docs/roadmap/R684.md`. Measurement: `/coord/handoff/R-431/measure.md`. All code below is in
`packages/runner/src/testpage-scan.ts`, at master 2d615230.

## The gap, in code

R-371's bb2ef6a1 guards "external code runs a test-app codeunit by an integer id" in two places. Both see codeunits
only:
1. **`foldIdTargets`** folds every unit `byNameAll(norm(raw))` finds for each `Proc.idRefs` entry. `Scanner.byKey` is
   built from `model.units`, the codeunits. `idRefsIn` keeps `codeunit::` names and integer literals of 4+ digits.
2. **`passesTestApp`**, for an argument fact `{ k: "int" }` handed to an unfollowed call, falls back only when
   `byNameAll(f.value)` finds a codeunit.

Reports, pages, xmlports and queries are in `model.objects`, reached through `otherByBase` (`<kind>:<name>` and
`<kind>:<id>`). The offline probe (measure.md §1) shows every non-direct shape MISSED for all four kinds: a literal
argument, `Id := Kind::X` or `Id := <literal>` then `Id` handed out, and a record field set either way. A direct
`Kind::"X"` argument already falls back (`isTestAppObject`), and that stays.

## The change

A. **`idRefsIn`** also keeps `report::X`, `page::X`, `xmlport::X` and `query::X` references, as the kinded string
`<kind>::<name>`. A codeunit's name is pushed bare, exactly as today, so the codeunit path cannot change. Integer
literals are unchanged (4+ digits). One new constant: `RUNNABLE_KINDS = ["report", "page", "xmlport", "query"]`.

B. **`foldIdTargets`**, for each ref:
- `<kind>::<name>`: `foldObject(u, st)` for every `u` of `objectsNamed(kind, name)`.
- A bare string: the codeunit fold exactly as today. In addition, when it is all digits, `foldObject` for every
  `objectsNamed(kind, raw)` of each runnable kind.
- `foldObject` is `reachUnit` plus `enterObject(baseKey)`: every trigger of the object and of the test app's
  extensions of it, page parts included, and what they reach. That is everything a run by id can execute. A
  procedure of the object runs only when called, and external code holding only an id cannot call one.
- **Ids below 1000:** `lowIds` (any test-app codeunit below 1000) folds every codeunit and returns early. A parallel
  `lowObjectIds` (any non-extension test-app object of a runnable kind below 1000) folds every runnable object. It is
  applied before the codeunit branch's early return, so both apply when both are set.

C. **`passesTestApp`**, the `int` fact: it also falls back when `f.value` is the id of a test-app object of a
runnable kind (`objectsNamed(kind, f.value)` not empty for any of the four, extensions excluded as in
`isTestAppObject`). The message names the kind: `<label> is handed <id>, a test-app <kind>'s id, by <proc>`.

**Not changed:**
- the direct `Kind::"X"` argument (already falls back);
- computed ids and platform-sourced ids (R390's stated limit);
- tables. A table id handed out reaches external code only through `RecordRef.Open(Id)`. Table triggers are
  already folded whenever a record of the table is reached, and a RecordRef argument folds every test-app table
  (`argHolds`). Tables are out of R684's scope and are named in the item as not covered here.
- `TEST_DIGEST_SCHEME` stays `v3`. The change only widens reached sets, so an affected test's digest compares unequal
  and the test is treated as new once: the safe direction. A scheme bump would re-run every test of every suite for
  no safety gain.

## Tests (test-first, `packages/runner/tests/test-digest.test.ts`, a new describe "R684")

The harness is bb2ef6a1's (`base`, `digestA`, `edit`, `unrelated`). One object per kind, each with a trigger that
does `Message('a')`: report 50102 (`OnPreReport`), page 50103 (`OnOpenPage`), xmlport 50104 (`OnPreXmlPort`) and
query 50105 (`OnBeforeOpen`). An external `DepCU.RunById(...)`.

`test.each` over the four kinds. **The moves direction, each RED before the change:**
1. `Id := Kind::"X"; DepCU.RunById(Id);`: an edit to the object moves the digest, and the unrelated edit does not
   (folded, not fallen back).
2. `Id := <id>; DepCU.RunById(Id);`: the same.
3. `S."Obj Id" := Kind::"X"; S.Modify(); DepCU.RunById(0);`: the same (the field shape).
4. `DepCU.RunById(<id>);`: the unrelated edit moves the digest (falls back).

**The keeps direction, GREEN before and after:**
5. `DepCU.RunById(42);` with the object declared: neither edit moves the digest (an ordinary Integer is no edge).
6. A test that names no such object (`DepCU.RunById(Id)` with `Id := 42`): an edit to the object does not move it.

**Plus:**
7. Ids below 1000: a page `500` and `Id := 500; DepCU.RunById(Id)`. An edit to the page moves the digest. RED before.
8. **No codeunit regression:** bb2ef6a1's three tests stay unchanged and green.

**Red-checks after the build, each restored:**
- Remove A's new kinds: 1 and 3 go red.
- Remove B's object fold: 1, 2 and 3 go red.
- Remove C: 4 goes red.
- Remove `lowObjectIds`: 7 goes red.
- And the false-positive direction: folding EVERY runnable object on any integer (an over-wide fix) turns 5 red,
  and 6 red too if every test folded them.

## Gates

`selectLegs` (`scripts/agentflow/gate-table.ts`) on this diff's paths gives `bcdev`, `lease`, `tables`, `chunked`
and `alrunner-v3`. They run on the final head: the first four on bc1 under a lease (`lease` is `itest:lend`), and
`itest:alrunner-v3` locally, with all legs. No gate fixture names a runnable object by id, so no frozen figure should
move.

## Cost

- No new walk. The fold reuses `foldObject`, and per test the set of refs is the same, now including four more
  reference kinds.
- **Measured exposure:** the 35 BC.History sites in 2 test apps. Only those apps' tests that reach a site gain a
  wider digest. CDO, DC and DO have none.
- A coincidental literal equal to a runnable object's id (2 seen in Tests-ERM) widens one digest. It never narrows
  one.
