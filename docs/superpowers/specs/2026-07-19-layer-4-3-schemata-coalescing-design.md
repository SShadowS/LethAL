# Layer 4.3 · Schemata Overlap Coalescing — Design

**Date:** 2026-07-19
**Status:** Drafted after section-by-section approval; awaiting spec review
**Pays down:** the Layer 3 deferral ("multi-mutation-per-statement deconfliction — current compile throws on overlap"), restoring design.md §3.1

## 1. Goal

Emit **one instrumented artifact per session**, containing every mutant, compiled once.

Today `compileSchemataForFile` throws when two specs resolve to the same AST node, and `printWithRewrites` throws on overlapping edits. The orchestrator works around this by splitting overlapping mutants into separate batches, each with its own schemata write, `alc` compile and publish. The sandbox fixture needs **3 compiles for 16 mutants**.

This is a workaround for a compiler limitation, not a design. design.md §3.1 chose mutant schemata precisely so that N mutants cost **one** compile; batching reintroduces the N-compiles cost the architecture exists to avoid.

## 2. Why overlap is a containment tree (verified, not assumed)

Coalescing is only tractable if overlapping sites nest. Measured across `fixtures/sandbox-app` and `packages/builtin-tier1/tests/fixtures/al`:

```
overlapping pairs: 53
  containment:     53
  PARTIAL:          0
```

This is structural, not luck: mutation specs target AST nodes, and two nodes in a tree are either disjoint or nested. Sites that resolve to enclosing statements inherit the same property, since enclosing statements of nested nodes are themselves nested or equal.

So coalescing is a **containment tree**, not a general interval-overlap problem.

## 3. The growth problem, and why it is a routing choice

`wrapStatement` emits both branches of the enclosing statement:

```al
if MutationSelector.Active('M0001') then begin
  <statement, mutated>
end else begin
  <statement, original>
end;
```

Each nesting level therefore **doubles** the emitted text. Depth 4 — `empty-block` (body) ⊃ `empty-block` (inner if) ⊃ `return-value` ⊃ `conditional-boundary` — reproduces the innermost statement ~16 times.

That doubling is not inherent. `liftExpression` already emits the original **once**:

```al
_m1: Boolean;
if MutationSelector.Active('M0001') then
  _m1 := A >= B
else
  _m1 := A > B;
exit(_m1);
```

`compile.ts` currently routes only `short-circuit-operand` to lift; everything statement-positioned goes to wrap. Making lift the primary strategy for expression-level mutations makes growth **linear in mutant count** rather than exponential in nesting depth.

Note the deletion-style operators never duplicated: `void-method-call` emits `if not Active(...) then <original>` (one copy) and `empty-block`'s mutated branch is empty. Only mutations whose replacement is a *modified copy* of the original duplicate — and those are exactly the ones lift handles.

## 4. Lift safety — provable, not heuristic

Lift hoists a prelude above the statement, so the expression is evaluated unconditionally. That is only sound under three conditions, all checkable:

**4.1 Unconditional evaluation — AL is EAGER (verified on real BC).**

An earlier draft of this spec assumed AL short-circuits `and`/`or` and specified an AST walk to avoid hoisting past a short-circuit. **That premise is false.** Probed against the live Cronus281 BC server (BC 28, AL runtime 17.0):

```al
Probe.Reset();
R := false and Probe.Bump();     // right operand STILL RAN
Probe.Reset();
R := true or Probe.Bump();       // right operand STILL RAN
```

Both reported `right operand ran 1 time(s)`. The same probe against al-runner — an independent AL implementation — agrees. **AL evaluates both operands of `and`/`or` unconditionally.**

Scope of verification: the assignment form was tested directly on real BC. The `if <expr> then` form was not separately published; AL evaluates a condition through the same expression machinery and there is no language-level reason for context-dependent laziness, but the implementation plan should confirm it rather than inherit the inference.

Consequently there is no in-statement conditional-evaluation construct to defend against: no short-circuit, no ternary. The evaluation-safety precondition collapses to a **placement** rule rather than an analysis:

> The prelude must be inserted into the same conditional context as its statement.

Inserting immediately before the statement in its own block satisfies this by construction: if the statement doesn't execute, neither does the prelude. The only care needed is a bare branch — `if X then Y := A / B;` has no block to hold a prelude, so the branch is wrapped: `if X then begin _m := A / B; Y := _m; end;`. That preserves the conditionality exactly.

This removes the AST walk entirely and, more importantly, removes the largest expected source of lift-fallbacks — which is what makes the linear-growth claim in §3 actually attainable rather than theoretical.

**4.2 Known type.** `typeOf(E)` must return non-null. The current `?? "Variant"` fallback is unsound — `Variant` does not accept every AL type — and is removed as a lift precondition.

