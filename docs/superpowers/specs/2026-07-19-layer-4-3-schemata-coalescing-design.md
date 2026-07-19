# Layer 4.3 · Schemata Overlap Coalescing — Design

**Date:** 2026-07-19 (rev 2 — first draft substantially wrong, see §9)
**Status:** Revised after adversarial review; awaiting spec review
**Pays down:** the Layer 3 deferral ("multi-mutation-per-statement deconfliction — current compile throws on overlap"), restoring design.md §3.1

## 1. Goal

Emit **one instrumented artifact per session** in the normal case, containing every mutant, compiled once.

Today `compileSchemataForFile` throws when two specs resolve to the same AST node and `printWithRewrites` throws on overlapping edits, so the orchestrator splits overlapping mutants into separate batches — each with its own schemata write, `alc` compile and publish. The sandbox fixture needs **3 compiles for 16 mutants**. design.md §3.1 chose mutant schemata precisely so N mutants cost *one* compile; batching reintroduces the N-compiles cost the architecture exists to avoid.

## 2. Overlap is a containment tree

Coalescing is tractable only if overlapping sites nest. Measured across `fixtures/sandbox-app` and `packages/builtin-tier1/tests/fixtures/al`: **53 overlapping pairs, 53 containment, 0 partial.**

The structural reason: spec targets are AST nodes, whose ranges are laminar, and mapping a node to an enclosing statement cannot create partial overlap.

**But LethAL does not currently enforce the premise.** `spec-validation.ts` accepts any `before` object carrying a `kind`; it never checks that the node belongs to the parsed tree or that its range matches a real node. A custom operator could synthesise a multi-node span — say "argument plus separator" for an argument-swap operator — and produce genuinely partial overlap. So this design adds an explicit invariant check rather than resting on two fixture counts:

> Every `spec.before` must correspond to a node in the current root, matched by exact range. Synthetic or multi-node spans are rejected at validation time.

## 3. Emission: flat dispatch, not nested wraps

**The exponential blowup comes from *nesting* wraps, not from wrapping.** `wrapStatement` keeps both branches, so nesting depth `d` reproduces the innermost statement `2^d` times.

Because **only one mutant is ever active** (`MutationSelector` holds a single id), nesting is unnecessary. A containment component compiles to one flat chain with one complete statement variant per mutant:

```al
if MutationSelector.Active('M0002') then begin
    <statement with the OUTER mutation applied>
end else if MutationSelector.Active('M0001') then begin
    <statement with the INNER mutation applied>
end else begin
    <original statement>
end;
```

Properties, all of which the rejected alternative lacked:

- **Linear:** N mutants in a component produce N+1 statement copies, not 2^N.
- **Evaluation order is exactly the original's** in every branch — nothing is hoisted, reordered, or moved across a sibling.
- **No temporaries**, so no type inference, no assignability question, no name-collision allocator, no `var`-parameter aliasing break, no Record/BigText copy semantics.
- **Deletion mutants fall out naturally** — their branch simply omits the statement.
- **An outer mutation that doesn't need the inner value never evaluates it**, because branches are independent rather than layered.

Each branch is the original statement with exactly one mutation applied, so per-branch semantics are whatever the original was — the property that makes this reviewable.

## 4. Why not lift (investigated and rejected as the primary mechanism)

The first draft proposed routing expression mutations through `liftExpression` (hoist into a typed temp) for linear growth. Adversarial review plus direct probing killed it. Recorded so it is not re-proposed:

- **Evaluation order.** Even an always-evaluated expression cannot be moved to the front. In `Consume(Bump('first'), Bump('second') > 0)`, lifting the comparison runs `second` before `first`. Record navigation, `Get`, `Modify`, number-series allocation and events all make that observable.
- **Earlier siblings may fail first.** In `Consume(FailNow(), 10 / D)`, hoisting the division replaces the original failure with a divide-by-zero.
- **AL has a ternary — verified.** `alc` rejects `D <> 0 ? 100 / D : 0` at runtime 13.0 with `AL0666: 'Support for the conditional operator (?:).' is not available in runtime version '13.0'. The supported runtime versions are: '14.0' or greater`, and compiles it cleanly at 14.0. So modern AL *does* conditionally evaluate sub-expressions, and hoisting out of a ternary arm introduces a division the original never reaches.
- **Type inference is far short of sufficient.** `types.ts` handles literals, identifiers from project-local symbols, parenthesised/unary and four binary classes. It infers nothing for call returns, member/field access, `Rec` fields, base-app symbols, enums, dates, collections, or interfaces; `Record "Sales Header"` degrades to `Record`, `List of [Text]` to `List`. And a known type is not a legal assignment — `BigText` requires its own methods.
- **`var` parameters and Record values.** Substituting a temp for an lvalue passed by `var` redirects mutations away from the original; copying a Record duplicates filters/keys/marks rather than preserving the receiver.
- **Triggers.** `findEnclosingProcedure` recognises only `procedure`; `applyLift` throws without one, and AL mutations occur heavily in triggers.

