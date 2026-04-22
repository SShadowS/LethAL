# LethAL Layer 2 Implementation Plan — Schemata Compiler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Transform a parsed AL project plus `MutationSpec[]` into a single instrumented AL project that compiles once and dispatches per-mutant at runtime via the `MutationSelector` SingleInstance codeunit. Implements design.md §3.1 (schemata dispatch) and §3.5 (wrap-lift-duplicate).

**Architecture:** New package `@lethal/schemata` depending on `@lethal/engine`. Consumes `MutationSpec[]` from operators (not yet built — Layer 3), produces an instrumented project directory that BC can compile. For Layer 2 we drive the compiler with hand-constructed `MutationSpec[]` in tests; real specs arrive in Layer 3.

**Tech Stack:** Bun + TypeScript, same monorepo. Uses Layer 1's `printWithRewrites` for the final source emission. No new runtime dependencies.

**Design spec reference:** `U:/Git/LethAL/design.md` §3.1 (dispatch), §3.5 (wrap-lift-duplicate compiler rules), §4 (ParentContextHint).

---

## File Structure

```
packages/schemata/
├── package.json                              # @lethal/schemata
├── tsconfig.json
├── src/
│   ├── ids.ts                                # deterministic mutant id assignment
│   ├── selector.ts                           # MutationSelector codeunit emitter
│   ├── wrap.ts                               # statement-position wrapping
│   ├── lift.ts                               # expression-position lifting
│   ├── duplicate.ts                          # short-circuit duplication
│   ├── compile.ts                            # orchestrates the three strategies
│   ├── project.ts                            # writes the instrumented project
│   └── index.ts
└── tests/
    ├── ids.test.ts
    ├── selector.test.ts
    ├── wrap.test.ts
    ├── lift.test.ts
    ├── duplicate.test.ts
    ├── compile.test.ts
    └── fixtures/al/
        ├── schemata-single-statement.al
        ├── schemata-expression.al
        └── schemata-short-circuit.al
```

**Boundary rationale.** Strategies (`wrap`, `lift`, `duplicate`) are separate files because each has distinct correctness properties and is independently testable. `compile.ts` is orchestration only — no emission logic. `project.ts` handles filesystem concerns. `ids.ts` and `selector.ts` are small standalone concerns.

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/schemata/package.json`
- Create: `packages/schemata/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@lethal/schemata",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@lethal/engine": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src/**/*", "tests/**/*"],
  "references": [{ "path": "../engine" }]
}
```

- [ ] **Step 3: Add to root tsconfig**

Edit `U:/Git/LethAL/tsconfig.json`, add `{ "path": "./packages/schemata" }` to references.

- [ ] **Step 4: Install + commit**

```bash
bun install
git add packages/schemata/package.json packages/schemata/tsconfig.json \
        tsconfig.json bun.lock
git commit -m "chore(schemata): package scaffold linked to engine"
```

---

## Task 2: Deterministic mutant ID assignment

**Files:**
- Create: `packages/schemata/src/ids.ts`
- Create: `packages/schemata/tests/ids.test.ts`

IDs must be stable across runs on the same specs: format `M<zero-padded-index>`, assigned in a deterministic sort order (by file path, then by node startIndex, then by operator name).

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect } from "bun:test";
import { assignMutantIds } from "../src/ids";
import type { MutationSpec } from "@lethal/engine";

function spec(overrides: Partial<MutationSpec> & { startIndex: number }): MutationSpec {
  const { startIndex, ...rest } = overrides;
  return {
    operatorName: "op.test",
    operatorVersion: "1.0.0",
    astNodeId: `${startIndex}`,
    before: { startIndex, endIndex: startIndex + 1, text: "x" } as never,
    after: { text: "y" } as never,
    parentContext: "statement-position",
    ...rest,
  };
}

describe("assignMutantIds", () => {
  it("assigns zero-padded ids in deterministic order", () => {
    const specs = [
      spec({ startIndex: 100 }),
      spec({ startIndex: 10 }),
      spec({ startIndex: 50 }),
    ];
    const ided = assignMutantIds(new Map([["file1.al", specs]]));
    const flat = [...ided.values()].flat();
    expect(flat.map((s) => s.mutantId)).toEqual(["M0001", "M0002", "M0003"]);
    expect(flat.map((s) => s.spec.before.startIndex)).toEqual([10, 50, 100]);
  });

  it("orders across files by path", () => {
    const s = (si: number) => spec({ startIndex: si });
    const ided = assignMutantIds(new Map([
      ["b.al", [s(10)]],
      ["a.al", [s(10)]],
    ]));
    const entries = [...ided.entries()];
    expect(entries[0]?.[0]).toBe("a.al");
    expect(entries[0]?.[1][0]?.mutantId).toBe("M0001");
    expect(entries[1]?.[0]).toBe("b.al");
    expect(entries[1]?.[1][0]?.mutantId).toBe("M0002");
  });
});
```

