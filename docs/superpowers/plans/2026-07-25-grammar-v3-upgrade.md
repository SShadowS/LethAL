# tree-sitter-al v3 Grammar Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move LethAL from the vendored tree-sitter-al v2.5.0 wasm to a fresh build of v3.0.1, updating every place that assumes the old AST shape, with no loss of mutation-site coverage.

**Architecture:** v3 inserts *container* nodes the old grammar did not have — `statement_block` between a `code_block` and its statements, `var_body` inside `var_section`, `declaration_body` inside object declarations. Nothing was renamed or removed; the tree simply got one level deeper in specific places. The upgrade is therefore a systematic "skip the new container" change across four clusters: AST walks, the semantic layer, one Tier-1 operator, and the schemata compiler.

**Tech Stack:** Bun, TypeScript, web-tree-sitter, tree-sitter CLI 0.26.11, `SShadowS/tree-sitter-al` v3.0.1 at `/u/Git/tree-sitter-al`.

## Global Constraints

- **Measured, not assumed.** Against 2,876 real Microsoft BC test-app files (114 MB), vendored v2.5.0 parses **99.9% clean** (3 files, 6 ERROR nodes) and v3.0.1 parses **100% clean** (0 errors). v3 is the better parser; every failure in this plan is LethAL's assumption about node shape, not a grammar defect.
- **The regression that matters is silent.** Under v3 with no code changes, statement-position calls drop from **703,239 to 0**, which would make `void-method-call` emit zero mutants while every parse looks perfect. Site counts, not parse errors, are the gate.
- **Frozen live baselines must not move:** bcdev **3 killed / 10 survived / 3 no-coverage**, al-runner **3 / 13 / 0**, both per-mutant. A differing verdict is a BLOCK, never "close enough".
- **Unit baseline before this work: 618 pass / 0 fail.** With the v3 wasm swapped in and no other change: **605 pass / 13 fail**. Those 13 are the work list.
- **No dual-grammar support.** Migrate to the v3 shape only. Supporting both shapes doubles the predicate surface for a grammar we control and have decided to track.
- **Build loop (order matters — the dist trap):** `bun run typecheck` (`tsc --build --force`), then `rm -rf packages/*/dist`, then `bun test`. Stale compiled `*.test.js` in `dist` cause ~21 phantom failures.
- **Conventions (CI fails otherwise):** no `!` non-null assertions; `exactOptionalPropertyTypes` (optional props via `...(v !== undefined ? { k: v } : {})`); typed error classes extend `Error` directly; fail loudly on caller-contract violations, never a plausible empty default.
- **Corpus location:** `C:/Users/SShadowS/AppData/Local/Temp/claude/al-corpus`. It is extracted Microsoft source — **never commit it**.

---

### Task 1: Vendor the v3 wasm and record the exact failure set

This task deliberately leaves the repo RED. Everything after it turns a specific cluster green. Work on branch `layer-6a-grammar-upgrade`.

**Files:**
- Modify: `packages/engine/vendor/tree-sitter-al.wasm` (binary swap)
- Modify: `packages/engine/src/ast/node-kinds.ts`

**Interfaces:**
- Produces: `ALNodeKind.statement_block`, `ALNodeKind.var_body`, `ALNodeKind.declaration_body` — the three container kinds later tasks consume.

- [ ] **Step 1: Create the branch and build a fresh wasm from the grammar repo**

```bash
cd /u/Git/LethAL && git checkout -b layer-6a-grammar-upgrade
cd /u/Git/tree-sitter-al && git log -1 --format="%h %ad %s" --date=short
tree-sitter build --wasm -o /tmp/tree-sitter-al-v3.wasm
ls -la /tmp/tree-sitter-al-v3.wasm
```

Expected: builds cleanly, ~7.9 MB. Do NOT use the `tree-sitter-al.wasm` checked into the grammar repo root — it predates later grammar commits.

- [ ] **Step 2: Back up and swap the vendored wasm**

```bash
cd /u/Git/LethAL
cp packages/engine/vendor/tree-sitter-al.wasm /tmp/vendored-v2.5.0.wasm.bak
cp /tmp/tree-sitter-al-v3.wasm packages/engine/vendor/tree-sitter-al.wasm
```

- [ ] **Step 3: Record the failure set — this is the work list**

```bash
cd /u/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test 2>&1 | tail -4
bun test 2>&1 | grep "(fail)" | sed 's/\[.*//' | sort
```

Expected: `605 pass, 13 fail`, and exactly these 13:

