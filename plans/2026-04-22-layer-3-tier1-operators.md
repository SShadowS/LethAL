# LethAL Layer 3 Implementation Plan — Tier 1 Generic Operators

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five Tier 1 generic mutation operators (ConditionalBoundary, NegateConditional, VoidMethodCall, ReturnValue, EmptyBlock) as a first-party `@lethal/builtin-tier1` package, and extend `@lethal/schemata`'s `compileSchemataForFile` to compose lift + duplicate artifacts (not only statement-position wrap). After Layer 3, the full pipeline `AL source → parse → operators.generate() → compileSchemataForFile → writeInstrumentedProject` runs end-to-end without hand-constructed `MutationSpec[]`.

**Architecture:** New package `@lethal/builtin-tier1` depends on `@lethal/operator-sdk` (types + builders) and, for AST-walk helpers not in the SDK's narrowed surface, directly on `@lethal/engine`. Each Tier 1 operator lives in its own file with its own `MutationOperator` export. Parent-context classification is uniform: an operator sets `parentContext` per design §3.5 rule 1/2/3, and the schemata compiler expands each spec into wrap / lift / duplicate AL forms against the narrowest enclosing statement (or procedure `var_section` for lift). No new runtime dependencies. All schemata-level text emission continues to flow through the formatting-preserving `printWithRewrites` primitive from Layer 1.

**Tech Stack:** Bun + TypeScript monorepo as-is. No new externals. Tests use existing fixture-driven patterns from Layer 1 / Layer 2.

**Design spec reference:** `U:/Git/LethAL/design.md` §3.5 (wrap-lift-duplicate selection rule), §4 (Tier 1 table + operator interface), §5.1 (history identity key — operators must set `before` to the mutation subtree so `ast_subtree_hash` computes correctly).

**Grammar notes (SShadowS/tree-sitter-al v2.5.0, already reconciled in Layer 1):**

- Four-way binary precedence split: `additive_expression`, `multiplicative_expression`, `comparison_expression`, `logical_expression`. Detect via `isBinaryExpressionKind`.
- Operator token lives in `operator` field **or** a namedChild whose `kind` ends in `_operator` (pattern used in `packages/engine/src/semantic/types.ts` and `canonicalization.ts`).
- `if_statement` fields are `then_branch` and `else_branch`. There is **no** field named `condition`; the condition expression is the first namedChild that is not `then_branch` / `else_branch` / a keyword token.
- `code_block` (not `block`) is the grammar name for `begin…end`.
- No `expression_statement` node exists: a call used as a statement appears as `call_expression` sitting directly inside a `code_block`.
- `call_expression` has a `function` field (identifier or `member_expression`).
- `procedure` has fields `name` and `return_type`; `parameter_list` and `var_section` are namedChildren, not field-named.

---

## File Structure

```
packages/
├── engine/
│   └── src/ast/
│       └── tree-walks.ts                     # NEW — findEnclosingStatement / findEnclosingProcedure / findEnclosingCodeBlock
│       (and export from src/index.ts)
├── operator-sdk/
│   └── src/index.ts                          # MODIFY — re-export new tree-walk helpers
├── schemata/
│   └── src/
│       ├── compile.ts                        # MODIFY — wrap-at-enclosing-statement + lift composition + duplicate composition
│       └── enclosing.ts                      # NEW — shared "resolve site statement" helper used by compile
├── builtin-tier1/                            # NEW PACKAGE
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                          # exports all five operators + the Tier 1 bundle
│   │   ├── conditional-boundary.ts
│   │   ├── negate-conditional.ts
│   │   ├── void-method-call.ts
│   │   ├── return-value.ts
│   │   ├── empty-block.ts
│   │   └── mutate-helpers.ts                 # small helpers: synthesizeAfter(before, text) etc.
│   └── tests/
│       ├── conditional-boundary.test.ts
│       ├── negate-conditional.test.ts
│       ├── void-method-call.test.ts
│       ├── return-value.test.ts
│       ├── empty-block.test.ts
│       ├── end-to-end.test.ts                # all 5 ops -> compile -> write -> read-back
│       └── fixtures/al/
│           ├── conditional-boundary.al
│           ├── negate-conditional.al
│           ├── void-method-call.al
│           ├── return-value.al
│           ├── empty-block.al
│           └── mixed-operators.al
```

**Boundary rationale.** Each operator file is ~40–80 LOC and independently testable; grouping them hurts readability. `mutate-helpers.ts` holds the synthetic-`after`-node shape used by every operator so we don't redefine it in five files. `enclosing.ts` in schemata is pulled out because lift, duplicate, **and** the upgraded wrap path all need to walk up to the narrowest enclosing statement — a single tested helper prevents drift.

---

## Task 1: Package scaffold for `@lethal/builtin-tier1`

**Files:**
- Create: `packages/builtin-tier1/package.json`
- Create: `packages/builtin-tier1/tsconfig.json`
- Modify: `U:/Git/LethAL/tsconfig.json` (add project reference)

- [ ] **Step 1: Create `packages/builtin-tier1/package.json`**

```json
{
  "name": "@lethal/builtin-tier1",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@lethal/engine": "workspace:*",
    "@lethal/operator-sdk": "workspace:*",
    "@lethal/schemata": "workspace:*"
  }
}
```

The schemata dependency is test-only (end-to-end test composes ops + compile); kept in `dependencies` for simplicity since this is a private workspace package.

- [ ] **Step 2: Create `packages/builtin-tier1/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src/**/*", "tests/**/*"],
  "references": [
    { "path": "../engine" },
    { "path": "../operator-sdk" },
    { "path": "../schemata" }
  ]
}
```

- [ ] **Step 3: Add project reference at repo root**

Edit `U:/Git/LethAL/tsconfig.json` to add `{ "path": "./packages/builtin-tier1" }` to the `references` array. Exact current contents:

```bash
cat U:/Git/LethAL/tsconfig.json
```

Expected to currently look like:
```json
{
  "files": [],
  "references": [
    { "path": "./packages/engine" },
    { "path": "./packages/operator-sdk" },
    { "path": "./packages/schemata" }
  ]
}
```

Add the new reference so the array becomes:
```json
{
  "files": [],
  "references": [
    { "path": "./packages/engine" },
    { "path": "./packages/operator-sdk" },
    { "path": "./packages/schemata" },
    { "path": "./packages/builtin-tier1" }
  ]
}
```

- [ ] **Step 4: Install + commit**

```bash
cd U:/Git/LethAL
bun install
git add packages/builtin-tier1/package.json packages/builtin-tier1/tsconfig.json tsconfig.json bun.lock
git commit -m "chore(builtin-tier1): package scaffold linked to engine, SDK, schemata"
```

Expected: commit succeeds, `bun install` reports no errors.

---

## Task 2: Engine AST tree-walk helpers

**Files:**
- Create: `packages/engine/src/ast/tree-walks.ts`
- Create: `packages/engine/tests/ast/tree-walks.test.ts`
- Modify: `packages/engine/src/index.ts` (re-export helpers)
- Modify: `packages/operator-sdk/src/index.ts` (re-export helpers)