- [ ] **Step 2: Implement `ids.ts`**

```typescript
import type { MutationSpec } from "@lethal/engine";

export interface IdedSpec {
  readonly mutantId: string;
  readonly spec: MutationSpec;
}

export function assignMutantIds(
  specsByFile: ReadonlyMap<string, readonly MutationSpec[]>,
): Map<string, IdedSpec[]> {
  const sortedPaths = [...specsByFile.keys()].sort();
  const out = new Map<string, IdedSpec[]>();
  let counter = 1;
  for (const path of sortedPaths) {
    const specs = [...(specsByFile.get(path) ?? [])].sort((a, b) => {
      const si = a.before.startIndex - b.before.startIndex;
      if (si !== 0) return si;
      return a.operatorName.localeCompare(b.operatorName);
    });
    const ided = specs.map((spec) => ({
      mutantId: `M${String(counter++).padStart(4, "0")}`,
      spec,
    }));
    out.set(path, ided);
  }
  return out;
}
```

- [ ] **Step 3: Run + commit**
```bash
bun test packages/schemata/tests/ids.test.ts
git add packages/schemata/src/ids.ts packages/schemata/tests/ids.test.ts
git commit -m "feat(schemata): deterministic mutant id assignment"
```

---

## Task 3: MutationSelector codeunit emitter

**Files:**
- Create: `packages/schemata/src/selector.ts`
- Create: `packages/schemata/tests/selector.test.ts`

Emits the AL source for the SingleInstance codeunit that the instrumented project depends on. Design §3.1 specifies: `Active(id: Text): Boolean` returning true iff `id` matches the currently-set mutant, with a fast early exit when no mutant is active.

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect } from "bun:test";
import { emitMutationSelector } from "../src/selector";

describe("emitMutationSelector", () => {
  it("produces a SingleInstance codeunit with Active and SetActive", () => {
    const src = emitMutationSelector({ objectId: 60000 });
    expect(src).toContain("codeunit 60000");
    expect(src).toContain("SingleInstance = true");
    expect(src).toContain("procedure Active(MutantId: Text): Boolean");
    expect(src).toContain("procedure SetActive(MutantId: Text)");
    expect(src).toContain("procedure ClearActive()");
    // fast-path early exit when no mutant is active
    expect(src).toContain("if ActiveId = '' then");
  });

  it("embeds the chosen object id verbatim", () => {
    const src = emitMutationSelector({ objectId: 60042 });
    expect(src).toContain("codeunit 60042");
  });
});
```

- [ ] **Step 2: Implement `selector.ts`**

```typescript
export interface SelectorConfig {
  readonly objectId: number;
}

