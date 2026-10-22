# R-629 plan r1: close R629 by ruling once one BC fact is measured; warn on a nested project; file the dependent-app gap

Lane preproc, 2026-10-22, after the restart. Master 16681485. Evidence: `measure.md`, `hang-probe.txt`, `nested.txt`,
`byname*.txt`, and the tools in `tools/`.

## What the measurement says
- **Count:** a nested project's copy deploys keys in a procedure its parent hang-refuses: bch 229, dc 6, do 0,
  cdo 0. R629's figure of 6 counted only R572's rule; the older r501-dispatch rules give 229.
- **Pairs:** a by-name join over ALL project pairs finds hits only between nested pairs (0 between unrelated
  projects). The one reverse pair (System Application and its nested SharePoint project) is an over-refusal in
  the child, read by parse, not a hang.
- **Why the counts differ:** one session mutates one `projectDir`, and its hang analysis sees only the `.al` files
  under it. The parent compiles the module's files into itself, so it refuses there. The module run alone sees no
  loop that calls those procedures, so nothing fires.

## Reachability: why the nested copy should not hang a real run
A session that runs on the nested module (`FileOperations`) deploys it as its own app. For the parent's loop
(`Custom Layout Reporting.GenerateFileName`) to run, the parent (`Base Application`) must be installed on the same
server.
- The parent declares the SAME objects: codeunit 419 "File Management" exists only in the module folder, so Base
  Application's codeunit 419 IS that file.
- BC refuses to install two apps that declare the same object. This is **known BC behaviour, NOT measured here**,
  and the ruling rests on it, so step 1 measures it.
- In real BC the module never ships alone. BC.History holds one `<App>.Source.zip` per published app; there is no
  File Operations zip, and no app.json outside Base Application's Modules folder depends on the module's id.
- DC: the release pipeline builds `Cloud` only. The Purchase Contracts module apps are never built alone, and
  Cloud's id ranges cover the module's range.

So a nested copy and its parent cannot both be on one server. The parent's loop cannot run beside the mutated
copy, provided step 1 confirms the BC fact.

## The real remaining gap is wider than nesting, and is filed on its own
A hang-capable loop in an installed DEPENDENT app that calls into the project under test is refused nowhere: the
hang analysis sees only `projectDir`. This is not specific to nested projects. DC's Integration app.json, which
depends on both the module and Document Capture, hints at a planned split that would create exactly this case. It
cannot be measured from the corpus caches, because the dependent app's source is not part of the run. **File it as
its own roadmap item** (an R164 limit). It is NOT closed here.

## Steps
1. **Measure the BC fact (one `/al-probe`, about 15 minutes, under a bc1 lease).** Publish and install a tiny app A
   declaring `codeunit 5xxxx "R629 Probe"`, then a second app B declaring the SAME codeunit id and name, with A
   still installed. Record exactly what BC says: is it refused at publish, at install, or not at all? Then do the
   same with the same NAME but a different id, and the same id under a different name. Then uninstall and
   unpublish both, and record the server back as it was.
   - Probe ids come from the repo's probe id range (`.claude/skills/al-probe`). Nothing is left on the server.
   - If BC REFUSES (expected): go to step 2.
   - If BC ALLOWS two apps declaring the same object: STOP and report. Then the nested copy IS reachable, and the
     plan becomes "refuse those copies" (a cross-project join on file and span against the enclosing app.json's
     project, with the re-price PRE-COMMITTED first: bch 229, dc 6).