```
buildCFG > includes three exit paths for the branching fixture
buildCFG > marks unreachable blocks when they exist
buildCallerIndex > does not double-count callers when multiple files parse through
buildCallerIndex > indexes direct and indirect callers of Helper
buildSemanticContext > exposes symbols, types, callers, and cfg-for-procedure
buildSymbolTable > distinguishes global vars from procedure-local vars
buildSymbolTable > registers a procedure within a codeunit
compileSchemataForFile — member splice reproduces a consumed terminator (C1) > an inner-block member directly followed by 'else' gains no ';'
compileSchemataForFile — member splice reproduces a consumed terminator (C1) > emits a fully re-parseable file when the component root is a statement (0 ERROR nodes)
end-to-end Layer 3 > runs all Tier 1 operators and composes a valid instrumented output
tier 1 conformance > lethal.void-method-call passes its conformance suite
tree-walks > findEnclosingStatement treats call_expression-inside-code_block as a statement
voidMethodCall > generates deletion specs only for statement-position calls
```

If the count or membership differs, STOP and report — the grammar moved again and this plan's task boundaries no longer match reality.

- [ ] **Step 4: Add the three container node kinds**

In `packages/engine/src/ast/node-kinds.ts`, alongside the existing entries (`block: "code_block"` is at line 26, `var_section: "var_section"` at line 19), add:

```typescript
  /** v3 wraps a `code_block`'s statements in a `statement_block` container. */
  statement_block: "statement_block",
  /** v3 wraps a `var_section`'s declarations in a `var_body` container. */
  var_body: "var_body",
  /** v3 wraps an object declaration's members in a `declaration_body` container. */
  declaration_body: "declaration_body",
```

Update the file's header comment: it currently says the mapping is for grammar **v2.5.0** — change it to **v3.0.1**, and note that v3 adds container nodes rather than renaming existing ones.

- [ ] **Step 5: Verify the constants compile and the failure set is unchanged**

```bash
cd /u/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test 2>&1 | tail -4
```

Expected: still `605 pass, 13 fail`. Adding constants changes no behavior.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/vendor/tree-sitter-al.wasm packages/engine/src/ast/node-kinds.ts
git commit -m "chore(grammar): vendor tree-sitter-al v3.0.1 and name its container nodes

v3 inserts statement_block, var_body and declaration_body containers rather
than renaming anything. Measured on 2876 real BC files: v3 parses 100% clean
vs v2.5.0's 99.9%. This commit intentionally leaves 13 tests red; each
following task turns one cluster green."
```

---

### Task 2: Statement position in `tree-walks`

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts` (`findEnclosingStatement`, ~lines 35-56; `findEnclosingBlock`, ~line 73)
- Test: `packages/engine/tests/ast/tree-walks.test.ts`

**Interfaces:**
- Produces: `isStatementPosition(node: ALSyntaxNode): boolean` — defined in `tree-walks.ts`, re-exported from `packages/engine/src/index.ts` AND `packages/operator-sdk/src/index.ts`. Task 3 and Task 5 both consume it. True when the node sits directly in a block's statement list under EITHER grammar shape.
- Produces (Task 4 also adds to this file): `blockStatements(block)`, `varDeclarations(varSection)`.

- [ ] **Step 1: Read the current function before changing it**

Read `packages/engine/src/ast/tree-walks.ts` lines 25-80. `findEnclosingStatement` has an expression-statement special case: a `call_expression` whose parent is `ALNodeKind.block`. Under v3 that parent is a `statement_block`, so the case never fires.

- [ ] **Step 2: Write the failing test**

Add to `packages/engine/tests/ast/tree-walks.test.ts`:

```typescript
it("isStatementPosition accepts a call directly inside a block's statement list", async () => {
  const root = wrapRoot(parseAL(`codeunit 50000 T { procedure P() begin Foo(); end; }`));
  const calls: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.kind === ALNodeKind.procedure_call) calls.push(n);
  });
  expect(calls.length).toBe(1);
  expect(isStatementPosition(calls[0] as ALSyntaxNode)).toBe(true);
});

it("isStatementPosition rejects a call that is an if-branch, not a statement-list member", async () => {
  const root = wrapRoot(
    parseAL(`codeunit 50000 T { procedure P() begin if X then Foo(); end; }`),
  );
  const calls: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.kind === ALNodeKind.procedure_call && n.text.startsWith("Foo")) calls.push(n);
  });
  expect(calls.length).toBe(1);
  expect(isStatementPosition(calls[0] as ALSyntaxNode)).toBe(false);
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/engine/tests/ast/tree-walks.test.ts`
Expected: FAIL — `isStatementPosition is not defined` (not an assertion failure).

- [ ] **Step 4: Implement**