export function emitMutationSelector(cfg: SelectorConfig): string {
  return `codeunit ${cfg.objectId} "Mutation Selector"
{
    SingleInstance = true;

    var
        ActiveId: Text;

    procedure Active(MutantId: Text): Boolean
    begin
        if ActiveId = '' then
            exit(false);
        exit(ActiveId = MutantId);
    end;

    procedure SetActive(MutantId: Text)
    begin
        ActiveId := MutantId;
    end;

    procedure ClearActive()
    begin
        ActiveId := '';
    end;
}
`;
}
```

- [ ] **Step 3: Run + commit**
```bash
bun test packages/schemata/tests/selector.test.ts
git add packages/schemata/src/selector.ts packages/schemata/tests/selector.test.ts
git commit -m "feat(schemata): MutationSelector SingleInstance codeunit emitter"
```

---

## Task 4: Wrap strategy (statement-position)

**Files:**
- Create: `packages/schemata/src/wrap.ts`
- Create: `packages/schemata/tests/wrap.test.ts`
- Create: `packages/schemata/tests/fixtures/al/schemata-single-statement.al`

Per design §3.5: `if MutationSelector.Active('M042') then <mutated> else <original>` placed in the same lexical scope as the original statement. This task ships the string-level emitter; the AST-site selection is Task 7.

- [ ] **Step 1: Fixture `schemata-single-statement.al`**

```al
codeunit 51000 "Wrap Target"
{
    procedure Process(Amount: Decimal)
    begin
        Amount := Amount + 1;
        Rec.Modify(true);
    end;
}
```

- [ ] **Step 2: Test**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { wrapStatement } from "../src/wrap";

describe("wrapStatement", () => {
  beforeAll(async () => { await initParser(); });

  it("emits deletion wrap for a removed statement", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/schemata-single-statement.al"),
      "utf8",
    );
    const tree = parseAL(src);
    const root = wrapRoot(tree);
    const modify = findFirst(root, ALNodeKind.expression_statement) ?? findFirst(root, ALNodeKind.assignment_statement);
    if (modify === null) throw new Error("no statement");
    const output = wrapStatement({
      mutantId: "M0001",
      original: modify,
      replacement: null, // null = deletion
    });
    expect(output).toContain("if not MutationSelector.Active('M0001') then");
    expect(output).toContain(modify.text.trim());
  });

  it("emits substitution wrap for a replaced statement", async () => {
    const src = `codeunit 51001 "W" { procedure P() begin X := 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const output = wrapStatement({
      mutantId: "M0002",
      original: assign,
      replacement: "X := 2;",
    });
    expect(output).toContain("if MutationSelector.Active('M0002') then");
    expect(output).toContain("X := 2;");
    expect(output).toContain("else");
    expect(output).toContain("X := 1");
  });
});
```

- [ ] **Step 3: Implement `wrap.ts`**

```typescript
import type { ALSyntaxNode } from "@lethal/engine";

export interface WrapInput {
  readonly mutantId: string;
  readonly original: ALSyntaxNode;
  readonly replacement: string | null; // null = deletion
}

export function wrapStatement(input: WrapInput): string {
  const originalText = input.original.text;
  if (input.replacement === null) {
    return `if not MutationSelector.Active('${input.mutantId}') then\n  ${originalText}`;
  }
  return `if MutationSelector.Active('${input.mutantId}') then\n  ${input.replacement}\nelse\n  ${originalText}`;
}
```

Note: this task produces only the wrap-source string. The printer-level rewrite (mapping a site's start/end byte range to the wrap string) happens in Task 7.

- [ ] **Step 4: Run + commit**
```bash
bun test packages/schemata/tests/wrap.test.ts
git add packages/schemata/src/wrap.ts packages/schemata/tests/wrap.test.ts \
        packages/schemata/tests/fixtures/al/schemata-single-statement.al
