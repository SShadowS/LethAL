# R-402: the hang tag reads loop-condition operands in active `#if` arms (short plan, r3)

Task: `H:/lethal-coord/tasks/R-402/task.md`. Item: `docs/roadmap/R402.md`. Branch `lethal/lane-preproc`, from master 0ef6652f. Offline.

## Revision r3 (`H:/lethal-coord/reviews/R-402-plan/reject-r2.md`)

| Point | r3 change | Where |
|---|---|---|
| 1. The refusal checked only the gap between siblings | The rule now also takes the previous statement's LAST non-trivia leaf. If that leaf is `;`, the statement owns its terminator and nothing is refused. The rule never searches descendants for a `;` | §2(a) |
| 2. Trivia | The trivia are named and measured. Comments, `#pragma` and `#region`/`#endregion` attach as SIBLINGS between the statement and the `#if`, and the rule skips them | §2(a), table C |
| 3. Legitimate cases with no separator | Three such cases were parsed and alc-compiled, and all are admitted: an empty `#if` before `end`, a comment-only `#if` before `end`, and an arm that supplies its own `;` | §2(a), table C |
| 4. Controls | 14 controls are added, all compiled under 4 builds and each tied to a red-check. The S4e assertion now depends on the build | table C, §4 |
| 5. Corpus classification | Every newly refused corpus file is classed as a real continuation or a conservative refusal, with its lost sites. If conservative refusals are not rare, I STOP and report before submitting | §3 |

### Table C: boundary controls, measured on master 0ef6652f (scratch `sweep.ts` + `boundary.ts`)

"Before" is the chain of siblings in front of the statement-level `#if` container (`preproc_conditional_statement`), back to the first non-trivia node. "Leaf" is that node's last leaf. `src` is the unmutated source compiled with alc, and `art` is the instrumented artifact compiled with alc, each under `[]`, `[X]`, `[Y]` and `[X,Y]`.

| Control | Before | Leaf | src | art | Rule result |
|---|---|---|---|---|---|
| c1 owned terminator `if A < 10 then A := A + 1;` then `#if X Foo(B); #endif` | `if_statement , ;` | `;` | ok | ok | admit (separator) |
| c2 empty `#if X #endif` before `end`, previous statement unterminated | `assignment_statement` | `1` | ok | ok | admit (every arm empty) |
| c2b comment-only arm before `end` | `assignment_statement` | `1` | ok | ok | admit (every arm is trivia) |
| c3 the arm supplies the separator `#if X ; Foo(B) #endif ;` | `assignment_statement` | `1` | ok | ok | admit (every non-empty arm starts with `;`) |
| c4 `#if` as a `then` branch | `then_keyword` | `then` | ok | ok | admit (the previous node is not a statement) |
| c4b `#if` as an `else` branch | `else_keyword` | `else` | ok | ok | admit |
| c5 `#if` in a case branch body | `:` | `:` | ok | ok | admit |
| c5b `#if` between case branches (`preproc_conditional_case`) | `case_branch` | `;` | ok | ok | out of the rule (not a statement container) |
| c6 `;` inside both arms, after a terminated statement | `assignment_statement , ;` | `;` | ok | ok | admit |
| c7 `A := A + 1; // done` then `#if` | `assignment_statement , ; , comment` | (trivia skipped) `;` | ok | ok | admit |
| c7b S4 with `// tail follows` before the `#if` | `repeat_statement , comment` | `)` | ok | **FAIL [X]** | **refuse** |
| c7c `#pragma` between | `assignment_statement , ; , pragma` | `;` | ok | ok | admit |
| c7d `#region` between | `assignment_statement , ; , preproc_region` | `;` | ok | ok | admit |
| c8 S4 with `#elif Y or (C > 3)` | `repeat_statement` | `)` | ok | **FAIL [X], [Y], [X,Y]** | **refuse** |
| S4e `until (A > 10);` then `#if X Foo(B); #endif` | `repeat_statement , ;` | `;` | ok | ok | admit; `Foo(B)` is a site under `[X]` only |

