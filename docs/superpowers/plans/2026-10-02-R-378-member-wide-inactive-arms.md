# R-378: member-wide analyses skip arms the build compiles out (short plan, r3)

Task: `H:/lethal-coord/tasks/R-378/task.md`. Item: `docs/roadmap/R378.md`. Branch `lethal/lane-preproc`, from master b1bc7e2e. Offline only.

## Revision r3: finding 6 (`H:/lethal-coord/reviews/R-378-plan/reject-r2.md`)

| Point | r3 change | Where |
|---|---|---|
| 6.1 The count claims disagreed | A3 is NOT tag-only, because `resolveForcedTrigger` also guards `swap-modify-flag`'s forward generator. §2 now states exactly when a mutant can disappear (none can appear). §4 no longer claims identical counts: it requires every count change to be one of those cases, listed | §2 A3, §4 |
| 6.2 The scheme bump was ruled out too early | It is no longer ruled out. A key and ordinal diff, master against the branch, on the pinned captures and the R214 corpora, decides it. A moved key for unchanged source means `IDENTITY_SCHEME` 7, coordinated through the orchestrator (R-307 holds 6) | §4 |
| 6.3 The A3-undecided test was missing | Added as a control with the same three proofs as A2-undecided, and red-checked | §3 |
| 6.4 A2's "no tag" was too wide | "No tag" only when an active key exists AND its field list is readable and non-empty. `primaryKeyFields` returning `[]` keeps the tag | §2 A2, §3 A2-unreadable-key |

## Revision r2: what changed, finding by finding (review `H:/lethal-coord/reviews/R-378-plan/review-r1.md`)

| Finding | r2 change | Where |
|---|---|---|
| 1. The inventory left out readers that change scoring | `testpage-scan`, `discovery`, `line-map` member spans and `test-digest` are named, each ruled "file", with a reason. The list is no longer called exhaustive | §1 table B |
| 2. "undecided" is not the safe direction for A2 and A3 | A rule per tag for when uncertainty KEEPS the tag. A2 picks the primary key from ACTIVE text, and a test covers the inactive-first-key case | §2, §3 rows A2-key, A2-undecided, A3-undecided |
| 3. The hang tag's "no path" was overstated | Stated as a measured limit. A4 is dropped: no code change and no test | §1 A4 |
| 4. The fallback opened up silently | Supplying the map and passing a node whose root is not in it THROWS. Only a context built without a map defaults to "active". Memory is checked on the large corpora | §2, §4 |
| 5. Missing fixture and controls | `p11-tier2` and every pinned `fixtures/r214/expected/*` capture are in the no-move check. A1 to A3 assert the exact mutant EXISTS in both builds before asserting its tag. The undecided control asserts that the table resolved AND that `evaluateArms` returned undecided | §3, §4 |

## 1. Readers that look past their own site

### A. Tags (fixed here)
A scratch probe ran on master through `generateMutationSet`, under `[]` and `[LETHALX]`, and measured all three of these.

| # | Analysis | Reads | Tag | `[]` build on master |
|---|---|---|---|---|
| A1 | `detectWriteTxnCodeunitRun` (`builtin-tier2/src/write-txn-codeunit-run.ts:80`), from `remove-commit` | the site's own enclosing body, after the `Commit` | `write-txn-codeunit-run` | tagged from an `Ok := Codeunit.Run(..)` that is only in an `#if LETHALX` arm |
| A2 | `onInsertAssignsPrimaryKey` / `primaryKeyFields` / `onInsertTrigger` (`builtin-tier2/src/insert-key-assignment.ts:110,124,165`), from `swap-modify-flag` on `Insert(true)` | the receiver table's FIRST `key(...)` and its first `OnInsert` (another file) | `run-trigger-skipped-insert` | kept from a key assignment that is only in an inactive arm. A control table with no such line drops it |
| A3 | `forcedTriggerCanRaise` / `findTableTrigger` (`builtin-tier2/src/forced-trigger-raise.ts:95,118`), from `swap-modify-flag` on an argument-less `Insert()` / `Modify()` / `Delete()` | the receiver table's trigger body (another file) | `run-trigger-forced` | tagged from an `Error` that is only in an inactive arm of `OnModify` |