git commit -m "feat(schemata): wrap strategy for statement-position mutations"
```

---

## Task 5: Lift strategy (expression-position)

**Files:**
- Create: `packages/schemata/src/lift.ts`
- Create: `packages/schemata/tests/lift.test.ts`
- Create: `packages/schemata/tests/fixtures/al/schemata-expression.al`

Per design §3.5: lift nested expressions to a pre-computed local via conditional assignment. Requires:
1. A fresh local var declared in the enclosing procedure's `var` block.
2. A conditional-assign statement placed in the narrowest enclosing statement block.
3. The original expression replaced by the local reference.

Layer 2 lift returns three artifacts: the var declaration string, the conditional-assign statement string, and the local reference string. Task 7's compile orchestrator combines them.

- [ ] **Step 1: Fixture**

```al
codeunit 51010 "Lift Target"
{
    procedure Compute(Amount: Decimal): Decimal
    var
        Result: Decimal;
    begin
        Result := F(Amount * 2) + G(Amount);
        exit(Result);
    end;
}
```

- [ ] **Step 2: Test**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser, parseAL, wrapRoot, findFirst, ALNodeKind } from "@lethal/engine";
import { liftExpression } from "../src/lift";

describe("liftExpression", () => {
  beforeAll(async () => { await initParser(); });

  it("emits var declaration, conditional assign, and local reference", () => {
    const src = `codeunit 51011 "L" { procedure P(A: Decimal): Decimal begin exit(F(A * 2) + G(A)); end; }`;
    const root = wrapRoot(parseAL(src));
    const mul = findFirst(root, ALNodeKind.multiplicative_expression);
    if (mul === null) throw new Error("no multiplicative_expression");
    const out = liftExpression({
      mutantId: "M0001",
      original: mul,
      replacementSource: "0",
      inferredType: "Decimal",
    });
    expect(out.varDeclaration).toMatch(/_m0001:\s*Decimal;/);
    expect(out.conditionalAssign).toContain("MutationSelector.Active('M0001')");
    expect(out.conditionalAssign).toContain("_m0001 := 0");
    expect(out.conditionalAssign).toContain(`_m0001 := ${mul.text.trim()}`);
    expect(out.replacementReference).toBe("_m0001");
  });
});
```

- [ ] **Step 3: Implement `lift.ts`**

```typescript
import type { ALSyntaxNode } from "@lethal/engine";

export interface LiftInput {
  readonly mutantId: string;
  readonly original: ALSyntaxNode;
  readonly replacementSource: string;
  readonly inferredType: string;
}

export interface LiftArtifacts {
  readonly varDeclaration: string;      // e.g. "_m0001: Decimal;"
  readonly conditionalAssign: string;   // multiline if/else assigning the local
  readonly replacementReference: string; // e.g. "_m0001"
}

export function liftExpression(input: LiftInput): LiftArtifacts {
  const local = `_m${input.mutantId.slice(1)}`; // "M0001" -> "_m0001"
  return {
    varDeclaration: `${local}: ${input.inferredType};`,
    conditionalAssign:
      `if MutationSelector.Active('${input.mutantId}') then\n` +
      `  ${local} := ${input.replacementSource}\n` +
      `else\n` +
      `  ${local} := ${input.original.text.trim()};`,
    replacementReference: local,
  };
}
```

- [ ] **Step 4: Run + commit**
```bash
bun test packages/schemata/tests/lift.test.ts
git add packages/schemata/src/lift.ts packages/schemata/tests/lift.test.ts \
        packages/schemata/tests/fixtures/al/schemata-expression.al
git commit -m "feat(schemata): lift strategy for expression-position mutations"
```

---

## Task 6: Duplicate strategy (short-circuit operand)

**Files:**
- Create: `packages/schemata/src/duplicate.ts`
- Create: `packages/schemata/tests/duplicate.test.ts`

Per design §3.5: for mutations on short-circuit-sensitive operators (`and`↔`or`), duplicate the enclosing statement under `if MutationSelector.Active then <mutated> else <original>`. Takes the enclosing statement and the mutated body.

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser, parseAL, wrapRoot, findFirst, ALNodeKind } from "@lethal/engine";
import { duplicateEnclosing } from "../src/duplicate";

