# R-405 part (a): the engine readers see members inside a member-level `#if` by arm (short plan, r2)

Task: `/coord/tasks/R-405/task.md`. Item: `docs/roadmap/R405.md`. Branch `lethal/lane-preproc` at master 8630bf2c. Part (b) (`reachLatchRefusals`, `canCarryMutationSelectorVar`) stays held behind R-307 and is not touched.

## Revisions
**r2** answers `/coord/reviews/R-405-plan/claude-adversary-r1.md` (6 required changes):

| Point | r2 change | Where |
|---|---|---|
| 1. Receiver must keep `allProcedureLikes` | The receiver does NOT use `liveMembers`. `declaresProcedure` keeps walking `allProcedureLikes` (R327 var-swallowed, split, R331 `#if`-object procedures) and FILTERS OUT only `inactive`. This also covers its callers at :664, :667 and :726. Red-check: iterate `liveMembers` instead | §2 |
| 2. Undecided is per FILE | `liveMembers` reports each member's PLACE: `direct` or `inside-if`. An undecided DIRECT member stays. An undecided member INSIDE `#if` is dropped for the symbol table and the triggers, but still counted by the receiver (each reader's safe side) | §2 |
| 3. The OnInsert undecided test cannot fail | `insertSkipCanRaise` returns before reading the trigger when the file is undecided (insert-key-assignment.ts:230). The same undecided case is added for `findTableTrigger` / `swap-modify-flag` forward, which CAN fail | §4 |
| 4. No-context path | The readers take the RAW optional `ctx.armOf`. With no map, `liveMembers` yields direct members only, exactly as today; it never asks `armOfNode`, which says `active` with no map and would yield both arms. Wired in `context.ts:56`, not the orchestrator | §2 |
| 5. A `var` section inside `#if` | Globals rule stated and tested | §2, §4 |
| 6. A3 pin | `site("on")` gives exactly one mutant with `plat = run-trigger-forced`; "off" gives `[]`; every other OPS row unchanged | §4 |

## 1. Today (code map, HEAD 8630bf2c): narrower than R405's text

**The arm map.** `SemanticContext.armOf(node)` (`engine/src/semantic/context.ts:41-76`) returns `active`, `inactive` or `undecided`. It is project-wide, built once from `evaluateArms` over every parsed file (`orchestrator.ts` ≈:817-824).

