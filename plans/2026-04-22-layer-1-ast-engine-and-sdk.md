# LethAL Layer 1 Implementation Plan — AST Engine + Operator SDK

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the reusable foundation layer that every later LethAL subsystem consumes: AL AST parsing, formatting-preserving printing, AST hashing, canonicalization, semantic analysis (symbol table / CFG / types / callers), the `MutationOperator` / `MutationSpec` contract, and the `@lethal/operator-sdk` package with typed `build.*` constructors and a conformance harness.

**Architecture:** Bun + TypeScript monorepo with two published packages. `@lethal/engine` owns AST, semantic analysis, hashing, canonicalization, and the operator interface types. `@lethal/operator-sdk` re-exports the public subset of engine types and adds typed builders + the conformance harness that custom operators consume. No mutation generation or execution in this layer — those are Layer 3 and Layer 4.

**Tech Stack:** Bun (runtime + package manager + test runner), TypeScript, `tree-sitter-al` parser (via `web-tree-sitter` WASM binding), `zod` for schema validation of `MutationSpec`, `blake3` for AST hashing. No other dependencies in Layer 1.

**Design spec reference:** `U:/Git/LethAL/design.md` §3.2, §3.3, §3.5, §4, §5.1 (identity key hash).

---

## File Structure

Monorepo rooted at repo root. Bun workspaces, TypeScript project references, Biome for formatting and lint.

```
LethAL/
├── package.json                          # workspace root, Bun workspaces
├── bun.lock
├── biome.json                            # formatter/lint config
├── tsconfig.base.json                    # shared compiler options
├── packages/
│   ├── engine/
│   │   ├── package.json                  # @lethal/engine
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── ast/
│   │   │   │   ├── parser.ts             # tree-sitter-al adapter
│   │   │   │   ├── node-kinds.ts         # ALNodeKind enum
│   │   │   │   ├── syntax-node.ts        # ALSyntaxNode type + traversal
│   │   │   │   ├── printer.ts            # formatting-preserving printer
│   │   │   │   ├── hash.ts               # ast_subtree_hash()
│   │   │   │   └── canonicalization.ts   # equivalence-preserving normalizations
│   │   │   ├── semantic/
│   │   │   │   ├── symbol-table.ts
│   │   │   │   ├── cfg.ts
│   │   │   │   ├── types.ts              # TypeTable
│   │   │   │   ├── callers.ts
│   │   │   │   └── context.ts            # SemanticContext composition
│   │   │   ├── operator/
│   │   │   │   ├── interface.ts          # MutationOperator + MutationSpec types
│   │   │   │   ├── spec-validation.ts    # zod schemas
│   │   │   │   └── registry.ts
│   │   │   └── index.ts                  # public exports
│   │   └── tests/
│   │       ├── ast/
│   │       │   ├── parser.test.ts
│   │       │   ├── printer.test.ts
│   │       │   ├── hash.test.ts
│   │       │   └── canonicalization.test.ts
│   │       ├── semantic/
│   │       │   ├── symbol-table.test.ts
│   │       │   ├── cfg.test.ts
│   │       │   ├── types.test.ts
│   │       │   └── callers.test.ts
│   │       ├── operator/
│   │       │   ├── interface.test.ts
│   │       │   └── spec-validation.test.ts
│   │       ├── integration/
│   │       │   └── roundtrip.test.ts
│   │       └── fixtures/
│   │           └── al/
│   │               ├── simple-codeunit.al
│   │               ├── calcfields.al
│   │               ├── short-circuit.al
│   │               ├── trigger-onvalidate.al
│   │               └── procedure-with-vars.al
│   └── operator-sdk/
│       ├── package.json                  # @lethal/operator-sdk
│       ├── tsconfig.json
│       ├── src/
│       │   ├── build.ts                  # typed AL node constructors
│       │   ├── conformance.ts            # ConformanceCase + runner
│       │   └── index.ts
│       └── tests/
│           ├── build.test.ts
│           └── conformance.test.ts
└── plans/
    └── 2026-04-22-layer-1-ast-engine-and-sdk.md   # this file
```

**Boundary rationale.** `engine` is the heavy package — parser, semantic analysis, printer, hashing. `operator-sdk` is a thin public-facing layer that deliberately narrows the API surface exposed to custom operator authors, so the engine internals can evolve without breaking third-party operators. Tests live beside their package's `src/` because each package is independently publishable.

---

## Task 1: Repo bootstrap + Bun workspaces

**Files:**
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `.gitignore`
- Create: `.gitattributes`

- [ ] **Step 1: Initialize git**

Design lives at `design.md` and the repo is not yet a git repo. Initialize it so later commits work.

Run:
```bash
cd U:/Git/LethAL && git init && git add design.md plans/ && git commit -m "chore: initial commit with design and layer-1 plan"
```

Expected: `[main (root-commit) <sha>] chore: initial commit with design and layer-1 plan` with 2 files changed.

- [ ] **Step 2: Create `.gitignore`**

Create `U:/Git/LethAL/.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
.bun-cache/
coverage/
*.log
.env
.env.local
```

- [ ] **Step 3: Create `.gitattributes`**

Create `U:/Git/LethAL/.gitattributes`:
```
* text=auto eol=lf
*.al text eol=lf
```

LF line endings uniformly — AL fixtures must not differ between Windows and Linux checkouts, because AST hashes include no line-ending information but parser behavior could.

- [ ] **Step 4: Create root `package.json` with workspaces**

Create `U:/Git/LethAL/package.json`:
```json
{
  "name": "lethal",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --build --force",
    "lint": "biome check ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "typescript": "^5.6.3",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 5: Create `tsconfig.base.json`**

Create `U:/Git/LethAL/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["bun"],
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

`strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` is intentional — LethAL's correctness story depends on the type system catching shape drift in `MutationSpec` and AST nodes.

- [ ] **Step 6: Create `biome.json`**

Create `U:/Git/LethAL/biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always" }
  }
}
```

- [ ] **Step 7: Install dev deps**

Run: `cd U:/Git/LethAL && bun install`
Expected: creates `bun.lock` and `node_modules/`. No errors.

- [ ] **Step 8: Commit**

```bash
git add .gitignore .gitattributes package.json tsconfig.base.json biome.json bun.lock
git commit -m "chore(repo): initialize bun workspace, typescript base, biome"
```

---

## Task 2: `@lethal/engine` package scaffold + tree-sitter-al adapter

**Files:**
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/src/ast/parser.ts`
- Create: `packages/engine/tests/ast/parser.test.ts`
- Create: `packages/engine/tests/fixtures/al/simple-codeunit.al`

- [ ] **Step 1: Create `packages/engine/package.json`**

```json
{
  "name": "@lethal/engine",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "web-tree-sitter": "^0.25.0",
    "zod": "^3.23.8",
    "@noble/hashes": "^1.5.0"
  }
}
```

`web-tree-sitter` is the WASM binding for tree-sitter that works in Bun and browsers. Version `^0.25.0` is required to support tree-sitter ABI 15 emitted by the current AL grammar release. `@noble/hashes` provides blake3 in pure JS — no native build requirement, which keeps the toolchain simple across Windows/Linux/macOS.

- [ ] **Step 2: Create `packages/engine/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

`rootDir` is intentionally omitted. Setting `rootDir: src` with tests in `include` produces `error TS6059: File '…/tests/…' is not under 'rootDir'`. TypeScript infers `rootDir` from the longest common prefix of included files, which gives us `packages/engine/`. Emit lands under `dist/src/…` and `dist/tests/…` — fine because `dist` is gitignored and never published.

- [ ] **Step 3: Install engine deps**

Run: `cd U:/Git/LethAL && bun install`
Expected: `web-tree-sitter`, `zod`, `@noble/hashes` land in `node_modules/`.

- [ ] **Step 4: Create fixture `simple-codeunit.al`**

Create `packages/engine/tests/fixtures/al/simple-codeunit.al`:
```al
codeunit 50100 "Simple Test"
{
    procedure DoubleIt(Value: Integer): Integer
    begin
        exit(Value * 2);
    end;
}
```

- [ ] **Step 5: Write failing test `parser.test.ts`**

Create `packages/engine/tests/ast/parser.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";

const fixture = resolve(__dirname, "../fixtures/al/simple-codeunit.al");

describe("parser", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("parses a simple codeunit without errors", async () => {
    const source = await readFile(fixture, "utf8");
    const tree = parseAL(source);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.type).toBe("source_file");
  });

  it("surfaces a procedure named DoubleIt in the AST", async () => {
    const source = await readFile(fixture, "utf8");
    const tree = parseAL(source);
    const proc = tree.rootNode.descendantsOfType("procedure")[0];
    expect(proc).toBeDefined();
    expect(proc!.text).toContain("DoubleIt");
  });
});
```

- [ ] **Step 6: Run to confirm failure**

Run: `bun test packages/engine/tests/ast/parser.test.ts`
Expected: fails with "Cannot find module '../../src/ast/parser'".

- [ ] **Step 7: Implement the parser adapter**

Create `packages/engine/src/ast/parser.ts`:
```typescript
import { Parser, Language, type Tree } from "web-tree-sitter";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let alLanguage: Language | null = null;
let parser: Parser | null = null;

const PARSER_WASM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/tree-sitter-al.wasm",
);

export async function initParser(): Promise<void> {
  if (parser !== null) return;
  await Parser.init();
  const wasmBytes = await readFile(PARSER_WASM_PATH);
  alLanguage = await Language.load(wasmBytes);
  parser = new Parser();
  parser.setLanguage(alLanguage);
}

export function parseAL(source: string): Tree {
  if (parser === null) {
    throw new Error("parser not initialized — call initParser() first");
  }
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error("tree-sitter returned null tree");
  }
  return tree;
}
```

The WASM binary is loaded from `packages/engine/vendor/tree-sitter-al.wasm`. The next step vendors it.

- [ ] **Step 8: Vendor the tree-sitter-al WASM**

Download or build `tree-sitter-al.wasm` from https://github.com/SShadowS/tree-sitter-al (active community AL grammar, MIT, publishes prebuilt WASM in Releases). Place at `packages/engine/vendor/tree-sitter-al.wasm`.

Run (from repo root):
```bash
mkdir -p packages/engine/vendor
# Option A (preferred): download a prebuilt wasm from a pinned release
curl -L -o packages/engine/vendor/tree-sitter-al.wasm \
  https://github.com/SShadowS/tree-sitter-al/releases/download/v2.5.0/tree-sitter-al.wasm
# Option B: build locally (requires Emscripten or Docker)
#   git clone https://github.com/SShadowS/tree-sitter-al /tmp/tsa
#   cd /tmp/tsa && git checkout v2.5.0
#   npx tree-sitter generate && npx tree-sitter build --wasm
#   cp tree-sitter-al.wasm U:/Git/LethAL/packages/engine/vendor/
```

Document the release tag and commit hash in `packages/engine/vendor/README.md`. The rest of this plan assumes node types match this grammar's `node-types.json`; if a different grammar is used, Task 3's `ALNodeKind` enum must be regenerated from its `node-types.json`.

- [ ] **Step 9: Run test, confirm pass**

Run: `bun test packages/engine/tests/ast/parser.test.ts`
Expected: both tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/package.json packages/engine/tsconfig.json \
        packages/engine/src/ast/parser.ts \
        packages/engine/tests/ast/parser.test.ts \
        packages/engine/tests/fixtures/al/simple-codeunit.al \
        packages/engine/vendor/tree-sitter-al.wasm \
        packages/engine/vendor/README.md \
        bun.lock
