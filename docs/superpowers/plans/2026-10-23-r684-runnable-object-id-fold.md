# R684: fold a test-app report, page, xmlport, query or table that reached code names by id (plan r2)

## Changes from r1

Deep review: ADOPT with fixes (spec-adversary, Opus, on r1 f28b6050). Every finding is applied:
1. **Critical, `lowIds`' early return.** With any test-app codeunit below 1000, `foldIdTargets` returns before it
   reads any ref, so r1's object refs were skipped. r2 runs the object half of the fold always, and makes only the
   codeunit half conditional. A new red test covers it.
2. **Important, tables.** A test can hand only a table's id (`Database::X`, or the literal) to external code that
   does `RecRef.Open(Id)` and fires the table's triggers (the Retention Policy / Data Archive pattern). The census,
   re-run with tables: test apps declare 17 tables in BC.History and 1 each in DC and DO. About 4 sites store or hand
   out a test-app table's id other than as a direct argument; a direct `Database::X` argument already falls back.
   r2 adds `table` to the kinds, `Database::` naming it.
3. **Minor, the second codeunit-only `int` check, in `traceParam`.** r2 gives both `int` checks one helper.
4. **Minor, an overclaim.** The fold covers what a direct `Page.Run(Page::X)` covers today: `enterObject` does not
   follow `RunObject`, `CardPageId`, `LookupPageId` or report layout files. That gap is inherited, not made worse.
5. **Tests:** a codeunit below 1000 with an object ref (finding 1), and a control with a 4+ digit literal that is no
   object's id.

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

A. **`idRefsIn`** also keeps `report::X`, `page::X`, `xmlport::X`, `query::X` and `database::X` references, as the
kinded string `<kind>::<name>`, with `database` read as `table`. A codeunit's name is pushed bare, exactly as today,
so the codeunit path cannot change. Integer literals are unchanged (4+ digits). One new constant:
`ID_RUN_KINDS = ["report", "page", "xmlport", "query", "table"]`.

B. **`foldIdTargets`**, restructured (review finding 1):
- **The object half, always.** If `lowObjectIds` is set (any non-extension test-app object of an `ID_RUN_KINDS`
  kind below 1000), `foldObject` every such object. Then for each ref of `extra` and `st.procs`:
  - `<kind>::<name>`: `foldObject(u, st)` for every `u` of `objectsNamed(kind, name)`;
  - all digits: `foldObject` for every `objectsNamed(kind, raw)` of each kind.
- **The codeunit half, exactly as today:** if `lowIds`, fold every codeunit; else fold each bare ref's codeunits.
  Only the codeunit fold is conditional now. The early return no longer skips the object half.
- `foldObject` is `reachUnit` plus `enterObject(baseKey)`: every trigger of the object and of the test app's
  extensions of it, page parts included, and what they reach. That is what a direct `Page.Run(Page::X)` covers
  today. `RunObject`, `CardPageId`, `LookupPageId` and layouts are not followed on either path (review finding 4,
  inherited). A procedure of the object runs only when called; external code holding only an id cannot call one.
  `reachUnit` puts the whole object text's hash in the digest, so any edit to the object moves it, including an
  edit to a query with no trigger.

C. **The `int` checks, one helper** (review finding 3). `idOwner(value): string | undefined` returns `codeunit`
when `byNameAll(value)` finds one, else the kind of the first non-extension `objectsNamed(kind, value)` among
`ID_RUN_KINDS`, else undefined. Both checks call it:
- `passesTestApp` (`!refsOnly`);
- `traceParam`.

The messages name the kind: `... a test-app <kind>'s id ...`.

**Not changed:**
- the direct `Kind::"X"` argument (already falls back);
- computed ids and platform-sourced ids (R390's stated limit);
- `TEST_DIGEST_SCHEME` stays `v3`. The change only widens reached sets, so an affected test's digest compares unequal
  and the test is treated as new once: the safe direction. A scheme bump would re-run every test of every suite for
  no safety gain.

## Tests (test-first, `packages/runner/tests/test-digest.test.ts`, a new describe "R684")

The harness is bb2ef6a1's (`base`, `digestA`, `edit`, `unrelated`). One object per kind, each with a trigger that
does `Message('a')`: report 50102 (`OnPreReport`), page 50103 (`OnOpenPage`), xmlport 50104 (`OnPreXmlPort`),
query 50105 (`OnBeforeOpen`) and table 50106 (`OnDelete`, named `Database::"Tb"`). An external `DepCU.RunById(...)`.

`describe.each` over the five kinds. **The moves direction, each RED before the change:**
1. `Id := Kind::"X"; DepCU.RunById(Id);`: an edit to the object moves the digest, and the unrelated edit does not
   (folded, not fallen back).
2. `Id := <id>; DepCU.RunById(Id);`: the same.
3. `S."Obj Id" := Kind::"X"; S.Modify(); DepCU.RunById(0);`: the same (the field shape).
4. `DepCU.RunById(<id>);`: the unrelated edit moves the digest (falls back).

**The keeps direction, GREEN before and after:**
5. `DepCU.RunById(42);` with the object declared: neither edit moves the digest (an ordinary Integer is no edge).
6. A test that names no such object (`Id := 77777; DepCU.RunById(Id)`, a 4+ digit literal that is no object's id):
   an edit to the object does not move the digest, and neither does the unrelated edit. This pins "only object ids
   fold".

**Plus:**
7. Ids below 1000: a page `500` and `Id := 500; DepCU.RunById(Id)`. An edit to the page moves the digest. RED before.
8. **`lowIds` without `lowObjectIds`** (review finding 1): a codeunit `500` in the app, and
   `Id := Report::"Rep"; DepCU.RunById(Id)`. An edit to the report moves the digest. RED before, and RED again with
   the early return restored.
9. **No codeunit regression:** bb2ef6a1's three tests stay unchanged and green.

**Red-checks after the build, each restored:**
- Remove A's new kinds: 1 and 3 go red.
- Remove B's object fold: 1, 2 and 3 go red.
- Remove C: 4 goes red.
- Remove `lowObjectIds`: 7 goes red.
- Restore the early return over the object half: 8 goes red.
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
- **Measured exposure:** the 35 BC.History sites in 2 test apps, plus about 4 table-id sites (BC.History, DC, DO;
  `census-t-*.json`). Only those apps' tests that reach a site gain a
  wider digest. CDO, DC and DO have none.
- A coincidental literal equal to a runnable object's id (2 seen in Tests-ERM) widens one digest. It never narrows
  one.
