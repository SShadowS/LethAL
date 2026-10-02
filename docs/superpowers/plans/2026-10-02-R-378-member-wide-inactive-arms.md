# R-378: member-wide analyses skip arms the build compiles out (short plan)

Task: `H:/lethal-coord/tasks/R-378/task.md`. Item: `docs/roadmap/R378.md`. Branch `lethal/lane-preproc`, from master b1bc7e2e. Offline only.

## 1. Which analyses read more than their own site

I checked every operator, the semantic layer, the runner and schemata. The analyses below set a TAG on a mutant from text outside the site. Each one was run on master through `generateMutationSet`, under `[]` and `[LETHALX]` (a scratch probe, not committed). The table gives what each build should get and what it gets today.

| # | Analysis | Reads | Tag | `[]` build today | Defect? |
|---|---|---|---|---|---|
| A1 | `detectWriteTxnCodeunitRun` (`builtin-tier2/src/write-txn-codeunit-run.ts:80`), from `remove-commit` | the whole enclosing procedure or trigger, after the `Commit` | `write-txn-codeunit-run` | tagged, although the only `Ok := Codeunit.Run(..)` is in an `#if LETHALX` arm | **yes** |
| A2 | `onInsertAssignsPrimaryKey` (`builtin-tier2/src/insert-key-assignment.ts:165`), from `insertSkipCanRaise`, from `swap-modify-flag` on `Insert(true)` | the RECEIVER table's `OnInsert` body (another file) | `run-trigger-skipped-insert` | kept, although the only primary-key assignment is in an inactive arm. The control table without that line drops it | **yes** |
| A3 | `forcedTriggerCanRaise` (`builtin-tier2/src/forced-trigger-raise.ts:95`), from `swap-modify-flag` on an argument-less `Modify()` / `Delete()` / `Insert()` | the receiver table's trigger body (another file) | `run-trigger-forced` | tagged, although the only `Error` in `OnModify` is in an inactive arm | **yes** |
| A4 | `classifyHangCapable` (`builtin-tier1/src/loop-hazard.ts:176`) | the ANCESTOR loops' conditions only, up to the member | `hangCapable` | not tagged in either build | no path found (below) |

**A4 has no path to inactive text that I can build.** The walk climbs `.parent` only. An ancestor of an active site lies in an inactive range only if a directive sits inside the loop's header:
- A split header (`#if X while A.. do begin #else while B.. do begin #endif`) makes R214 refuse the whole file (`marker-mismatch`), so no site exists to tag.
- A directive inside the condition (`while (A < 10) #if X and (B < 5) #endif do`) is not read as part of the condition. `B := B + 1` is untagged in BOTH builds.

The second shape is a DIFFERENT defect: when the arm is active, the tag is missed. That is the unsafe direction for a hang tag. It is not this item, because it is not "reads inactive text". I will file it as a new roadmap item with the repro. A4 gets a pinning test (below), with no code change.

**Not tags, so out of R-378. Listed so the review can overrule.**
- **Project-wide indexes** (`buildSymbolTable`, `receiver.ts` `declaresProcedure` / `projectDeclaresProcedureOnTable`, `TypeTable`). These read inactive declarations. In those cases they REFUSE a site rather than mis-tag one. Examples: a `procedure Commit()` declared only in an inactive arm shadows the built-in. A trigger declared only inside an object-level `#if` is not found, so `R.Delete()` on such a table generates no mutant in either build (measured). Wrong refusals lose sites; they do not tag anything. Fixing them means making the symbol table aware of arms, which is a larger change. I will file one roadmap item for it.
- **`buildCallerIndex` and `cfgFor`** have no consumer outside tests.
- **Structural and manifest code** (`reachLatchRefusals`, `canCarryMutationSelectorVar`, coverage line-map, `describeObjectKinds`) places a latch, decides "can carry the selector" or names lines. None of these sets a tag. The selector-carrier case can only refuse a file. I will name these in the same filed item.
- **Site-local operators** (`shift-integer`, `negate-guard`, `remove-not`, `swap-enum-member` case labels, `return-value`) read only the site's ancestors or one `case`.

## 2. How each skips inactive nodes, without computing the ranges twice