git commit -m "feat(engine): tree-sitter-al adapter with init + parse"
```

---

## Task 3: `ALNodeKind` enum

**Files:**
- Create: `packages/engine/src/ast/node-kinds.ts`
- Create: `packages/engine/tests/ast/node-kinds.test.ts`

Generating the full enum from `node-types.json` is Task 3's purpose; downstream tasks reference `ALNodeKind` values by name.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/ast/node-kinds.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { ALNodeKind, isALNodeKind } from "../../src/ast/node-kinds";

describe("ALNodeKind", () => {
  it("includes core kinds referenced by the design spec", () => {
    expect(ALNodeKind.if_statement).toBe("if_statement");
    expect(ALNodeKind.procedure).toBe("procedure");
    expect(ALNodeKind.codeunit).toBe("codeunit");
    expect(ALNodeKind.binary_expression).toBe("binary_expression");
    expect(ALNodeKind.source_file).toBe("source_file");
  });

  it("recognizes valid kinds via isALNodeKind", () => {
    expect(isALNodeKind("if_statement")).toBe(true);
    expect(isALNodeKind("source_file")).toBe(true);
  });

  it("rejects unknown kinds", () => {
    expect(isALNodeKind("not_a_real_kind")).toBe(false);
    expect(isALNodeKind("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/ast/node-kinds.test.ts`
Expected: fails with "Cannot find module '../../src/ast/node-kinds'".

- [ ] **Step 3: Implement `node-kinds.ts`**

Create `packages/engine/src/ast/node-kinds.ts`. The enum values must match the grammar's `node-types.json` exactly. Below is the canonical core subset used by later tasks; extend as additional tasks reference more kinds.

```typescript
export const ALNodeKind = {
  source_file: "source_file",
  codeunit: "codeunit",
  table: "table",
  page: "page",
  report: "report",
  procedure: "procedure",
  trigger: "trigger",
  var_section: "var_section",
  variable_declaration: "variable_declaration",
  parameter_list: "parameter_list",
  parameter: "parameter",

  block: "block",
  if_statement: "if_statement",
  case_statement: "case_statement",
  repeat_statement: "repeat_statement",
  while_statement: "while_statement",
  for_statement: "for_statement",
  exit_statement: "exit_statement",
  error_statement: "error_statement",
  assignment_statement: "assignment_statement",
  expression_statement: "expression_statement",

  binary_expression: "binary_expression",
  unary_expression: "unary_expression",
  parenthesized_expression: "parenthesized_expression",
  identifier: "identifier",
  integer_literal: "integer_literal",
  decimal_literal: "decimal_literal",
  text_literal: "text_literal",
  boolean_literal: "boolean_literal",
  field_access: "field_access",
  procedure_call: "procedure_call",
  method_call: "method_call",

  type_reference: "type_reference",
  record_type: "record_type",
} as const;

export type ALNodeKind = (typeof ALNodeKind)[keyof typeof ALNodeKind];

const VALID_KINDS: ReadonlySet<string> = new Set(Object.values(ALNodeKind));

export function isALNodeKind(value: unknown): value is ALNodeKind {
  return typeof value === "string" && VALID_KINDS.has(value);
}
```

If subsequent tasks need kinds not listed here, they extend this file and add a test case covering the new value.

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/ast/node-kinds.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/ast/node-kinds.ts packages/engine/tests/ast/node-kinds.test.ts
git commit -m "feat(engine): ALNodeKind enum + type guard"
```

---

## Task 4: `ALSyntaxNode` type + traversal helpers

**Files:**
- Create: `packages/engine/src/ast/syntax-node.ts`
- Create: `packages/engine/tests/ast/syntax-node.test.ts`

`ALSyntaxNode` is the read-only façade over `web-tree-sitter`'s `SyntaxNode`. This isolates the engine from the underlying parser library and narrows the API surface operators see.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/ast/syntax-node.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst, findAll } from "../../src/ast/syntax-node";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("syntax-node", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function load(): Promise<string> {
    return readFile(
      resolve(__dirname, "../fixtures/al/simple-codeunit.al"),
      "utf8",
    );
  }

  it("wraps a tree-sitter root into an ALSyntaxNode", async () => {
    const tree = parseAL(await load());
    const root = wrapRoot(tree);
    expect(root.kind).toBe(ALNodeKind.source_file);
    expect(root.children.length).toBeGreaterThan(0);
  });

  it("findFirst returns the first descendant matching a kind", async () => {
    const root = wrapRoot(parseAL(await load()));
    const proc = findFirst(root, ALNodeKind.procedure);
    expect(proc).not.toBeNull();
    expect(proc!.text).toContain("DoubleIt");
  });

  it("findAll returns all descendants matching a kind", async () => {
    const root = wrapRoot(parseAL(await load()));
    const exits = findAll(root, ALNodeKind.exit_statement);
    expect(exits.length).toBe(1);
  });

  it("exposes parent + children + text as read-only", async () => {
    const root = wrapRoot(parseAL(await load()));
    const proc = findFirst(root, ALNodeKind.procedure)!;
    expect(proc.parent).not.toBeNull();
    // readonly compile-time check (no runtime assertion possible)
    // @ts-expect-error children is readonly
    proc.children = [];
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/ast/syntax-node.test.ts`
Expected: fails with module-not-found.

- [ ] **Step 3: Implement `syntax-node.ts`**

Create `packages/engine/src/ast/syntax-node.ts`:
```typescript
import type { Tree, SyntaxNode as TSSyntaxNode } from "web-tree-sitter";
import { type ALNodeKind, isALNodeKind } from "./node-kinds";

export interface ALSyntaxNode {
  readonly kind: ALNodeKind;
  readonly rawKind: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly parent: ALSyntaxNode | null;
  readonly children: readonly ALSyntaxNode[];
  readonly namedChildren: readonly ALSyntaxNode[];
  readonly fieldName: string | null;
  childForFieldName(name: string): ALSyntaxNode | null;
}

class WrappedNode implements ALSyntaxNode {
  constructor(
    private readonly ts: TSSyntaxNode,
    private readonly parentNode: ALSyntaxNode | null,
    readonly fieldName: string | null,
  ) {}

  get kind(): ALNodeKind {
    if (!isALNodeKind(this.ts.type)) {
      return this.ts.type as ALNodeKind;
    }
    return this.ts.type;
  }

  get rawKind(): string {
    return this.ts.type;
  }

  get text(): string {
    return this.ts.text;
  }

  get startIndex(): number {
    return this.ts.startIndex;
  }

  get endIndex(): number {
    return this.ts.endIndex;
  }

  get startPosition(): { readonly row: number; readonly column: number } {
    return this.ts.startPosition;
  }

  get endPosition(): { readonly row: number; readonly column: number } {
    return this.ts.endPosition;
  }

  get parent(): ALSyntaxNode | null {
    return this.parentNode;
  }

  get children(): readonly ALSyntaxNode[] {
    return this.ts.children.map(
      (c, i) => new WrappedNode(c, this, this.ts.fieldNameForChild(i) ?? null),
    );
  }

  get namedChildren(): readonly ALSyntaxNode[] {
    return this.ts.namedChildren.map(
      (c, i) => new WrappedNode(c, this, this.ts.fieldNameForNamedChild(i) ?? null),
    );
  }

  childForFieldName(name: string): ALSyntaxNode | null {
    const child = this.ts.childForFieldName(name);
    return child === null ? null : new WrappedNode(child, this, name);
  }
}

export function wrapRoot(tree: Tree): ALSyntaxNode {
  return new WrappedNode(tree.rootNode, null, null);
}

export function findFirst(
  root: ALSyntaxNode,
  kind: ALNodeKind,
): ALSyntaxNode | null {
  if (root.kind === kind) return root;
  for (const child of root.children) {
    const hit = findFirst(child, kind);
    if (hit !== null) return hit;
  }
  return null;
}

export function findAll(root: ALSyntaxNode, kind: ALNodeKind): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.kind === kind) out.push(n);
  });
  return out;
}

export function visit(
  root: ALSyntaxNode,
  fn: (node: ALSyntaxNode) => void,
): void {
  fn(root);
  for (const child of root.children) {
    visit(child, fn);
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/ast/syntax-node.test.ts`
Expected: pass. The `@ts-expect-error` ensures readonly enforcement is compile-level.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/ast/syntax-node.ts \
        packages/engine/tests/ast/syntax-node.test.ts
git commit -m "feat(engine): ALSyntaxNode facade + traversal helpers"
```

---

## Task 5: Formatting-preserving printer

**Files:**
- Create: `packages/engine/src/ast/printer.ts`
- Create: `packages/engine/tests/ast/printer.test.ts`
- Create: `packages/engine/tests/fixtures/al/comments-and-spacing.al`

The printer is bytewise-identity for unmodified nodes (thanks to `startIndex`/`endIndex` preservation) and surgically splices replacements when given a rewrite map.

- [ ] **Step 1: Create fixture `comments-and-spacing.al`**

```al
codeunit 50101 "Spacing Test"
{
    // Leading comment on procedure
    procedure Check(Amount:  Decimal): Boolean
    var
        Result: Boolean; // trailing comment
    begin
        // inside-block comment
        Result := Amount > 0;     // align on column
        exit(Result);
    end;
}
```

Unusual whitespace and comments are intentional — the printer must preserve them byte-for-byte when no rewrite targets the surrounding nodes.

- [ ] **Step 2: Write failing test**

Create `packages/engine/tests/ast/printer.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst } from "../../src/ast/syntax-node";
import { print, printWithRewrites } from "../../src/ast/printer";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("printer", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function loadFixture(name: string): Promise<string> {
    return readFile(
      resolve(__dirname, `../fixtures/al/${name}`),
      "utf8",
    );
  }

  it("round-trips a file byte-identical without rewrites", async () => {
    const source = await loadFixture("comments-and-spacing.al");
    const tree = parseAL(source);
    const output = print(source, wrapRoot(tree));
    expect(output).toBe(source);
  });

  it("replaces a single node via printWithRewrites, preserving surroundings", async () => {
    const source = await loadFixture("simple-codeunit.al");
    const tree = parseAL(source);
    const root = wrapRoot(tree);
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    const output = printWithRewrites(source, root, new Map([
      [exit, "exit(0);"],
    ]));
    expect(output).toContain("exit(0);");
    expect(output).not.toContain("Value * 2");
    expect(output.split("\n").length).toBe(source.split("\n").length);
  });

  it("composes multiple rewrites in document order", async () => {
    const source = await loadFixture("comments-and-spacing.al");
    const tree = parseAL(source);
    const root = wrapRoot(tree);
    const resultAssign = findFirst(root, ALNodeKind.assignment_statement)!;
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    const output = printWithRewrites(source, root, new Map([
      [resultAssign, "Result := Amount >= 0;"],
      [exit, "exit(not Result);"],
    ]));
    expect(output).toContain("Amount >= 0");
    expect(output).toContain("not Result");
    expect(output).toContain("// trailing comment");
    expect(output).toContain("// inside-block comment");
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun test packages/engine/tests/ast/printer.test.ts`
Expected: module-not-found failure.

- [ ] **Step 4: Implement `printer.ts`**

Create `packages/engine/src/ast/printer.ts`:
```typescript
import type { ALSyntaxNode } from "./syntax-node";

export function print(source: string, _root: ALSyntaxNode): string {
  // unmodified round-trip is just the original source
  return source;
}

export function printWithRewrites(
  source: string,
  root: ALSyntaxNode,
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
): string {
  if (rewrites.size === 0) return source;

  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [node, replacement] of rewrites) {
    assertNodeInTree(node, root);
    edits.push({
      start: node.startIndex,
      end: node.endIndex,
      replacement,
    });
  }

  edits.sort((a, b) => a.start - b.start);
  assertNoOverlap(edits);

  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start));
    parts.push(edit.replacement);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function assertNodeInTree(node: ALSyntaxNode, root: ALSyntaxNode): void {
  if (node.startIndex < root.startIndex || node.endIndex > root.endIndex) {
    throw new Error(
      `rewrite target at ${node.startIndex}..${node.endIndex} is outside root ${root.startIndex}..${root.endIndex}`,
    );
  }
}

function assertNoOverlap(
  edits: ReadonlyArray<{ start: number; end: number }>,
): void {
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1];
    const curr = edits[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr.start < prev.end) {
      throw new Error(
        `overlapping rewrites at ${prev.start}..${prev.end} and ${curr.start}..${curr.end}`,
      );
    }
  }
}
```

- [ ] **Step 5: Run test, confirm pass**

Run: `bun test packages/engine/tests/ast/printer.test.ts`
Expected: all three tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/ast/printer.ts \
        packages/engine/tests/ast/printer.test.ts \
        packages/engine/tests/fixtures/al/comments-and-spacing.al
git commit -m "feat(engine): formatting-preserving printer with rewrite support"
```