2. **A cheap guard, test-first:** when `projectDir` sits under an ENCLOSING directory that holds its own
   `app.json`, the session prints one warning naming both paths:
   > this project's files are also compiled into <parent>; hang refusals are decided over this project only, so
   > a loop in <parent> or in any dependent app that calls into it is not seen (R629)
   - It is a warning, not a refusal: a module run alone is legitimate, and step 1 shows the parent cannot be
     installed beside it.
   - Search upward from `projectDir` and stop at the repo or filesystem root. The cost is a few `existsSync` calls.
   - It follows the existing warning conventions (an event code plus the receipt), with no new `SessionReport`
     field, so the schema ripple is avoided. If a caveat is the convention there instead, follow that, including
     `CAVEAT_INTERPRETATIONS` and the counts.
   - Tests: a temp tree with an enclosing app.json warns once, naming both paths. Without one there is no warning.
     An app.json in a SIBLING directory gives no warning.
   - Red checks: drop the upward search, and the "warns" test goes red. Make it match any ancestor directory
     without an app.json, and the "no warning" test goes red.
3. **R629 closes by ruling:** `closed 2026-10-22 — the nested copy cannot be installed beside its parent (measured
   <step 1>), so the parent's loop never runs against the mutated copy; the remaining gap is a dependent app's loop,
   filed as R<new>`. The text records the counts (229 / 6 / 0 / 0) and that R629's 6 was only R572's rule.
4. **File R<new>:** the dependent-app hang gap. Name the price as unmeasurable from source-only caches, and give
   one measurable route: a census over an app set where both the dependent's and the target's source are present,
   e.g. DC's Cloud plus Integration, if Integration is ever built alone.
5. **Gates:** the change touches session warnings only, so `bun scripts/verify.ts`. If the warning sits in a path
   that `itest:bcdev` runs (the fixture is not nested, so it must NOT fire), run `itest:bcdev` once on the final
   head under a lease, and record its figures as unchanged.
6. Build review (opus), CI on both jobs, submit.

## Not done, and why
- **No refusal of the 229 + 6 keys.** Refusing them would remove mutants from a module run alone, where nothing can
  hang them, which is an over-refusal; that depends on step 1's answer.
- **No re-price,** because no key changes. The warning does not touch deploy decisions.

## r2: plan-review fixes (2026-10-22). These override anything above.

From `review-opus-plan.md`.
- **New step 0 (offline, from the cached dumps and the corpus source; any parse of BaseApp-sized sets runs only
  under a heavy flock slot):** for each of the 229 + 6 keys, find which PROJECT holds the loop that refuses it. The
  parent's `hang-probe.ts` already reports each refused procedure; it gains the refusing loop's own file and its
  project.
  - **Loop in the parent's own code** (outside the nested module's folder): it can run only if the parent is
    installed, so the step-1 ruling covers it.
  - **Loop in a SIBLING module** (bch: e.g. Email or Retention Policy calling Record Reference, which a modular
    System Application install allows), or for DC in Integration: it is the dependent-app gap, and it is REACHABLE
    without the parent. These keys are NOT closed. They become the new item's MEASURED price, by corpus and by
    module pair.
  - Write the split to `measure.md` before step 1. The split decides the route:
    - all keys in the parent's own code: the plan stands;
    - some keys in siblings: refusing them is on the table. Send it to the orchestrator: refuse the sibling-reached
      keys (a cross-project join over the projects the corpus says depend on the target, with the re-price
      PRE-COMMITTED first), or file it with the measured price.
- **Step 1 probe, made strict:**
  - a 5xxxx probe id (codeunit 419 is outside a customer app's range, so it would be refused for another reason);
  - two apps with DIFFERENT app ids, neither depending on the other, as with Base Application and the module;
  - the cases: same id and name; same name with another id; same id under another name;
  - if both install, record which copy a call from app A's code reaches;
  - **anything unclear is a STOP**, reported, and never read as the ruling.
- **Step 2 warning:** the upward search stops at the first directory holding `.git` (or at a root the test passes
  in). It never runs to `/`, so a stray `/tmp/app.json` cannot reach the tests. A repo-root `app.json` that
  compiles its subfolder apps DOES warn, which is correct.
- **Step 3 ruling text:** "closed by ruling for the parent-loop case only". Any sibling-reached keys are named, and
  moved to the new item with their measured price.

## Size
Small. Step 1 takes about 15 minutes live. Step 2 is about 40 lines plus 3 tests. Steps 3 and 4 are docs. In
total, half a day including the review and CI.
