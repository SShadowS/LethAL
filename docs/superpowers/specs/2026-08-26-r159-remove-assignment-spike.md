# R159 spike: is `remove-assignment` worth building?

Written before the live half.

## 1. The candidate

`assignment_statement` is the largest kind the node-kind census leaves unclaimed: **6,850**
occurrences inside procedure and trigger bodies on `do-rel2/Cloud`, **zero** exact-span overlap with
any shipped operator, 527x R13's bar of 13.

It is the direct analogue of `void-method-call`, which deletes a statement-position CALL and has
shipped since Layer 2. AL has two statement forms and LethAL deleted one of them.

Left-hand side: `identifier` 5,057, `member_expression` 1,380, `quoted_identifier` 331,
`subscript_expression` 76.

## 2. Compile, both halves

Reusing `void-method-call`'s emit shape rather than deriving a new one — `isStatementSlot`, empty
replacement, `parentContext: "statement-position"` — so the shape that could bite (an assignment that
is the whole un-braced body of an `if` or `for`, where deletion leaves a dangling `then`/`do`) is
handled by R161's `emptiedSlotFiller`, which that operator already needed.

- **Naive splice:** 14 of 14 compile, including both sole-body shapes, a compound `+=`, a subscript
  LHS and a quoted-identifier LHS.
- **Real emit path:** instrumented artifact compiles with **0 errors**, 14 of its 107 mutants from
  this operator, dispatch verified and printed.
- **Conformance: 4 cases, PASS.**

One expectation had to be corrected before it passed, and it is worth recording because it is a
property of the grammar rather than a typo: `beforeText` carries **no trailing `;`**. The semicolon is
a separate token, not part of the `assignment_statement` node, exactly as `void-method-call`'s
`DoThing()` carries none. Deleting the node leaves a bare `;`, a valid empty statement in AL, which
that operator has relied on since Layer 2.

## 3. This one moves EVERY gate

Measured, and it is the largest landing cost of any operator this row has produced:

| gate / demo | sites |
| --- | ---: |
| `itest:tables` (`sandbox-data`) | **+52** |
| gift-card demo | +12 |
| `credit-limit` demo | +8 |
| `itest:hang` (`sandbox-hang`) | +2 |
| `itest:bcdev` / `itest:alrunner` / `itest:envtool` (`sandbox-app`) | +1 |

`flip-boolean-literal` touched two gates and `negate-guard` one. This touches five, and every frozen
figure in CLAUDE.md moves with it.

## 4. Live half — an AGGREGATE pre-commitment, and it is labelled as such

A per-mutant pre-commitment over 75 verdicts belongs to the BUILD, where the measured values are the
honest input (that is how `flip-boolean-literal` was built: 14 of its 16 came from this spike). What
the spike needs to answer is narrower — **are deleted assignments killable, and at what rate** — so
that is what is predicted here, as three aggregates:

| fixture | mutants | predicted |
| --- | ---: | --- |
| `sandbox-data` | 52 | **38 killed / 14 survived / 0 no-coverage** |
| `credit-limit` | 8 | **5 killed / 3 survived / 0 no-coverage** |

Reasoning, so a miss is diagnosable rather than just wrong. `sandbox-data` kills 80.5% of its mutants
overall (219 of 272). Assignments should sit slightly BELOW that: they are more killable than average
where they write data a test asserts, and less killable wherever the target is never read again,
which is this operator's known equivalence weakness and the one thing a source-derived layer cannot
see. 73% is that judgement expressed as a number. `credit-limit`'s suite is weaker (55% overall) and
its assignments mostly set order fields before an `Insert`, so a majority-kill but a thinner one.

**The threshold that decides the recommendation.** If deleted assignments come back overwhelmingly
survived — say under 40% killed on `sandbox-data` — the operator is emitting mutants nothing
separates and the equivalence cost dominates, which is a refusal. A kill rate near the fixture's own
average means it is doing the same work `void-method-call` does on the other statement form.

---

## OUTCOME, appended after the runs. Nothing above is edited.

| fixture | predicted | measured | scored kill rate |
| --- | --- | --- | ---: |
| `sandbox-data` | 38 / 14 / 0 | **33 killed / 16 survived / 3 no-coverage** | 67.3% |
| `credit-limit` | 5 / 3 / 0 | **4 killed / 1 survived / 3 no-coverage** | 80.0% |

**The decision the spike existed to make is clear: BUILD.** Both fixtures kill a solid majority of
the scored mutants, far above the 40% refusal threshold §4 set in advance. Deleting an assignment is
doing the same work `void-method-call` does on the other statement form.

### Where the prediction was wrong, and it was the same mistake twice

I predicted **0 no-coverage on both** and both produced some — 3 and 3. The kill/survive split was
close (33 against 38, 4 against 5); the missing category was not close, it was absent from my
reasoning entirely.

The cause is not subtle and that is what makes it worth writing down. I reasoned about whether a
suite would CATCH a deleted assignment and forgot that a third answer exists: the assignment may sit
in a procedure no test calls. Both fixtures say so in their own READMEs — `credit-limit`'s posting
helpers (`PostInvoice`, `PostPayment`, `PostEntry`) are called by no test and already contribute 8
`no-coverage` mutants, and this operator's three land in exactly those procedures. I had read that
sentence while writing the credit-limit freeze two hours earlier.

A kill-versus-survive prediction that ignores coverage is answering a different question from the one
the tool answers, and the fix is procedural: predict the three-way split, never the two-way one.

### Landing cost, unchanged from §3 and larger than any operator this row has produced

Five gates, every frozen figure in CLAUDE.md, and a per-mutant pre-commitment over 75 verdicts —
52 on `sandbox-data`, 12 gift-card, 8 `credit-limit`, 2 `sandbox-hang`, 1 `sandbox-app` (which alone
moves `itest:bcdev`, `itest:alrunner` AND `itest:envtool`, since all three run that fixture).

The measured verdicts above are the honest input for the `sandbox-data` and `credit-limit` halves of
that pre-commitment, the same way this spike's numbers fed `flip-boolean-literal`'s build. The
gift-card, `sandbox-hang` and `sandbox-app` sites are still unmeasured and must be predicted.
