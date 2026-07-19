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

**4.1 Unconditional evaluation.** Within a single statement, AL has exactly one conditional-evaluation construct: short-circuit `and`/`or`. There is no ternary. So:

> Expression `E` is unconditionally evaluated whenever its statement runs **iff** no ancestor of `E`, up to that statement, is the right operand of a `logical_expression`.

A local AST walk decides this. The CFG is not consulted: it is statement-granular and cannot see inside an expression, and branch-level reachability is already handled by the fact that each branch is its own statement.

Counter-example the rule correctly rejects: in `X and (Total / Count > 0)`, hoisting the division evaluates it even when `X` is false — a divide-by-zero the original never reaches.

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

## 7. Out of scope

- Container pool, leasing and fencing (the next layer).
- Line-level coverage validation (separate spike, still unstarted).
- Widening lift to conditionally-evaluated expressions via guarded preludes — the fallback covers those correctly, just less compactly. Revisit if measurement shows the fallback rate matters.

## 8. Exit criteria

- The sandbox fixture compiles to **one artifact**, down from 3 batches.
- **Verdicts are unchanged on both backends**, verified live: al-runner `3 killed / 13 survived / 0 no-coverage` (18.8%), bcdev `3 killed / 10 survived / 3 no-coverage` (23.1%). This is the criterion that matters — coalescing must be a pure compile-shape change with zero behavioural effect.
- Generated source growth is **measured and reported** on the fixture (before vs after), together with the lift-fallback rate.
- A test proves nested mutants do not interfere: with the outer mutant active, the inner mutation must not apply, and vice versa.
- `bun test`, `bun run typecheck`, `bunx biome check packages/runner` green; `itest:alrunner` and `itest:bcdev` pass.