The schemata compiler (Task 8) and every Tier 1 operator needs to ascend the AST to find:
- narrowest enclosing statement (for statement-position wrap and short-circuit duplicate)
- narrowest enclosing `code_block` (for lift's conditional-assign placement)
- enclosing `procedure` (for lift's var_section)

Centralize these now so operators and schemata stay consistent on what counts as a "statement".

Statement kinds (per `ALNodeKind`): `if_statement`, `case_statement`, `repeat_statement`, `while_statement`, `for_statement`, `exit_statement`, `error_statement`, `assignment_statement`. Plus three grammar specials:
- A `code_block` that is the body of a procedure, trigger, or branch **is** a statement by grammar position.
- A `call_expression` whose parent is a `code_block` is a statement (the "expression-statement" grammar quirk).
- A `procedure_call` likewise when parented by `code_block`. (Same raw kind `call_expression`; listed for clarity.)

- [ ] **Step 1: Write failing test `packages/engine/tests/ast/tree-walks.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import {
  ALNodeKind,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  findEnclosingStatement,
  findFirst,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "../../src";

describe("tree-walks", () => {
  beforeAll(async () => { await initParser(); });

  it("findEnclosingStatement returns narrowest statement ancestor", () => {
    const src = `codeunit 51100 "T" { procedure P(A: Integer) begin if A > 0 then X := A + 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const additive = findFirst(root, ALNodeKind.additive_expression);
    if (additive === null) throw new Error("no additive_expression");
    const stmt = findEnclosingStatement(additive);
    expect(stmt).not.toBeNull();
    expect(stmt?.kind).toBe(ALNodeKind.assignment_statement);
  });

  it("findEnclosingStatement treats call_expression-inside-code_block as a statement", () => {
    const src = `codeunit 51101 "T" { procedure P() begin DoThing(42); end; }`;
    const root = wrapRoot(parseAL(src));
    let integerNode = null as ReturnType<typeof findFirst>;
    visit(root, (n) => {
      if (integerNode === null && n.kind === ALNodeKind.integer_literal) integerNode = n;
    });
    if (integerNode === null) throw new Error("no integer literal");
    const stmt = findEnclosingStatement(integerNode);
    expect(stmt).not.toBeNull();
    expect(stmt?.kind).toBe(ALNodeKind.procedure_call);
    expect(stmt?.text).toBe("DoThing(42)");
  });

  it("findEnclosingProcedure returns the procedure node", () => {
    const src = `codeunit 51102 "T" { procedure P(A: Integer): Integer begin exit(A + 1); end; }`;
    const root = wrapRoot(parseAL(src));
    const additive = findFirst(root, ALNodeKind.additive_expression);
    if (additive === null) throw new Error("no additive_expression");
    const proc = findEnclosingProcedure(additive);
    expect(proc?.kind).toBe(ALNodeKind.procedure);
    expect(proc?.childForFieldName("name")?.text).toBe("P");
  });

  it("findEnclosingCodeBlock returns narrowest code_block ancestor", () => {
    const src = `codeunit 51103 "T" { procedure P(A: Integer) begin if A > 0 then begin X := 1; end; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const block = findEnclosingCodeBlock(assign);
    expect(block?.kind).toBe(ALNodeKind.block);
    // The narrowest code_block is the then-branch's block, not the procedure body.
    expect(block?.text.trim().startsWith("begin")).toBe(true);
    // The then-branch block's text should NOT contain the outer `if` condition.
    expect(block?.text).not.toContain("A > 0");
  });

  it("returns null when no ancestor matches", () => {
    const src = `codeunit 51104 "T" { procedure P() begin end; }`;
    const root = wrapRoot(parseAL(src));
    expect(findEnclosingProcedure(root)).toBeNull();
    expect(findEnclosingStatement(root)).toBeNull();
    expect(findEnclosingCodeBlock(root)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd U:/Git/LethAL
bun test packages/engine/tests/ast/tree-walks.test.ts
```

Expected: compile/import error — `findEnclosingStatement` etc. do not exist in `@lethal/engine` yet.

- [ ] **Step 3: Implement `packages/engine/src/ast/tree-walks.ts`**

```typescript
import { ALNodeKind } from "./node-kinds";
import type { ALSyntaxNode } from "./syntax-node";

const STATEMENT_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.if_statement,
  ALNodeKind.case_statement,
  ALNodeKind.repeat_statement,
  ALNodeKind.while_statement,
  ALNodeKind.for_statement,
  ALNodeKind.exit_statement,
  ALNodeKind.error_statement,
  ALNodeKind.assignment_statement,
]);

/**
 * Narrowest ancestor that the grammar treats as a statement.
 *
 * Includes the statement kinds plus two positional cases:
 *   - a `code_block` whose parent is a procedure, trigger, or branch
 *   - a `call_expression` whose parent is a `code_block` (expression-statement quirk)
 *
 * Returns `null` if the node has no statement ancestor (e.g., the root node).
 * The node itself is considered a candidate — calling with an `if_statement`
 * returns that same node.
 */
export function findEnclosingStatement(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (STATEMENT_KINDS.has(current.kind)) return current;
    if (
      current.kind === ALNodeKind.procedure_call &&
      current.parent !== null &&
      current.parent.kind === ALNodeKind.block
    ) {
      return current;
    }
    if (
      current.kind === ALNodeKind.block &&
      current.parent !== null &&
      (current.parent.kind === ALNodeKind.procedure ||
        current.parent.kind === ALNodeKind.trigger ||
        current.parent.kind === ALNodeKind.if_statement ||
        current.parent.kind === ALNodeKind.while_statement ||
        current.parent.kind === ALNodeKind.for_statement ||
        current.parent.kind === ALNodeKind.repeat_statement ||
        current.parent.kind === ALNodeKind.case_statement)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** Narrowest `procedure` ancestor, or `null` if the node is outside any procedure. */
export function findEnclosingProcedure(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.procedure) return current;
    current = current.parent;
  }
  return null;
}

/** Narrowest `code_block` ancestor (strictly upward — excludes `node` itself). */
export function findEnclosingCodeBlock(node: ALSyntaxNode): ALSyntaxNode | null {
  let current: ALSyntaxNode | null = node.parent;
  while (current !== null) {
    if (current.kind === ALNodeKind.block) return current;
    current = current.parent;
  }
  return null;
}
```

- [ ] **Step 4: Add exports to `packages/engine/src/index.ts`**

Append to the `// AST` section:

```typescript
export {
  findEnclosingStatement,
  findEnclosingProcedure,
  findEnclosingCodeBlock,
} from "./ast/tree-walks";
```

- [ ] **Step 5: Add SDK re-exports in `packages/operator-sdk/src/index.ts`**

Extend the existing `export { ... } from "@lethal/engine";` line so it becomes:

```typescript
export {
  astSubtreeHash,
  visit,
  findEnclosingStatement,
  findEnclosingProcedure,
  findEnclosingCodeBlock,
} from "@lethal/engine";
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd U:/Git/LethAL
bun test packages/engine/tests/ast/tree-walks.test.ts
```

Expected: 5 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/ast/tree-walks.ts \
        packages/engine/src/index.ts \
        packages/engine/tests/ast/tree-walks.test.ts \
        packages/operator-sdk/src/index.ts
git commit -m "feat(engine): tree-walk helpers findEnclosingStatement/Procedure/CodeBlock"
```

---

## Task 3: `mutate-helpers.ts` — shared synthetic-after builder

**Files:**
- Create: `packages/builtin-tier1/src/mutate-helpers.ts`
- Create: `packages/builtin-tier1/tests/mutate-helpers.test.ts`

Every operator emits `after` with mutated text spanning the same byte range as `before`. Centralize the shape so the five operator files don't each invent one.

- [ ] **Step 1: Write failing test `packages/builtin-tier1/tests/mutate-helpers.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { synthesizeAfter } from "../src/mutate-helpers";

describe("synthesizeAfter", () => {
  beforeAll(async () => { await initParser(); });

  it("copies before's span + kind but replaces text", () => {
    const src = `codeunit 51200 "S" { procedure P(A: Integer; B: Integer) begin if A > B then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    if (cmp === null) throw new Error("no comparison_expression");
    const after = synthesizeAfter(cmp, "A >= B");
    expect(after.text).toBe("A >= B");
    expect(after.kind).toBe(cmp.kind);
    expect(after.startIndex).toBe(cmp.startIndex);
    expect(after.endIndex).toBe(cmp.endIndex);
    expect(after.parent).toBe(cmp.parent);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/builtin-tier1/tests/mutate-helpers.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement `packages/builtin-tier1/src/mutate-helpers.ts`**

```typescript
import type { ALSyntaxNode } from "@lethal/operator-sdk";

/**
 * Produce a synthetic "after" node that reuses every structural field of
 * `before` but swaps `text`. The schemata compiler only reads `.text` from
 * `after`, so the rest of the shape exists to keep TypeScript + downstream
 * consumers from choking on a partial object.
 *
 * Intentionally a thin adapter — operators that need richer synthesis should
 * go through `build.*` in the SDK and wrap the result here.
 */
export function synthesizeAfter(
  before: ALSyntaxNode,
  text: string,
): ALSyntaxNode {
  return {
    kind: before.kind,
    rawKind: before.rawKind,
    text,
    startIndex: before.startIndex,
    endIndex: before.endIndex,
    startPosition: before.startPosition,
    endPosition: before.endPosition,
    parent: before.parent,
    children: before.children,
    namedChildren: before.namedChildren,
    fieldName: before.fieldName,
    childForFieldName: before.childForFieldName.bind(before),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/builtin-tier1/tests/mutate-helpers.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/builtin-tier1/src/mutate-helpers.ts \
        packages/builtin-tier1/tests/mutate-helpers.test.ts
git commit -m "feat(builtin-tier1): synthesizeAfter helper for operator mutation specs"
```

---

## Task 4: ConditionalBoundary operator

**Files:**
- Create: `packages/builtin-tier1/src/conditional-boundary.ts`
- Create: `packages/builtin-tier1/tests/conditional-boundary.test.ts`
- Create: `packages/builtin-tier1/tests/fixtures/al/conditional-boundary.al`

Mutation rule: swap relational operators in `comparison_expression` nodes. `>` ↔ `>=`, `<` ↔ `<=`. Each site produces exactly one spec — the boundary flip. `parentContext` is `statement-position` since the enclosing statement (if / while / repeat / assign) is always grammatical for wrap.

- [ ] **Step 1: Create fixture `packages/builtin-tier1/tests/fixtures/al/conditional-boundary.al`**

```al
codeunit 51300 "Conditional Boundary Target"
{
    procedure Classify(n: Integer): Integer
    begin
        if n > 0 then
            exit(1);
        if n < 0 then
            exit(-1);
        if n >= 100 then
            exit(2);
        exit(0);
    end;
}
```

- [ ] **Step 2: Write failing test `packages/builtin-tier1/tests/conditional-boundary.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { conditionalBoundary } from "../src/conditional-boundary";

describe("conditionalBoundary", () => {
  beforeAll(async () => { await initParser(); });

  it("has correct manifest", () => {
    expect(conditionalBoundary.name).toBe("lethal.conditional-boundary");
    expect(conditionalBoundary.tier).toBe(1);
    expect(conditionalBoundary.targetNodeKinds).toEqual([ALNodeKind.comparison_expression]);
    expect(conditionalBoundary.producesNodeKinds).toEqual([ALNodeKind.comparison_expression]);
  });

  it("generates one spec per >, <, >=, <= site", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/conditional-boundary.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.comparison_expression)
      .filter((n) => conditionalBoundary.targets(n, ctx))
      .flatMap((n) => conditionalBoundary.generate(n, ctx));

    // fixture has three comparison sites: > 0, < 0, >= 100
    expect(specs).toHaveLength(3);
    const beforeTexts = specs.map((s) => s.before.text).sort();
    expect(beforeTexts).toEqual(["n < 0", "n > 0", "n >= 100"]);

    const mapping = new Map(specs.map((s) => [s.before.text, s.after.text]));
    expect(mapping.get("n > 0")).toBe("n >= 0");
    expect(mapping.get("n < 0")).toBe("n <= 0");
    expect(mapping.get("n >= 100")).toBe("n > 100");

    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.operatorName).toBe("lethal.conditional-boundary");
    }
  });

  it("skips = and <> (NegateConditional's domain)", () => {
    const src = `codeunit 51301 "X" { procedure P(A: Integer) begin if A = 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "x.al", root }]);
    const specs = findAll(root, ALNodeKind.comparison_expression)
      .filter((n) => conditionalBoundary.targets(n, ctx))
      .flatMap((n) => conditionalBoundary.generate(n, ctx));
    expect(specs).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/builtin-tier1/tests/conditional-boundary.test.ts
```

Expected: module-not-found.

- [ ] **Step 4: Implement `packages/builtin-tier1/src/conditional-boundary.ts`**

```typescript
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const BOUNDARY_FLIP: ReadonlyMap<string, string> = new Map([
  [">", ">="],
  [">=", ">"],
  ["<", "<="],
  ["<=", "<"],
]);

export const conditionalBoundary: MutationOperator = {
  name: "lethal.conditional-boundary",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.comparison_expression],
  producesNodeKinds: [ALNodeKind.comparison_expression],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.comparison_expression) return false;
    const op = findOperator(node);
    return op !== null && BOUNDARY_FLIP.has(op);
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const op = findOperator(node);
    if (op === null) return [];
    const flipped = BOUNDARY_FLIP.get(op);
    if (flipped === undefined) return [];
    const mutatedText = replaceOperatorToken(node, op, flipped);
    if (mutatedText === null) return [];
    return [
      {
        operatorName: "lethal.conditional-boundary",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "flips > to >=",
      sourceAL: `codeunit 51302 "C" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A > 0",
          afterText: "A >= 0",
        },
      ],
    },
    {
      name: "flips <= to <",
      sourceAL: `codeunit 51303 "C" { procedure P(A: Integer) begin if A <= 5 then exit(1); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A <= 5",
          afterText: "A < 5",
        },
      ],
    },
  ],
};

function findOperator(node: ALSyntaxNode): string | null {
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

/**
 * Build the mutated comparison text by replacing only the operator token's
 * slice of `node.text`. Avoids re-rendering operands (preserves whitespace,
 * comments within operands, and any other formatting).
 */
function replaceOperatorToken(
  node: ALSyntaxNode,
  oldOp: string,
  newOp: string,
): string | null {
  const opNode =
    node.childForFieldName("operator") ??
    node.namedChildren.find((c) => c.kind.endsWith("_operator")) ??
    null;
  if (opNode === null) return null;
  const opStart = opNode.startIndex - node.startIndex;
  const opEnd = opNode.endIndex - node.startIndex;
  const nodeText = node.text;
  const before = nodeText.slice(0, opStart);
  const after = nodeText.slice(opEnd);
  // Sanity check: the slice we're replacing must match the reported token.
  if (nodeText.slice(opStart, opEnd) !== oldOp) return null;
  return `${before}${newOp}${after}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/builtin-tier1/tests/conditional-boundary.test.ts
```

Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier1/src/conditional-boundary.ts \
        packages/builtin-tier1/tests/conditional-boundary.test.ts \
        packages/builtin-tier1/tests/fixtures/al/conditional-boundary.al
git commit -m "feat(builtin-tier1): ConditionalBoundary operator (>/>=, </<=)"
```

---

## Task 5: NegateConditional operator

**Files:**
- Create: `packages/builtin-tier1/src/negate-conditional.ts`
- Create: `packages/builtin-tier1/tests/negate-conditional.test.ts`
- Create: `packages/builtin-tier1/tests/fixtures/al/negate-conditional.al`

Mutation rules:
- `comparison_expression` with `=` ↔ `<>` → `parentContext: "statement-position"`
- `logical_expression` with `and` ↔ `or` → `parentContext: "short-circuit-operand"` (design §3.5 rule 3; short-circuit semantics would be lost by lift)

Single operator file covers both because they share the operator-flip mechanism; they differ only in which expression kind and which `parentContext` they target.

- [ ] **Step 1: Create fixture `packages/builtin-tier1/tests/fixtures/al/negate-conditional.al`**

```al
codeunit 51400 "Negate Conditional Target"
{
    procedure Check(A: Integer; B: Boolean; C: Boolean): Boolean
    begin
        if A = 0 then
            exit(false);
        if A <> 5 then
            exit(false);
        if B and C then
            exit(true);
        if B or C then
            exit(true);
        exit(false);
    end;
}
```

- [ ] **Step 2: Write failing test `packages/builtin-tier1/tests/negate-conditional.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { negateConditional } from "../src/negate-conditional";

describe("negateConditional", () => {
  beforeAll(async () => { await initParser(); });

  it("generates specs for =/<> as statement-position, and/or as short-circuit-operand", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/negate-conditional.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const candidates = [
      ...findAll(root, ALNodeKind.comparison_expression),
      ...findAll(root, ALNodeKind.logical_expression),
    ];
    const specs = candidates
      .filter((n) => negateConditional.targets(n, ctx))
      .flatMap((n) => negateConditional.generate(n, ctx));

    expect(specs).toHaveLength(4);

    const byBefore = new Map(specs.map((s) => [s.before.text, s]));
    expect(byBefore.get("A = 0")?.after.text).toBe("A <> 0");
    expect(byBefore.get("A = 0")?.parentContext).toBe("statement-position");
    expect(byBefore.get("A <> 5")?.after.text).toBe("A = 5");
    expect(byBefore.get("A <> 5")?.parentContext).toBe("statement-position");
    expect(byBefore.get("B and C")?.after.text).toBe("B or C");
    expect(byBefore.get("B and C")?.parentContext).toBe("short-circuit-operand");
    expect(byBefore.get("B or C")?.after.text).toBe("B and C");
    expect(byBefore.get("B or C")?.parentContext).toBe("short-circuit-operand");
  });

  it("skips non-target operators in comparison_expression", () => {
    const src = `codeunit 51401 "X" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "x.al", root }]);
    const specs: unknown[] = [];
    visit(root, (n) => {
      if (negateConditional.targets(n, ctx)) specs.push(...negateConditional.generate(n, ctx));
    });
    expect(specs).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/builtin-tier1/tests/negate-conditional.test.ts
```

Expected: module-not-found.

- [ ] **Step 4: Implement `packages/builtin-tier1/src/negate-conditional.ts`**

```typescript
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type ParentContextHint,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const COMPARISON_FLIP: ReadonlyMap<string, string> = new Map([
  ["=", "<>"],
  ["<>", "="],
]);

const LOGICAL_FLIP: ReadonlyMap<string, string> = new Map([
  ["and", "or"],
  ["or", "and"],
]);

export const negateConditional: MutationOperator = {
  name: "lethal.negate-conditional",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [
    ALNodeKind.comparison_expression,
    ALNodeKind.logical_expression,
  ],
  producesNodeKinds: [
    ALNodeKind.comparison_expression,
    ALNodeKind.logical_expression,
  ],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    const op = findOperator(node);
    if (op === null) return false;
    if (node.kind === ALNodeKind.comparison_expression) return COMPARISON_FLIP.has(op);
    if (node.kind === ALNodeKind.logical_expression) return LOGICAL_FLIP.has(op);
    return false;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const op = findOperator(node);
    if (op === null) return [];

    let flipped: string | undefined;
    let parentContext: ParentContextHint;
    if (node.kind === ALNodeKind.comparison_expression) {
      flipped = COMPARISON_FLIP.get(op);
      parentContext = "statement-position";
    } else if (node.kind === ALNodeKind.logical_expression) {
      flipped = LOGICAL_FLIP.get(op);
      parentContext = "short-circuit-operand";
    } else {
      return [];
    }
    if (flipped === undefined) return [];

    const mutatedText = replaceOperatorToken(node, op, flipped);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.negate-conditional",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext,
      },
    ];
  },

  conformanceTests: [
    {
      name: "flips = to <>",
      sourceAL: `codeunit 51402 "C" { procedure P(A: Integer): Boolean begin exit(A = 0); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "A = 0",
          afterText: "A <> 0",
        },
      ],
    },
    {
      name: "flips and to or as short-circuit-operand",
      sourceAL: `codeunit 51403 "C" { procedure P(A: Boolean; B: Boolean) begin if A and B then exit; end; }`,
      expectedSpecs: [
        {
          parentContext: "short-circuit-operand",
          beforeText: "A and B",
          afterText: "A or B",
        },
      ],
    },
  ],
};

function findOperator(node: ALSyntaxNode): string | null {
  const field = node.childForFieldName("operator");
  if (field !== null) return field.text;
  for (const c of node.namedChildren) {
    if (c.kind.endsWith("_operator")) return c.text;
  }
  return null;
}

function replaceOperatorToken(
  node: ALSyntaxNode,
  oldOp: string,
  newOp: string,
): string | null {
  const opNode =
    node.childForFieldName("operator") ??
    node.namedChildren.find((c) => c.kind.endsWith("_operator")) ??
    null;
  if (opNode === null) return null;
  const opStart = opNode.startIndex - node.startIndex;
  const opEnd = opNode.endIndex - node.startIndex;
  const nodeText = node.text;
  if (nodeText.slice(opStart, opEnd) !== oldOp) return null;
  return `${nodeText.slice(0, opStart)}${newOp}${nodeText.slice(opEnd)}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/builtin-tier1/tests/negate-conditional.test.ts
```

Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier1/src/negate-conditional.ts \
        packages/builtin-tier1/tests/negate-conditional.test.ts \
        packages/builtin-tier1/tests/fixtures/al/negate-conditional.al
git commit -m "feat(builtin-tier1): NegateConditional operator (=/<> stmt, and/or short-circuit)"
```

---

## Task 6: VoidMethodCall operator

**Files:**
- Create: `packages/builtin-tier1/src/void-method-call.ts`
- Create: `packages/builtin-tier1/tests/void-method-call.test.ts`
- Create: `packages/builtin-tier1/tests/fixtures/al/void-method-call.al`

Mutation rule: for `call_expression` nodes that are statements (parent is `code_block`), emit a deletion spec — `after.text = ""`. Compile's wrap path (Task 8) turns this into `if not MutationSelector.Active('M...') then <call>`, which effectively deletes the call when the mutant is active. Scope restriction: only calls whose return value is unused (i.e., used as a statement). `parentContext: "statement-position"`.

- [ ] **Step 1: Create fixture `packages/builtin-tier1/tests/fixtures/al/void-method-call.al`**

```al
codeunit 51500 "Void Method Call Target"
{
    procedure Run(A: Integer): Integer
    var
        B: Integer;
    begin
        DoThing(A);
        Log('start');
        B := Compute(A);
        exit(B);
    end;
}
```

Expectation: `DoThing(A)` and `Log('start')` produce specs. `Compute(A)` is RHS of an assignment (not a statement-level call) and is skipped. `exit(B)` is an `exit_statement`, not `call_expression`.

- [ ] **Step 2: Write failing test `packages/builtin-tier1/tests/void-method-call.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { voidMethodCall } from "../src/void-method-call";

describe("voidMethodCall", () => {
  beforeAll(async () => { await initParser(); });

  it("generates deletion specs only for statement-position calls", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/void-method-call.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.procedure_call)
      .filter((n) => voidMethodCall.targets(n, ctx))
      .flatMap((n) => voidMethodCall.generate(n, ctx));

    const beforeTexts = specs.map((s) => s.before.text).sort();
    expect(beforeTexts).toEqual(["DoThing(A)", "Log('start')"]);
    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.after.text).toBe("");
      expect(s.operatorName).toBe("lethal.void-method-call");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/builtin-tier1/tests/void-method-call.test.ts
```

Expected: module-not-found.

- [ ] **Step 4: Implement `packages/builtin-tier1/src/void-method-call.ts`**

```typescript
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

export const voidMethodCall: MutationOperator = {
  name: "lethal.void-method-call",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.procedure_call],
  producesNodeKinds: [ALNodeKind.procedure_call],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.procedure_call) return false;
    // Only statement-position calls (direct child of a code_block).
    return node.parent !== null && node.parent.kind === ALNodeKind.block;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    return [
      {
        operatorName: "lethal.void-method-call",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, ""),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "deletes a statement-position call",
      sourceAL: `codeunit 51501 "V" { procedure P() begin DoThing(); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "DoThing()",
          afterText: "",
        },
      ],
    },
  ],
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/builtin-tier1/tests/void-method-call.test.ts
```

Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier1/src/void-method-call.ts \
        packages/builtin-tier1/tests/void-method-call.test.ts \
        packages/builtin-tier1/tests/fixtures/al/void-method-call.al
git commit -m "feat(builtin-tier1): VoidMethodCall operator (statement-position call deletion)"
```

---

## Task 7: ReturnValue operator

**Files:**
- Create: `packages/builtin-tier1/src/return-value.ts`
- Create: `packages/builtin-tier1/tests/return-value.test.ts`
- Create: `packages/builtin-tier1/tests/fixtures/al/return-value.al`

Mutation rule: for `exit_statement` nodes carrying an expression, replace the returned value:
- Enclosing procedure returns `Boolean` → wrap as `exit(not <orig>)` (flip).
- Enclosing procedure returns `Integer` / `Decimal` / `BigInteger` → `exit(0)`.
- Other return types → skip (conservative).

Targets the whole `exit_statement` with `parentContext: "statement-position"` so the compiler wraps the entire statement.

The operator uses `SemanticContext.symbols` to find the enclosing procedure's `returnType`.

- [ ] **Step 1: Create fixture `packages/builtin-tier1/tests/fixtures/al/return-value.al`**

```al
codeunit 51600 "Return Value Target"
{
    procedure CountPositive(n: Integer): Integer
    begin
        if n > 0 then
            exit(n);
        exit(0);
    end;

    procedure IsPositive(n: Integer): Boolean
    begin
        exit(n > 0);
    end;

    procedure LogOnly(n: Integer)
    begin
        exit;
    end;
}
```

Expectation: three exit statements with expressions — `exit(n)`, `exit(0)`, `exit(n > 0)` — produce specs. The bare `exit;` (no expression) is skipped.

- [ ] **Step 2: Write failing test `packages/builtin-tier1/tests/return-value.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { returnValue } from "../src/return-value";

describe("returnValue", () => {
  beforeAll(async () => { await initParser(); });

  it("zeros numeric returns and negates boolean returns; skips bare exit", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/return-value.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.exit_statement)
      .filter((n) => returnValue.targets(n, ctx))
      .flatMap((n) => returnValue.generate(n, ctx));

    const mapping = new Map(specs.map((s) => [s.before.text.trim(), s.after.text.trim()]));
    // CountPositive -> Integer: exit(n) -> exit(0); exit(0) is not mutated (already 0)
    expect(mapping.get("exit(n)")).toBe("exit(0)");
    expect(mapping.has("exit(0)")).toBe(false);
    // IsPositive -> Boolean: exit(n > 0) -> exit(not (n > 0))
    expect(mapping.get("exit(n > 0)")).toBe("exit(not (n > 0))");
    // LogOnly: `exit;` has no expression -> skipped
    expect([...mapping.keys()]).not.toContain("exit");

    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.operatorName).toBe("lethal.return-value");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/builtin-tier1/tests/return-value.test.ts
```

Expected: module-not-found.

- [ ] **Step 4: Implement `packages/builtin-tier1/src/return-value.ts`**

```typescript
import {
  ALNodeKind,
  findEnclosingProcedure,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const NUMERIC_RETURN_TYPES = new Set(["Integer", "Decimal", "BigInteger"]);

export const returnValue: MutationOperator = {
  name: "lethal.return-value",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.exit_statement],
  producesNodeKinds: [ALNodeKind.exit_statement],
  requiresSemantic: ["symbol-table"],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.exit_statement) return false;
    const arg = exitArgument(node);
    if (arg === null) return false;
    const rt = resolveReturnType(node);
    if (rt === null) return false;
    if (rt === "Boolean") return true;
    if (NUMERIC_RETURN_TYPES.has(rt)) {
      // skip exit(0) / exit(0.0) — already the target of the numeric mutation
      const trimmed = arg.text.trim();
      return trimmed !== "0" && trimmed !== "0.0";
    }
    return false;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    const arg = exitArgument(node);
    if (arg === null) return [];
    const rt = resolveReturnType(node);
    if (rt === null) return [];

    let mutatedArg: string;
    if (rt === "Boolean") {
      mutatedArg = `not (${arg.text.trim()})`;
    } else if (rt === "Decimal") {
      mutatedArg = "0.0";
    } else if (NUMERIC_RETURN_TYPES.has(rt)) {
      mutatedArg = "0";
    } else {
      return [];
    }

    const mutatedText = replaceArgInExit(node, arg, mutatedArg);
    if (mutatedText === null) return [];

    return [
      {
        operatorName: "lethal.return-value",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, mutatedText),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "zeros an Integer return",
      sourceAL: `codeunit 51601 "R" { procedure P(): Integer begin exit(42); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "exit(42)",
          afterText: "exit(0)",
        },
      ],
    },
    {
      name: "negates a Boolean return",
      sourceAL: `codeunit 51602 "R" { procedure P(): Boolean begin exit(true); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "exit(true)",
          afterText: "exit(not (true))",
        },
      ],
    },
  ],
};

/**
 * Returns the argument expression of `exit(<expr>)`, or null if the exit has
 * no expression (`exit;`).
 *
 * Grammar shape: the exit_statement has the keyword `exit`, optionally
 * followed by `(`, an expression (the first non-keyword namedChild),
 * and `)`. We pick the first namedChild that isn't a keyword or punctuation.
 */
function exitArgument(node: ALSyntaxNode): ALSyntaxNode | null {
  for (const c of node.namedChildren) {
    if (c.kind === "exit" || c.rawKind === "exit") continue;
    return c;
  }
  return null;
}

function resolveReturnType(exitNode: ALSyntaxNode): string | null {
  const proc = findEnclosingProcedure(exitNode);
  if (proc === null) return null;
  const rtNode = proc.childForFieldName("return_type");
  if (rtNode === null) return null;
  // return_type text may be ": Integer" or "Integer" depending on grammar
  // production — strip colon + whitespace.
  const raw = rtNode.text.replace(/^\s*:\s*/, "").trim();
  const first = raw.split(/\s+/)[0] ?? raw;
  return first;
}

function replaceArgInExit(
  exitNode: ALSyntaxNode,
  arg: ALSyntaxNode,
  mutated: string,
): string | null {
  const argStart = arg.startIndex - exitNode.startIndex;
  const argEnd = arg.endIndex - exitNode.startIndex;
  const text = exitNode.text;
  if (argStart < 0 || argEnd > text.length) return null;
  return `${text.slice(0, argStart)}${mutated}${text.slice(argEnd)}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/builtin-tier1/tests/return-value.test.ts
```

Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier1/src/return-value.ts \
        packages/builtin-tier1/tests/return-value.test.ts \
        packages/builtin-tier1/tests/fixtures/al/return-value.al
git commit -m "feat(builtin-tier1): ReturnValue operator (zero numeric, negate boolean)"
```

---

## Task 8: EmptyBlock operator

**Files:**
- Create: `packages/builtin-tier1/src/empty-block.ts`
- Create: `packages/builtin-tier1/tests/empty-block.test.ts`
- Create: `packages/builtin-tier1/tests/fixtures/al/empty-block.al`

Mutation rule: for `code_block` nodes that form a procedure body or a branch body (and have at least one non-trivial child statement), emit a spec that replaces the whole block with `begin end`. `parentContext: "statement-position"`.

Exclusion: empty blocks (already `begin end`) produce no specs — the mutation would be semantically identical.

- [ ] **Step 1: Create fixture `packages/builtin-tier1/tests/fixtures/al/empty-block.al`**

```al
codeunit 51700 "Empty Block Target"
{
    procedure Work(A: Integer): Integer
    begin
        if A > 0 then begin
            Log('positive');
            exit(A);
        end;
        exit(0);
    end;

    procedure AlreadyEmpty()
    begin
    end;
}
```

Expectation: `Work`'s outer body AND the `if` then-branch block produce specs (2 total). The outer `AlreadyEmpty` body produces no spec (already empty).

- [ ] **Step 2: Write failing test `packages/builtin-tier1/tests/empty-block.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { emptyBlock } from "../src/empty-block";

describe("emptyBlock", () => {
  beforeAll(async () => { await initParser(); });

  it("generates one spec per non-empty block; skips already-empty blocks", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/empty-block.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.block)
      .filter((n) => emptyBlock.targets(n, ctx))
      .flatMap((n) => emptyBlock.generate(n, ctx));

    expect(specs.length).toBe(2);
    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.after.text).toBe("begin end");
      expect(s.operatorName).toBe("lethal.empty-block");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/builtin-tier1/tests/empty-block.test.ts
```

Expected: module-not-found.

- [ ] **Step 4: Implement `packages/builtin-tier1/src/empty-block.ts`**

```typescript
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
} from "@lethal/operator-sdk";
import { synthesizeAfter } from "./mutate-helpers";

const BODY_PARENT_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.procedure,
  ALNodeKind.trigger,
  ALNodeKind.if_statement,
  ALNodeKind.while_statement,
  ALNodeKind.for_statement,
  ALNodeKind.repeat_statement,
  ALNodeKind.case_statement,
]);

export const emptyBlock: MutationOperator = {
  name: "lethal.empty-block",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.block],
  producesNodeKinds: [ALNodeKind.block],
  requiresSemantic: [],

  targets(node: ALSyntaxNode, _ctx: SemanticContext): boolean {
    if (node.kind !== ALNodeKind.block) return false;
    if (node.parent === null) return false;
    if (!BODY_PARENT_KINDS.has(node.parent.kind)) return false;
    // Skip already-empty blocks. Cheapest signal: whether the block has any
    // namedChildren that aren't `begin` / `end` keywords.
    const hasContent = node.namedChildren.some(
      (c) => c.rawKind !== "begin" && c.rawKind !== "end",
    );
    return hasContent;
  },

  generate(node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] {
    return [
      {
        operatorName: "lethal.empty-block",
        operatorVersion: "1.0.0",
        astNodeId: `${node.startIndex}-${node.endIndex}`,
        before: node,
        after: synthesizeAfter(node, "begin end"),
        parentContext: "statement-position",
      },
    ];
  },

  conformanceTests: [
    {
      name: "empties a procedure body",
      sourceAL: `codeunit 51701 "E" { procedure P() begin DoThing(); end; }`,
      expectedSpecs: [
        {
          parentContext: "statement-position",
          beforeText: "begin\n        DoThing();\n    end",
          afterText: "begin end",
        },
      ],
    },
  ],
};
```

Note: the `beforeText` in the conformance case is intentionally tight to the fixture's formatting so that the test catches grammar-node-span regressions. Adjust only if a subsequent formatter change legitimately shifts whitespace.

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/builtin-tier1/tests/empty-block.test.ts
```

Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier1/src/empty-block.ts \
        packages/builtin-tier1/tests/empty-block.test.ts \
        packages/builtin-tier1/tests/fixtures/al/empty-block.al
git commit -m "feat(builtin-tier1): EmptyBlock operator (replace body with begin end)"
```

---

## Task 9: Package public exports

**Files:**
- Create: `packages/builtin-tier1/src/index.ts`

- [ ] **Step 1: Write `packages/builtin-tier1/src/index.ts`**

```typescript
import type { MutationOperator } from "@lethal/operator-sdk";
import { conditionalBoundary } from "./conditional-boundary";
import { emptyBlock } from "./empty-block";
import { negateConditional } from "./negate-conditional";
import { returnValue } from "./return-value";
import { voidMethodCall } from "./void-method-call";

export { conditionalBoundary } from "./conditional-boundary";
export { emptyBlock } from "./empty-block";
export { negateConditional } from "./negate-conditional";
export { returnValue } from "./return-value";
export { voidMethodCall } from "./void-method-call";
export { synthesizeAfter } from "./mutate-helpers";

/** Convenience bundle for registering all Tier 1 operators at once. */
export const tier1Operators: readonly MutationOperator[] = [
  conditionalBoundary,
  negateConditional,
  voidMethodCall,
  returnValue,
  emptyBlock,
];
```

- [ ] **Step 2: Typecheck + run package tests**

```bash
cd U:/Git/LethAL
bun run typecheck
bun test packages/builtin-tier1/
```

Expected: typecheck passes; builtin-tier1 suite green.

- [ ] **Step 3: Commit**

```bash
git add packages/builtin-tier1/src/index.ts
git commit -m "feat(builtin-tier1): public API exports + tier1Operators bundle"
```

---

## Task 10: Schemata — shared "resolve site statement" helper

**Files:**
- Create: `packages/schemata/src/enclosing.ts`
- Create: `packages/schemata/tests/enclosing.test.ts`

Before upgrading `compile.ts`, extract the "find the enclosing statement + compute spliced-mutated text" logic into its own file. Compile (Task 11), lift (Task 12), and duplicate (Task 13) all call into it, and having one tested implementation prevents divergence.

- [ ] **Step 1: Write failing test `packages/schemata/tests/enclosing.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import {
  ALNodeKind,
  findFirst,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { resolveSite } from "../src/enclosing";

describe("resolveSite", () => {
  beforeAll(async () => { await initParser(); });

  it("when before is itself a statement, site equals before", () => {
    const src = `codeunit 51800 "E" { procedure P() begin X := 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const site = resolveSite(assign, "X := 2");
    expect(site.statement).toBe(assign);
    expect(site.mutatedText).toBe("X := 2");
  });

  it("when before is a sub-expression, site is enclosing stmt with spliced text", () => {
    const src = `codeunit 51801 "E" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    if (cmp === null) throw new Error("no comparison");
    const site = resolveSite(cmp, "A >= 0");
    expect(site.statement.kind).toBe(ALNodeKind.if_statement);
    expect(site.mutatedText).toContain("if A >= 0 then");
    expect(site.mutatedText).toContain("exit(1)");
    // original operator must not leak into mutated text
    expect(site.mutatedText).not.toContain("A > 0");
  });

  it("throws if node has no enclosing statement", () => {
    const src = `codeunit 51802 "E" { procedure P() begin end; }`;
    const root = wrapRoot(parseAL(src));
    expect(() => resolveSite(root, "x")).toThrow(/no enclosing statement/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/schemata/tests/enclosing.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement `packages/schemata/src/enclosing.ts`**

```typescript
import type { ALSyntaxNode } from "@lethal/engine";
import { findEnclosingStatement } from "@lethal/engine";

export interface ResolvedSite {
  /** The statement we emit the wrap/duplicate form against. */
  readonly statement: ALSyntaxNode;
  /** `statement.text` with `before`'s span replaced by `afterText`. */
  readonly mutatedText: string;
}

/**
 * Resolve the "site statement" for a spec's `before` node and compute the
 * mutated text of that statement.
 *
 * - If `before` is itself a statement, the site IS the before node and
 *   `mutatedText === afterText`.
 * - Otherwise walk up to the narrowest enclosing statement and splice
 *   `afterText` into `statement.text` at `before`'s byte range.
 *
 * Throws if `before` has no enclosing statement (malformed input — no
 * legitimate operator should ever emit a spec for a node outside a procedure).
 */
export function resolveSite(
  before: ALSyntaxNode,
  afterText: string,
): ResolvedSite {
  const statement = findEnclosingStatement(before);
  if (statement === null) {
    throw new Error(
      `resolveSite: no enclosing statement for node at ${before.startIndex}..${before.endIndex}`,
    );
  }
  if (statement === before) {
    return { statement, mutatedText: afterText };
  }
  const relStart = before.startIndex - statement.startIndex;
  const relEnd = before.endIndex - statement.startIndex;
  const stmtText = statement.text;
  if (relStart < 0 || relEnd > stmtText.length) {
    throw new Error(
      `resolveSite: before span ${before.startIndex}..${before.endIndex} is not contained in statement ${statement.startIndex}..${statement.endIndex}`,
    );
  }
  const mutatedText =
    stmtText.slice(0, relStart) + afterText + stmtText.slice(relEnd);
  return { statement, mutatedText };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/schemata/tests/enclosing.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/enclosing.ts packages/schemata/tests/enclosing.test.ts
git commit -m "feat(schemata): resolveSite helper for enclosing-statement text splicing"
```

---

## Task 11: Compile — upgraded statement-position wrap

**Files:**
- Modify: `packages/schemata/src/compile.ts`
- Modify: `packages/schemata/tests/compile.test.ts`

Change: instead of rewriting `spec.before` with `wrapStatement(...)`, use `resolveSite` to resolve to the enclosing statement and rewrite *that*. This is a behavior-preserving change for the existing test (where `spec.before` already is an assignment_statement) but enables operators whose `before` is a sub-expression.

Also: raise helpful errors for `expression-position` / `short-circuit-operand` — Task 12 and Task 13 remove those errors.

- [ ] **Step 1: Extend `packages/schemata/tests/compile.test.ts`**

Append the following cases to the existing `describe("compileSchemataForFile", ...)` block (keep the original `it("wraps a single statement-position mutation", ...)` intact):

```typescript
  it("wraps at the enclosing statement when before is a sub-expression", async () => {
    const src = `codeunit 51810 "C" { procedure P(A: Integer) begin if A > 0 then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    if (cmp === null) throw new Error("no comparison");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.flip",
        operatorVersion: "1.0.0",
        astNodeId: `${cmp.startIndex}`,
        before: cmp,
        after: { ...cmp, text: "A >= 0" } as never,
        parentContext: "statement-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then");
    expect(output).toContain("if A >= 0 then exit(1)");
    expect(output).toContain("if A > 0 then exit(1)");
  });

  it("deletes a statement when after.text is empty (VoidMethodCall semantics)", async () => {
    const src = `codeunit 51811 "C" { procedure P() begin DoThing(); end; }`;
    const root = wrapRoot(parseAL(src));
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (call === null) throw new Error("no call");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.void",
        operatorVersion: "1.0.0",
        astNodeId: `${call.startIndex}`,
        before: call,
        after: { ...call, text: "" } as never,
        parentContext: "statement-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if not MutationSelector.Active('M0001') then");
    expect(output).toContain("DoThing()");
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
bun test packages/schemata/tests/compile.test.ts
```

Expected: first new test fails (existing compile only rewrites `spec.before`, not the enclosing statement).

- [ ] **Step 3: Rewrite `packages/schemata/src/compile.ts`**

Replace the whole file:

```typescript
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { printWithRewrites } from "@lethal/engine";
import { resolveSite } from "./enclosing";
import { assignMutantIds, type IdedSpec } from "./ids";
import { wrapStatement } from "./wrap";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
): string {
  const ided = assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  const rewrites = new Map<ALSyntaxNode, string>();
  for (const entry of ided) {
    applyOne(entry, rewrites);
  }

  return printWithRewrites(source, root, rewrites);
}

function applyOne(
  entry: IdedSpec,
  rewrites: Map<ALSyntaxNode, string>,
): void {
  const { mutantId, spec } = entry;
  if (spec.parentContext === "statement-position") {
    const afterText = (spec.after as unknown as { text?: string }).text ?? "";
    const site = resolveSite(spec.before, afterText);
    const replacement =
      afterText === ""
        ? wrapStatement({ mutantId, original: site.statement, replacement: null })
        : wrapStatement({
            mutantId,
            original: site.statement,
            replacement: site.mutatedText,
          });
    assertNoDuplicateRewrite(rewrites, site.statement);
    rewrites.set(site.statement, replacement);
    return;
  }
  throw new Error(
    `compileSchemataForFile: parentContext "${spec.parentContext}" requires Task 12/13. ` +
      "Call is still coming.",
  );
}

function assertNoDuplicateRewrite(
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
  node: ALSyntaxNode,
): void {
  if (rewrites.has(node)) {
    throw new Error(
      `compileSchemataForFile: two specs resolved to the same statement at ${node.startIndex}..${node.endIndex}. ` +
        "Multi-mutation-per-statement composition is not yet supported.",
    );
  }
}
```

Note: the deletion form passes `replacement: null` to `wrapStatement` when `after.text === ""`, which produces the `if not Active then <orig>` form per Layer 2 Task 4.

- [ ] **Step 4: Run tests to verify all three compile cases pass**

```bash
bun test packages/schemata/tests/compile.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts
git commit -m "feat(schemata): compile wraps at enclosing statement (stmt-pos sub-exprs)"
```

---

## Task 12: Compile — lift composition

**Files:**
- Modify: `packages/schemata/src/compile.ts`
- Modify: `packages/schemata/tests/compile.test.ts`

Compose lift artifacts into the output:
1. Narrowest enclosing `code_block` receives a conditional-assign statement inserted at the start.
2. The enclosing `procedure`'s `var_section` gains a new `_mNNNN: <Type>;` declaration (creating the var_section if none exists).
3. The original `spec.before` expression is rewritten to the local reference.

Placement rule (design §3.5): conditional-assign goes in the narrowest enclosing statement block, not at procedure top — re-evaluations inside loops must happen each iteration.

For Layer 3 scope: support one lift per enclosing procedure and one lift per enclosing statement (no multi-lift coalescing). The dispatch error when >1 lift hits the same block makes the constraint explicit.

- [ ] **Step 1: Extend `packages/schemata/tests/compile.test.ts`**

Add imports at the top if not already present:

```typescript
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
```

Append inside the same describe block:

```typescript
  it("composes a lift: var_section + conditional-assign + expression replacement", async () => {
    const src = `codeunit 51820 "L"
{
    procedure Compute(A: Integer): Integer
    var
        Result: Integer;
    begin
        Result := F(A * 2) + G(A);
        exit(Result);
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const mul = findFirst(root, ALNodeKind.multiplicative_expression);
    if (mul === null) throw new Error("no multiplicative");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.lift",
        operatorVersion: "1.0.0",
        astNodeId: `${mul.startIndex}`,
        before: mul,
        after: { ...mul, text: "0" } as never,
        parentContext: "expression-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    // var_section got an _m0001
    expect(output).toMatch(/_m0001:\s*Integer;/);
    // conditional-assign in the enclosing code_block
    expect(output).toContain("MutationSelector.Active('M0001')");
    expect(output).toContain("_m0001 := 0");
    expect(output).toContain("_m0001 := A * 2");
    // expression replaced with local reference
    expect(output).toContain("Result := F(_m0001) + G(A);");
    // conditional-assign precedes the assignment
    const condIdx = output.indexOf("_m0001 := 0");
    const useIdx = output.indexOf("Result := F(_m0001)");
    expect(condIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeGreaterThan(condIdx);
  });

  it("creates a var_section when the enclosing procedure has none", async () => {
    const src = `codeunit 51821 "L"
{
    procedure Compute(A: Integer): Integer
    begin
        exit(F(A * 2));
    end;
}`;
    const root = wrapRoot(parseAL(src));
    const mul = findFirst(root, ALNodeKind.multiplicative_expression);
    if (mul === null) throw new Error("no multiplicative");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.lift",
        operatorVersion: "1.0.0",
        astNodeId: `${mul.startIndex}`,
        before: mul,
        after: { ...mul, text: "0" } as never,
        parentContext: "expression-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    // a var block must now appear before the procedure's begin
    expect(output).toMatch(/var\s+_m0001:\s*Integer;\s+begin/s);
  });
```

- [ ] **Step 2: Run test to confirm the new cases fail**

```bash
bun test packages/schemata/tests/compile.test.ts
```

Expected: the two new cases fail with `parentContext "expression-position" requires Task 12/13`.

- [ ] **Step 3: Update `packages/schemata/src/compile.ts` — add lift path**

Full file replacement:

```typescript
import type { ALSyntaxNode, MutationSpec, SemanticContext } from "@lethal/engine";
import {
  ALNodeKind,
  buildSemanticContext,
  findEnclosingCodeBlock,
  findEnclosingProcedure,
  printWithRewrites,
} from "@lethal/engine";
import { resolveSite } from "./enclosing";
import { assignMutantIds, type IdedSpec } from "./ids";
import { liftExpression } from "./lift";
import { wrapStatement } from "./wrap";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
): string {
  // Semantic context is built lazily for type inference in lift. When no lift
  // is present it's unused and costs one empty-symbol-table build.
  const ctx = buildSemanticContext([{ path: "<file>", root }]);
  const ided = assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  const rewrites = new Map<ALSyntaxNode, string>();
  const codeBlockInserts = new Map<ALSyntaxNode, string[]>();
  const procedureInjects = new Map<ALSyntaxNode, string[]>();
  const blockExprRewrites = new Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>();

  for (const entry of ided) {
    dispatch(entry, ctx, rewrites, codeBlockInserts, procedureInjects, blockExprRewrites);
  }

  commitLiftRewrites(rewrites, codeBlockInserts, procedureInjects, blockExprRewrites);

  return printWithRewrites(source, root, rewrites);
}

function dispatch(
  entry: IdedSpec,
  ctx: SemanticContext,
  rewrites: Map<ALSyntaxNode, string>,
  codeBlockInserts: Map<ALSyntaxNode, string[]>,
  procedureInjects: Map<ALSyntaxNode, string[]>,
  blockExprRewrites: Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>,
): void {
  const { mutantId, spec } = entry;
  if (spec.parentContext === "statement-position") {
    applyWrap(mutantId, spec, rewrites);
    return;
  }
  if (spec.parentContext === "expression-position") {
    applyLift(mutantId, spec, ctx, codeBlockInserts, procedureInjects, blockExprRewrites);
    return;
  }
  throw new Error(
    `compileSchemataForFile: parentContext "${spec.parentContext}" requires Task 13. ` +
      "Call is still coming.",
  );
}

function applyWrap(
  mutantId: string,
  spec: MutationSpec,
  rewrites: Map<ALSyntaxNode, string>,
): void {
  const afterText = (spec.after as unknown as { text?: string }).text ?? "";
  const site = resolveSite(spec.before, afterText);
  const replacement =
    afterText === ""
      ? wrapStatement({ mutantId, original: site.statement, replacement: null })
      : wrapStatement({
          mutantId,
          original: site.statement,
          replacement: site.mutatedText,
        });
  assertNoDuplicateRewrite(rewrites, site.statement);
  rewrites.set(site.statement, replacement);
}

function applyLift(
  mutantId: string,
  spec: MutationSpec,
  ctx: SemanticContext,
  codeBlockInserts: Map<ALSyntaxNode, string[]>,
  procedureInjects: Map<ALSyntaxNode, string[]>,
  blockExprRewrites: Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>,
): void {
  const enclosingBlock = findEnclosingCodeBlock(spec.before);
  const enclosingProc = findEnclosingProcedure(spec.before);
  if (enclosingBlock === null || enclosingProc === null) {
    throw new Error(
      `compileSchemataForFile: lift target at ${spec.before.startIndex} has no enclosing procedure/block`,
    );
  }
  const inferredType = ctx.types.typeOf(spec.before) ?? "Variant";
  const afterText = (spec.after as unknown as { text?: string }).text ?? "";
  const artifacts = liftExpression({
    mutantId,
    original: spec.before,
    replacementSource: afterText,
    inferredType,
  });

  // Fold the expression-level rewrite into the block-level rewrite rather
  // than registering a separate printer edit — the two would overlap.
  pushExprRewrite(blockExprRewrites, enclosingBlock, spec.before, artifacts.replacementReference);
  pushMulti(codeBlockInserts, enclosingBlock, artifacts.conditionalAssign);
  pushMulti(procedureInjects, enclosingProc, artifacts.varDeclaration);
}

function pushExprRewrite(
  m: Map<ALSyntaxNode, Array<{ node: ALSyntaxNode; text: string }>>,
  block: ALSyntaxNode,
  node: ALSyntaxNode,
  text: string,
): void {
  const existing = m.get(block);
  if (existing === undefined) m.set(block, [{ node, text }]);
  else existing.push({ node, text });
}

function pushMulti<K>(m: Map<K, string[]>, k: K, v: string): void {
  const existing = m.get(k);
  if (existing === undefined) m.set(k, [v]);
  else existing.push(v);
}

/**
 * Commit all lift-derived edits to `rewrites` in one coordinated pass.
 *
 * A procedure without an existing `var_section` needs its `var` block created
 * *before* its body `code_block`. The same body may also need a prelude
 * conditional-assign inserted after `begin`. Both edits land on the same
 * body node — so we merge them into one rewrite per block to avoid the
 * printer's no-overlap invariant.
 */
function commitLiftRewrites(
  rewrites: Map<ALSyntaxNode, string>,
  codeBlockInserts: ReadonlyMap<ALSyntaxNode, readonly string[]>,
  procedureInjects: ReadonlyMap<ALSyntaxNode, readonly string[]>,
  blockExprRewrites: ReadonlyMap<ALSyntaxNode, ReadonlyArray<{ node: ALSyntaxNode; text: string }>>,
): void {
  // Step 1: resolve each procedure's var-declaration target.
  // If the procedure already has a var_section, rewrite it directly.
  // Otherwise, fold the declarations into the body block's rewrite (step 2).
  const bodyVarPreludes = new Map<ALSyntaxNode, readonly string[]>();
  for (const [proc, decls] of procedureInjects) {
    const existingVar = proc.namedChildren.find(
      (c) => c.kind === ALNodeKind.var_section,
    );
    if (existingVar !== undefined) {
      if (rewrites.has(existingVar)) {
        throw new Error("var_section already targeted by another rewrite");
      }
      const declText = decls.map((d) => `        ${d}`).join("\n");
      rewrites.set(
        existingVar,
        `${existingVar.text.replace(/\s+$/, "")}\n${declText}`,
      );
      continue;
    }
    const body = proc.namedChildren.find((c) => c.kind === ALNodeKind.block);
    if (body === undefined) {
      throw new Error("procedure has no code_block body — cannot inject var_section");
    }
    bodyVarPreludes.set(body, decls);
  }

  // Step 2: rewrite each code_block that needs prelude inserts, inner
  // expression rewrites, and/or a prepended var_section. One unified
  // rewrite per block.
  const allBlocks = new Set<ALSyntaxNode>([
    ...codeBlockInserts.keys(),
    ...bodyVarPreludes.keys(),
    ...blockExprRewrites.keys(),
  ]);
  for (const block of allBlocks) {
    if (rewrites.has(block)) {
      throw new Error(
        "compileSchemataForFile: a code_block is both a lift host and a direct rewrite target — not supported in Layer 3",
      );
    }
    // Apply inner expression rewrites to the block's text first. Edits are
    // sorted by startIndex (descending) so each splice's remaining offsets
    // stay valid as we go.
    const exprEdits = (blockExprRewrites.get(block) ?? [])
      .slice()
      .sort((a, b) => b.node.startIndex - a.node.startIndex);
    let blockText = block.text;
    for (const e of exprEdits) {
      const relStart = e.node.startIndex - block.startIndex;
      const relEnd = e.node.endIndex - block.startIndex;
      if (relStart < 0 || relEnd > blockText.length) {
        throw new Error(
          `commitLiftRewrites: expression at ${e.node.startIndex}..${e.node.endIndex} outside block ${block.startIndex}..${block.endIndex}`,
        );
      }
      blockText = blockText.slice(0, relStart) + e.text + blockText.slice(relEnd);
    }

    const preludes = codeBlockInserts.get(block) ?? [];
    let blockReplacement: string;
    if (preludes.length > 0) {
      const indent = detectIndent(block.text);
      const joined = preludes
        .map((p) => indentMultiline(p, indent))
        .join("\n");
      const body = stripBeginEnd(blockText);
      blockReplacement = `begin\n${joined}\n${body}\nend`;
    } else {
      blockReplacement = blockText;
    }
    const varDecls = bodyVarPreludes.get(block);
    if (varDecls !== undefined) {
      const declText = varDecls.map((d) => `        ${d}`).join("\n");
      rewrites.set(block, `var\n${declText}\n    ${blockReplacement}`);
    } else {
      rewrites.set(block, blockReplacement);
    }
  }
}

function detectIndent(blockText: string): string {
  const lines = blockText.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed === "end" || trimmed.startsWith("end")) continue;
    const lead = line.slice(0, line.length - trimmed.length);
    if (lead.length > 0) return lead;
  }
  return "  ";
}

function indentMultiline(s: string, indent: string): string {
  return s
    .split("\n")
    .map((ln) => (ln.length === 0 ? ln : `${indent}${ln}`))
    .join("\n");
}

function stripBeginEnd(blockText: string): string {
  // strip first `begin` line + last `end` token
  const trimmed = blockText.trim();
  const withoutBegin = trimmed.replace(/^begin\b\s*/, "");
  const withoutEnd = withoutBegin.replace(/\s*end\s*$/, "");
  return withoutEnd;
}

function assertNoDuplicateRewrite(
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
  node: ALSyntaxNode,
): void {
  if (rewrites.has(node)) {
    throw new Error(
      `compileSchemataForFile: two specs resolved to the same AST node at ${node.startIndex}..${node.endIndex}`,
    );
  }
}
```

Note the design trade-off: lift-prelude insertion into a `code_block` is expressed as a rewrite of the whole block, not as a separate insertion edit. This reuses `printWithRewrites`'s no-overlap invariant without adding a new primitive. The cost is that any spec whose rewrite target IS a block (e.g. `EmptyBlock` against the same block) conflicts — we assert and fail loudly rather than silently producing wrong output.

- [ ] **Step 4: Run tests to verify lift cases pass**

```bash
bun test packages/schemata/tests/compile.test.ts
```

Expected: all 5 compile cases pass (2 wrap + 2 lift + 1 delete).

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts
git commit -m "feat(schemata): compile lift composition (var_section + conditional-assign)"
```

---

## Task 13: Compile — duplicate composition

**Files:**
- Modify: `packages/schemata/src/compile.ts`
- Modify: `packages/schemata/tests/compile.test.ts`

Compose duplicate artifacts: for `short-circuit-operand` specs, resolve the enclosing statement, then rewrite that statement with `duplicateEnclosing({ mutantId, enclosingStatement, mutatedStatement })`. `mutatedStatement` = the enclosing statement's text with the operand span replaced by `after.text` — reusing `resolveSite`.

- [ ] **Step 1: Extend `packages/schemata/tests/compile.test.ts`**

Append to the same describe:

```typescript
  it("composes a duplicate for short-circuit-operand", async () => {
    const src = `codeunit 51830 "D" { procedure P(A: Boolean; B: Boolean) begin if A and B then DoThing(); end; }`;
    const root = wrapRoot(parseAL(src));
    const logical = findFirst(root, ALNodeKind.logical_expression);
    if (logical === null) throw new Error("no logical");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.neg",
        operatorVersion: "1.0.0",
        astNodeId: `${logical.startIndex}`,
        before: logical,
        after: { ...logical, text: "A or B" } as never,
        parentContext: "short-circuit-operand",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then begin");
    expect(output).toContain("if A or B then DoThing()");
    expect(output).toContain("end else begin");
    expect(output).toContain("if A and B then DoThing()");
  });
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test packages/schemata/tests/compile.test.ts
```

Expected: the new test fails with `parentContext "short-circuit-operand" requires Task 13`.

- [ ] **Step 3: Patch `packages/schemata/src/compile.ts` — add duplicate path**

Add import at the top alongside existing imports:

```typescript
import { duplicateEnclosing } from "./duplicate";
```

Replace the final `throw new Error` in `dispatch(...)` with a dispatch to a new `applyDuplicate`:

```typescript
  if (spec.parentContext === "short-circuit-operand") {
    applyDuplicate(mutantId, spec, rewrites);
    return;
  }
  throw new Error(
    `compileSchemataForFile: unknown parentContext "${spec.parentContext}"`,
  );
```

Add the `applyDuplicate` implementation (place it after `applyLift`):

```typescript
function applyDuplicate(
  mutantId: string,
  spec: MutationSpec,
  rewrites: Map<ALSyntaxNode, string>,
): void {
  const afterText = (spec.after as unknown as { text?: string }).text ?? "";
  const site = resolveSite(spec.before, afterText);
  assertNoDuplicateRewrite(rewrites, site.statement);
  const duplicated = duplicateEnclosing({
    mutantId,
    enclosingStatement: site.statement,
    mutatedStatement: site.mutatedText,
  });
  rewrites.set(site.statement, duplicated);
}
```

- [ ] **Step 4: Run tests to verify the duplicate case passes**

```bash
bun test packages/schemata/tests/compile.test.ts
```

Expected: 6 pass (2 wrap + 1 delete + 2 lift + 1 duplicate).

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts
git commit -m "feat(schemata): compile duplicate composition (short-circuit-operand)"
```

---

## Task 14: End-to-end integration test

**Files:**
- Create: `packages/builtin-tier1/tests/end-to-end.test.ts`
- Create: `packages/builtin-tier1/tests/fixtures/al/mixed-operators.al`

Exercises the full pipeline: parse → build semantic context → run all five operators → `compileSchemataForFile` → `writeInstrumentedProject` → read files back and assert expected structure. This is the acceptance test for Layer 3.

- [ ] **Step 1: Create fixture `packages/builtin-tier1/tests/fixtures/al/mixed-operators.al`**

```al
codeunit 51900 "Mixed Operators"
{
    procedure Classify(n: Integer; OnlyPositive: Boolean): Integer
    begin
        if n > 0 then begin
            Log('positive');
            exit(n);
        end;
        if OnlyPositive and (n = 0) then
            exit(0);
        exit(-1);
    end;
}
```

- [ ] **Step 2: Write `packages/builtin-tier1/tests/end-to-end.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
  type MutationSpec,
} from "@lethal/engine";
import {
  compileSchemataForFile,
  writeInstrumentedProject,
} from "@lethal/schemata";
import { tier1Operators } from "../src";

const SRC_PATH = new URL(
  "./fixtures/al/mixed-operators.al",
  import.meta.url,
).pathname;

describe("end-to-end Layer 3", () => {
  beforeAll(async () => { await initParser(); });

  it("runs all Tier 1 operators and composes a valid instrumented output", async () => {
    const src = await readFile(SRC_PATH, "utf8");
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "mixed.al", root }]);

    const specs: MutationSpec[] = [];
    visit(root, (node) => {
      for (const op of tier1Operators) {
        if (op.targets(node, ctx)) {
          for (const s of op.generate(node, ctx)) specs.push(s);
        }
      }
    });

    // Sanity: fixture should produce at least one spec per operator that
    // applies to it. Fixture was hand-picked to hit ConditionalBoundary
    // (n>0), NegateConditional (n=0, and), VoidMethodCall (Log), ReturnValue
    // (exit(n), exit(-1)), EmptyBlock (both body blocks).
    const names = new Set(specs.map((s) => s.operatorName));
    expect(names.has("lethal.conditional-boundary")).toBe(true);
    expect(names.has("lethal.negate-conditional")).toBe(true);
    expect(names.has("lethal.void-method-call")).toBe(true);
    expect(names.has("lethal.return-value")).toBe(true);
    expect(names.has("lethal.empty-block")).toBe(true);

    // Specs may target overlapping statements (e.g. EmptyBlock covers the
    // then-branch block; ConditionalBoundary covers the containing
    // if_statement). Layer 3 compile rejects overlap — filter to one spec per
    // enclosing statement so the integration check focuses on composition,
    // not deconfliction (deferred to Layer 4).
    const kept = dedupeByFirstSite(specs);
    expect(kept.length).toBeGreaterThan(0);

    const compiled = compileSchemataForFile(src, root, kept);
    expect(compiled).toContain("MutationSelector.Active(");

    // Write to tmp dir and read back
    const dir = await mkdtemp(join(tmpdir(), "lethal-e2e-"));
    try {
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "mixed.al", source: src, root, specs: kept }],
        selectorObjectId: 60000,
      });
      const written = await readFile(join(dir, "mixed.al"), "utf8");
      expect(written).toBe(compiled);
      const manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      expect(manifest.mutants.length).toBe(kept.length);
      expect(manifest.selectorObjectId).toBe(60000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Keep the first spec whose `before` span does not overlap any already-kept
 * spec's enclosing-statement span. Good enough for integration coverage in
 * Layer 3 — real deconfliction arrives in Layer 4.
 */
function dedupeByFirstSite(specs: readonly MutationSpec[]): MutationSpec[] {
  const kept: MutationSpec[] = [];
  const used: Array<{ start: number; end: number }> = [];
  for (const s of specs) {
    const r = { start: s.before.startIndex, end: s.before.endIndex };
    if (used.some((u) => !(r.end <= u.start || r.start >= u.end))) continue;
    used.push(r);
    kept.push(s);
  }
  return kept;
}
```

- [ ] **Step 3: Run test**

```bash
bun test packages/builtin-tier1/tests/end-to-end.test.ts
```

Expected: 1 pass. The generated output file contains multiple `MutationSelector.Active('M00NN')` call sites spanning all three parentContexts.

- [ ] **Step 4: Commit**

```bash
git add packages/builtin-tier1/tests/end-to-end.test.ts \
        packages/builtin-tier1/tests/fixtures/al/mixed-operators.al
git commit -m "test(builtin-tier1): end-to-end Layer 3 integration (ops -> compile -> write)"
```

---

## Task 15: Conformance sweep + schemata exports + full run

**Files:**
- Modify: `packages/schemata/src/index.ts`

Final housekeeping: expose the new helpers from schemata's public surface, run the full test suite + typecheck + biome.

- [ ] **Step 1: Extend `packages/schemata/src/index.ts`**

Append at the end of the existing exports:

```typescript
export { resolveSite } from "./enclosing";
export type { ResolvedSite } from "./enclosing";
```

- [ ] **Step 2: Run all conformance suites against all five operators**

Add a short conformance-runner script in-repo? No — use the SDK's `runConformance` directly from `bun test` since `conformance.test.ts` already exists per Layer 1.

Create `packages/builtin-tier1/tests/conformance.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser } from "@lethal/engine";
import { runConformance } from "@lethal/operator-sdk";
import { tier1Operators } from "../src";

