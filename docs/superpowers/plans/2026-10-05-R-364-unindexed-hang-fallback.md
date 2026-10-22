# R-364 (A): in an object the symbol table cannot index, the hang check refuses by NAME; the platform-kill tag stays (short plan, r2)

**r2: gpt-6.1-sol round 1 (`/coord/handoff/R-364/sol-review-r1.md`), applied on top of the r1 body below:**
1. **The gate and the matcher are separate.**
   - **The matcher:** `export function loopConditionReadsByName(assignment, target: NameTarget, ctx): boolean`, where `NameTarget = { receiver: string | null; member: string }` (normalised: case-insensitive, quotes stripped). It is exported so R-458 (lethal-bugs) reuses it with its own gate, and nobody builds a second matcher.
     - `receiver: null` (a plain variable target) matches only a PLAIN identifier in an enclosing loop's condition, never the member half of `R.Amount`. So `while R.Amount < 10 do Amount := …` is NOT refused.
     - With a receiver, it compares the (receiver, member) PAIR structurally against the condition's member reads, never concatenated text (`"A.B".C` against `A."B.C"`). It keeps `conditionReadsMember`'s active-arm and `#if`-tail handling.
   - **R-364's gate:** declaration resolution stays FIRST, because trigger locals resolve from the tree even inside wrapped objects. Only when the target (or the member target's receiver) does NOT resolve, AND the assignment's OWN enclosing object is in `unindexedObjects`, matched by file root and span (never by wrapper `===` or offset alone), is the matcher used.
     - A wrapped codeunit's caller is not affected.
     - `memberTargetOf` is restructured so the receiver identifier and the member are read from the tree BEFORE resolution, which `memberRefOf` loses today.
   - **Out of scope, stated:** objects in `unparsedObjects` (ERROR nodes), failed headers and other unindexed members keep today's behaviour.
2. **The tag is a separate code path,** and is fixed in Tier 1, not Tier 2. The census site is a `DeleteAll(true)` emitted by Tier 1's `flip-boolean-literal`; `runTriggerSkipTag` drops the tag at `receiver.ts`'s `claimsRecordMethod`, which rejects an unresolved receiver BEFORE `deleteSkipCanRaise` (whose `skipCanRaise` already keeps the tag on an unresolved receiver) can run.
   - The fix lives in `runTriggerSkipTag`: when the receiver does not resolve, the platform-kill TAG is kept (screen tagging is conservative).
   - The shared `claimsRecordMethod` CLAIMING is NOT weakened, so Tier-2 cession and dedup are unchanged.
3. **Credible tests.**
   - **Shift:** a DIRECTLY assigned literal in the loop (`i := 0` inside `while i < N`), since `i := i + 1` already yields no shift mutant. Each positive asserts the mutant EXISTS without the fallback (candidacy), then is refused with it.
   - **Wrong-fix control:** the shadowing control is replaced by an INDEXED object with an unresolvable target `Ghost` whose name a loop condition reads: it must NOT be refused. This catches a fallback applied everywhere.
   - **More shapes:** wrapped member positives and negatives (pair matching, and `R.Amount` against a plain `Amount`), quoted names, an inactive condition tail, a nested wrapper inside `#else` (a real parser test), and a trigger-local target in a wrapped object (resolved by declaration, NOT by the fallback).
   - **All four callers:** `remove-assignment`, `shift-integer`, `flip-boolean-literal`; and `swap-additive` only if its type guard admits a wrapped site at all; if not, that is stated.
4. **Counting:** the refusal path is confirmed as refusal-only (all four callers refuse, with no session-stop tag or reach marker), counted per eligible (node, operator) pair in `hang-refused`. The BaseApp re-run reports the pairs, not "7 assignments".

Task: `/coord/tasks/R-364/task.md`. Census: `/coord/handoff/R-364/measurement.md`. Worktree `/work/lethal-wt/r364`, branch `lethal/r364`, fast-forwarded to master ebc46f19. Orchestrator rulings:
- (A) is built here;
- (B) R365, R366, R367, R368, R370 and R376 are closed as rulings;
- (C) R364 and R369 are closed as a ruling, with the shared symbol-table fix recorded;
- `IDENTITY_SCHEME` 16 (master is 14; R-254 holds 15).

