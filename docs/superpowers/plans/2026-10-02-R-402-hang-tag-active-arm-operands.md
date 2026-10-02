# R-402: the hang tag reads loop-condition operands in active `#if` arms (short plan, r2)

Task: `H:/lethal-coord/tasks/R-402/task.md`. Item: `docs/roadmap/R402.md`. Branch `lethal/lane-preproc`, from master 0ef6652f. Offline.

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
- A statement-level `preproc_conditional_statement` whose nearest preceding sibling, skipping comments, is a STATEMENT, with no `;` token between the two, continues that statement. The tree misplaces that code, so the whole file is `undecided` with the reason `directive-continues-statement at line N`.
- The rule is separator-aware by construction. S4, S4b, S4c and S4d are refused. S4e, which has a `;`, is not.
- A `#if` that follows `begin`, `then`, `else`, `do` or `;` is untouched.
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
  - (ii) newly undecided files with `directive-continues-statement`, each listed with its line;
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
  - S4, S4b, S4c and S4d (every build): the file is refused with a `preproc-undecided` row whose detail starts `directive-continues-statement`.
  - S4e: not refused, and `Foo(B)` keeps its `void-method-call` site.
  - S8, S12 and S13: their existing `preproc-undecided` rows (`marker-mismatch`).
- **Classifier unit test** (builtin-tier1): `classifyHangCapable` on S1 with a context whose `armOf` answers "undecided": B is tagged.
- **Red-checks:**
  - Remove the tail read: S1, S2 and S3's tagged rows go red.
  - Drop the inactive skip: the S1 `[]`, S2 and S3 `[X]` untagged rows and S9 to S11 `[]` go red.
  - Skip on `!== "active"` instead of `=== "inactive"`: the undecided classifier test goes red.
  - Read directive conditions: a row whose directive symbol is also a variable name (`#if B`) goes red.
  - Remove the continuation rule: the S4 rows go red.
  - Ignore the `;` check: the S4e control goes red.
- **Compile-backed:** `scripts/r402-shape-sweep.ts` runs on the branch before submit. Every emitted artifact must compile under every build; the output goes in the submit note. It needs alc, so it is a script and not a unit test.