describe("duplicateEnclosing", () => {
  beforeAll(async () => { await initParser(); });

  it("wraps the enclosing statement twice with mutated / original bodies", () => {
    const src = `codeunit 51020 "D" { procedure P(A: Boolean; B: Boolean) begin if A and B then DoThing(); end; }`;
    const root = wrapRoot(parseAL(src));
    const ifStmt = findFirst(root, ALNodeKind.if_statement);
    if (ifStmt === null) throw new Error("no if_statement");
    const out = duplicateEnclosing({
      mutantId: "M0001",
      enclosingStatement: ifStmt,
      mutatedStatement: ifStmt.text.replace(" and ", " or "),
    });
    expect(out).toContain("if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("end else begin");
    expect(out).toContain("or B then DoThing()");
    expect(out).toContain("and B then DoThing()");
  });
});
```

- [ ] **Step 2: Implement `duplicate.ts`**

```typescript
import type { ALSyntaxNode } from "@lethal/engine";

export interface DuplicateInput {
  readonly mutantId: string;
  readonly enclosingStatement: ALSyntaxNode;
  readonly mutatedStatement: string;
}

export function duplicateEnclosing(input: DuplicateInput): string {
  return (
    `if MutationSelector.Active('${input.mutantId}') then begin\n` +
    `  ${input.mutatedStatement}\n` +
    `end else begin\n` +
    `  ${input.enclosingStatement.text}\n` +
    `end;`
  );
}
```

- [ ] **Step 3: Run + commit**
```bash
bun test packages/schemata/tests/duplicate.test.ts
git add packages/schemata/src/duplicate.ts packages/schemata/tests/duplicate.test.ts
git commit -m "feat(schemata): duplicate strategy for short-circuit operand mutations"
```

---

## Task 7: Schemata compiler orchestrator

**Files:**
- Create: `packages/schemata/src/compile.ts`
- Create: `packages/schemata/tests/compile.test.ts`

Takes `IdedSpec[]` and a source file's AST root; emits a single rewritten AL source string where every mutation site is replaced with the appropriate wrap/lift/duplicate form. Groups lift artifacts (var declarations, conditional assigns) by enclosing procedure so they land in the right block.

For Layer 2, scope compile to a single file + statement-position wraps only. Lift and duplicate composition is complex enough to justify a follow-up task in Layer 3 when operator-produced lifts arrive. Flag this explicitly in the task.

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initParser, parseAL, wrapRoot, findFirst, ALNodeKind } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { compileSchemataForFile } from "../src/compile";

describe("compileSchemataForFile", () => {
  beforeAll(async () => { await initParser(); });

  it("wraps a single statement-position mutation", async () => {
    const src = `codeunit 51030 "C" { procedure P() begin X := 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const specs: MutationSpec[] = [
      {
        operatorName: "op.flip",
        operatorVersion: "1.0.0",
        astNodeId: `${assign.startIndex}`,
        before: assign,
        after: { ...assign, text: "X := 2;" } as never,
        parentContext: "statement-position",
      },
    ];
    const output = compileSchemataForFile(src, root, specs);
    expect(output).toContain("if MutationSelector.Active('M0001') then");
    expect(output).toContain("X := 2;");
    expect(output).toContain("X := 1");
  });
});
```

- [ ] **Step 2: Implement `compile.ts`**

```typescript
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { printWithRewrites } from "@lethal/engine";
import { assignMutantIds } from "./ids";
import { wrapStatement } from "./wrap";