**`findTableTrigger`** (`forced-trigger-raise.ts:128-144`) and **`onInsertTrigger`** (`insert-key-assignment.ts:133-148`) ALREADY drop inactive direct members (R378's `isLive`). What they do not do is look INSIDE a member-level `preproc_conditional`, a `#if` wrapping a whole member in the object body. That is the R378 "A3-gone" shape: `TABLE_D`'s `OnModify` inside `#if LETHALX` gets no forward `swap-modify-flag` mutant in either build. (The test comment calls it "object-level"; it is member-level in the grammar.)

**`buildSymbolTable`** (`symbol-table.ts` `indexMembers` :371-410) indexes direct `procedure` and split members only.
- A procedure inside a member-level `preproc_conditional` is not indexed. It is counted as `null` under its name (`allProcedureLikes`, R327/R330), so `uniqueProcedure` refuses it in EVERY build.
- Triggers are never indexed; trigger readers read the AST.
- An object wrapped whole in `#if` (`preproc_conditional_object`) goes to `unindexedObjects`.

**`receiver.ts` `declaresProcedure`** (:597-607) and **`projectDeclaresProcedureOnTable`** (:638-678) count every procedure-like, inactive arms included, with no arm awareness. So a built-in call (`Commit`, `Modify`, ...) on an object that declares a same-named procedure only in an inactive arm is refused as shadowed. Consumers are at :196-197, :213, :331 and :347. They take `symbols`, not a context.

## 2. Change

**A shared reader for the symbol table and the triggers: `liveMembers(body, armOf?)`** (engine, beside `declarationMembers`).
- It yields the direct members, each tagged `place: "direct"`.
- When `armOf` is given, it ALSO yields the members inside each member-level `preproc_conditional`, recursively (nested `#if`), each tagged `place: "inside-if"` and with its arm from `armOf`.
- When `armOf` is ABSENT (no context, or a context built without arms), it yields direct members only: exactly `declarationMembers` today (r2 point 4). It takes the raw optional `ctx.armOf`, never `armOfNode`, which reports `active` with no map and would yield both arms.
- **Undecided is per file** (r2 point 2), so the answer depends on the place:
  - `direct` and undecided: present, as today;
  - `inside-if` and undecided: DROPPED for the symbol table and the triggers (their safe side: no resolution, no forward mutant).
  - Without this, `findTableTrigger`'s `isLive` (`!== "inactive"`) would find a trigger in an undecided `#if`, and the first arm in the text would win.

**The four readers.**

| Reader | Active (any place) | Inactive | Undecided, direct | Undecided, inside `#if` |
|---|---|---|---|---|
| `buildSymbolTable` (procedures) | indexed; two arms declaring one name leave exactly one, so it resolves | skipped (not counted as `null`) | as today | counted `null`, as today: refused |
| `buildSymbolTable` (globals, a `var` section inside `#if`) | its variables are globals, typed as declared | not globals | as today | not globals: a receiver typed by one is unresolved, so refused |
| `findTableTrigger` | found | not found | found, as today | NOT found: no forward mutant |
| `onInsertTrigger` | found | not found | as today (never reached: `insertSkipCanRaise` returns first when the file is undecided) | not found |
| `declaresProcedure` / `projectDeclaresProcedureOnTable` | counts | does NOT count, so the built-in is no longer shadowed | counts | counts (refused, the safe side) |

- **Globals rule** (r2 point 5): a `var` section inside a member-level `#if` contributes its variables exactly when the arm is active. Two arms declaring the same name with different types leave the active arm's type. Today neither arm's variables are globals, so a receiver typed by one is unresolved; the change ADMITS such receivers only in an active arm.
- **The receiver does NOT use `liveMembers`** (r2 point 1). `declaresProcedure` keeps `allProcedureLikes`, which also catches procedures swallowed by a var section (R327), split members and `#if`-wrapped objects (R331). It filters out only members whose `armOf` is `inactive`. `projectDeclaresProcedureOnTable` (:664, :667) and the caller at :726 inherit that filter.
- **Plumbing** (r2 point 4): `buildSemanticContext` (context.ts:56) passes its raw optional `armOf` into `buildSymbolTable`, and the receiver functions read `ctx.armOf`. The orchestrator is unchanged; its one call (≈:823) already supplies the arms.
- **Not in scope**, stated so it is not lost: a whole object wrapped in `#if` (`preproc_conditional_object`, still `unindexedObjects`), and `TypeTable`. The build checks whether a roadmap item covers them, and files one if none does.

## 3. Identity (acceptance 3)

The rule (`IDENTITY_SCHEME` doc, `schemata/src/project.ts:118`): bump for any change that can move an existing mutant's key for unchanged AL source. Ordinals number `(astHash, codeunit, member, operator, major)` twins in source order (project.ts:125-152).
- **Can a key move?** In principle, yes. A newly ADMITTED mutant earlier in a member, with the same tuple as an existing one, takes ordinal 0 and pushes the old one to 1. Example: `B.Modify()`, now admitted because B's `OnModify` is in an active arm, sits before `A.Modify()` with the same positional hash. The same goes for a built-in call no longer refused as shadowed.
- **Measured BEFORE choosing** (the first build step, before any other code is committed):
  - `bun scripts/r214-capture.ts <project> [--symbols ...] [--repo <worktree>]` on master and on the branch;
  - for EVERY `app.json` project under `fixtures/` and `examples/`, under every gate symbol set (`sandbox-symbols`: `[]`, `[LETHALA]`, `[LETHALB]`; every other: `[]`);
  - plus the r214 and r364 unit fixtures under `packages/runner/tests/fixtures/`;
  - then classify each difference as (i) a mutant gone or new by the rule, or (ii) a surviving mutant whose key changed.
- **Expected:** no committed gate fixture has a member-level `#if` around a procedure or trigger, so their captures are identical. The synthetic twin case above shows a (ii) move. The rule therefore calls for a bump, and before taking a number **I message the orchestrator with the measured diff** (master is 7, R-307 holds 8). A test pins the twin move under the new scheme.

## 4. Tests (test-first; each red on today's code; each red-checked)

- **A3-gone pin flipped** (acceptance 1, r2 point 6):
  - `site("on")` for `DTab.Modify()` gives EXACTLY ONE `swap-modify-flag` mutant, with `plat = run-trigger-forced`;
  - "off" gives `[]`;
  - every other OPS row in the file is unchanged in both builds;
  - the pin is renamed to say so.
- **The symbol table:**
  - a procedure in an active arm resolves;
  - one in an inactive arm is absent;
  - `#if X procedure P ... #else procedure P ... #endif` resolves to the active one;
  - undecided inside `#if` gives a refusal, as today, while an undecided direct procedure resolves, as today;
  - nested `#if`.
- **Globals:** a `var` section inside `#if` declaring `R: Record "D Tab"`:
  - an active arm makes `R.Modify()` resolve;
  - an inactive arm leaves it unresolved;
  - two arms with different types resolve to the active one;
  - undecided leaves it unresolved.
- **Triggers:**
  - `OnInsert` inside a member-level `#if`: an active arm drives `insertSkipCanRaise` exactly as a direct `OnInsert` does, and an inactive arm acts as if absent;
  - `findTableTrigger` / `swap-modify-flag` forward with the table's FILE undecided (r2 point 3): a trigger inside `#if` is NOT found, so there is no forward mutant, while a direct trigger in the same undecided file IS found, as today. This one can fail.
- **Receivers:**
  - `Commit()` / `R.Modify()` on an object declaring `Commit` / `Modify` only in an inactive arm is NOT refused as shadowed;
  - in an active arm it IS refused;
  - undecided: refused;
  - a var-swallowed (R327), split, or `#if`-object (R331) declaration still shadows, exactly as today.
- **No context:** each reader gives byte-identical answers to master, including a file with a member-level `#if` (direct members only, never both arms).
- **Identity:** the synthetic twin moves under the new scheme, and the r214 pinned captures change only where §3's measurement says.
- **Red-checks:**
  - drop the recursion into `preproc_conditional`;
  - treat undecided as active (the undecided tests, including the `findTableTrigger` one);
  - have the receiver iterate `liveMembers` instead of filtering `allProcedureLikes` (the R327/R331 shadowing tests);
  - use `armOfNode` instead of the raw optional `armOf` (the no-context test);
  - treat inactive as present (the inactive tests);
  - leave `armOf` out of the receiver call sites;
  - leave the scheme at 7 (the twin test).

## 5. Gates (acceptance 4)

- **Offline:** §3's capture diff (every fixture, every gate set), filed with the plan's evidence.
- **Live, on the final tree:**
  - `itest:alrunner` (local), which carries the `[LETHALA]`/`[LETHALB]` symbol legs;
  - under a Cronus28 lease, `itest:bcdev` and `itest:tables` (swap-modify-flag's home fixture), one at a time.
- No frozen figure is expected to move: the captures predict identical mutant sets. If a scheme bump is taken, the gates' baselines key by identity, so the build checks how each gate compares keys across a scheme change BEFORE running them. If a baseline would need re-recording, that is a block for the owner, raised before any gate run.
- `compile:fixtures` only if a fixture `.al` changes (none planned).
- Update R405 (part a done, part b open) and regenerate the index.