No measured shape had a statement OWNING its `;` before a statement-level `#if`. In every statement list the `;` is a sibling. The last-leaf check is kept, as the review requires, and it is red-checked with a hand-built tree.

## Revision r2: what changed (`H:/lethal-coord/reviews/R-402-plan/reject-r1.md`)

| Finding | r2 change | Where |
|---|---|---|
| 1. Shapes were missing; `identifiersIn` reads inactive arms | 17 shapes, each parsed AND compiled (unmutated source and instrumented artifact, 4 builds). One arm-aware operand walk replaces `identifiersIn`; it never reads directive conditions | §1, §2 |
| 2. S4 breaks the artifact | Measured on master: it does break it, in 3 of 4 S4 variants. The file is REFUSED in R-402 with a named reason, through a separator-aware rule in `evaluateArms` | §1, §2 |
| 3. Undecided reaches the classifier | Skip only "inactive", read "undecided", and red-check it with a classifier test that uses an undecided context | §2, §4 |
| 4. Controls and compile-backed tests | Control `Foo(B)` after a terminated `repeat`. A committed compile script runs every shape under every build before submit. The undecided shapes assert the `preproc-undecided` row | §4 |
| 5. No unconditional zero-change promise | A key diff by cause on the four corpora. `r214-capture` does not compile, so the compile script covers that | §3 |

## 1. Shapes, measured on master 0ef6652f

Method: `scratchpad/r402/sweep.ts`, which becomes `scripts/r402-shape-sweep.ts` in the build. For each shape and each build (`[]`, `[X]`, `[Y]`, `[X,Y]`) it reports:
- `generateMutationSet`: the specs, any `preproc-undecided` row, and the `remove-assignment` hang tags;
- an alc compile of the unmutated source;
- an alc compile of the instrumented artifact, with LethAL Control symbols.

The unmutated source compiles under every build for every shape.

| Shape | Tree | Decision | Hang tag today (variable read only in the `#if` arm) | Artifact |
|---|---|---|---|---|
| S1 `while (A<10)` `#if X and (B<5)` `#endif` | `preproc_conditional_expression_tail` beside `condition` | decided | **B untagged under [X]** (miss) | ok |
| S2 S1 + `#elif Y and (C<7)` | same tail, one operand per arm | decided | **B and C untagged** in their builds | ok |
| S3 S1 with `#if not X` | same | decided | **B untagged under []** | ok |
| S4 `repeat … until (A>10)` `#if X or (B>5)` `#endif ;` | MISPARSE: the tail is a statement-level `preproc_conditional_statement` after the repeat, holding a call `or(...)` | decided | B untagged | **FAILS under [X]**: `AL0111: Semicolon expected` |
| S4b S4 + empty `#else` | same | decided | B untagged | **FAILS under [X]** |
| S4c `or (B>5) or (C>3)` | same, holding `logical_expression(or(...) or ...)` | decided | B and C untagged | ok (compiles, but the hang tag is missed) |
| S4d nested `#if Y or (C>3)` | same | decided | B and C untagged | **FAILS under [X]** and [X,Y] (`AL0104: 'end' expected`) |
| S4e control: `until (A>10);` then `#if X Foo(B); #endif` | the SAME tree as S4 (`preproc_conditional_statement` holding `call_expression`); only the `;` in the source differs | decided | B untagged (correct) | ok |
| S8 operand prefix `#if X (B<5) and #endif (A<10)` | ERROR | **undecided** (marker-mismatch) | no mutant | n/a |
| S9 tail inside a call argument `Check(A #if X + B #endif, 10)` | tail inside `condition` | decided | **B tagged under []** (over-tag) | ok |
| S10 tail inside a subscript `Arr[1 #if X + B #endif]` | tail inside `condition` | decided | **B tagged under []** | ok |
| S11 `preproc_conditional_list_elements` `A in [1, 2 #if X , B #endif]` | inside `condition` | decided | **B tagged under []** | ok |
| S12 nested tail | ERROR | **undecided** | no mutant | n/a |
| S13 `#if X while (B<5) #else while (A<10) #endif do` | ERROR | **undecided** | no mutant | n/a |
| S14 a whole loop inside a statement-level `#if` | an ordinary loop inside `preproc_conditional_statement` | decided | B tagged only under [X] (correct already) | ok |
| S15 an assignment tail `A := A #if X + B #endif;` / S16 an `if` condition tail | a tail node | decided | not a loop | ok |