---

## Task 6: AST subtree hash

**Files:**
- Create: `packages/engine/src/ast/hash.ts`
- Create: `packages/engine/tests/ast/hash.test.ts`
- Create: `packages/engine/tests/fixtures/al/hash-equiv-formatting.al`
- Create: `packages/engine/tests/fixtures/al/hash-differs-operator.al`

Per design §5.1: `ast_subtree_hash(node)` is "normalized hash of the mutation target subtree (whitespace stripped, local variable names canonicalized to positional ids, comments dropped)". This is the identity anchor used both by history filtering and AST canonicalization.

- [ ] **Step 1: Create fixtures**

`packages/engine/tests/fixtures/al/hash-equiv-formatting.al`:
```al
codeunit 50102 "Hash A"
{
    procedure CheckA(xyz: Integer): Boolean
    begin
        exit(xyz >   0);
    end;
}
```

`packages/engine/tests/fixtures/al/hash-differs-operator.al`:
```al
codeunit 50103 "Hash B"
{
    procedure CheckB(abc: Integer): Boolean
    begin
        exit(abc >= 0);
    end;
}
```

Whitespace and local-param name differ between these two files. Same AST shape for the `>` expression in the first, different operator in the second. Hash should equal a third fixture (below) and differ from this one.

Also create `packages/engine/tests/fixtures/al/hash-equiv-rename.al`:
```al
codeunit 50104 "Hash C"
{
    procedure CheckC(renamed: Integer): Boolean
    begin
        exit(renamed > 0);
    end;
}
```

- [ ] **Step 2: Write failing test**

Create `packages/engine/tests/ast/hash.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst } from "../../src/ast/syntax-node";
import { astSubtreeHash } from "../../src/ast/hash";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("astSubtreeHash", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function hashExitExpr(fixture: string): Promise<string> {
    const source = await readFile(
      resolve(__dirname, `../fixtures/al/${fixture}`),
      "utf8",
    );
    const root = wrapRoot(parseAL(source));
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    const inner = findFirst(exit, ALNodeKind.binary_expression)!;
    return astSubtreeHash(inner);
  }

  it("is invariant under whitespace differences", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    const c = await hashExitExpr("hash-equiv-rename.al");
    expect(a).toBe(c);
  });

  it("is invariant under local-identifier rename", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    const c = await hashExitExpr("hash-equiv-rename.al");
    expect(a).toBe(c);
  });

  it("differs when the operator changes", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    const b = await hashExitExpr("hash-differs-operator.al");
    expect(a).not.toBe(b);
  });

  it("produces a deterministic fixed-length hex hash", async () => {
    const a = await hashExitExpr("hash-equiv-formatting.al");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun test packages/engine/tests/ast/hash.test.ts`
Expected: fails with module-not-found.

- [ ] **Step 4: Implement `hash.ts`**

Create `packages/engine/src/ast/hash.ts`:
```typescript
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { ALSyntaxNode } from "./syntax-node";
import { ALNodeKind } from "./node-kinds";

export function astSubtreeHash(node: ALSyntaxNode): string {
  const scope = new Map<string, number>();
  const canonical = serializeCanonical(node, scope);
  return bytesToHex(blake3(utf8ToBytes(canonical)));
}

function serializeCanonical(
  node: ALSyntaxNode,
  scope: Map<string, number>,
): string {
  if (node.kind === ALNodeKind.identifier) {
    const text = node.text;
    if (!scope.has(text)) {
      scope.set(text, scope.size);
    }
    return `(identifier #${scope.get(text)})`;
  }

  if (isLiteral(node.kind)) {
    return `(${node.kind} ${node.text})`;
  }

  const parts: string[] = [`(${node.kind}`];
  for (const child of node.namedChildren) {
    parts.push(" ");
    parts.push(serializeCanonical(child, scope));
  }
  parts.push(")");
  return parts.join("");
}

function isLiteral(kind: string): boolean {
  return (
    kind === ALNodeKind.integer_literal ||
    kind === ALNodeKind.decimal_literal ||
    kind === ALNodeKind.text_literal ||
    kind === ALNodeKind.boolean_literal
  );
}
```

Identifier canonicalization uses a scope-local positional id: the first identifier encountered is `#0`, second distinct `#1`, etc. A rename of the parameter name is absorbed. Literal values participate in the hash (different literal → different hash), per design §5.1 ("changes when the expression's structure or operators change"). Comments are implicitly dropped — tree-sitter does not include comments as named children of expressions.

- [ ] **Step 5: Run test, confirm pass**

Run: `bun test packages/engine/tests/ast/hash.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/ast/hash.ts \
        packages/engine/tests/ast/hash.test.ts \
        packages/engine/tests/fixtures/al/hash-equiv-formatting.al \
        packages/engine/tests/fixtures/al/hash-differs-operator.al \
        packages/engine/tests/fixtures/al/hash-equiv-rename.al
git commit -m "feat(engine): ast_subtree_hash with normalized identifier+whitespace"
```

---

## Task 7: AST canonicalization rules

**Files:**
- Create: `packages/engine/src/ast/canonicalization.ts`
- Create: `packages/engine/tests/ast/canonicalization.test.ts`