Lift remains viable **later** as a narrow optimisation for expressions proven pure, contextually independent, assignable, and inserted at their exact evaluation point. It is not the mechanism this layer builds on.

## 5. Composition

Group mutants into **containment components** — maximal sets connected by containment — then emit one flat chain per component, ordered outermost-mutation-first so the most enclosing variant is tested before narrower ones. Disjoint components are independent edits and compose as today.

Mutants targeting the same node are simply sibling branches in the chain; the current `assertNoDuplicateRewrite` throw disappears.

## 6. Batching: retained as a capacity and failure-isolation fallback

The first draft proposed deleting batching outright. **Reversed** — this is flagged for the reader because it contradicts an earlier decision in this design's own discussion:

- **One bad mutant would kill the whole session.** Every guarded branch must compile even when inactive. One custom operator emitting an invalid replacement, or one unsupported construct, fails the single artifact and turns *all* mutants into errors. Batching bounds that blast radius.
- **No size budget exists.** Flat dispatch is linear, but a component with many mutants still multiplies its statement, and there is no generated-source, per-object, compile-time or memory budget defined anywhere.

So: **one artifact is the target, not an invariant.** Overlap-driven batching is removed — that is the point of the layer — but the artifact-splitting mechanism stays, driven by (a) a configurable size budget and (b) automatic bisection after a failed all-mutant compile, so a compile error identifies the offending mutant instead of invalidating the run.

Consequently `MutantOutcome.batchIndex`, `runs.batch_count` and per-artifact versioning all stay. (Note: the store has no per-mutant batch column — the first draft claimed otherwise without checking.)

## 7. Mutant id allocation — already fixed

Review surfaced that ids were allocated twice: globally in `writeInstrumentedProject` (into the manifest) and again per-file in `compileSchemataForFile` (into the emitted guards), so for any multi-file project the manifest and the guards disagreed. Verified on the fixture: manifest `M0005` for `SandboxPricing`, emitted guard `M0001` — an id with no matching guard (never activates, reported survived) and an id emitted in two files (co-activates both).

Fixed and merged in `4ec2095` ahead of this layer, since it affected shipped verdicts. Coalescing depends on ids being artifact-global, so this was a prerequisite regardless.

## 8. Known gap: LethAL is blind to ternaries

The grammar parses `ternary_expression` cleanly (verified: 0 error nodes), but `ALNodeKind` has no entry for it. So no operator can target a ternary and no analysis can recognise one. On runtime 14.0+ projects LethAL silently under-mutates.

Out of scope here, but it must be recorded: any future lift work depends on recognising ternaries, and mutation coverage of modern AL does too.

## 9. What the first draft got wrong

Kept deliberately. This design's first revision claimed lift made growth linear and that lift safety was provable by checking only right operands of `logical_expression`. Both were wrong:

- The rule's premise — that short-circuit `and`/`or` is the only in-statement conditional evaluation — was false twice over. AL doesn't short-circuit at all (probed on the live BC server: `false and Bump()` still ran `Bump()`), and AL *does* have a ternary, which the rule didn't know about.
- Even a perfect conditional-evaluation check wouldn't have made hoisting safe, because evaluation *order* relative to siblings breaks independently.

The correction came from an external adversarial review plus direct probes against real infrastructure — not from re-reading the design.

**Consequence for design.md §3.5.** Rule 3 justifies the `duplicate` composition as preserving "the short-circuit signal the mutation is meant to test." AL has no short-circuit signal, so that rationale is void, and the `short-circuit-operand` context exists to serve it. This design does not change it — flat dispatch subsumes `duplicate` anyway — but §3.5 should be corrected so the false premise stops propagating.

## 10. Out of scope

- Container pool, leasing and fencing.
- Line-level coverage validation.
- Lift as a narrow optimisation (§4).
- Ternary support in `ALNodeKind` and the operators (§8).
- Retiring `short-circuit-operand` from design.md §3.5 and the Tier 1 operators.

## 11. Exit criteria

- The sandbox fixture compiles to **one artifact**, down from 3.
- **Verdicts unchanged on both backends**, verified live: al-runner `3 killed / 13 survived / 0 no-coverage` (18.8%), bcdev `3 killed / 10 survived / 3 no-coverage` (23.1%). Coalescing must be a pure compile-shape change with zero behavioural effect.
- A test proves mutants in one component do not interfere: with the outer mutant active the inner mutation must not apply, and vice versa.
- Generated source growth measured and reported (fixture, before vs after), demonstrating linearity rather than asserting it.
- Every `spec.before` is validated against a real tree node (§2).
- A deliberately-broken mutant triggers bisection and names itself, rather than failing the session (§6).
- `bun test`, `bun run typecheck`, `bunx biome check` green; `itest:alrunner` and `itest:bcdev` pass.