`for`, `downto` and `foreach` are not in `LOOP_KINDS`. That is an existing scope decision (R164), not shape coverage.

## 2. Fix

**(a) S4 refusal, in `evaluateArms`.** It is the R214 evaluator, so the existing `preproc-undecided` row, warning and caveat all apply.
- **The rule (r3).** For each statement-level `preproc_conditional_statement` P:
  1. **Trivia.** Walk back over P's preceding siblings, skipping trivia: `comment` (and the grammar's other comment kinds), `pragma`, `preproc_region` and `preproc_endregion`. The first other sibling is PREV.
  2. **Admit** when PREV is absent, is a `;` token, is a keyword or `:`, or is not a statement node. That covers `begin`, `then`, `else`, `do`, a case label, and another preproc container.
  3. **Admit** when PREV's last leaf, skipping trivia leaves, is `;`. That is a terminator the statement owns.
  4. **Admit** when every arm of P is empty or trivia-only, or when every non-empty arm's first non-trivia token is `;`. Both of those are legitimate AL (c2, c2b and c3 compile).
  5. **Otherwise refuse:** the whole file is `undecided` with the reason `directive-continues-statement at line N`. An arm's content continues an unterminated statement, and the tree has misplaced it.
- **Scope.** The rule applies only to `preproc_conditional_statement`. Case-level containers (`preproc_conditional_case`) parse their branches structurally and are not misplaced (c5b).
- **Limit.** A `preproc_conditional_statement` whose PREV is another preproc container is admitted. Its content cannot be judged without evaluating the earlier container's arms, and no such continuation shape was found.
- S4, S4b, S4c, S4d, c7b and c8 are refused. S4e and every control in table C are admitted.
- Correct structural ownership of the tail is a grammar change (tree-sitter-al). It will be filed as its own item for when the grammar gains it, so a refusal is not the permanent answer.

**(b) One arm-aware operand walk** replaces `identifiersIn` for each enclosing loop. It reads:
- the `condition` subtree;
- each `preproc_conditional_expression_tail` that is a direct child of the loop (S1 to S3).

The walk is recursive, so tails and list elements nested inside the condition (S9 to S11) are reached by the same walk. It never reads directive markers or their conditions (`preproc_if`, `preproc_elif`, `preproc_else`, `preproc_endif`). It skips a node only when `armOfNode(ctx, node) === "inactive"`.

**(c) Undecided is read, so it tags.** `generateMutationSet` runs operators before it refuses an undecided file, so `armOf` can answer "undecided" to the classifier. Reading those operands is the safe direction for a hang tag, because an untagged hang-capable mutant can strand a tier. The mutants are then dropped anyway.