Per design §7: canonicalization is a small auditable ruleset for syntactic equivalence detection. Each rule preserves semantics and takes an AST node + returns a canonical AST representation. Layer 1 ships a minimal ruleset; subsequent mutation operators can add rules.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/ast/canonicalization.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst } from "../../src/ast/syntax-node";
import { canonicalize, type CanonicalForm } from "../../src/ast/canonicalization";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("canonicalize", () => {
  beforeAll(async () => {
    await initParser();
  });

  function canon(expressionInCodeunit: string): CanonicalForm {
    const src = `codeunit 50200 "T" { procedure P(): Boolean begin exit(${expressionInCodeunit}); end; }`;
    const root = wrapRoot(parseAL(src));
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    return canonicalize(findFirst(exit, ALNodeKind.binary_expression) ?? findFirst(exit, ALNodeKind.unary_expression)!);
  }

  it("strips parentheses that do not affect precedence", () => {
    const a = canon("(1 + 2)");
    const b = canon("1 + 2");
    expect(a.form).toBe(b.form);
  });

  it("normalizes double-negation", () => {
    const a = canon("not not true");
    const b = canon("true");
    expect(a.form).toBe(b.form);
  });

  it("treats commutative operators in canonical operand order", () => {
    const a = canon("1 + x");
    const b = canon("x + 1");
    expect(a.form).toBe(b.form);
  });

  it("does NOT equate non-equivalent expressions", () => {
    const a = canon("1 + 2");
    const b = canon("1 + 3");
    expect(a.form).not.toBe(b.form);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/ast/canonicalization.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `canonicalization.ts`**

Create `packages/engine/src/ast/canonicalization.ts`:
```typescript
import type { ALSyntaxNode } from "./syntax-node";
import { ALNodeKind } from "./node-kinds";

export interface CanonicalForm {
  readonly form: string;
}

const COMMUTATIVE: ReadonlySet<string> = new Set([
  "+",
  "*",
  "=",
  "<>",
  "and",
  "or",
  "xor",
]);

export function canonicalize(node: ALSyntaxNode): CanonicalForm {
  return { form: canon(node) };
}

function canon(node: ALSyntaxNode): string {
  const stripped = stripParens(node);

  if (stripped.kind === ALNodeKind.unary_expression) {
    const operator = firstChildTextByRole(stripped, "operator");
    const operand = stripped.childForFieldName("operand") ?? stripped.namedChildren[0];
    if (operator === "not" && operand !== undefined) {
      const inner = stripParens(operand);
      if (
        inner.kind === ALNodeKind.unary_expression &&
        firstChildTextByRole(inner, "operator") === "not"
      ) {
        const innerOperand =
          inner.childForFieldName("operand") ?? inner.namedChildren[0];
        if (innerOperand !== undefined) {
          return canon(innerOperand);
        }
      }
    }
    return `(unary ${operator} ${operand === undefined ? "" : canon(operand)})`;
  }

  if (stripped.kind === ALNodeKind.binary_expression) {
    const operator = firstChildTextByRole(stripped, "operator");
    const left = stripped.childForFieldName("left") ?? stripped.namedChildren[0];
    const right = stripped.childForFieldName("right") ?? stripped.namedChildren[1];
    if (left === undefined || right === undefined) {
      return `(binary ${operator})`;
    }
    const lc = canon(left);
    const rc = canon(right);
    if (operator !== null && COMMUTATIVE.has(operator)) {
      const [a, b] = lc <= rc ? [lc, rc] : [rc, lc];
      return `(binary ${operator} ${a} ${b})`;
    }
    return `(binary ${operator} ${lc} ${rc})`;
  }

  return `(${stripped.kind} ${stripped.text.trim()})`;
}

function stripParens(node: ALSyntaxNode): ALSyntaxNode {
  let current = node;
  while (
    current.kind === ALNodeKind.parenthesized_expression &&
    current.namedChildren.length === 1
  ) {
    const inner = current.namedChildren[0];
    if (inner === undefined) break;
    current = inner;
  }
  return current;
}

function firstChildTextByRole(
  node: ALSyntaxNode,
  fieldName: string,
): string | null {
  const child = node.childForFieldName(fieldName);
  if (child !== null) return child.text;
  for (const c of node.children) {
    if (c.fieldName === fieldName) return c.text;
  }
  return null;
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/ast/canonicalization.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/ast/canonicalization.ts \
        packages/engine/tests/ast/canonicalization.test.ts
git commit -m "feat(engine): AST canonicalization (parens, double-not, commutative)"
```

---

## Task 8: Symbol table

**Files:**
- Create: `packages/engine/src/semantic/symbol-table.ts`
- Create: `packages/engine/tests/semantic/symbol-table.test.ts`
- Create: `packages/engine/tests/fixtures/al/procedure-with-vars.al`

The symbol table answers: for a given identifier reference in an AL source, what does it resolve to — procedure parameter, local var, global codeunit var, procedure, field of a known table?

Layer 1 implements a project-local table: all codeunits, tables, pages, reports in the parsed project are visible. Base-app and system-app symbols are **out of scope** for Layer 1 (we lack access to Microsoft's symbol files here). Identifiers that don't resolve locally are marked `unresolved`. Downstream code treats unresolved identifiers as "external," which is correct for mutation testing — we don't mutate what we can't see.

- [ ] **Step 1: Create fixture `procedure-with-vars.al`**

```al
codeunit 50105 "Vars Test"
{
    var
        GlobalCount: Integer;

    procedure Compute(Input: Integer): Integer
    var
        Local: Integer;
    begin
        Local := Input * 2;
        GlobalCount := GlobalCount + 1;
        exit(Local + GlobalCount);
    end;
}
```

- [ ] **Step 2: Write failing test**

Create `packages/engine/tests/semantic/symbol-table.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";

describe("buildSymbolTable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("registers a codeunit by id and name", async () => {
    const src = await readFile(
      resolve(__dirname, "../fixtures/al/procedure-with-vars.al"),
      "utf8",
    );
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    const cu = table.resolveObject({ kind: "codeunit", idOrName: "50105" });
    expect(cu).not.toBeNull();
    expect(cu!.name).toBe("Vars Test");
    expect(cu!.id).toBe(50105);
  });

  it("registers a procedure within a codeunit", async () => {
    const src = await readFile(
      resolve(__dirname, "../fixtures/al/procedure-with-vars.al"),
      "utf8",
    );
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    const proc = table.resolveProcedure("Vars Test", "Compute");
    expect(proc).not.toBeNull();
    expect(proc!.parameters.map((p) => p.name)).toEqual(["Input"]);
  });

  it("distinguishes global vars from procedure-local vars", async () => {
    const src = await readFile(
      resolve(__dirname, "../fixtures/al/procedure-with-vars.al"),
      "utf8",
    );
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    const globals = table.globalsOf("Vars Test");
    expect(globals.map((g) => g.name)).toEqual(["GlobalCount"]);
    const locals = table.localsOf("Vars Test", "Compute");
    expect(locals.map((l) => l.name)).toEqual(["Local"]);
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun test packages/engine/tests/semantic/symbol-table.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement `symbol-table.ts`**

Create `packages/engine/src/semantic/symbol-table.ts`:
```typescript
import type { ALSyntaxNode } from "../ast/syntax-node";
import { ALNodeKind } from "../ast/node-kinds";
import { findAll } from "../ast/syntax-node";

export interface SourceFile {
  readonly path: string;
  readonly root: ALSyntaxNode;
}

export interface ObjectSymbol {
  readonly kind: "codeunit" | "table" | "page" | "report";
  readonly id: number;
  readonly name: string;
  readonly node: ALSyntaxNode;
}

export interface ProcedureSymbol {
  readonly name: string;
  readonly owner: string;
  readonly parameters: readonly VarSymbol[];
  readonly locals: readonly VarSymbol[];
  readonly returnType: string | null;
  readonly node: ALSyntaxNode;
}

export interface VarSymbol {
  readonly name: string;
  readonly typeText: string;
  readonly node: ALSyntaxNode;
}

export interface SymbolTable {
  resolveObject(q: { kind: ObjectSymbol["kind"]; idOrName: string }): ObjectSymbol | null;
  resolveProcedure(ownerName: string, procName: string): ProcedureSymbol | null;
  globalsOf(ownerName: string): readonly VarSymbol[];
  localsOf(ownerName: string, procName: string): readonly VarSymbol[];
  readonly objects: readonly ObjectSymbol[];
}

export function buildSymbolTable(files: readonly SourceFile[]): SymbolTable {
  const objects: ObjectSymbol[] = [];
  const procedures = new Map<string, ProcedureSymbol[]>();
  const globals = new Map<string, VarSymbol[]>();

  for (const file of files) {
    for (const objectNode of file.root.children) {
      const header = parseObjectHeader(objectNode);
      if (header === null) continue;
      objects.push({ ...header, node: objectNode });

      const varSection = objectNode.namedChildren.find(
        (c) => c.kind === ALNodeKind.var_section,
      );
      if (varSection !== undefined) {
        globals.set(header.name, collectVarDeclarations(varSection));
      }

      const procs: ProcedureSymbol[] = [];
      for (const procNode of findAll(objectNode, ALNodeKind.procedure)) {
        const proc = parseProcedure(procNode, header.name);
        if (proc !== null) procs.push(proc);
      }
      procedures.set(header.name, procs);
    }
  }

  return {
    resolveObject({ kind, idOrName }) {
      const id = Number.parseInt(idOrName, 10);
      for (const o of objects) {
        if (o.kind !== kind) continue;
        if (!Number.isNaN(id) && o.id === id) return o;
        if (o.name === idOrName) return o;
      }
      return null;
    },
    resolveProcedure(ownerName, procName) {
      const list = procedures.get(ownerName);
      if (list === undefined) return null;
      return list.find((p) => p.name === procName) ?? null;
    },
    globalsOf(ownerName) {
      return globals.get(ownerName) ?? [];
    },
    localsOf(ownerName, procName) {
      return this.resolveProcedure(ownerName, procName)?.locals ?? [];
    },
    objects,
  };
}

function parseObjectHeader(
  node: ALSyntaxNode,
): { kind: ObjectSymbol["kind"]; id: number; name: string } | null {
  const kindMap: Record<string, ObjectSymbol["kind"]> = {
    [ALNodeKind.codeunit]: "codeunit",
    [ALNodeKind.table]: "table",
    [ALNodeKind.page]: "page",
    [ALNodeKind.report]: "report",
  };
  const kind = kindMap[node.kind];
  if (kind === undefined) return null;

  const idNode = node.childForFieldName("id");
  const nameNode = node.childForFieldName("name");
  if (idNode === null || nameNode === null) return null;

  const id = Number.parseInt(idNode.text, 10);
  const name = nameNode.text.replace(/^"|"$/g, "");
  return { kind, id, name };
}

function parseProcedure(
  node: ALSyntaxNode,
  owner: string,
): ProcedureSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return null;

  const paramsNode = node.childForFieldName("parameters");
  const parameters: VarSymbol[] =
    paramsNode === null ? [] : collectParameters(paramsNode);

  const varSection = node.namedChildren.find(
    (c) => c.kind === ALNodeKind.var_section,
  );
  const locals = varSection === undefined ? [] : collectVarDeclarations(varSection);

  const returnTypeNode = node.childForFieldName("return_type");
  const returnType = returnTypeNode === null ? null : returnTypeNode.text;

  return {
    name: nameNode.text,
    owner,
    parameters,
    locals,
    returnType,
    node,
  };
}

function collectParameters(paramsNode: ALSyntaxNode): VarSymbol[] {
  const out: VarSymbol[] = [];
  for (const p of findAll(paramsNode, ALNodeKind.parameter)) {
    const name = p.childForFieldName("name")?.text ?? "";
    const type = p.childForFieldName("type")?.text ?? "";
    if (name !== "") out.push({ name, typeText: type, node: p });
  }
  return out;
}

function collectVarDeclarations(varSection: ALSyntaxNode): VarSymbol[] {
  const out: VarSymbol[] = [];
  for (const decl of findAll(varSection, ALNodeKind.variable_declaration)) {
    const name = decl.childForFieldName("name")?.text ?? "";
    const type = decl.childForFieldName("type")?.text ?? "";
    if (name !== "") out.push({ name, typeText: type, node: decl });
  }
  return out;
}
```

- [ ] **Step 5: Run test, confirm pass**

Run: `bun test packages/engine/tests/semantic/symbol-table.test.ts`
Expected: pass. If field names differ in the vendored grammar, adjust `childForFieldName("id")`, `("name")`, etc. to match — document the mapping in a comment at top of `symbol-table.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/semantic/symbol-table.ts \
        packages/engine/tests/semantic/symbol-table.test.ts \
        packages/engine/tests/fixtures/al/procedure-with-vars.al
git commit -m "feat(engine): project-local symbol table (codeunits, procs, vars)"
```

---

## Task 9: Control flow graph

**Files:**
- Create: `packages/engine/src/semantic/cfg.ts`
- Create: `packages/engine/tests/semantic/cfg.test.ts`
- Create: `packages/engine/tests/fixtures/al/branching.al`

CFG is per-procedure. Node = basic block (linear sequence). Edges = control transitions (branch, fall-through, exit). Used later by dataflow advisories in §7 and by unreachable-mutation-site detection in §3.3.

- [ ] **Step 1: Create fixture `branching.al`**

```al
codeunit 50106 "Branching"
{
    procedure Classify(n: Integer): Integer
    begin
        if n > 0 then
            exit(1);
        if n < 0 then
            exit(-1);
        exit(0);
    end;
}
```

- [ ] **Step 2: Write failing test**

Create `packages/engine/tests/semantic/cfg.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findAll } from "../../src/ast/syntax-node";
import { buildCFG } from "../../src/semantic/cfg";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("buildCFG", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function cfgOf(fixture: string, procIndex = 0) {
    const src = await readFile(
      resolve(__dirname, `../fixtures/al/${fixture}`),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const proc = findAll(root, ALNodeKind.procedure)[procIndex]!;
    return buildCFG(proc);
  }

  it("produces an entry block and an exit block", async () => {
    const cfg = await cfgOf("branching.al");
    expect(cfg.entry).toBeDefined();
    expect(cfg.exit).toBeDefined();
  });

  it("includes three exit paths for the branching fixture", async () => {
    const cfg = await cfgOf("branching.al");
    const exitBlocks = cfg.blocks.filter((b) =>
      b.successors.includes(cfg.exit),
    );
    expect(exitBlocks.length).toBe(3);
  });

  it("marks unreachable blocks when they exist", async () => {
    const src = `codeunit 50107 "U" { procedure P(): Integer begin exit(1); exit(2); end; }`;
    const root = wrapRoot(parseAL(src));
    const proc = findAll(root, ALNodeKind.procedure)[0]!;
    const cfg = buildCFG(proc);
    expect(cfg.blocks.some((b) => !b.reachable)).toBe(true);
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun test packages/engine/tests/semantic/cfg.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement `cfg.ts`**

Create `packages/engine/src/semantic/cfg.ts`:
```typescript
import type { ALSyntaxNode } from "../ast/syntax-node";
import { ALNodeKind } from "../ast/node-kinds";

export interface CFG {
  readonly entry: BasicBlock;
  readonly exit: BasicBlock;
  readonly blocks: readonly BasicBlock[];
}

export interface BasicBlock {
  readonly id: number;
  readonly statements: readonly ALSyntaxNode[];
  readonly successors: BasicBlock[];
  readonly reachable: boolean;
}

export function buildCFG(procedure: ALSyntaxNode): CFG {
  const body = procedure.namedChildren.find((c) => c.kind === ALNodeKind.block);
  const builder = new Builder();
  const entry = builder.newBlock();
  const exit = builder.newBlock();
  if (body === undefined) {
    entry.successors.push(exit);
    builder.markReachable(entry);
    builder.markReachable(exit);
    return builder.finalize(entry, exit);
  }
  const tails = builder.emitBlock(body, entry, exit);
  for (const tail of tails) {
    if (!tail.successors.includes(exit)) tail.successors.push(exit);
  }
  builder.markReachable(entry);
  return builder.finalize(entry, exit);
}

class Builder {
  private readonly allBlocks: MutableBlock[] = [];

  newBlock(): MutableBlock {
    const block: MutableBlock = {
      id: this.allBlocks.length,
      statements: [],
      successors: [],
      reachable: false,
    };
    this.allBlocks.push(block);
    return block;
  }

  emitBlock(
    block: ALSyntaxNode,
    current: MutableBlock,
    exitBlock: MutableBlock,
  ): MutableBlock[] {
    let tails: MutableBlock[] = [current];
    for (const stmt of block.namedChildren) {
      tails = this.emitStatement(stmt, tails, exitBlock);
      if (tails.length === 0) break;
    }
    return tails;
  }

  emitStatement(
    stmt: ALSyntaxNode,
    tails: MutableBlock[],
    exitBlock: MutableBlock,
  ): MutableBlock[] {
    if (stmt.kind === ALNodeKind.if_statement) {
      const thenBranch = stmt.childForFieldName("consequence");
      const elseBranch = stmt.childForFieldName("alternative");
      const merged = this.newBlock();
      for (const tail of tails) {
        tail.statements.push(stmt);
        const thenStart = this.newBlock();
        tail.successors.push(thenStart);
        const thenTails = thenBranch === null
          ? [thenStart]
          : this.emitStatement(thenBranch, [thenStart], exitBlock);
        for (const t of thenTails) t.successors.push(merged);

        if (elseBranch !== null) {
          const elseStart = this.newBlock();
          tail.successors.push(elseStart);
          const elseTails = this.emitStatement(elseBranch, [elseStart], exitBlock);
          for (const t of elseTails) t.successors.push(merged);
        } else {
          tail.successors.push(merged);
        }
      }
      return [merged];
    }

    if (stmt.kind === ALNodeKind.exit_statement) {
      for (const tail of tails) {
        tail.statements.push(stmt);
        tail.successors.push(exitBlock);
      }
      return [];
    }

    if (stmt.kind === ALNodeKind.block) {
      let current = tails;
      for (const inner of stmt.namedChildren) {
        current = this.emitStatement(inner, current, exitBlock);
        if (current.length === 0) return [];
      }
      return current;
    }

    for (const tail of tails) tail.statements.push(stmt);
    return tails;
  }

  markReachable(from: MutableBlock): void {
    const visited = new Set<number>();
    const queue: MutableBlock[] = [from];
    while (queue.length > 0) {
      const block = queue.shift() as MutableBlock;
      if (visited.has(block.id)) continue;
      visited.add(block.id);
      block.reachable = true;
      for (const succ of block.successors) {
        queue.push(succ as MutableBlock);
      }
    }
  }

  finalize(entry: MutableBlock, exit: MutableBlock): CFG {
    return {
      entry,
      exit,
      blocks: this.allBlocks.slice(),
    };
  }
}

interface MutableBlock {
  id: number;
  statements: ALSyntaxNode[];
  successors: MutableBlock[];
  reachable: boolean;
}
```

Single responsibility: produce a CFG scoped to one procedure with if-statement and exit-statement handling. Loops and case-statements are not yet modeled; a TODO-less follow-up task would add them when operators that need loop-level reasoning arrive (Tier 2 operators in Layer 6).

- [ ] **Step 5: Run test, confirm pass**

Run: `bun test packages/engine/tests/semantic/cfg.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/semantic/cfg.ts \
        packages/engine/tests/semantic/cfg.test.ts \
        packages/engine/tests/fixtures/al/branching.al
git commit -m "feat(engine): CFG builder (if / exit / reachability)"
```

---

## Task 10: Type table

**Files:**
- Create: `packages/engine/src/semantic/types.ts`
- Create: `packages/engine/tests/semantic/types.test.ts`

The type table answers: what is the AL type of this expression? Layer 1 implements this for literals, identifiers (resolved via symbol table), and binary/unary expressions over built-in types. Operator equivalence checks and dataflow advisories consume it.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/semantic/types.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { buildTypeTable } from "../../src/semantic/types";
import { ALNodeKind } from "../../src/ast/node-kinds";

async function typeOfExitExpr(codeunitSrc: string): Promise<string | null> {
  const root = wrapRoot(parseAL(codeunitSrc));
  const symbols = buildSymbolTable([{ path: "t.al", root }]);
  const types = buildTypeTable([{ path: "t.al", root }], symbols);
  const exit = findFirst(root, ALNodeKind.exit_statement)!;
  const inner = exit.namedChildren[0]!;
  return types.typeOf(inner);
}

describe("buildTypeTable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("types a literal integer expression as Integer", async () => {
    expect(await typeOfExitExpr(
      `codeunit 50300 "T" { procedure P(): Integer begin exit(42); end; }`,
    )).toBe("Integer");
  });

  it("types a decimal literal as Decimal", async () => {
    expect(await typeOfExitExpr(
      `codeunit 50301 "T" { procedure P(): Decimal begin exit(1.5); end; }`,
    )).toBe("Decimal");
  });

  it("types a comparison as Boolean", async () => {
    expect(await typeOfExitExpr(
      `codeunit 50302 "T" { procedure P(): Boolean begin exit(1 > 0); end; }`,
    )).toBe("Boolean");
  });

  it("returns null for unresolvable identifiers", async () => {
    expect(await typeOfExitExpr(
      `codeunit 50303 "T" { procedure P(): Integer begin exit(UnknownVar); end; }`,
    )).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/semantic/types.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `types.ts`**

Create `packages/engine/src/semantic/types.ts`:
```typescript
import type { ALSyntaxNode } from "../ast/syntax-node";
import { ALNodeKind } from "../ast/node-kinds";
import type { SourceFile, SymbolTable } from "./symbol-table";

export interface TypeTable {
  typeOf(node: ALSyntaxNode): string | null;
}

export function buildTypeTable(
  _files: readonly SourceFile[],
  symbols: SymbolTable,
): TypeTable {
  return {
    typeOf(node) {
      return computeType(node, symbols);
    },
  };
}

function computeType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  switch (node.kind) {
    case ALNodeKind.integer_literal:
      return "Integer";
    case ALNodeKind.decimal_literal:
      return "Decimal";
    case ALNodeKind.text_literal:
      return "Text";
    case ALNodeKind.boolean_literal:
      return "Boolean";
    case ALNodeKind.parenthesized_expression: {
      const inner = node.namedChildren[0];
      return inner === undefined ? null : computeType(inner, symbols);
    }
    case ALNodeKind.binary_expression:
      return binaryType(node, symbols);
    case ALNodeKind.unary_expression: {
      const operand = node.childForFieldName("operand") ?? node.namedChildren[0];
      if (operand === undefined) return null;
      const inner = computeType(operand, symbols);
      const op = node.childForFieldName("operator")?.text;
      if (op === "not") return "Boolean";
      if (op === "-" || op === "+") return inner;
      return inner;
    }
    case ALNodeKind.identifier:
      return resolveIdentifierType(node, symbols);
    default:
      return null;
  }
}

function binaryType(node: ALSyntaxNode, symbols: SymbolTable): string | null {
  const op = node.childForFieldName("operator")?.text ?? "";
  const left = node.childForFieldName("left") ?? node.namedChildren[0];
  const right = node.childForFieldName("right") ?? node.namedChildren[1];
  if (left === undefined || right === undefined) return null;

  const comparison = new Set([
    "<", "<=", ">", ">=", "=", "<>",
  ]);
  const logical = new Set(["and", "or", "xor"]);
  if (comparison.has(op) || logical.has(op)) return "Boolean";

  const leftType = computeType(left, symbols);
  const rightType = computeType(right, symbols);
  if (leftType === null || rightType === null) return null;
  if (leftType === rightType) return leftType;
  if (
    (leftType === "Integer" && rightType === "Decimal") ||
    (leftType === "Decimal" && rightType === "Integer")
  ) {
    return "Decimal";
  }
  return leftType;
}

function resolveIdentifierType(
  node: ALSyntaxNode,
  symbols: SymbolTable,
): string | null {
  for (const obj of symbols.objects) {
    const proc = findEnclosingProcedure(node, obj.node);
    if (proc === null) continue;
    const procSym = symbols.resolveProcedure(obj.name, proc);
    if (procSym === null) continue;
    const local = procSym.locals.find((v) => v.name === node.text);
    if (local !== undefined) return extractType(local.typeText);
    const param = procSym.parameters.find((p) => p.name === node.text);
    if (param !== undefined) return extractType(param.typeText);
    const global = symbols.globalsOf(obj.name).find((g) => g.name === node.text);
    if (global !== undefined) return extractType(global.typeText);
    return null;
  }
  return null;
}

function findEnclosingProcedure(
  node: ALSyntaxNode,
  objectNode: ALSyntaxNode,
): string | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null && current !== objectNode) {
    if (current.kind === ALNodeKind.procedure) {
      return current.childForFieldName("name")?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}

function extractType(typeText: string): string {
  return typeText.split(/\s+/)[0] ?? typeText;
}
```

Base-app types (e.g., `Record`, `Codeunit` as variables) are not resolved in Layer 1. `resolveIdentifierType` returns `null` when it can't resolve — the contract for downstream code is clear: `null` means "external, don't mutate based on type assumptions."

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/semantic/types.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/semantic/types.ts \
        packages/engine/tests/semantic/types.test.ts
git commit -m "feat(engine): type table for literals, identifiers, expressions"
```

---

## Task 11: Caller lookup

**Files:**
- Create: `packages/engine/src/semantic/callers.ts`
- Create: `packages/engine/tests/semantic/callers.test.ts`
- Create: `packages/engine/tests/fixtures/al/caller-chain.al`

Given a procedure symbol, return all call sites that invoke it. Used by operators that need to know "is this procedure's return value observed anywhere" and by dataflow advisories.

- [ ] **Step 1: Create fixture `caller-chain.al`**

```al
codeunit 50108 "Callers"
{
    procedure Helper(): Integer
    begin
        exit(1);
    end;

    procedure Direct(): Integer
    begin
        exit(Helper());
    end;

    procedure Indirect(): Integer
    begin
        exit(Direct() + Helper());
    end;
}
```

- [ ] **Step 2: Write failing test**

Create `packages/engine/tests/semantic/callers.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { buildCallerIndex } from "../../src/semantic/callers";

describe("buildCallerIndex", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("indexes direct and indirect callers of Helper", async () => {
    const src = await readFile(
      resolve(__dirname, "../fixtures/al/caller-chain.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "c.al", root }]);
    const callers = buildCallerIndex([{ path: "c.al", root }], symbols);
    const helperCalls = callers.callersOf("Callers", "Helper");
    const names = helperCalls.map((c) => c.fromProcedure).sort();
    expect(names).toEqual(["Direct", "Indirect"]);
  });

  it("returns empty list for an uncalled procedure", async () => {
    const src = `codeunit 50109 "U" { procedure Unused(): Integer begin exit(0); end; }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "u.al", root }]);
    const callers = buildCallerIndex([{ path: "u.al", root }], symbols);
    expect(callers.callersOf("U", "Unused")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `bun test packages/engine/tests/semantic/callers.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement `callers.ts`**

Create `packages/engine/src/semantic/callers.ts`:
```typescript
import type { ALSyntaxNode } from "../ast/syntax-node";
import { findAll } from "../ast/syntax-node";
import { ALNodeKind } from "../ast/node-kinds";
import type { SourceFile, SymbolTable } from "./symbol-table";

export interface CallerIndex {
  callersOf(ownerName: string, procName: string): readonly CallSite[];
}

export interface CallSite {
  readonly fromOwner: string;
  readonly fromProcedure: string;
  readonly node: ALSyntaxNode;
}

export function buildCallerIndex(
  files: readonly SourceFile[],
  symbols: SymbolTable,
): CallerIndex {
  const index = new Map<string, CallSite[]>();

  for (const file of files) {
    for (const obj of symbols.objects) {
      if (!file.root.text.includes(obj.name)) continue;
      const calls = [
        ...findAll(obj.node, ALNodeKind.procedure_call),
        ...findAll(obj.node, ALNodeKind.method_call),
      ];
      for (const call of calls) {
        const target = resolveCallTarget(call, obj.name, symbols);
        if (target === null) continue;
        const enclosing = enclosingProcedureName(call);
        if (enclosing === null) continue;
        const key = siteKey(target.owner, target.procedure);
        const site: CallSite = {
          fromOwner: obj.name,
          fromProcedure: enclosing,
          node: call,
        };
        const list = index.get(key);
        if (list === undefined) index.set(key, [site]);
        else list.push(site);
      }
    }
  }

  return {
    callersOf(ownerName, procName) {
      return index.get(siteKey(ownerName, procName)) ?? [];
    },
  };
}

function siteKey(owner: string, proc: string): string {
  return `${owner}::${proc}`;
}

function resolveCallTarget(
  call: ALSyntaxNode,
  fallbackOwner: string,
  symbols: SymbolTable,
): { owner: string; procedure: string } | null {
  const nameNode = call.childForFieldName("name");
  if (nameNode === null) return null;
  const procName = nameNode.text;
  if (symbols.resolveProcedure(fallbackOwner, procName) === null) return null;
  return { owner: fallbackOwner, procedure: procName };
}

function enclosingProcedureName(node: ALSyntaxNode): string | null {
  let current: ALSyntaxNode | null = node;
  while (current !== null) {
    if (current.kind === ALNodeKind.procedure) {
      return current.childForFieldName("name")?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}
```

Cross-codeunit calls are out of scope for Layer 1's caller index — the `resolveCallTarget` only resolves within the fallback owner. Layer 6 expands this to handle qualified calls (`Codeunit.Procedure`) when Tier 2 operators need them.

- [ ] **Step 5: Run test, confirm pass**

Run: `bun test packages/engine/tests/semantic/callers.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/semantic/callers.ts \
        packages/engine/tests/semantic/callers.test.ts \
        packages/engine/tests/fixtures/al/caller-chain.al
git commit -m "feat(engine): intra-codeunit caller index"
```

---

## Task 12: SemanticContext composition

**Files:**
- Create: `packages/engine/src/semantic/context.ts`
- Create: `packages/engine/tests/semantic/context.test.ts`

`SemanticContext` bundles symbols + CFG + types + callers into the object operators consume. Matches the `SemanticContext` interface declared in design §4.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/semantic/context.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";

describe("buildSemanticContext", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("exposes symbols, types, callers, and cfg-for-procedure", async () => {
    const src = await readFile(
      resolve(__dirname, "../fixtures/al/caller-chain.al"),
      "utf8",
    );
    const ctx = buildSemanticContext([
      { path: "c.al", root: wrapRoot(parseAL(src)) },
    ]);
    expect(ctx.symbols.resolveProcedure("Callers", "Helper")).not.toBeNull();
    expect(ctx.callers.callersOf("Callers", "Helper").length).toBe(2);

    const helper = ctx.symbols.resolveProcedure("Callers", "Helper")!;
    const cfg = ctx.cfgFor(helper);
    expect(cfg.entry).toBeDefined();
    expect(cfg.exit).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/semantic/context.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `context.ts`**

Create `packages/engine/src/semantic/context.ts`:
```typescript
import type { CFG } from "./cfg";
import { buildCFG } from "./cfg";
import type { CallerIndex } from "./callers";
import { buildCallerIndex } from "./callers";
import type { ProcedureSymbol, SourceFile, SymbolTable } from "./symbol-table";
import { buildSymbolTable } from "./symbol-table";
import type { TypeTable } from "./types";
import { buildTypeTable } from "./types";

export interface SemanticContext {
  readonly symbols: SymbolTable;
  readonly types: TypeTable;
  readonly callers: CallerIndex;
  cfgFor(procedure: ProcedureSymbol): CFG;
}

export function buildSemanticContext(
  files: readonly SourceFile[],
): SemanticContext {
  const symbols = buildSymbolTable(files);
  const types = buildTypeTable(files, symbols);
  const callers = buildCallerIndex(files, symbols);
  const cfgCache = new WeakMap<object, CFG>();
  return {
    symbols,
    types,
    callers,
    cfgFor(procedure) {
      const cached = cfgCache.get(procedure);
      if (cached !== undefined) return cached;
      const cfg = buildCFG(procedure.node);
      cfgCache.set(procedure, cfg);
      return cfg;
    },
  };
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/semantic/context.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/semantic/context.ts \
        packages/engine/tests/semantic/context.test.ts
git commit -m "feat(engine): SemanticContext composition with CFG cache"
```

---

## Task 13: `MutationOperator` + `MutationSpec` types

**Files:**
- Create: `packages/engine/src/operator/interface.ts`
- Create: `packages/engine/tests/operator/interface.test.ts`

Defines the contract from design §4. No implementations — those live in Layer 3 and beyond. This task ships only the interfaces + a minimal `MutationSpec` smoke test that ensures the types compile cleanly against a stub operator.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/operator/interface.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import type {
  MutationOperator,
  MutationSpec,
  ConformanceCase,
} from "../../src/operator/interface";

describe("MutationOperator typing", () => {
  it("accepts a minimal valid operator shape", () => {
    const op: MutationOperator = {
      name: "test.op",
      version: "1.0.0",
      tier: "custom",
      targetNodeKinds: ["binary_expression"],
      producesNodeKinds: ["binary_expression"],
      requiresSemantic: [],
      targets: () => false,
      generate: () => [],
      conformanceTests: [] as ConformanceCase[],
    };
    expect(op.name).toBe("test.op");
  });

  it("MutationSpec carries parentContext required field", () => {
    const spec: MutationSpec = {
      operatorName: "test.op",
      operatorVersion: "1.0.0",
      astNodeId: "node-1",
      before: {} as never,
      after: {} as never,
      parentContext: "statement-position",
    };
    expect(spec.parentContext).toBe("statement-position");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/operator/interface.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `interface.ts`**

Create `packages/engine/src/operator/interface.ts`:
```typescript
import type { ALNodeKind } from "../ast/node-kinds";
import type { ALSyntaxNode } from "../ast/syntax-node";
import type { SemanticContext } from "../semantic/context";

export type SemanticCapability = "symbol-table" | "cfg" | "type-info";

export type ParentContextHint =
  | "statement-position"
  | "expression-position"
  | "short-circuit-operand";

export type EquivalenceHint = "likely-equivalent" | "unknown";

export type AstNodeId = string;

export interface MutationSpec {
  readonly operatorName: string;
  readonly operatorVersion: string;
  readonly astNodeId: AstNodeId;
  readonly before: ALSyntaxNode;
  readonly after: ALSyntaxNode;
  readonly parentContext: ParentContextHint;
  readonly equivalenceHint?: EquivalenceHint;
}

export interface ConformanceCase {
  readonly name: string;
  readonly sourceAL: string;
  readonly expectedSpecs: ReadonlyArray<{
    readonly parentContext: ParentContextHint;
    readonly beforeText: string;
    readonly afterText: string;
  }>;
}

export interface MutationOperator {
  readonly name: string;
  readonly version: string;
  readonly tier: 1 | 2 | 3 | "custom";

  readonly targetNodeKinds: readonly ALNodeKind[];
  readonly producesNodeKinds: readonly ALNodeKind[];
  readonly requiresSemantic: readonly SemanticCapability[];

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean;
  generate(node: ALSyntaxNode, ctx: SemanticContext): readonly MutationSpec[];
  isEquivalent?(spec: MutationSpec, ctx: SemanticContext): boolean;

  readonly conformanceTests: readonly ConformanceCase[];
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/operator/interface.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/operator/interface.ts \
        packages/engine/tests/operator/interface.test.ts
git commit -m "feat(engine): MutationOperator + MutationSpec contract types"
```

---

## Task 14: `MutationSpec` schema validation with zod

**Files:**
- Create: `packages/engine/src/operator/spec-validation.ts`
- Create: `packages/engine/tests/operator/spec-validation.test.ts`

Design §4 conformance gate step 3: "every returned spec must pass schema validation and compile through the wrap-lift-duplicate compiler." Layer 1 ships the schema validation half; the compile half ships in Layer 2.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/operator/spec-validation.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { validateSpec } from "../../src/operator/spec-validation";

describe("validateSpec", () => {
  const base = {
    operatorName: "test.op",
    operatorVersion: "1.0.0",
    astNodeId: "node-1",
    before: { kind: "binary_expression" },
    after: { kind: "binary_expression" },
    parentContext: "statement-position",
  };

  it("accepts a well-formed spec", () => {
    const result = validateSpec(base);
    expect(result.ok).toBe(true);
  });

  it("rejects a spec missing parentContext", () => {
    const { parentContext, ...bad } = base;
    const result = validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("parentContext");
    }
  });

  it("rejects a spec with an invalid parentContext value", () => {
    const result = validateSpec({ ...base, parentContext: "nowhere" });
    expect(result.ok).toBe(false);
  });

  it("rejects a spec with non-semver operator version", () => {
    const result = validateSpec({ ...base, operatorVersion: "v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("operatorVersion");
    }
  });

  it("accepts optional equivalenceHint when present", () => {
    const result = validateSpec({ ...base, equivalenceHint: "likely-equivalent" });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/operator/spec-validation.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `spec-validation.ts`**

Create `packages/engine/src/operator/spec-validation.ts`:
```typescript
import { z } from "zod";

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

const specSchema = z.object({
  operatorName: z.string().min(1),
  operatorVersion: z.string().regex(SEMVER),
  astNodeId: z.string().min(1),
  before: z.object({ kind: z.string() }).passthrough(),
  after: z.object({ kind: z.string() }).passthrough(),
  parentContext: z.enum([
    "statement-position",
    "expression-position",
    "short-circuit-operand",
  ]),
  equivalenceHint: z.enum(["likely-equivalent", "unknown"]).optional(),
});

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateSpec(raw: unknown): ValidationResult {
  const parsed = specSchema.safeParse(raw);
  if (parsed.success) return { ok: true };
  return { ok: false, error: formatZodError(parsed.error) };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/operator/spec-validation.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/operator/spec-validation.ts \
        packages/engine/tests/operator/spec-validation.test.ts
git commit -m "feat(engine): MutationSpec zod schema validation"
```

---

## Task 15: Operator registry

**Files:**
- Create: `packages/engine/src/operator/registry.ts`
- Create: `packages/engine/tests/operator/registry.test.ts`

The registry holds loaded operators in-process. It does **not** yet run the conformance gate — conformance + fuzz live in Layer 4's run driver, since they need the wrap-lift-duplicate compiler. The registry in Layer 1 is a manifest-validation-only holder.

- [ ] **Step 1: Write failing test**

Create `packages/engine/tests/operator/registry.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { createRegistry } from "../../src/operator/registry";
import type { MutationOperator } from "../../src/operator/interface";

function op(overrides: Partial<MutationOperator> = {}): MutationOperator {
  return {
    name: "test.op",
    version: "1.0.0",
    tier: "custom",
    targetNodeKinds: ["binary_expression"],
    producesNodeKinds: ["binary_expression"],
    requiresSemantic: [],
    targets: () => false,
    generate: () => [],
    conformanceTests: [],
    ...overrides,
  };
}

describe("registry", () => {
  it("registers a well-formed operator", () => {
    const reg = createRegistry();
    reg.register(op());
    expect(reg.list().map((o) => o.name)).toEqual(["test.op"]);
  });

  it("rejects a duplicate name+version", () => {
    const reg = createRegistry();
    reg.register(op());
    expect(() => reg.register(op())).toThrow(/already registered/);
  });

  it("accepts two versions of the same operator name", () => {
    const reg = createRegistry();
    reg.register(op({ version: "1.0.0" }));
    reg.register(op({ version: "2.0.0" }));
    expect(reg.list().length).toBe(2);
  });

  it("rejects a manifest with unknown ALNodeKind", () => {
    const reg = createRegistry();
    expect(() =>
      reg.register(
        op({ targetNodeKinds: ["not_a_real_kind" as never] }),
      ),
    ).toThrow(/unknown ALNodeKind/);
  });

  it("rejects non-semver version", () => {
    const reg = createRegistry();
    expect(() => reg.register(op({ version: "latest" }))).toThrow(/semver/);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/engine/tests/operator/registry.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `registry.ts`**

Create `packages/engine/src/operator/registry.ts`:
```typescript
import type { MutationOperator } from "./interface";
import { isALNodeKind } from "../ast/node-kinds";

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

export interface Registry {
  register(op: MutationOperator): void;
  list(): readonly MutationOperator[];
  get(name: string, version: string): MutationOperator | null;
}

export function createRegistry(): Registry {
  const key = (n: string, v: string) => `${n}@${v}`;
  const operators = new Map<string, MutationOperator>();

  return {
    register(op) {
      if (!SEMVER.test(op.version)) {
        throw new Error(
          `operator ${op.name}: version ${op.version} is not semver`,
        );
      }
      for (const kind of op.targetNodeKinds) {
        if (!isALNodeKind(kind)) {
          throw new Error(
            `operator ${op.name}: targetNodeKinds contains unknown ALNodeKind "${kind}"`,
          );
        }
      }
      for (const kind of op.producesNodeKinds) {
        if (!isALNodeKind(kind)) {
          throw new Error(
            `operator ${op.name}: producesNodeKinds contains unknown ALNodeKind "${kind}"`,
          );
        }
      }
      const k = key(op.name, op.version);
      if (operators.has(k)) {
        throw new Error(`operator ${k} already registered`);
      }
      operators.set(k, op);
    },
    list() {
      return Array.from(operators.values());
    },
    get(name, version) {
      return operators.get(key(name, version)) ?? null;
    },
  };
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/engine/tests/operator/registry.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/operator/registry.ts \
        packages/engine/tests/operator/registry.test.ts
git commit -m "feat(engine): operator registry with manifest validation"
```

---

## Task 16: Engine public exports

**Files:**
- Create: `packages/engine/src/index.ts`

- [ ] **Step 1: Write exports**

Create `packages/engine/src/index.ts`:
```typescript
// AST
export { initParser, parseAL } from "./ast/parser";
export { ALNodeKind, isALNodeKind } from "./ast/node-kinds";
export type { ALSyntaxNode } from "./ast/syntax-node";
export { wrapRoot, findFirst, findAll, visit } from "./ast/syntax-node";
export { print, printWithRewrites } from "./ast/printer";
export { astSubtreeHash } from "./ast/hash";
export { canonicalize } from "./ast/canonicalization";
export type { CanonicalForm } from "./ast/canonicalization";

// Semantic
export type {
  SourceFile,
  SymbolTable,
  ObjectSymbol,
  ProcedureSymbol,
  VarSymbol,
} from "./semantic/symbol-table";
export { buildSymbolTable } from "./semantic/symbol-table";
export type { CFG, BasicBlock } from "./semantic/cfg";
export { buildCFG } from "./semantic/cfg";
export type { TypeTable } from "./semantic/types";
export { buildTypeTable } from "./semantic/types";
export type { CallerIndex, CallSite } from "./semantic/callers";
export { buildCallerIndex } from "./semantic/callers";
export type { SemanticContext } from "./semantic/context";
export { buildSemanticContext } from "./semantic/context";

// Operator contract
export type {
  MutationOperator,
  MutationSpec,
  ConformanceCase,
  ParentContextHint,
  EquivalenceHint,
  SemanticCapability,
  AstNodeId,
} from "./operator/interface";
export { validateSpec } from "./operator/spec-validation";
export type { ValidationResult } from "./operator/spec-validation";
export { createRegistry } from "./operator/registry";
export type { Registry } from "./operator/registry";
```

- [ ] **Step 2: Typecheck the package**

Run: `cd U:/Git/LethAL && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Run all engine tests**

Run: `bun test packages/engine`
Expected: all tests pass (cumulative from Tasks 2-15).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/index.ts
git commit -m "feat(engine): public API exports"
```

---

## Task 17: `@lethal/operator-sdk` package scaffold

**Files:**
- Create: `packages/operator-sdk/package.json`
- Create: `packages/operator-sdk/tsconfig.json`
- Create: `packages/operator-sdk/src/index.ts`

- [ ] **Step 1: Create `package.json`**

Create `packages/operator-sdk/package.json`:
```json
{
  "name": "@lethal/operator-sdk",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@lethal/engine": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*", "tests/**/*"],
  "references": [{ "path": "../engine" }]
}
```

Same `rootDir` omission as the engine package; see Task 2 Step 2 for rationale.

- [ ] **Step 3: Create initial stub `src/index.ts`**

```typescript
export {} from "@lethal/engine";
```

Bun picks up the workspace reference once `bun install` runs.

- [ ] **Step 4: Install workspace deps**

Run: `cd U:/Git/LethAL && bun install`

- [ ] **Step 5: Commit**

```bash
git add packages/operator-sdk/package.json \
        packages/operator-sdk/tsconfig.json \
        packages/operator-sdk/src/index.ts \
        bun.lock
git commit -m "chore(operator-sdk): package scaffold linked to engine"
```

---

## Task 18: SDK `build.*` typed constructors

**Files:**
- Create: `packages/operator-sdk/src/build.ts`
- Create: `packages/operator-sdk/tests/build.test.ts`

These constructors are the AL-limits enforcement from design §4: operators cannot mint AL syntax that AL doesn't have because no constructor exposes it. The constructors emit `ALSyntaxNode`-compatible shapes parseable by the engine's printer (which consumes raw tree-sitter ranges for unmodified nodes but string content for `printWithRewrites` entries).

Layer 1 ships the minimal constructor set needed by Tier 1 operators: boolean/numeric literals, identifier references, binary ops, unary ops, procedure calls, assignment, and a "literal expression" escape for cases where a full AST subtree isn't needed. Each constructor returns a `BuiltExpression` that renders to a valid AL source fragment on demand.

- [ ] **Step 1: Write failing test**

Create `packages/operator-sdk/tests/build.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { build } from "../src/build";

describe("build", () => {
  it("emits a boolean literal", () => {
    expect(build.booleanLiteral(true).toAL()).toBe("true");
    expect(build.booleanLiteral(false).toAL()).toBe("false");
  });

  it("emits an integer literal", () => {
    expect(build.integerLiteral(42).toAL()).toBe("42");
  });

  it("emits a decimal literal with canonical format", () => {
    expect(build.decimalLiteral(1.5).toAL()).toBe("1.5");
  });

  it("emits an identifier", () => {
    expect(build.identifier("Amount").toAL()).toBe("Amount");
  });

  it("emits a binary op", () => {
    const expr = build.binaryOp(
      ">",
      build.identifier("Amount"),
      build.integerLiteral(0),
    );
    expect(expr.toAL()).toBe("Amount > 0");
  });

  it("emits nested binary op with explicit parentheses", () => {
    const expr = build.binaryOp(
      "+",
      build.binaryOp("*", build.identifier("a"), build.integerLiteral(2)),
      build.identifier("b"),
    );
    expect(expr.toAL()).toBe("(a * 2) + b");
  });

  it("emits a procedure call", () => {
    const expr = build.procedureCall("Helper", [build.integerLiteral(1)]);
    expect(expr.toAL()).toBe("Helper(1)");
  });

  it("rejects invalid identifier via assertIdentifier", () => {
    expect(() => build.identifier("")).toThrow(/identifier/);
    expect(() => build.identifier("1bad")).toThrow(/identifier/);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/operator-sdk/tests/build.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `build.ts`**

Create `packages/operator-sdk/src/build.ts`:
```typescript
export interface BuiltExpression {
  toAL(): string;
}

type ALBinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "div"
  | "mod"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or"
  | "xor";

type ALUnaryOp = "-" | "+" | "not";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const build = {
  booleanLiteral(value: boolean): BuiltExpression {
    return literal(value ? "true" : "false");
  },

  integerLiteral(value: number): BuiltExpression {
    if (!Number.isInteger(value)) {
      throw new Error(`integerLiteral: ${value} is not an integer`);
    }
    return literal(value.toString(10));
  },

  decimalLiteral(value: number): BuiltExpression {
    if (Number.isInteger(value)) return literal(`${value}.0`);
    return literal(value.toString(10));
  },

  textLiteral(value: string): BuiltExpression {
    return literal(`'${value.replace(/'/g, "''")}'`);
  },

  identifier(name: string): BuiltExpression {
    if (!IDENTIFIER.test(name)) {
      throw new Error(`identifier: "${name}" is not a valid AL identifier`);
    }
    return literal(name);
  },

  binaryOp(
    op: ALBinaryOp,
    left: BuiltExpression,
    right: BuiltExpression,
  ): BuiltExpression {
    return literal(`${paren(left)} ${op} ${paren(right)}`);
  },

  unaryOp(op: ALUnaryOp, operand: BuiltExpression): BuiltExpression {
    if (op === "not") return literal(`not ${paren(operand)}`);
    return literal(`${op}${paren(operand)}`);
  },

  procedureCall(
    name: string,
    args: readonly BuiltExpression[],
  ): BuiltExpression {
    if (!IDENTIFIER.test(name)) {
      throw new Error(`procedureCall: "${name}" is not a valid AL identifier`);
    }
    const rendered = args.map((a) => a.toAL()).join(", ");
    return literal(`${name}(${rendered})`);
  },

  assignment(
    target: BuiltExpression,
    value: BuiltExpression,
  ): BuiltExpression {
    return literal(`${target.toAL()} := ${value.toAL()}`);
  },
} as const;

function literal(rendered: string): BuiltExpression {
  return {
    toAL() {
      return rendered;
    },
  };
}

function paren(expr: BuiltExpression): string {
  const rendered = expr.toAL();
  if (/\s/.test(rendered)) return `(${rendered})`;
  return rendered;
}
```

The constructors emit source-level AL strings, validated for well-formed identifiers and numeric literals at call time. Future Layer 2 work can swap `BuiltExpression` from string-wrapping to AST-wrapping without changing the public signature.

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/operator-sdk/tests/build.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/operator-sdk/src/build.ts \
        packages/operator-sdk/tests/build.test.ts
git commit -m "feat(sdk): typed build.* constructors for AL expressions"
```

---

## Task 19: Conformance harness

**Files:**
- Create: `packages/operator-sdk/src/conformance.ts`
- Create: `packages/operator-sdk/tests/conformance.test.ts`

Harness runs an operator's `conformanceTests` array against its `targets` + `generate`, comparing produced `MutationSpec.before`/`after` text against the expected entries in each `ConformanceCase`. Used by operator authors during development and by the conformance gate in Layer 4.

- [ ] **Step 1: Write failing test**

Create `packages/operator-sdk/tests/conformance.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser } from "@lethal/engine";
import type { MutationOperator } from "@lethal/engine";
import { runConformance } from "../src/conformance";

function stubOperator(
  overrides: Partial<MutationOperator>,
): MutationOperator {
  return {
    name: "stub",
    version: "1.0.0",
    tier: "custom",
    targetNodeKinds: ["binary_expression"],
    producesNodeKinds: ["binary_expression"],
    requiresSemantic: [],
    targets: () => false,
    generate: () => [],
    conformanceTests: [],
    ...overrides,
  };
}

describe("runConformance", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("passes when operator produces expected mutations", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "flip > to >=",
          sourceAL: `codeunit 60001 "X" { procedure P(): Boolean begin exit(1 > 0); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "1 > 0",
              afterText: "1 >= 0",
            },
          ],
        },
      ],
      targets: (n) => n.kind === "binary_expression" && n.text.includes(">"),
      generate: (n) => [
        {
          operatorName: "stub",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}`,
          before: n,
          after: { ...n, text: n.text.replace(">", ">=") } as never,
          parentContext: "statement-position",
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(true);
  });

  it("reports a failing case when expected spec does not appear", async () => {
    const op = stubOperator({
      conformanceTests: [
        {
          name: "expects something that never fires",
          sourceAL: `codeunit 60002 "X" { procedure P(): Boolean begin exit(true); end; }`,
          expectedSpecs: [
            {
              parentContext: "statement-position",
              beforeText: "true",
              afterText: "false",
            },
          ],
        },
      ],
    });
    const result = await runConformance(op);
    expect(result.allPassed).toBe(false);
    expect(result.failures[0]?.caseName).toBe("expects something that never fires");
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test packages/operator-sdk/tests/conformance.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `conformance.ts`**

Create `packages/operator-sdk/src/conformance.ts`:
```typescript
import {
  buildSemanticContext,
  parseAL,
  visit,
  wrapRoot,
  type MutationOperator,
  type MutationSpec,
} from "@lethal/engine";

export interface ConformanceResult {
  allPassed: boolean;
  failures: ConformanceFailure[];
}

export interface ConformanceFailure {
  caseName: string;
  reason: string;
  produced: ReadonlyArray<{
    beforeText: string;
    afterText: string;
    parentContext: MutationSpec["parentContext"];
  }>;
}

export async function runConformance(
  op: MutationOperator,
): Promise<ConformanceResult> {
  const failures: ConformanceFailure[] = [];

  for (const c of op.conformanceTests) {
    const tree = parseAL(c.sourceAL);
    const root = wrapRoot(tree);
    const ctx = buildSemanticContext([{ path: `conformance://${c.name}`, root }]);

    const produced: MutationSpec[] = [];
    visit(root, (node) => {
      if (op.targets(node, ctx)) {
        for (const spec of op.generate(node, ctx)) {
          produced.push(spec);
        }
      }
    });

    const expectedRemaining = c.expectedSpecs.slice();
    for (const spec of produced) {
      const idx = expectedRemaining.findIndex(
        (e) =>
          e.parentContext === spec.parentContext &&
          e.beforeText === spec.before.text.trim() &&
          e.afterText === renderAfter(spec).trim(),
      );
      if (idx >= 0) expectedRemaining.splice(idx, 1);
    }

    if (expectedRemaining.length > 0) {
      failures.push({
        caseName: c.name,
        reason: `expected mutation not produced: ${JSON.stringify(expectedRemaining[0])}`,
        produced: produced.map((s) => ({
          beforeText: s.before.text,
          afterText: renderAfter(s),
          parentContext: s.parentContext,
        })),
      });
    }
  }

  return { allPassed: failures.length === 0, failures };
}

function renderAfter(spec: MutationSpec): string {
  // In Layer 1, `after` may be a raw ALSyntaxNode-shaped object whose `.text`
  // already carries the rendered AL. Subsequent layers wrap this through
  // the wrap-lift-duplicate compiler; for now, fall back to `.text`.
  const after = spec.after as { text?: string };
  return after.text ?? "";
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `bun test packages/operator-sdk/tests/conformance.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/operator-sdk/src/conformance.ts \
        packages/operator-sdk/tests/conformance.test.ts
git commit -m "feat(sdk): conformance harness for operator golden tests"
```

---

## Task 20: SDK public exports

**Files:**
- Modify: `packages/operator-sdk/src/index.ts`

- [ ] **Step 1: Replace stub with full export surface**

Rewrite `packages/operator-sdk/src/index.ts`:
```typescript
// Engine types + utilities re-exposed to operator authors.
// The SDK intentionally surfaces only the subset operators need; engine
// internals may evolve without breaking registered operators.
export type {
  ALSyntaxNode,
  ALNodeKind,
  MutationOperator,
  MutationSpec,
  ConformanceCase,
  ParentContextHint,
  EquivalenceHint,
  SemanticCapability,
  SemanticContext,
  AstNodeId,
} from "@lethal/engine";

export { astSubtreeHash, visit } from "@lethal/engine";

// SDK-owned surface
export { build } from "./build";
export type { BuiltExpression } from "./build";
export { runConformance } from "./conformance";
export type { ConformanceResult, ConformanceFailure } from "./conformance";
```

- [ ] **Step 2: Typecheck + run all tests**

Run: `cd U:/Git/LethAL && bun run typecheck && bun test`
Expected: no typecheck errors; all tests pass across both packages.

- [ ] **Step 3: Commit**

```bash
git add packages/operator-sdk/src/index.ts
git commit -m "feat(sdk): narrow public surface for custom operators"
```

---

## Task 21: Integration round-trip test

**Files:**
- Create: `packages/operator-sdk/tests/integration/roundtrip.test.ts`
- Copy fixture reference: reuse `packages/engine/tests/fixtures/al/comments-and-spacing.al`

End-to-end Layer-1 smoke: parse → build semantic context → identify a binary expression → compute its hash and canonical form → print the file unmodified → print again with a rewrite using `build.*`. The test lives in operator-sdk (not engine) because it exercises both packages; engine does not depend on operator-sdk.

- [ ] **Step 1: Write the integration test**

Create `packages/operator-sdk/tests/integration/roundtrip.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  astSubtreeHash,
  buildSemanticContext,
  canonicalize,
  findFirst,
  initParser,
  parseAL,
  print,
  printWithRewrites,
  wrapRoot,
} from "@lethal/engine";
import { build } from "../../src/build";

describe("Layer 1 integration", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("round-trips and rewrites a realistic fixture", async () => {
    const path = resolve(
      __dirname,
      "../../../engine/tests/fixtures/al/comments-and-spacing.al",
    );
    const source = await readFile(path, "utf8");

    const tree = parseAL(source);
    const root = wrapRoot(tree);
    const ctx = buildSemanticContext([{ path, root }]);
    expect(ctx.symbols.objects.length).toBe(1);

    const binaryExpr = findFirst(root, ALNodeKind.binary_expression)!;
    const hashBefore = astSubtreeHash(binaryExpr);
    const canonBefore = canonicalize(binaryExpr);

    // unmodified print is byte-identical
    expect(print(source, root)).toBe(source);

    // rewrite the expression using SDK builders
    const replacement = build.binaryOp(
      ">=",
      build.identifier(binaryExpr.text.split(">")[0]!.trim()),
      build.integerLiteral(0),
    );
    const output = printWithRewrites(
      source,
      root,
      new Map([[binaryExpr, replacement.toAL()]]),
    );
    expect(output).toContain(">=");
    expect(output).not.toBe(source);

    // parsing the rewritten source produces a new AST whose binary expression
    // has a different hash (the operator changed).
    const rewrittenRoot = wrapRoot(parseAL(output));
    const rewrittenExpr = findFirst(rewrittenRoot, ALNodeKind.binary_expression)!;
    const hashAfter = astSubtreeHash(rewrittenExpr);
    expect(hashAfter).not.toBe(hashBefore);

    // but canonicalization still classifies the ORIGINAL as itself
    const canonAfter = canonicalize(binaryExpr);
    expect(canonAfter.form).toBe(canonBefore.form);
  });
});
```

- [ ] **Step 2: Run test, confirm pass**

Run: `bun test packages/operator-sdk/tests/integration/roundtrip.test.ts`
Expected: pass.

- [ ] **Step 3: Run full test suite across packages**

Run: `cd U:/Git/LethAL && bun test`
Expected: all tests pass.

- [ ] **Step 4: Typecheck full workspace**

Run: `cd U:/Git/LethAL && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Lint check**

Run: `cd U:/Git/LethAL && bun run lint`
Expected: no errors (or only auto-fixable formatting issues; run `biome check --apply .` if so and recommit formatting-only changes).

- [ ] **Step 6: Commit the integration test**

```bash
git add packages/operator-sdk/tests/integration/roundtrip.test.ts
git commit -m "test(sdk): Layer 1 integration round-trip (parse → rewrite → reparse)"
```

---

## Checkpoint: Layer 1 Complete

At this point the following are shippable:

- `@lethal/engine` exposes AST (parse, traverse, print, hash, canonicalize), semantic analysis (symbols, CFG, types, callers, context), and the operator contract (interface, spec validation, registry).
- `@lethal/operator-sdk` exposes the narrowed public surface for custom operators, typed `build.*` constructors enforcing AL-level well-formedness, and the conformance harness.
- All tests pass; typecheck + lint are clean.

**Next plan:** `plans/YYYY-MM-DD-layer-2-schemata-compiler.md` picks up with the wrap-lift-duplicate compiler that consumes `MutationSpec[]` from Layer 1 operators and produces a single instrumented AL project compilable by BC.

**Spec coverage audit for Layer 1.** Mapping each spec requirement consumed by this layer to the task that ships it:

| Spec reference | Covered by |
|---|---|
| §3.2 AST-based parser + formatting-preserving printer | Tasks 2, 5 |
| §3.3 Symbol table + CFG | Tasks 8, 9 |
| §3.3 Type info for stillborn detection | Task 10 |
| §3.5 `ParentContextHint` enum (consumed by Layer 2) | Task 13 |
| §4 `MutationOperator` + `MutationSpec` interfaces | Task 13 |
| §4 Manifest validation (kinds, semver) | Task 15 |
| §4 SDK `build.*` constructors | Task 18 |
| §4 Conformance harness | Task 19 |
| §5.1 `ast_subtree_hash` identity key component | Task 6 |
| §7 Syntactic AST canonicalization | Task 7 |
| §10 Bun + TypeScript stack | Task 1 |

Layer-1-scoped open spec items **not** covered here (deferred to later layers):

- Wrap-lift-duplicate compiler (§3.5) — Layer 2
- Conformance gate at load time with fuzz (§4) — Layer 4 (needs the wrap-lift-duplicate compiler)
- Worker budget sandboxing (§4) — Layer 4
- Dataflow advisory, kill-diversity ranking (§7) — Layer 7 (reporter)
- Developer "manually confirmed equivalent" feedback loop (§7) — Layer 8 (historical DB)
- Git-assisted refactor migration (§5.1) — Layer 8