Add to `packages/engine/src/ast/tree-walks.ts`:

```typescript
/**
 * Is this node a direct member of a block's statement list?
 *
 * Grammar note: v3 wraps a `code_block`'s statements in a `statement_block`
 * container, so a statement's parent is the `statement_block` and its
 * grandparent is the `code_block`. Keying on `code_block` alone — as this
 * codebase did under v2.5.0 — silently matches nothing under v3.
 */
export function isStatementPosition(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  return parent.kind === ALNodeKind.statement_block || parent.kind === ALNodeKind.block;
}
```

Then replace the expression-statement case inside `findEnclosingStatement` — the clause currently reading `current.kind === ALNodeKind.procedure_call && current.parent !== null && current.parent.kind === ALNodeKind.block` — with:

```typescript
    if (current.kind === ALNodeKind.procedure_call && isStatementPosition(current)) {
      return current;
    }
```

`findEnclosingCodeBlock` (which returns the narrowest `ALNodeKind.block` ancestor) needs no change: `code_block` still exists and is still the ancestor — there is simply a `statement_block` in between.

Now export it. `packages/engine/src/index.ts` exports a curated list, and `packages/operator-sdk/src/index.ts:16-23` re-exports a curated subset of that (`ALNodeKind`, `astSubtreeHash`, `visit`, `findEnclosingStatement`, `findEnclosingProcedure`, `findEnclosingCodeBlock`). Add `isStatementPosition` to **both** lists, or Task 3 cannot import it:

```typescript
export {
  ALNodeKind,
  astSubtreeHash,
  visit,
  findEnclosingStatement,
  findEnclosingProcedure,
  findEnclosingCodeBlock,
  isStatementPosition,
} from "@lethal/engine";
```

- [ ] **Step 5: Run the tests**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/engine/tests/ast/tree-walks.test.ts`
Expected: PASS, including the previously-failing `findEnclosingStatement treats call_expression-inside-code_block as a statement`.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/ast/tree-walks.ts packages/engine/tests/ast/tree-walks.test.ts
git commit -m "fix(engine): statement position spans v3's statement_block container"
```

---

### Task 3: `void-method-call` — the operator that silently zeroed

**Files:**
- Modify: `packages/builtin-tier1/src/void-method-call.ts:19-22`
- Test: `packages/builtin-tier1/tests/void-method-call.test.ts`