## 3. Moves, by cause
- **Keys and verdicts from the tag alone:** none. `hangCapable` is not in `identityKeyOf`, and it drives only the hang count and warning.
- **The S4 refusal** removes every site of an affected file, and that changes sites, hashes and ordinals in that file. It is the R214 refusal path, which reports the file.
- **Before submit:** run `scripts/r214-capture.ts`, master 0ef6652f against the branch, on DC, SysApp, BCF and BaseApp, S0 and S1, plus the pinned `fixtures/r214/expected` captures. List every change by cause:
  - (i) `hang=` going from `-` to `loop-condition-target` (S1 to S3 shapes) or the reverse (S9 to S11 over-tags removed), each site listed with its shape;
  - (ii) newly undecided files with `directive-continues-statement`, each listed with its line and classed as a REAL continuation (the `#if` arm's content is an expression tail of the previous statement) or a CONSERVATIVE refusal (legitimate AL the rule refuses), with the sites lost per file. If conservative refusals are more than rare (more than 2 files, or more than 1% of the newly refused sites), I STOP and report to the orchestrator before submitting;
  - any other change is a STOP.
  - Peak memory must stay at most 110% of master's.
- **Gate fixtures:** none has a directive inside a loop, and none has a statement-level `#if` after an unterminated statement. The pinned captures must stay byte-identical.
- **`r214-capture` does not compile,** so `scripts/r402-shape-sweep.ts` is the compile check. It runs before submit, and every artifact it emits must compile.

## 4. Tests (test-first, each red-checked)
- **Runner, through `generateMutationSet`:** `packages/runner/tests/r402-hang-active-arm.test.ts`. Each tag row first asserts that `remove-assignment` on the named assignment EXISTS in that build.
  - S1 `[]`: B untagged, A tagged. S1 `[X]`: B tagged.
  - S2 `[X]`: B tagged, C untagged. S2 `[Y]`: C tagged, B untagged. S2 `[]`: both untagged. Each arm uses its own variable.
  - S3 `[]`: B tagged. S3 `[X]`: B untagged.
  - S9, S10 and S11 `[]`: B untagged. Under `[X]`: B tagged.
  - S14 `[X]`: B tagged. S14 `[]`: no B site.
  - S4, S4b, S4c, S4d, c7b and c8 (every build): the file is refused with a `preproc-undecided` row whose detail starts `directive-continues-statement`.
  - S4e: not refused. `Foo(B)`'s `void-method-call` site EXISTS under `[X]` and does NOT exist under `[]`.
  - Every admitted control in table C (c1, c2, c2b, c3, c4, c4b, c5, c5b, c6, c7, c7c and c7d): no `preproc-undecided` row, and the sites the sweep listed exist in the builds where it listed them.
  - S8, S12 and S13: their existing `preproc-undecided` rows (`marker-mismatch`).
- **Classifier unit test** (builtin-tier1): `classifyHangCapable` on S1 with a context whose `armOf` answers "undecided": B is tagged.
- **Red-checks:**
  - Remove the tail read: S1, S2 and S3's tagged rows go red.
  - Drop the inactive skip: the S1 `[]`, S2 and S3 `[X]` untagged rows and S9 to S11 `[]` go red.
  - Skip on `!== "active"` instead of `=== "inactive"`: the undecided classifier test goes red.
  - Read directive conditions: a row whose directive symbol is also a variable name (`#if B`) goes red.
  - Remove the continuation rule: the S4, c7b and c8 rows go red.
  - Remove the sibling-separator check (step 2's `;`): S4e, c1 and c6 go red.
  - Remove the trivia skip: c7b goes red, because a comment PREV is not a statement and the file is admitted. c7, c7c and c7d also go red, because PREV is then the comment and not the `;`.
  - Remove the owned-terminator check (step 3): a hand-built-tree unit test goes red. It is a statement node whose last leaf is `;`, followed by a continuing arm, and it must be admitted.
  - Remove the empty or trivia-only arm admission: c2 and c2b go red.
  - Remove the `;`-first admission: c3 goes red.
  - Apply the rule to `preproc_conditional_case`: c5b goes red.
- **Compile backing:** every control and shape is in `scripts/r402-shape-sweep.ts`. On the branch, every admitted shape's artifact must compile under all four builds, and every refused shape must emit no artifact for its file.
- **Compile-backed:** `scripts/r402-shape-sweep.ts` runs on the branch before submit. Every emitted artifact must compile under every build; the output goes in the submit note. It needs alc, so it is a script and not a unit test.