**4.3 Insertable prelude.** The statement must sit where a preceding statement can be inserted. A bare `if X then S;` requires wrapping the branch in `begin…end` to take a prelude.

**When any condition fails**, the mutant falls back to `wrapStatement` and the reason is **recorded** — per-mutant in the manifest, aggregated in the report. Never silent, never dropped: a rising fallback rate is a visible signal to widen the analysis, and a mutant is never skipped merely because it is hard to lift (that would understate what the suite failed to catch).

## 5. Composition: innermost-first with temp substitution

This is the core algorithm and it is forced by correctness.

For `exit(A > B)` carrying a boundary mutant on `A > B` and a return-value mutant on the whole `exit(...)`:

```al
_m1: Boolean; _m2: Boolean;
if Active('M0001') then _m1 := A >= B else _m1 := A > B;   // inner first
if Active('M0002') then _m2 := not _m1 else _m2 := _m1;    // outer references _m1
exit(_m2);
```

The outer mutant's **original** branch must reference `_m1`, not the source text `A > B`. Otherwise activating `M0002` silently discards `M0001`'s rewrite and the two mutants interfere — one would mask the other, producing wrong verdicts rather than a compile error.

So compilation walks the containment tree **innermost-first**, and each level substitutes any already-lifted child with its temp reference. N nested mutants yield N preludes.

Only one mutant is ever active (`MutationSelector` holds a single id), so nested guards need no combinatorial reasoning — inactive levels pass their input through unchanged.

## 6. Removing batching

With one artifact per session, the batch concept is vestigial and is **removed entirely** rather than left as a length-one loop:

- `batchByOverlap` and `OverlapSite` deleted from `selection.ts`, with their tests.
- The orchestrator's batch loop collapses to a single prepare → deploy → run.
- `prepareBatchProject` becomes a single project preparation.
- `MutantOutcome.batchIndex` and the store's batch column are dropped.
- The app version simplifies to `1.0.<runId>.0`, preserving cross-run monotonicity (BC rejects a version below the installed one).
- Mutant ids become file-scoped rather than batch-scoped. Cross-run identity is unaffected — it keys on `(astHash, codeunitName, operatorName, operatorMajor)`, never the mutant code.

The parallel worker fan-out from Layer 4.2 is unaffected: workers shard *mutants*, and they now all share one artifact, which is strictly simpler than the per-worker-per-batch deploy they do today.

## 7. Surfaced: design.md §3.5 rule 3 rests on the same false premise

Not a Layer 4.3 decision, but this spec's probe invalidates a foundational rule and it must not be discovered again later.

`design.md` §3.5 states:

> **3. Duplicate (short-circuit-sensitive operand mutation)** · when the mutation changes an operator whose evaluation semantics include short-circuit behavior (e.g., `and` ↔ `or`), lifting loses the short-circuit signal the mutation is meant to test.

AL has no short-circuit behaviour, so "the short-circuit signal the mutation is meant to test" does not exist. That rationale is void. Downstream of it:

- The `short-circuit-operand` parent context (`design.md` §4 operator interface) exists to route to `duplicate`.
- `negate-conditional` declares it for `logical_expression` targets (`packages/builtin-tier1/src/negate-conditional.ts`).
- `compile.ts` dispatches it to `duplicateEnclosing`.

Nothing is *broken*: duplicating where lifting would do is conservative, costing emitted size rather than correctness — which is precisely the cost Layer 4.3 exists to remove. But it means the `duplicate` composition may have no remaining justification, and `and`↔`or` mutants may be liftable like any other expression.

**This spec does not change that.** It records the contradiction and proposes the question be settled deliberately: either amend §3.5 and retire `short-circuit-operand`, or identify a different reason `duplicate` must stay. Layer 4.3 treats `short-circuit-operand` exactly as it does today; retiring it is a separate decision with its own blast radius across Layers 2 and 3.

## 8. Out of scope

- Container pool, leasing and fencing (the next layer).
- Line-level coverage validation (separate spike, still unstarted).
- Widening lift to conditionally-evaluated expressions via guarded preludes — the fallback covers those correctly, just less compactly. Revisit if measurement shows the fallback rate matters.

## 9. Exit criteria

- The sandbox fixture compiles to **one artifact**, down from 3 batches.
- **Verdicts are unchanged on both backends**, verified live: al-runner `3 killed / 13 survived / 0 no-coverage` (18.8%), bcdev `3 killed / 10 survived / 3 no-coverage` (23.1%). This is the criterion that matters — coalescing must be a pure compile-shape change with zero behavioural effect.
- Generated source growth is **measured and reported** on the fixture (before vs after), together with the lift-fallback rate.
- A test proves nested mutants do not interfere: with the outer mutant active, the inner mutation must not apply, and vice versa.
- `bun test`, `bun run typecheck`, `bunx biome check packages/runner` green; `itest:alrunner` and `itest:bcdev` pass.