**A4, the hang tag (`classifyHangCapable`, `builtin-tier1/src/loop-hazard.ts:176`): a measured limit, not a fix.** It walks ANCESTOR loops only, but `identifiersIn` (`:123-132`) reads every named descendant of a loop condition and does not check arms. I measured two shapes:
- a split loop header, where R214 refuses the whole file (`marker-mismatch`);
- a directive inside a condition (`while (A < 10) #if X and (B < 5) #endif do`), where `B` is not read in either build.

I have not shown that every shape keeps inactive operands out of the condition's subtree. R378's close-out will state this as a limit. The second shape's ACTIVE-arm miss is the unsafe direction for a hang tag, so it is filed (C1 below). No A4 test is added: a test that is untagged in both builds has no guard to red-check.

### B. Readers that change scoring, filed rather than fixed (with the reason)
- **B1 `testpage-scan.ts` (`:580-603`, `:769-831`, `:1855-1915`).** It scans whole test and helper bodies, all arms, to refuse tests that may open a TestPage. Over-refusal is its safe direction.
- **B2 `discovery.ts` (`:139-175`).** It finds `[Test]` methods by regex over whole codeunit sections, so a `[Test]` that exists only in a compiled-out arm is discovered.
- **B3 `test-digest.ts` (`:1-27`, `:182-225`).** It walks procedures and triggers for verify's "was this test edited" decision. Over-including is its safe direction.
- **Why B1 to B3 are not fixed here.** All three read the TEST app. LethAL computes the effective symbol set for the TARGET only (config symbols plus the target's `app.json`). The test app's own build set is not modelled anywhere, so there is no correct range to skip with.
  - File: one roadmap item, "test-app readers ignore `#if`; the test app's symbol set is not modelled".
- **B4 `line-map.ts` member spans (`:370-419`).** These attribute covered lines to members. R301, R316 and R318 already span split members so that "a line belongs to the member whichever arm was compiled". A member declared only in an inactive arm gets a span, but compiled code can put no covered line there. The case not covered is two whole-member arms declaring the same name in one object.
  - File: its own item, to measure before changing, because it touches coverage attribution, a verdict input.
- **B5 project-wide indexes** (`buildSymbolTable`, `receiver.ts` `declaresProcedure` and `projectDeclaresProcedureOnTable`, `TypeTable`) **and structural readers** (`reachLatchRefusals`, `canCarryMutationSelectorVar`). These read inactive declarations and in those cases REFUSE a site rather than tag one.
  - Measured: a trigger inside an object-level `#if` is not found, so `R.Delete()` generates no mutant in either build.
  - File: one item.

`buildCallerIndex` and `cfgFor` have no consumer outside tests. The site-local operators (`shift-integer`, `negate-guard`, `remove-not`, `swap-enum-member` case labels, `return-value`) read only the site's ancestors or one `case`. This list covers what I found. It is not a proof that nothing else exists.

### C. Also filed
- **C1:** the hang tag misses a loop-condition operand inside an ACTIVE `#if`, with the measured repro.

## 2. Mechanism, and when uncertainty keeps a tag

- **One evaluation per file, earlier.** In `generateMutationSet`, compute `buildSymbols` first. Then run `evaluateArms(root, source, buildSymbols)` ONCE for every parsed file, including files that `--only` or `--exclude` drop, because those can still be a receiver table. Store the results in `Map<root, ArmEvaluation>`. Pass the map to `buildSemanticContext(files, arms)`, and have the per-file R214 loop read the same map instead of calling `evaluateArms` again.
- **`SemanticContext.armOf?(node): "active" | "inactive" | "undecided"`.** It climbs `.parent` to the root and looks the root up.
  - A map is supplied and the root is not in it: throw `Error` naming the node's line. That is a caller-contract violation.
  - No map: `armOf` is undefined, and callers treat that as "active". This is for contexts built by hand in unit tests.
- **The rule, per tag.**
  - **A1:** never sees "undecided", because R214 generates no mutant in an undecided file and A1 reads only the site's own body. It skips "inactive" nodes. Its existing over-flagging rule is unchanged.
  - **A2:** the tag is kept unless the table is resolved AND it is PROVEN that the build's `OnInsert` does not assign the build's primary key. So:
    - If the receiver table's file is "undecided", KEEP the tag, and do not scan.
    - Otherwise, the primary key is the first `key(...)` whose node is "active". The `OnInsert` is the first active one. Assignments and `Validate` calls in inactive ranges do not count.
    - "No tag" needs an active key whose field list is readable and non-empty. No active key, or an active key where `primaryKeyFields` reads `[]` (no readable field list), KEEPS the tag. Today both cases answer no tag, which is the direction the module's own comment calls wrong.
  - **A3:** the module under-tags indirect raises by design (its comment). R-378 does not widen that. It only removes evidence the build cannot run:
    - If the receiver table's file is "undecided", KEEP the tag, and do not scan.
    - Otherwise, the trigger is the first active trigger with that name, and raise-capable calls in inactive ranges do not count.
    - **A3 also decides GENERATION.** `forcedTriggerSite` calls `resolveForcedTrigger`, and it guards both `targets` and `generate` of the forward direction (`swap-modify-flag.ts:191`, `:308-322`). So:
      - **A mutant DISAPPEARS** exactly when every table-level `trigger_declaration` named for the method (`OnInsert` / `OnModify` / `OnDelete`) that is a direct member of the receiver table's body starts in an inactive range. That trigger is not in the build, so `Modify()` versus `Modify(true)` runs no trigger in either case. The mutant was equivalent, and dropping it is the fix.
      - **No mutant APPEARS.** The change only removes candidates from `findTableTrigger`. It never adds one, and an undecided file keeps today's lookup.
      - **A tag-only change happens** when an active and an inactive trigger of the same name are both direct members. The first active one is read.
      - Measured on master: a trigger inside an object-level `#if` is not a direct `trigger_declaration` member (the B5 shape), so the disappearing case may never occur in real code. §4 counts it.
    - **Ordinals.** The ordinal counts mutants within `(astHash, codeunit, member, operator, major)` in source order (`project.ts:84-87`). A receiver variable is a positional id in `astSubtreeHash`, so `A.Modify()` and `B.Modify()` on two different tables in one member share a tuple. If A's mutant disappears, B's ordinal can drop from 1 to 0. That is a key move for unchanged source, and §4 decides whether it happens.

## 3. Repros (test-first, each red-checked)

The tests go in `packages/runner/tests/r378-member-wide-arms.test.ts`, through `generateMutationSet` with `preprocessorSymbols`. Each one first asserts that the named mutant (operator, file and line) EXISTS in BOTH builds, then asserts its tag.

| Row | Build without `LETHALX` | Build with `LETHALX` |
|---|---|---|
| A1 | `remove-commit` exists, no tag | exists, `write-txn-codeunit-run` |
| A2 | `Insert(true)` exists, no tag | exists, `run-trigger-skipped-insert` |
| A2-key | the active first key is `"Code"`, which `OnInsert` assigns: tag KEPT | the active first key is `Amount`, which `OnInsert` does not assign: no tag |
| A3 | `Modify()` exists, no tag | exists, `run-trigger-forced` |
| A2-undecided | a receiver table with an undecidable directive (`#if LETHALX LETHALY`, `unparsed-condition`) and an `OnInsert` with no key assignment | |
| A3-undecided | a receiver table with the same undecidable directive, whose `OnModify` has no raise-capable call. The forward `Modify()` mutant exists and KEEPS `run-trigger-forced` | |
| A2-unreadable-key | a receiver table whose active key has no readable field list. Unit level, on `insertSkipCanRaise` with a hand-built tree, if alc refuses such a key: tag KEPT | |
| A3-gone | if a shape exists where a direct trigger member is inactive: the forward mutant exists in the build with `LETHALX` and is ABSENT in the build without it. If no such shape parses, the test pins that the object-level `#if` trigger keeps today's answer (no mutant in either build) | |

- **A2-key shape:** `#if LETHALX key(PK; Amount) #else key(PK; "Code") #endif`. I will first check that alc compiles it (`/al-compile`) and that R214 decides it.
- **A2-undecided and A3-undecided are CONTROLS.** It must first prove three things:
  - (a) `buildSemanticContext(...).symbols.resolveObject` resolves that table;
  - (b) `evaluateArms` returns `undecided` for its file;
  - (c) the same table WITHOUT the bad directive gives no tag.
  - Only then does it assert the tag is KEPT.
- **Throw test:** a context built with a map, asked about a node from a tree that is not in it, throws.
- **Red-checks** (`mutation-red-checker`):
  - Remove each skip alone. A1's, A2's and A3's no-`LETHALX` halves go red.
  - Revert A2's active-key choice: A2-key goes red.
  - Remove the "undecided keeps the tag" branch, separately for A2 and for A3: A2-undecided goes red, then A3-undecided goes red.
  - Remove the readable-key condition: A2-unreadable-key goes red.
  - Remove the throw: the throw test goes red.
  - Make `armOf` always answer "active": every no-`LETHALX` half goes red.

The loop runs `bun scripts/verify.ts` and biome on the touched files.

## 4. Can a fixture's tag, verdict or memory move?

- **Pinned captures.** Every `packages/runner/tests/fixtures/r214/expected/*.txt` (including `p11-tier2.0.txt` and `.1.txt`, whose line 6 is `plat=-`) and `fixture-sandbox-symbols.*` must stay byte-identical. The existing r214 capture test asserts this.
  - `p11-tier2`'s later `Codeunit.Run` is a bare statement. It is not a consumed one, so A1 does not tag it in either build.
- **Gate fixtures.** Only `fixtures/sandbox-symbols` has `#if`, and it holds no `Commit`, `Codeunit.Run`, `Insert`, `Modify`, `Delete` or loop. No gate figure moves and no pre-commitment is needed.
- **Verdicts.** A tag never moves a verdict: it is reported beside a kill.
- **Keys and the scheme (decided by measurement, not ruled out).** A tag is not in `identityKeyOf` (`selection.ts:36`). A3's disappearing case can still renumber a surviving mutant (§2). So, before submit:
  - Diff the full key list (the serialized identity key, ordinal included) master b1bc7e2e against the branch for every pinned capture and every R214 corpus and set. `r214-capture.ts` prints the key per deployed mutant.
  - Classify each difference as either (i) a mutant gone under §2's A3 rule, or (ii) a surviving mutant whose key changed.
  - Any (ii) for unchanged source means `IDENTITY_SCHEME` 7. I message the orchestrator BEFORE bumping (R-307 holds 6), and the bump follows R214's scheme-race procedure.
  - Zero (ii) means no bump, and the submit note gives the diff's counts.
- **Operator versions** are unchanged. If the review wants a minor bump, it is two lines plus `operator-version-invariant.test.ts`.
- **Large corpora.** `r214-capture.ts` on the R214 corpora (DC and BaseApp, sets S0 and S1, per `docs/superpowers/specs/2026-09-29-r214-precommitment.md` §Corpora), run sequentially:
  - (a) Peak memory on a no-listing run must be at most 110% of master b1bc7e2e's, measured the same way the same day. The map adds one small range list per file, and the roots are already held.
  - (b) The `plat=` changes are listed per corpus. These are the expected fixes, and none of them is a verdict.
  - (c) Raw and deployed counts change ONLY by mutants gone under §2's A3 rule. Each one is listed by file, line and receiver table, with the inactive trigger named. No mutant may appear. A count change of any other kind is a STOP.
  - The corpora are on `U:`, and `H:/lethal-scratch` holds no product code.

## 5. Also in the build
- A CHANGELOG entry.
- R378 marked `done (<sha>)`, with A4's measured limit, and the index regenerated.
- New roadmap items, with the next free ids re-checked right before writing: B1 to B3 (one item), B4, B5, and C1.
