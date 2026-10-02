# R-402: the hang tag reads loop-condition operands in active `#if` arms (short plan)

Task: `H:/lethal-coord/tasks/R-402/task.md`. Item: `docs/roadmap/R402.md`. Branch `lethal/lane-preproc`, from master 0ef6652f. Offline.

## 1. Shapes, measured

The analysis is `classifyHangCapable` (`packages/builtin-tier1/src/loop-hazard.ts`). It walks the ANCESTOR loops of an assignment (`while_statement`, `repeat_statement`; `LOOP_KINDS`) and reads the identifiers under each loop's `condition` field. Its callers are `remove-assignment`, `swap-additive`, `shift-integer` and `flip-boolean-literal`, through `hangCapableForMutatedNode`.

I parsed each shape with the engine (scratch probe, not committed) and evaluated it with `evaluateArms`:

| # | Shape | Tree | R214 file decision | Hang tag on `B := B + 1` today |
|---|---|---|---|---|
| S1 | `while (A < 10)` `#if X` `and (B < 5)` `#endif` `do` | the tail is a `preproc_conditional_expression_tail` node, a SIBLING of `condition` inside `while_statement`, with `operator` and `operand` fields | decided | **missed with X**; measured through `generateMutationSet` in R-378 |
| S2 | S1 with `#elif Y` `and (B < 7)` | the same tail node, with one `operator`/`operand` pair per arm | decided | missed in both arms |
| S3 | S1 with `#if not X` | the same tail node | decided | missed without X |
| S4 | `repeat ... until (A > 10)` `#if X` `or (B > 5)` `#endif` `;` | **misparsed.** The tail is not in `repeat_statement`. It is the NEXT sibling, a statement-level `preproc_conditional_statement` holding `call_expression` `or(...)` | decided | **missed with X** |
| S5 | `#if X` / `#else` / `#endif` choosing the whole condition (while or repeat) | ERROR nodes | **undecided** (`marker-mismatch`): the whole file is refused, so no mutant exists | n/a |
| S6 | the tail inside the parentheses, `while ((A < 10)` `#if X` `and (B < 5)` `#endif` `) do` | ERROR nodes | **undecided** | n/a |
| S7 | two consecutive tails | ERROR nodes | **undecided** | n/a |

**`for` loops** are not in `LOOP_KINDS`. A `for` header has a bound, not a condition operand, and making counter loops hang-capable is R164's ruling, not this item's. Out of scope.

## 2. The fix
- **S1 to S3.** In `classifyHangCapable`, as well as `identifiersIn(conditionOf(loop))`, read each `operand` child of every `preproc_conditional_expression_tail` that is a direct child of the loop. Read an operand only where `armOfNode(ctx, operand)` is `"active"` (R378's `armOf`). This is one helper, `conditionOperands(loop, ctx)`, used where `conditionOf` is used today.
- **S4.** For a `repeat_statement`, also read the next named sibling when the misparse can be recognised exactly: it is a `preproc_conditional_statement` whose arms each hold exactly one `call_expression` whose `function` is the bare identifier `and`, `or` or `xor`. Read each active arm's arguments as condition operands. The match is deliberately narrow: an ordinary statement-level `#if` after a `repeat` holds statements, not a call named `or`. Undecided cannot arise, as the next point explains.
- **Undecided.** The mutated site's own file is never undecided, because R214 generates no mutant in such a file (S5 to S7). The loop and its tail are in that same file, so `armOf` answers only "active" or "inactive" here. If it ever answered "undecided", the SAFE direction for a hang tag is to TAG: an untagged hang-capable mutant can strand a tier. So "undecided" is treated as readable, not skipped.
- **Inactive operands stay unread.** That is today's behaviour, because tails are not read at all, now made explicit.
- **Also filed, not fixed:** S4's misparse also makes `or (B > 5)` look like a statement-level call, so call operators can claim it as a site (for example `void-method-call`). That is a grammar defect. It gets its own roadmap item, with `roadmap-next-id.ts` run right before writing.

## 3. Can a tag, verdict or key move?
- **Keys:** no. `hangCapable` is not in `identityKeyOf`.
- **Verdicts:** no. The tag is reported per mutant, and the run warns `hang-capable` with a count. It changes which mutants are counted as hang-capable, never a verdict.
- **Gate fixtures:** no gate fixture has a directive inside a loop condition. Only `fixtures/sandbox-symbols` has `#if`, and it has no loop. So no gate figure moves, and no pre-commitment is needed.
- **Check before submit,** as in R-378: run `scripts/r214-capture.ts` on master 0ef6652f and on the branch, over the four R214 corpora, S0 and S1, plus the pinned `fixtures/r214/expected` captures.
  - Required: 0 mutants gone, 0 appeared, 0 key moves, 0 `plat=` changes.
  - `hang=` may only go from `-` to `loop-condition-target`, and every such site is listed with its shape.
  - Any other change is a STOP.
  - Peak memory must stay at most 110% of master's.

## 4. Tests (test-first, each red-checked)
These go in `packages/runner/tests/r402-hang-active-arm.test.ts`, through `generateMutationSet`. Every row first asserts that `remove-assignment` on `B := B + 1` (and on `A := A + 1`) EXISTS in that build, then asserts its tag:

| Shape | Build | `B := B + 1` | `A := A + 1` |
|---|---|---|---|
| S1 | `[]` | untagged | tagged |
| S1 | `[X]` | **tagged** | tagged |
| S2 | `[X]` | tagged | |
| S2 | `[Y]` | tagged (the elif arm) | |
| S2 | `[]` | untagged | |
| S3 | `[]` | tagged | |
| S3 | `[X]` | untagged | |
| S4 | `[X]` | **tagged** | |
| S4 | `[]` | untagged | |
| S5 to S7 | any | no mutant in the file (pin, no product line) | |

**Red-checks:**
- Remove the tail read: S1, S2 and S3's tagged rows go red.
- Read tail operands without the `armOf` check: S1 `[]`, S2 `[]` and S3 `[X]` go red.
- Remove the S4 sibling read: S4 `[X]` goes red.
- Widen S4's match to any `preproc_conditional_statement`: a control row goes red. The control is a `repeat` followed by an ordinary statement-level `#if` holding `B := 0;`, where `B` must stay untagged.