**Interfaces:**
- Consumes: `isStatementPosition` from Task 2, imported from `@lethal/operator-sdk` (Task 2 added it to that package's re-export list). Operators never import `@lethal/engine` directly — follow the existing import block at the top of `void-method-call.ts`.

- [ ] **Step 1: Confirm the operator is the silent-zero case**

```bash
cd /u/Git/LethAL && bun run scripts/probe-grammar-corpus.ts "C:/Users/SShadowS/AppData/Local/Temp/claude/al-corpus" --limit 200 2>&1 | grep statementCalls
```

Expected right now: `statementCalls 0`. That single number is the entire reason this task exists.

- [ ] **Step 2: Write the failing test**

The existing test `generates deletion specs only for statement-position calls` already fails. Add one that pins the v3 shape explicitly so a future grammar bump cannot re-zero it silently:

```typescript
it("still targets a statement-position call under the v3 statement_block shape", async () => {
  const root = wrapRoot(
    parseAL(`codeunit 50000 T { procedure P() begin DoWork(); end; }`),
  );
  const specs: MutationSpec[] = [];
  visit(root, (n) => {
    if (voidMethodCall.targets(n, ctx)) specs.push(...voidMethodCall.generate(n, ctx));
  });
  expect(specs.length).toBe(1);
  expect(specs[0]?.after.text).toBe("");
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/builtin-tier1/tests/void-method-call.test.ts`
Expected: FAIL — `expect(specs.length).toBe(1)` received `0`.

- [ ] **Step 4: Implement**

In `packages/builtin-tier1/src/void-method-call.ts`, replace the body of `targets`:

```typescript
  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    // Only statement-position calls. v3 wraps a block's statements in a
    // `statement_block`, so this cannot key on `code_block` directly.
    return isStatementPosition(node);
  },
```

- [ ] **Step 5: Run the operator tests and the conformance suite**

```bash
cd /u/Git/LethAL && rm -rf packages/*/dist
bun test packages/builtin-tier1
```

Expected: PASS, including `tier 1 conformance > lethal.void-method-call passes its conformance suite`.

- [ ] **Step 6: Confirm the site count came back**

```bash
bun run scripts/probe-grammar-corpus.ts "C:/Users/SShadowS/AppData/Local/Temp/claude/al-corpus" --limit 200 2>&1 | grep statementCalls
```

Expected: a large non-zero number. The probe counts sites the same way the operator does, so this is the corpus-scale proof the operator is alive again.

- [ ] **Step 7: Commit**

```bash
git add packages/builtin-tier1/src/void-method-call.ts packages/builtin-tier1/tests/void-method-call.test.ts
git commit -m "fix(tier1): void-method-call finds statement calls under v3

Under v3 this operator matched nothing — 703,239 corpus sites became 0 — while
every parse still looked perfect. Pins the v3 shape in a test."
```

---

### Task 4: Semantic layer — `var_body` and `statement_block`

**Files:**
- Modify: `packages/engine/src/semantic/symbol-table.ts:80-82` (globals) and `:151-153` (procedure-locals)
- Modify: `packages/engine/src/semantic/cfg.ts:138` (block statement walk)
- Test: `packages/engine/tests/semantic/symbol-table.test.ts`, `packages/engine/tests/semantic/cfg.test.ts`

**Interfaces:**
- Consumes: `ALNodeKind.var_body`, `ALNodeKind.statement_block` from Task 1.

- [ ] **Step 1: Read both call sites first**

`symbol-table.ts` finds a `var_section` as a direct `namedChild` and then reads its declarations. Under v3 the declarations sit inside a `var_body` child of that `var_section`. `cfg.ts:138` iterates `stmt.namedChildren` of a `code_block` looking for statements; under v3 those live one level down in a `statement_block`.

- [ ] **Step 2: Write a helper and use it in both files**

Add to `packages/engine/src/ast/tree-walks.ts`:

```typescript
/**
 * The statements of a block, skipping v3's `statement_block` container.
 *
 * Returns the block's own named children under a grammar without the
 * container, so callers need no version branching.
 */
export function blockStatements(block: ALSyntaxNode): readonly ALSyntaxNode[] {
  const inner = block.namedChildren.find((c) => c.kind === ALNodeKind.statement_block);
  return inner === undefined ? block.namedChildren : inner.namedChildren;
}

/**
 * The declarations of a `var_section`, skipping v3's `var_body` container.
 */
export function varDeclarations(varSection: ALSyntaxNode): readonly ALSyntaxNode[] {
  const inner = varSection.namedChildren.find((c) => c.kind === ALNodeKind.var_body);
  return inner === undefined ? varSection.namedChildren : inner.namedChildren;
}
```

- [ ] **Step 3: Run the semantic tests and confirm they still fail**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/engine/tests/semantic`
Expected: still failing — the helpers exist but nothing calls them yet.

- [ ] **Step 4: Wire the helpers in**

In `symbol-table.ts`, wherever the code iterates a `var_section`'s children to read declarations, wrap with `varDeclarations(varSection)`. In `cfg.ts:138`, replace `for (const inner of stmt.namedChildren)` with `for (const inner of blockStatements(stmt))`.

`callers.ts` and `context.ts` have no direct shape assumption — their tests fail because they build on the symbol table and CFG. Re-run them after this change before touching them; if they pass, do not modify them.

- [ ] **Step 5: Run the semantic tests**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/engine`
Expected: PASS — all 7 semantic-cluster failures (`buildSymbolTable` ×2, `buildCFG` ×2, `buildCallerIndex` ×2, `buildSemanticContext` ×1) green.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/ast/tree-walks.ts packages/engine/src/semantic/symbol-table.ts packages/engine/src/semantic/cfg.ts
git commit -m "fix(engine): symbol table and CFG traverse v3's var_body/statement_block"
```

---

### Task 5: Schemata compiler — the statement splice

**Files:**
- Modify: `packages/schemata/src/compile.ts:114` (doc comment) and `:165-170` (the splice predicate)
- Test: `packages/schemata/tests/compile.test.ts`

**Interfaces:**
- Consumes: `isStatementPosition` from Task 2.

- [ ] **Step 1: Read the predicate and its doc comment**

`compile.ts` decides whether a mutation's component root is a statement, which drives whether a consumed `;` terminator is reproduced. The current predicate is:

```typescript
    statement.kind === ALNodeKind.block ||
    (statement.parent !== null && statement.parent.kind !== ALNodeKind.block);
```

Under v3 a statement's parent is a `statement_block`, so the second clause is true for ordinary statements and the splice reproduces terminators incorrectly. Both failing tests in this cluster are about exactly that.

- [ ] **Step 2: Run the two failing tests to see the current output**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/schemata/tests/compile.test.ts`
Expected: the two `member splice reproduces a consumed terminator (C1)` tests fail, one on a stray `;` before `else`, one on non-zero ERROR nodes in the re-parsed output.

- [ ] **Step 3: Implement**

Replace the predicate with one expressed in terms of statement position rather than a specific container kind:

```typescript
  const isBlockOrNonStatementChild =
    statement.kind === ALNodeKind.block || !isStatementPosition(statement);
```

Update the doc comment at `compile.ts:114`, which names `ALNodeKind.block` explicitly, to describe statement position instead and to note that v3 interposes a `statement_block`.

- [ ] **Step 4: Run the schemata tests**

Run: `cd /u/Git/LethAL && rm -rf packages/*/dist && bun test packages/schemata`
Expected: PASS, both C1 tests green.

- [ ] **Step 5: Run the whole unit suite**

Run: `cd /u/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test 2>&1 | tail -4`
Expected: **all green**, at least 618 pass + the tests added in Tasks 2 and 3, 0 fail. The `end-to-end Layer 3` test should now pass as a consequence.

If anything is still red, STOP: the remaining failure is outside the four clusters this plan mapped and needs its own diagnosis.

- [ ] **Step 6: Commit**

```bash
git add packages/schemata/src/compile.ts
git commit -m "fix(schemata): terminator splice keys on statement position, not code_block"
```

---

### Task 6: Corpus proof and the live gate

Unit tests prove the shape is handled. They are structurally blind to AL that compiles but behaves differently, so the corpus and the live gate are the real evidence.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md` (§8 grammar-skew note)
- Modify: `packages/engine/src/ast/canonicalization.ts`, `packages/engine/src/semantic/callers.ts` — comments only, if they still cite v2.5.0

- [ ] **Step 1: Corpus must be clean AND keep its sites**

```bash
cd /u/Git/LethAL
bun run scripts/probe-grammar-corpus.ts "C:/Users/SShadowS/AppData/Local/Temp/claude/al-corpus" --json /tmp/grammar-after.json 2>&1 | grep -v "^  \.\.\." | tail -20
```

Expected, compared against the recorded v2.5.0 baseline (2,876 files, 99.9% clean, 703,239 statementCalls, 122,758 blocks, 2,152 triggerBlocks, 112,397 procedures, 11,094 exits):

- `hard parse failures: 0`
- `clean files: 100.0%` — better than v2.5.0's 99.9%
- `statementCalls` within a few percent of 703,239 — **a large drop here is the silent regression this whole plan exists to prevent**
- `blocks`, `triggerBlocks`, `procedures`, `exits` all unchanged

- [ ] **Step 2: Update the stale grammar-version comments**

`packages/engine/src/ast/canonicalization.ts:13` and `packages/engine/src/semantic/callers.ts:9` both cite "SShadowS/tree-sitter-al v2.5.0". Update to v3.0.1 where the note is still accurate, and correct it where v3 changed the shape being described.

In `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md` §8, the bullet saying the vendored grammar is behind the repo and that an upgrade "is not required by this design" is now historical — replace it with a note that the upgrade landed in this layer and record the `statement_block` finding, since Tier 2's own predicates will be written against the v3 shape.

- [ ] **Step 3: Run the full live gate (foreground, never poll — minutes each)**

```bash
cd /u/Git/LethAL
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
LETHAL_ITEST_BCDEV=1 bun run itest:lease
LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish
```

Expected: bcdev **3/10/3**, al-runner **3/13/0**, both per-mutant identical to the committed baselines; lease PASS P1-P10 + P9B; stale-publish PASS.

A per-mutant difference is a BLOCK. It would mean the grammar change altered which sites are mutable — the exact thing the frozen baselines exist to catch. Diagnose before proceeding; do not re-freeze the baseline to make it pass.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/ast/canonicalization.ts packages/engine/src/semantic/callers.ts docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md
git commit -m "docs(grammar): record the v3 upgrade and its corpus + live evidence"
```

- [ ] **Step 5: Report the evidence**

State plainly in the final report: corpus clean-rate before and after, every site count before and after, the four live suite results, and the unit count. If any site count moved by more than a few percent, say so and explain why rather than presenting the gate as clean.

---

## Notes for the implementer

- **Task 1 leaves the repo red on purpose.** Tasks 2-5 each turn one named cluster green. If you find yourself fixing a test outside your task's cluster, stop and report — the clusters were measured, and a stray failure means something else moved.
- **The interesting failure mode here is silence.** Every task's real question is "did the site count survive", not "did the tests pass". A grammar that parses perfectly and yields no mutation sites passes every unit test in this repo.
- **Do not re-freeze a baseline to make the gate green.** The baselines are the only instrument that can detect a mutation-coverage change from a parser change.