## 1. The defect (measured)
- **Where:** 7 BaseApp mutants (5 `remove-assignment`, 2 `shift-integer`) in 4 Base Application reports wrapped whole in `#if not CLEAN28`.
- **What they are:** `i := i + 1` in a `while` loop, and `Done :=` / `TypeExist :=` read by an `until`.
- **What goes wrong:** they are deployed WITHOUT the hang refusal the compiled build applies. `classifyHangCapable` (in `packages/builtin-tier1/src/loop-hazard.ts`) returns `null` when `resolveVarRef` cannot resolve the target, and inside a wrapped object NOTHING resolves, because the symbol table leaves it in `unindexedObjects` (R343).
- **The tag:** the same cause drops one platform-kill tag (`CalculateSubcontracts.Report.al`), which is the unsafe direction for a screen.

## 2. Change
1. **Name fallback, only where resolution cannot exist.** In `classifyHangCapable` (the assignment path AND R454's member-target path), when the target does not resolve AND the assignment sits inside an object in `ctx.symbols.unindexedObjects`, compare by NAME:
   - the assignment target's name, case-insensitive with quotes stripped, against the identifiers in each enclosing loop's condition (`conditionIdentifiers`);
   - for a member target, the receiver name plus the member name.
   A match returns `"loop-condition-target"`.
   - This is the safe direction: an extra refusal costs a site, while a missed one can hang a session.
   - In an INDEXED object nothing changes: resolution stays by declaration, and an unresolved target still returns `null`, the spec 3.1 rule that a name match is a guess. The doc comment says so.
   - The refusals flow through the operators' existing `hangCapableForMutatedNode` path, so they are counted in R-447's `hang-refused` excluded-sites row like every other hang refusal. Nothing new is plumbed.
2. **The platform-kill tag.** First find the code path that drops the `CalculateSubcontracts` tag (`insertSkipCanRaise` or `forcedTriggerCanRaise` in builtin-tier2, or the receiver classification in `receiver.ts`). The rule is that an UNRESOLVED receiver keeps the tag, the existing R143 rule. Inside an unindexed object, "unresolved" must count as unresolved, not as "not a record". If this is a separate code path from (1), that is stated, and it is fixed and tested on its own.
3. **`IDENTITY_SCHEME` 16** (removed mutants can move same-tuple ordinals): every literal bumped in one commit, as before, plus a constant pin.
4. **Docs.**
   - R343's text gains a sentence: inside a wrapped object the hang check cannot resolve names and so used to skip, and R-364 makes it refuse by name.
   - Closing paragraphs for R364, R365, R366, R367, R368, R369, R370 and R376 per the rulings, with the census numbers. R364/R369's paragraph records the shared symbol-table fix: read var-section `#if` declarations by arm, and treat a stretched var `#if` as member-level.
   - CHANGELOG: Fixed (hang refusal in wrapped objects; the platform-kill tag) and Changed (scheme 16).

## 3. Tests (test-first; each red-checked in each direction)
- **The 7 shapes, inside an object wrapped whole in `#if not X`, built under `[]`:**
  - `while i < N do begin ...; i := i + 1; end;` gives no `remove-assignment` or `shift-integer` mutant, and the site is counted as hang-refused;
  - `repeat ... Done := ...; until Done;` gives no `remove-assignment` mutant.
- **Direction controls:**
  - the same shapes in an INDEXED object, resolved by declaration: still refused (unchanged);
  - an indexed object where the target name matches the loop condition's name but the DECLARATION differs (a local shadowing a global, of R-405a's kind): NOT refused. This shows the name fallback is confined to unindexed objects;
  - in a wrapped object, an assignment to a name that NO enclosing loop condition reads is still mutated, so the fallback is not a blanket refusal.
- **The tag:** the `CalculateSubcontracts` shape in a wrapped object keeps its platform-kill tag; control: a resolvable non-raising receiver in an indexed object drops it, as today.
- **Scheme:** the pin.
- **Red-checks** (the `mutation-red-checker`):
  - drop the fallback (the wrapped tests go red);
  - apply the fallback in every object (the shadowing control goes red);
  - match any loop at all (the "unrelated name" control goes red);
  - drop the tag fix (the tag test goes red);
  - leave the scheme at 14.

## 4. Measure and gates
- **Gate capture diff:** no committed fixture holds a wrapped object with these shapes, so the diff should be empty. If it is not, STOP and pre-commit before any gate.
- **BaseApp re-run:** the 7 sites are now hang-refused, the `CalculateSubcontracts` tag is present, and nothing else moves except other wrapped-object hang shapes (each listed).
- **Then:** `itest:alrunner`; branch CI green on both jobs.