- **One evaluation per file, moved earlier.** `generateMutationSet` today calls `evaluateArms(root, source, buildSymbols)` in its per-file loop (`orchestrator.ts:820`), after `buildSemanticContext` (`:776`). I will compute `buildSymbols` first, run `evaluateArms` ONCE per parsed file into a `Map<root, ArmEvaluation>`, and have the loop read that map instead of calling `evaluateArms` again.
- **On the context.** `SemanticContext` gains an optional `armOf?(node): "active" | "inactive" | "undecided"`. It climbs `.parent` to the file root, looks the root up in the map, and tests `startsInInactiveArm` on `node.startIndex`.
  - An `undecided` file answers "undecided" for every node.
  - Absent means nothing is compiled out (unit tests that build a context by hand).
  - Root identity is the same object, because the context and the loop are built from the same `parsed` array. A test pins this through `generateMutationSet`.
  - `buildSemanticContext` takes the map as an optional second argument. Its first argument and its existing callers are unchanged.
- **Each analysis skips "inactive" only.** "undecided" keeps today's behaviour (read everything), which for all three tags is the over-tagging direction, the direction each one already chose for uncertainty.
  - A1: `visit` skips a node that is inactive.
  - A2: assignments and `Validate` calls in an inactive range do not count as assigning the key. The primary key is still read from `keys`. A `keys` section split by `#if` is left as today, and I will note it.
  - A3: raise-capable calls in an inactive range do not count.
  - The receiver table in A2 and A3 is in another file, so the lookup uses THAT file's ranges. That is why the map is per root, not per site.

## 3. Repros (test-first, each red-checked)

These go in `packages/runner/tests/r378-member-wide-arms.test.ts`, through `generateMutationSet` with `preprocessorSymbols`, in the probe's shapes. Each test asserts both builds.

| # | Under `[]` (arm inactive) | Under `[LETHALX]` (arm active) |
|---|---|---|
| A1 | `remove-commit` has no tag | tagged `write-txn-codeunit-run` |
| A2 | `Insert(true)` has no tag | tagged `run-trigger-skipped-insert` |
| A3 | `Modify()` has no tag, but the mutant still exists | tagged `run-trigger-forced` |

- **A4 pin:** a loop whose condition holds the target only inside an inactive arm stays untagged. No product line guards it, so its red-check is the probe's measurement, stated as such.
- **Undecided control:** the receiver table holds an undecidable directive, and A2's tag is KEPT.
- **Red-checks** (with `mutation-red-checker`): for each of A1, A2 and A3, remove that analysis's skip alone; the `[]` half goes red and the `[LETHALX]` half stays green. Separately, make `armOf` always answer "active": all three `[]` halves go red.

The loop runs `bun scripts/verify.ts` and biome on the touched files.

## 4. Can a fixture's tag or verdict move?

- Only `fixtures/sandbox-symbols` (and its tests) has `#if`. It has no `Commit`, `Codeunit.Run`, `Insert`, `Modify`, `Delete` or loop. Every other fixture has no directive, so `armOf` answers "active" everywhere, and A1 to A3 read exactly what they read today.
- No gate figure moves, and no gate would see this, so no pre-commitment is needed.
- **Check before submit:** `scripts/r214-capture.ts` on every fixture (both R321 sets for `sandbox-symbols`), before and after. The `plat=` and `hang=` columns must be identical. The result goes in the submit note.
- Tags move no verdict anywhere: a tag is reported beside a kill (`platformArtifactKills`) and never changes it.
- No identity key moves, because a tag is not part of the key (`identityKeyOf`, `selection.ts:36`). So there is no scheme bump.
- Operator versions stay unchanged, because a tag is not the mutated text. If the review wants a minor bump on `remove-commit` and `swap-modify-flag`, it is two lines plus `operator-version-invariant.test.ts`.

## 5. Also in the build
- A CHANGELOG entry.
- R378 marked `done (<sha>)`, and the index regenerated.
- Two new roadmap items, with the next free ids re-checked just before writing:
  - the hang tag missing a loop-condition operand that sits inside an active `#if` (repro above);
  - the symbol table, receiver and structural readers that read inactive declarations and so refuse sites.