export function compileSchemataForFile(
  source: string,
  root: ALSyntaxNode,
  specs: readonly MutationSpec[],
): string {
  const ided = assignMutantIds(new Map([["<file>", specs]])).get("<file>") ?? [];

  const rewrites = new Map<ALSyntaxNode, string>();
  for (const { mutantId, spec } of ided) {
    if (spec.parentContext !== "statement-position") {
      throw new Error(
        `compileSchemataForFile: parentContext "${spec.parentContext}" not yet supported in Layer 2. ` +
          "Lift and duplicate strategies land in Layer 3.",
      );
    }
    const after = spec.after as unknown as { text?: string };
    const replacement = after.text ?? null;
    rewrites.set(
      spec.before,
      wrapStatement({ mutantId, original: spec.before, replacement }),
    );
  }

  return printWithRewrites(source, root, rewrites);
}
```

- [ ] **Step 3: Run + commit**
```bash
bun test packages/schemata/tests/compile.test.ts
git add packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts
git commit -m "feat(schemata): compile orchestrator for statement-position mutations"
```

---

## Task 8: Project writer

**Files:**
- Create: `packages/schemata/src/project.ts`
- Create: `packages/schemata/tests/project.test.ts`

Writes the compiled schemata to a target directory: each source file's rewritten content plus the `MutationSelector` codeunit plus a `mutant-manifest.json` mapping mutant ids to their `(file, line, operator)` for downstream execution.

- [ ] **Step 1: Test**

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initParser, parseAL, wrapRoot, findFirst, ALNodeKind } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { writeInstrumentedProject } from "../src/project";

describe("writeInstrumentedProject", () => {
  beforeAll(async () => { await initParser(); });

  it("writes rewritten sources + selector + manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-"));
    try {
      const src = `codeunit 51040 "P" { procedure P() begin X := 1; end; }`;
      const root = wrapRoot(parseAL(src));
      const assign = findFirst(root, ALNodeKind.assignment_statement);
      if (assign === null) throw new Error("no assignment");
      const specs: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assign.startIndex}`,
          before: assign,
          after: { ...assign, text: "X := 2;" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "P.Codeunit.al", source: src, root, specs }],
        selectorObjectId: 60000,
      });

      const entries = (await readdir(dir)).sort();
      expect(entries).toContain("P.Codeunit.al");
      expect(entries).toContain("MutationSelector.Codeunit.al");
      expect(entries).toContain("mutant-manifest.json");

      const manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      expect(manifest.mutants).toHaveLength(1);
      expect(manifest.mutants[0].mutantId).toBe("M0001");
      expect(manifest.mutants[0].operatorName).toBe("op.flip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Implement `project.ts`**

```typescript
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compileSchemataForFile } from "./compile";
import { assignMutantIds } from "./ids";
import { emitMutationSelector } from "./selector";

export interface InstrumentedFile {
  readonly path: string;
  readonly source: string;
  readonly root: ALSyntaxNode;
  readonly specs: readonly MutationSpec[];
}

export interface WriteInput {
  readonly targetDir: string;
  readonly files: readonly InstrumentedFile[];
  readonly selectorObjectId: number;
}

export interface MutantManifestEntry {
  readonly mutantId: string;
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly operatorName: string;
  readonly operatorVersion: string;
}

export interface MutantManifest {
  readonly selectorObjectId: number;
  readonly mutants: readonly MutantManifestEntry[];
}

export async function writeInstrumentedProject(input: WriteInput): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });

  const specsByFile = new Map<string, readonly MutationSpec[]>();
  for (const f of input.files) specsByFile.set(f.path, f.specs);
  const idedByFile = assignMutantIds(specsByFile);

  const manifest: MutantManifestEntry[] = [];
  for (const f of input.files) {
    const compiled = compileSchemataForFile(f.source, f.root, f.specs);
    await writeFile(join(input.targetDir, basename(f.path)), compiled, "utf8");
    for (const { mutantId, spec } of idedByFile.get(f.path) ?? []) {
      manifest.push({
        mutantId,
        file: f.path,
        startIndex: spec.before.startIndex,
        endIndex: spec.before.endIndex,
        operatorName: spec.operatorName,
        operatorVersion: spec.operatorVersion,
      });
    }
  }

  await writeFile(
    join(input.targetDir, "MutationSelector.Codeunit.al"),
    emitMutationSelector({ objectId: input.selectorObjectId }),
    "utf8",
  );

  const manifestJson: MutantManifest = {
    selectorObjectId: input.selectorObjectId,
    mutants: manifest,
  };
  await writeFile(
    join(input.targetDir, "mutant-manifest.json"),
    `${JSON.stringify(manifestJson, null, 2)}\n`,
    "utf8",
  );
}
```

- [ ] **Step 3: Run + commit**
```bash
bun test packages/schemata/tests/project.test.ts
git add packages/schemata/src/project.ts packages/schemata/tests/project.test.ts
git commit -m "feat(schemata): instrumented project writer + manifest"
```

---

## Task 9: Package public exports

**Files:**
- Create: `packages/schemata/src/index.ts`

- [ ] **Step 1: Write exports**

```typescript
export { assignMutantIds } from "./ids";
export type { IdedSpec } from "./ids";
export { emitMutationSelector } from "./selector";
export type { SelectorConfig } from "./selector";
export { wrapStatement } from "./wrap";
export type { WrapInput } from "./wrap";
export { liftExpression } from "./lift";
export type { LiftInput, LiftArtifacts } from "./lift";
export { duplicateEnclosing } from "./duplicate";
export type { DuplicateInput } from "./duplicate";
export { compileSchemataForFile } from "./compile";
export { writeInstrumentedProject } from "./project";
export type {
  InstrumentedFile,
  WriteInput,
  MutantManifest,
  MutantManifestEntry,
} from "./project";
```

- [ ] **Step 2: Typecheck + full test**
```bash
bun run typecheck
bun test
```

- [ ] **Step 3: Commit**
```bash
git add packages/schemata/src/index.ts
git commit -m "feat(schemata): public API exports"
```

---

## Checkpoint: Layer 2 Complete

What ships:

- `@lethal/schemata` package with deterministic mutant-id assignment, the `MutationSelector` codeunit emitter, three AST-grammar-aware wrapping strategies (wrap, lift, duplicate), a single-file compile orchestrator scoped to statement-position mutations, and a project writer that lays out the instrumented source tree with a `mutant-manifest.json`.
- Full wrap-lift-duplicate strategy implementations available as standalone functions (lift + duplicate are individually tested) but not yet composed into `compileSchemataForFile`. Expression-position and short-circuit composition ship with Layer 3 once operators start producing non-statement MutationSpecs.

**Next plan:** `plans/YYYY-MM-DD-layer-3-tier1-operators.md` will implement Tier 1 generic operators (ConditionalBoundary, NegateConditional, VoidMethodCall, ReturnValue, EmptyBlock) against the engine + SDK, wire them into the compile orchestrator, and extend `compileSchemataForFile` to handle lift + duplicate composition.

**Spec coverage audit for Layer 2:**

| Spec reference | Covered by |
|---|---|
| §3.1 dispatch mechanism via SingleInstance codeunit | Task 3 |
| §3.1 schemata single-compile transform | Task 7, Task 8 |
| §3.5 wrap strategy | Task 4 |
| §3.5 lift strategy | Task 5 |
| §3.5 duplicate strategy | Task 6 |
| §3.5 "never extract to a procedure" | entire package design — no extraction path exists |
| §5.1 mutant-id stability (deterministic) | Task 2 |
| Mutant manifest for execution | Task 8 |

**Deferred to Layer 3:**

- Lift + duplicate composition in `compileSchemataForFile` (currently throws on non-statement parentContext).
- Cross-file orchestration (Task 8 handles multiple files but doesn't yet coordinate shared lift locals across them — not needed since lift is per-procedure).
- Actual operator implementations — Tier 1 operators live in Layer 3.