describe("tier 1 conformance", () => {
  beforeAll(async () => { await initParser(); });

  for (const op of tier1Operators) {
    it(`${op.name} passes its conformance suite`, async () => {
      const result = await runConformance(op);
      if (!result.allPassed) {
        console.error(JSON.stringify(result.failures, null, 2));
      }
      expect(result.allPassed).toBe(true);
    });
  }
});
```

- [ ] **Step 3: Run the full test suite + typecheck + lint**

```bash
cd U:/Git/LethAL
bun run typecheck
bun test
bun run lint
```

Expected: all tests pass, typecheck clean, biome reports no diagnostics on new files. If lint fires on any new file, fix formatting in place (biome is the project's source of truth per Layer 1 decisions).

- [ ] **Step 4: Commit**

```bash
git add packages/schemata/src/index.ts \
        packages/builtin-tier1/tests/conformance.test.ts
git commit -m "feat(builtin-tier1): conformance sweep + schemata resolveSite export"
```

---

## Checkpoint: Layer 3 Complete

What ships:

- `@lethal/builtin-tier1` package with five Tier 1 operators (ConditionalBoundary, NegateConditional, VoidMethodCall, ReturnValue, EmptyBlock), each with its own targeted node-kind surface, conformance suite, and unit tests, plus a `tier1Operators` bundle for easy registration.
- Engine tree-walk helpers (`findEnclosingStatement`, `findEnclosingProcedure`, `findEnclosingCodeBlock`) used by operators and schemata alike, re-exported via the SDK.
- Schemata compile upgrade: `compileSchemataForFile` now handles all three `parentContext` values (statement-position, expression-position, short-circuit-operand) — composing lift artifacts into the enclosing procedure's var_section + narrowest code_block, and composing duplicate forms at the enclosing statement.
- `@lethal/schemata` `resolveSite` helper shared by wrap, lift, and duplicate paths.
- End-to-end integration test proving parse → operators → compile → writeInstrumentedProject produces readable output with the manifest intact.

**Next plan:** `plans/YYYY-MM-DD-layer-4-execution-runtime.md` — coverage-informed test selection, sequential execution loop, kill-confirmation re-run, and the first real mutant-run (§6.1–6.7). Layer 4 also tackles multi-mutation-per-statement deconfliction and cross-site coalescing of lift preludes, both deferred here.

**Spec coverage audit for Layer 3:**

| Spec reference | Covered by |
|---|---|
| §4 Tier 1 ConditionalBoundary | Task 4 |
| §4 Tier 1 NegateConditional | Task 5 |
| §4 Tier 1 VoidMethodCall | Task 6 |
| §4 Tier 1 ReturnValue | Task 7 |
| §4 Tier 1 EmptyBlock | Task 8 |
| §3.5 wrap selection rule 1 | Task 11 (statement-position upgrade) |
| §3.5 lift selection rule 2 | Task 12 |
| §3.5 duplicate selection rule 3 | Task 13 |
| §3.5 "never extract to a procedure" | operator + compile design — no extraction path exists |
| §5.1 `ast_subtree_hash` targets the mutation subtree | operators set `before` = mutation subtree (not enclosing stmt) |
| §4 `MutationOperator.conformanceTests` mandatory | Task 15 conformance sweep |

**Deferred to Layer 4:**

- Multi-mutation-per-enclosing-statement deconfliction (current compile fails loudly on overlap; integration test filters to first spec per site).
- Cross-site lift-prelude coalescing inside a single code_block.
- Operator budget enforcement (256 MB / 500 ms per design §4) — requires Bun Worker wiring, which lives with the execution runtime.
