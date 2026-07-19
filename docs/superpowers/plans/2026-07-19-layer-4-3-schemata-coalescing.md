# Layer 4.3 — Schemata Overlap Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile every mutant into **one** instrumented artifact instead of one per overlap batch, by emitting overlapping mutants as a flat dispatch chain rather than nested wraps.

**Architecture:** Mutants whose resolved statements nest form a *containment component*. Each component compiles to one flat `if/else if/else` chain rooted at the outermost statement, with one complete branch per mutant plus an original branch. Because only one mutant is ever active, no nesting is needed — growth is linear (N+1 branches), evaluation order inside each branch is exactly the original's, and no temporaries are introduced.

**Tech Stack:** Bun + TypeScript monorepo. tree-sitter-al via `@lethal/engine`. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-07-19-layer-4-3-schemata-coalescing-design.md`

## Global Constraints

- A branch is **the component root's text with `spec.before`'s byte range replaced by the spec's `after` text**. This is uniform for mutation (`A > B` → `A >= B`), deletion (`after` empty), and block replacement (`empty-block` → `begin end`).
- Branch order is **outermost mutation first**, then by ascending `before.startIndex`, then by `operatorName`. Order must be deterministic — verdicts must not depend on it.
- Only ONE mutant is ever active (`MutationSelector` holds a single id). Never emit nested guards for mutants in the same component.
- **Never hoist an expression into a temporary.** Lift is rejected for this layer (spec §4): AL evaluation order, AL's ternary (`AL0666` confirms `?:` exists at runtime ≥14.0), `var`-parameter aliasing and insufficient type inference all break it.
- Mutant ids are allocated **once, artifact-wide** (fixed in `4ec2095`). `compileSchemataForFile` accepts pre-assigned ids; never re-derive them.
- Overlap-driven batching is removed. **Artifact splitting is retained** for size budget and compile-failure bisection (spec §6) — `MutantOutcome.batchIndex` and `runs.batch_count` stay.
- No non-null assertions (`!`) — biome sets `noNonNullAssertion: error`. `exactOptionalPropertyTypes` is on: conditional spreads for optional fields.
- Verdicts must be unchanged: al-runner `3 killed / 13 survived / 0 no-coverage` (18.8%), bcdev `3 killed / 10 survived / 3 no-coverage` (23.1%).
- Every task ends green on `bun test`, `bun run typecheck`, `bunx biome check packages/schemata packages/runner`. Delete `packages/*/dist` immediately before any reported test run (PowerShell `Remove-Item -Recurse -Force` if `rm -rf` is blocked) — `tsc --build` regenerates compiled test copies that inflate counts.

---

## File Structure

```
packages/schemata/src/
├── components.ts        # NEW — group specs into containment components, pick each root
├── dispatch.ts          # NEW — emit the flat if/else-if chain for one component
├── compile.ts           # MODIFY — route through components+dispatch; drop the
│                        #          duplicate-rewrite throw and the wrap/lift/duplicate fork
├── wrap.ts              # KEEP — still used for a single-mutant component (degenerate chain)
├── lift.ts              # KEEP but UNUSED by compile (spec §4 rejects it); left for future work
└── duplicate.ts         # KEEP but UNUSED by compile

packages/schemata/tests/
├── components.test.ts   # NEW
├── dispatch.test.ts     # NEW
└── compile.test.ts      # MODIFY — overlapping specs now compile instead of throwing

packages/engine/src/operator/
└── spec-validation.ts   # MODIFY — assert `before` matches a real node in the tree

packages/runner/src/
├── selection.ts         # MODIFY — delete batchByOverlap + OverlapSite
└── orchestrator.ts      # MODIFY — one artifact; keep the splitting seam for bisection
```

**Boundary rationale.** `components.ts` is pure grouping over ranges and `dispatch.ts` is pure text emission — both testable without parsing or I/O, which is what makes the algorithm reviewable. `compile.ts` keeps only the wiring.

---

## Task 1: Containment components

**Files:**
- Create: `packages/schemata/src/components.ts`
- Create: `packages/schemata/tests/components.test.ts`

**Interfaces:**
- Consumes: `IdedSpec` from `./ids` (`{ mutantId: string; spec: MutationSpec }`), `resolveSite` from `./enclosing`.
- Produces (used by Tasks 2, 3):

```ts
export interface ComponentMember {
  readonly mutantId: string;
  readonly spec: MutationSpec;
  /** Statement this spec resolves to (may be nested inside the component root). */
  readonly statement: ALSyntaxNode;
  /** `spec.after`'s text, "" for deletion mutants. */
  readonly afterText: string;
}
export interface Component {
  /** Outermost resolved statement — the node the printer rewrites. */
  readonly root: ALSyntaxNode;
  /** Ordered: outermost mutation first, then by startIndex, then operatorName. */
  readonly members: readonly ComponentMember[];
}
export function buildComponents(ided: readonly IdedSpec[]): Component[];
```

- [ ] **Step 1: Write the failing test**

Create `packages/schemata/tests/components.test.ts`:

```ts
import { describe, expect, it, beforeAll } from "bun:test";
import { ALNodeKind, findAll, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { buildComponents } from "../src/components";

const SRC = `codeunit 79000 "T"
{
    procedure IsOver(A: Integer; B: Integer): Boolean
    begin
        exit(A > B);
    end;

    procedure Other(V: Integer): Integer
    begin
        exit(V);
    end;
}
`;

function synth(before: never, afterText: string, op: string): MutationSpec {
  return {
    operatorName: op,
    operatorVersion: "1.0.0",
    astNodeId: `${before.startIndex}-${before.endIndex}`,
    before,
    after: { ...before, text: afterText } as never,
    parentContext: "statement-position",
  } as MutationSpec;
}

describe("buildComponents", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("groups nested sites into ONE component rooted at the outermost statement", () => {
    const root = wrapRoot(parseAL(SRC));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const exits = findAll(root, ALNodeKind.exit_statement);
    const firstExit = exits[0];
    if (cmp === undefined || firstExit === undefined) throw new Error("fixture drift");

    const comps = buildComponents([
      { mutantId: "M0001", spec: synth(cmp as never, "A >= B", "boundary") },
      { mutantId: "M0002", spec: synth(firstExit as never, "exit(false);", "return-value") },
    ]);

    expect(comps).toHaveLength(1);
    const c = comps[0];
    if (c === undefined) throw new Error("no component");
    expect(c.root.startIndex).toBe(firstExit.startIndex);
    expect(c.members.map((m) => m.mutantId)).toEqual(["M0002", "M0001"]); // outermost first
  });

  it("keeps disjoint sites in separate components", () => {
    const root = wrapRoot(parseAL(SRC));
    const exits = findAll(root, ALNodeKind.exit_statement);
    const a = exits[0];
    const b = exits[1];
    if (a === undefined || b === undefined) throw new Error("fixture drift");

    const comps = buildComponents([
      { mutantId: "M0001", spec: synth(a as never, "exit(false);", "return-value") },
      { mutantId: "M0002", spec: synth(b as never, "exit(0);", "return-value") },
    ]);
    expect(comps).toHaveLength(2);
  });

  it("is deterministic — same input, same components and order", () => {
    const root = wrapRoot(parseAL(SRC));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const firstExit = findAll(root, ALNodeKind.exit_statement)[0];
    if (cmp === undefined || firstExit === undefined) throw new Error("fixture drift");
    const input = [
      { mutantId: "M0001", spec: synth(cmp as never, "A >= B", "boundary") },
      { mutantId: "M0002", spec: synth(firstExit as never, "exit(false);", "return-value") },
    ];
    const a = buildComponents(input).map((c) => c.members.map((m) => m.mutantId));
    const b = buildComponents(input).map((c) => c.members.map((m) => m.mutantId));
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/schemata/tests/components.test.ts`
Expected: FAIL — cannot resolve `../src/components`.

- [ ] **Step 3: Implement `components.ts`**

```ts
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { resolveSite } from "./enclosing";
import type { IdedSpec } from "./ids";

export interface ComponentMember {
  readonly mutantId: string;
  readonly spec: MutationSpec;
  readonly statement: ALSyntaxNode;
  readonly afterText: string;
}

export interface Component {
  readonly root: ALSyntaxNode;
  readonly members: readonly ComponentMember[];
}

function contains(outer: ALSyntaxNode, inner: ALSyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/**
 * Group specs whose resolved statements nest. Overlap between mutation sites is
 * always containment (spec §2: AST ranges are laminar), so a component is a
 * containment chain and its root is simply the widest statement in it.
 *
 * The root is what the printer rewrites; every member's edit is spliced into the
 * root's text, so members nested at any depth are handled uniformly.
 */
export function buildComponents(ided: readonly IdedSpec[]): Component[] {
  const resolved: ComponentMember[] = ided.map((entry) => {
    const afterText = (entry.spec.after as unknown as { text?: string }).text ?? "";
    const site = resolveSite(entry.spec.before, afterText);
    return { mutantId: entry.mutantId, spec: entry.spec, statement: site.statement, afterText };
  });

  // Widest statement first, so the first member of a chain is always its root.
  const bySpan = [...resolved].sort((a, b) => {
    const start = a.statement.startIndex - b.statement.startIndex;
    if (start !== 0) return start;
    return b.statement.endIndex - a.statement.endIndex;
  });

  const groups: Array<{ root: ALSyntaxNode; members: ComponentMember[] }> = [];
  for (const m of bySpan) {
    const host = groups.find((g) => contains(g.root, m.statement));
    if (host === undefined) groups.push({ root: m.statement, members: [m] });
    else host.members.push(m);
  }

  return groups.map((g) => ({
    root: g.root,
    members: [...g.members].sort(orderOutermostFirst),
  }));
}

/** Outermost mutation first, then by position, then by operator — fully deterministic. */
function orderOutermostFirst(a: ComponentMember, b: ComponentMember): number {
  const span = b.spec.before.endIndex - b.spec.before.startIndex -
    (a.spec.before.endIndex - a.spec.before.startIndex);
  if (span !== 0) return span;
  const start = a.spec.before.startIndex - b.spec.before.startIndex;
  if (start !== 0) return start;
  return a.spec.operatorName.localeCompare(b.spec.operatorName);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/schemata/tests/components.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/components.ts packages/schemata/tests/components.test.ts
git commit -m "feat(schemata): group overlapping mutation sites into containment components"
```

---

## Task 2: Flat dispatch emission

**Files:**
- Create: `packages/schemata/src/dispatch.ts`
- Create: `packages/schemata/tests/dispatch.test.ts`

**Interfaces:**
- Consumes: `Component`, `ComponentMember` (Task 1).
- Produces (used by Task 3): `export function emitDispatch(component: Component): string;` — returns the replacement text for `component.root`.

- [ ] **Step 1: Write the failing test**

Create `packages/schemata/tests/dispatch.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { emitDispatch } from "../src/dispatch";

/** Minimal stand-ins — emitDispatch only reads ranges and text. */
function node(text: string, startIndex: number) {
  return { text, startIndex, endIndex: startIndex + text.length } as never;
}

function member(mutantId: string, beforeText: string, beforeStart: number, afterText: string) {
  return {
    mutantId,
    spec: { before: node(beforeText, beforeStart), operatorName: "op" },
    statement: node(beforeText, beforeStart),
    afterText,
  } as never;
}

describe("emitDispatch", () => {
  it("emits one branch per mutant plus an original branch", () => {
    const root = node("exit(A > B);", 100);
    const out = emitDispatch({
      root,
      members: [
        member("M0002", "exit(A > B);", 100, "exit(false);"),
        member("M0001", "A > B", 105, "A >= B"),
      ],
    } as never);

    // One guard per mutant, in order, and the original last.
    expect(out).toContain("if MutationSelector.Active('M0002') then begin");
    expect(out).toContain("end else if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("exit(false);"); // outer variant
    expect(out).toContain("exit(A >= B);"); // inner variant spliced into the ROOT
    expect(out).toContain("exit(A > B);"); // original branch
    expect(out.trimEnd().endsWith("end;")).toBe(true);
    // Linear, not nested: exactly one `if` per mutant, no nested guard inside a branch.
    expect(out.match(/MutationSelector\.Active/g)).toHaveLength(2);
  });

  it("a deletion mutant's branch omits the deleted span", () => {
    const root = node("LogAudit(Amount);", 50);
    const out = emitDispatch({
      root,
      members: [member("M0001", "LogAudit(Amount)", 50, "")],
    } as never);
    expect(out).toContain("if MutationSelector.Active('M0001') then begin");
    expect(out).toContain("LogAudit(Amount);"); // original branch still present
    // The mutated branch contains only the residual separator, not the call.
    const mutatedBranch = out.slice(0, out.indexOf("end else"));
    expect(mutatedBranch).not.toContain("LogAudit(Amount)");
  });

  it("a single-mutant component still emits a two-branch chain", () => {
    const root = node("exit(V);", 10);
    const out = emitDispatch({
      root,
      members: [member("M0001", "exit(V);", 10, "exit(0);")],
    } as never);
    expect(out.match(/MutationSelector\.Active/g)).toHaveLength(1);
    expect(out).toContain("exit(0);");
    expect(out).toContain("exit(V);");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/schemata/tests/dispatch.test.ts`
Expected: FAIL — cannot resolve `../src/dispatch`.

- [ ] **Step 3: Implement `dispatch.ts`**

```ts
import type { Component, ComponentMember } from "./components";

/**
 * Emit one flat guard chain for a containment component.
 *
 * Only ONE mutant is ever active, so mutants in a component are siblings in an
 * if/else-if chain rather than nested guards. That keeps growth linear (N+1
 * branches for N mutants) and — crucially — keeps evaluation order inside every
 * branch identical to the original statement's, because nothing is hoisted.
 *
 * Each branch is the component ROOT's text with that mutant's `before` span
 * replaced by its `after` text. Uniform for mutation, deletion (empty after) and
 * block replacement.
 */
export function emitDispatch(component: Component): string {
  const original = component.root.text;
  const branches = component.members.map((m) => ({
    mutantId: m.mutantId,
    text: spliceIntoRoot(component.root, m),
  }));

  const parts: string[] = [];
  for (const [i, b] of branches.entries()) {
    const lead = i === 0 ? "if" : "end else if";
    parts.push(`${lead} MutationSelector.Active('${b.mutantId}') then begin\n  ${b.text}\n`);
  }
  parts.push(`end else begin\n  ${original}\nend;`);
  return parts.join("");
}

function spliceIntoRoot(root: Component["root"], m: ComponentMember): string {
  const relStart = m.spec.before.startIndex - root.startIndex;
  const relEnd = m.spec.before.endIndex - root.startIndex;
  const text = root.text;
  if (relStart < 0 || relEnd > text.length) {
    throw new Error(
      `emitDispatch: member ${m.mutantId} span ${m.spec.before.startIndex}..${m.spec.before.endIndex} ` +
        `is not contained in component root ${root.startIndex}..${root.endIndex}`,
    );
  }
  return text.slice(0, relStart) + m.afterText + text.slice(relEnd);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/schemata/tests/dispatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/dispatch.ts packages/schemata/tests/dispatch.test.ts
git commit -m "feat(schemata): flat dispatch chain emission for a containment component"
```

---

## Task 3: Route compileSchemataForFile through components

**Files:**
- Modify: `packages/schemata/src/compile.ts`
- Modify: `packages/schemata/tests/compile.test.ts`

**Interfaces:**
- Consumes: `buildComponents` (Task 1), `emitDispatch` (Task 2), existing `wrapIfBodyBlock` and `injectMutationSelectorVar` in `compile.ts`.
- Produces: `compileSchemataForFile` no longer throws on overlapping specs.

- [ ] **Step 1: Write the failing test**

Append to `packages/schemata/tests/compile.test.ts` (reuse its existing parse/spec helpers):

```ts
describe("compileSchemataForFile — overlapping specs coalesce", () => {
  it("compiles two nested mutants into one flat chain instead of throwing", async () => {
    await initParser();
    const src = `codeunit 79000 "T"
{
    procedure IsOver(A: Integer; B: Integer): Boolean
    begin
        exit(A > B);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    const ex = findAll(root, ALNodeKind.exit_statement)[0];
    if (cmp === undefined || ex === undefined) throw new Error("fixture drift");

    const out = compileSchemataForFile(src, root, [
      spec(cmp, "A >= B", "lethal.conditional-boundary"),
      spec(ex, "exit(false);", "lethal.return-value"),
    ]);

    // Both mutants present, exactly one guard each, no nesting.
    expect(out.match(/MutationSelector\.Active/g)).toHaveLength(2);
    expect(out).toContain("exit(false);");
    expect(out).toContain("exit(A >= B);");
    expect(out).toContain("exit(A > B);");
  });
});
```

Add a `spec(before, afterText, operatorName)` helper to the file if one does not already exist, matching the shape the existing tests build.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/schemata/tests/compile.test.ts`
Expected: FAIL — `two specs resolved to the same AST node` or an overlapping-rewrite throw.

- [ ] **Step 3: Rewrite the compile body**

In `packages/schemata/src/compile.ts`, replace the per-spec `dispatch(...)` loop with component-based emission:

```ts
  const components = buildComponents(ided);
  const rewrites = new Map<ALSyntaxNode, string>();
  for (const component of components) {
    rewrites.set(component.root, wrapIfBodyBlock(component.root, emitDispatch(component)));
  }
```

Delete `dispatch`, `applyWrap`, `applyLift`, `applyDuplicate`, `commitLiftRewrites`, `assertNoDuplicateRewrite` and the now-unused `codeBlockInserts` / `procedureInjects` / `blockExprRewrites` maps and their imports. Keep `injectMutationSelectorVar` and its call, and keep `wrapIfBodyBlock`.

`buildSemanticContext` is no longer needed (it existed only for lift's type inference) — remove it and its import.

Add a comment recording why lift/duplicate are no longer routed to:

```ts
// Emission is a FLAT dispatch chain per containment component, never nested
// guards: only one mutant is ever active, so mutants that overlap are siblings
// in one if/else-if chain. Nesting wraps is what produced 2^depth growth.
// lift.ts/duplicate.ts are intentionally no longer routed to — see the design
// spec §4: hoisting into a temp breaks AL evaluation order, cannot be typed
// reliably, and is unsafe around ternaries and `var` parameters.
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/schemata` — PASS. Some existing tests assert the old wrap/lift output shape; update those that assert *emission form* to the new chain, and say in the commit exactly which changed and why. Do NOT change tests that assert *which mutants exist* — those must still hold.

Then `bun test` (dist deleted first), `bun run typecheck`, `bunx biome check packages/schemata` — all green.

- [ ] **Step 5: Commit**

```bash
git add packages/schemata
git commit -m "feat(schemata): compile overlapping mutants as one flat dispatch chain"
```

---

## Task 4: Validate that every spec targets a real tree node

**Files:**
- Modify: `packages/engine/src/operator/spec-validation.ts`
- Modify: `packages/engine/tests/operator/spec-validation.test.ts` (create if absent)

**Interfaces:**
- Produces: `validateSpec(spec, root?)` — when `root` is supplied, the spec is rejected unless `spec.before` matches a node in `root` by exact range.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeAll } from "bun:test";
import { initParser, parseAL, wrapRoot, findAll, ALNodeKind, validateSpec } from "../../src/index";

describe("validateSpec — before must be a real tree node", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("rejects a synthetic span that matches no node", () => {
    const src = `codeunit 1 "T" { procedure P(A: Integer): Boolean begin exit(A > 0); end; }`;
    const root = wrapRoot(parseAL(src));
    const synthetic = { ...root, startIndex: 10, endIndex: 30 } as never;
    const res = validateSpec(
      {
        operatorName: "x",
        operatorVersion: "1.0.0",
        astNodeId: "10-30",
        before: synthetic,
        after: synthetic,
        parentContext: "statement-position",
      } as never,
      root,
    );
    expect(res.ok).toBe(false);
  });

  it("accepts a genuine node", () => {
    const src = `codeunit 1 "T" { procedure P(A: Integer): Boolean begin exit(A > 0); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    if (cmp === undefined) throw new Error("fixture drift");
    const res = validateSpec(
      {
        operatorName: "x",
        operatorVersion: "1.0.0",
        astNodeId: `${cmp.startIndex}-${cmp.endIndex}`,
        before: cmp,
        after: cmp,
        parentContext: "statement-position",
      } as never,
      root,
    );
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/engine/tests/operator/spec-validation.test.ts`
Expected: FAIL — `validateSpec` takes one argument and accepts the synthetic span.

- [ ] **Step 3: Implement**

Add an optional second parameter to `validateSpec`. When supplied, walk `root` and require a node with exactly `before.startIndex`/`before.endIndex`:

```ts
/**
 * When `root` is given, `before` must correspond to a real node in that tree.
 * Coalescing relies on mutation sites being laminar (design spec §2), which
 * holds for genuine AST nodes but NOT for a synthetic multi-node span an
 * operator might invent — that could produce true partial overlap.
 */
export function validateSpec(spec: MutationSpec, root?: ALSyntaxNode): ValidationResult {
  // ... existing checks unchanged ...
  if (root !== undefined && !hasNodeWithSpan(root, spec.before.startIndex, spec.before.endIndex)) {
    return {
      ok: false,
      errors: [
        `before span ${spec.before.startIndex}..${spec.before.endIndex} does not match any node in the parsed tree`,
      ],
    };
  }
  return { ok: true, errors: [] };
}

function hasNodeWithSpan(root: ALSyntaxNode, start: number, end: number): boolean {
  let found = false;
  visit(root, (n) => {
    if (n.startIndex === start && n.endIndex === end) found = true;
  });
  return found;
}
```

Match the file's existing `ValidationResult` shape rather than the sketch above if it differs.

- [ ] **Step 4: Pass the root at the call site**

In `packages/runner/src/orchestrator.ts`'s `generateMutationSet`, the specs are already filtered by `validateSpec(spec)`. Change it to `validateSpec(spec, root)` so operators emitting synthetic spans are rejected before they reach the compiler.

- [ ] **Step 5: Run tests**

Run: `bun test` (dist deleted first), `bun run typecheck`, `bunx biome check packages/engine packages/runner` — all green.

- [ ] **Step 6: Commit**

```bash
git add packages/engine packages/runner
git commit -m "feat(engine): validate that a mutation spec targets a real tree node

Coalescing relies on mutation sites being laminar, which holds for genuine AST
nodes but not for a synthetic multi-node span an operator could invent."
```

---

## Task 5: One artifact — remove overlap batching

**Files:**
- Modify: `packages/runner/src/selection.ts`
- Modify: `packages/runner/tests/selection.test.ts`
- Modify: `packages/runner/src/orchestrator.ts`
- Modify: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: coalescing compiler (Task 3).
- Produces: `runSession` writes and deploys **one** artifact per session. `MutantOutcome.batchIndex` and `runs.batch_count` remain (retained for the splitting seam, spec §6) — a single artifact reports index `0` and count `1`.

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/orchestrator.test.ts`:

```ts
describe("runSession — single artifact", () => {
  test("a project whose mutants overlap still deploys exactly once", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.deploys).toHaveLength(1);
    expect(report.batches).toBe(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/orchestrator.test.ts`
Expected: FAIL — the fixture's nested mutants produce 3 deploys.

- [ ] **Step 3: Delete `batchByOverlap`**

Remove `batchByOverlap`, `OverlapSite` and their tests from `selection.ts` / `selection.test.ts`, and drop the re-export from `packages/runner/src/index.ts`.

- [ ] **Step 4: Collapse the orchestrator's batch loop**

In `orchestrator.ts`, replace the `for (const [batchIdx, batchSpecs] of specBatches.entries())` loop with a single artifact preparation, keeping the body otherwise unchanged:

```ts
  // One artifact: overlapping mutants now coalesce into flat dispatch chains
  // (Layer 4.3), so there is nothing left for overlap batching to separate.
  // The artifact-splitting SEAM is deliberately retained for size budget and
  // compile-failure bisection (design spec §6) — hence batchIdx/batchCount stay.
  const batchIdx = 0;
  const artifacts = [allFiles];
```

Keep `prepareBatchProject`, the deploy try/catch, baseline, coverage filter, worker fan-out and disposal exactly as they are — this task changes only how many artifacts there are, not what happens per artifact. `finishRun` reports `batchCount: 1`.

- [ ] **Step 5: Run tests**

Run: `bun test packages/runner` — PASS. Update any orchestrator test that asserted a batch count of 3 to 1, and say which in the commit.

Then `bun test` (dist deleted first), `bun run typecheck`, `bunx biome check packages/runner` — green.

- [ ] **Step 6: Verify the fixture collapses to one artifact**

Run:

```bash
bun packages/runner/src/cli.ts run --project fixtures/sandbox-app --tests fixtures/sandbox-tests --dry-run
```

Expected: `16 mutant site(s), 1 batch(es)` — down from 3.

- [ ] **Step 7: Commit**

```bash
git add packages/runner
git commit -m "feat(runner): one instrumented artifact per session

Overlap batching existed only because the compiler threw on overlapping
mutants; flat dispatch removes that constraint. The artifact-splitting seam is
retained for size budget and compile-failure bisection."
```

---

## Task 6: Compile-failure bisection

**Files:**
- Create: `packages/runner/src/bisect.ts`
- Create: `packages/runner/tests/bisect.test.ts`
- Modify: `packages/runner/src/orchestrator.ts`

**Interfaces:**
- Produces:

```ts
/**
 * Binary-search a mutant set for one whose presence makes `compiles` fail.
 * Returns the offending mutant, or null when the whole set compiles.
 */
export async function bisectFailingMutant<T>(
  mutants: readonly T[],
  compiles: (subset: readonly T[]) => Promise<boolean>,
): Promise<T | null>;
```

- [ ] **Step 1: Write the failing test**

Create `packages/runner/tests/bisect.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { bisectFailingMutant } from "../src/bisect";

describe("bisectFailingMutant", () => {
  test("finds the single offending mutant", async () => {
    const bad = "M0007";
    const found = await bisectFailingMutant(
      ["M0001", "M0002", bad, "M0009"],
      async (subset) => !subset.includes(bad),
    );
    expect(found).toBe(bad);
  });

  test("returns null when everything compiles", async () => {
    expect(await bisectFailingMutant(["M0001", "M0002"], async () => true)).toBeNull();
  });

  test("uses O(log n) compiles, not O(n)", async () => {
    let calls = 0;
    const mutants = Array.from({ length: 64 }, (_, i) => `M${i}`);
    await bisectFailingMutant(mutants, async (subset) => {
      calls++;
      return !subset.includes("M63");
    });
    expect(calls).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/runner/tests/bisect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bisect.ts`**

```ts
/**
 * Binary-search for a mutant whose presence breaks compilation.
 *
 * One artifact means one bad mutant would otherwise turn every mutant in the
 * session into an error with no indication of which one was at fault (design
 * spec §6). This narrows it to a name in O(log n) compiles.
 */
export async function bisectFailingMutant<T>(
  mutants: readonly T[],
  compiles: (subset: readonly T[]) => Promise<boolean>,
): Promise<T | null> {
  if (await compiles(mutants)) return null;

  let candidates = [...mutants];
  while (candidates.length > 1) {
    const mid = Math.floor(candidates.length / 2);
    const left = candidates.slice(0, mid);
    candidates = (await compiles(left)) ? candidates.slice(mid) : left;
  }
  return candidates[0] ?? null;
}
```

- [ ] **Step 4: Wire it into the orchestrator's deploy failure path**

Where a deploy failure is caught, attempt bisection before recording the batch as errored, and put the offending mutant's id in the failure note:

```ts
      } catch (err) {
        const culprit = await bisectFailingMutant(execute, async (subset) => {
          try {
            await prepareArtifact(subset);
            await cfg.backend.deploy(artifactDir);
            return true;
          } catch {
            return false;
          }
        });
        const note = culprit === null
          ? String(err)
          : `compile failed; bisected to mutant ${culprit.mutantId} (${culprit.file}:${culprit.startLine} ${culprit.operatorName})`;
        for (const m of execute) {
          if (perMutantTests.get(m.mutantId) === undefined) continue;
          record(cfg.store, runId, m, "error", outcomes, batchIdx, undefined, note);
        }
        continue;
      }
```

Extract whatever artifact preparation the current code does into a `prepareArtifact(subset)` helper so bisection can re-prepare with a subset.

- [ ] **Step 5: Add an orchestrator test**

```ts
  test("a mutant that breaks compilation is named, not blamed on the whole run", async () => {
    const dirs = await makeProject();
    let seenSubsets = 0;
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    // Fail deploy while a specific mutant is present; succeed otherwise.
    backend.deployGuard = (dir: string) => {
      seenSubsets++;
      return seenSubsets === 1 ? new Error("alc: AL0001") : undefined;
    };
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    store.close();
  });
```

Add the `deployGuard` hook to `StubBackend` so the test can fail deploy conditionally.

- [ ] **Step 6: Run tests**

Run: `bun test` (dist deleted first), `bun run typecheck`, `bunx biome check packages/runner` — all green.

- [ ] **Step 7: Commit**

```bash
git add packages/runner
git commit -m "feat(runner): bisect a failed all-mutant compile to the offending mutant"
```

---

## Task 7: Measure growth and verify live

**Files:**
- Create: `packages/runner/itest/growth.itest.ts`
- Modify: `fixtures/README.md`
- Modify: root `package.json` (add `itest:growth`)

- [ ] **Step 1: Write the growth measurement script**

Create `packages/runner/itest/growth.itest.ts` — a standalone bun script (not a `bun:test` file), reporting emitted source size for the fixture:

```ts
#!/usr/bin/env bun
/**
 * Reports instrumented-source growth for the sandbox fixture. Not env-gated —
 * it needs no server, only the schemata compiler. Run: bun run itest:growth
 */
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet } from "../src/orchestrator";

const PROJECT = join(import.meta.dir, "..", "..", "..", "fixtures", "sandbox-app");
const files = await generateMutationSet(PROJECT);
const originalBytes = files.reduce((n, f) => n + f.source.length, 0);
const mutantCount = files.reduce((n, f) => n + f.specs.length, 0);

const dir = await mkdtemp(join(tmpdir(), "lethal-growth-"));
await writeInstrumentedProject({
  targetDir: dir,
  files,
  selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
});

let emitted = 0;
for (const entry of await readdir(dir)) {
  if (!entry.endsWith(".al")) continue;
  emitted += (await stat(join(dir, entry))).size;
}

const ratio = emitted / originalBytes;
console.log(`mutants:          ${mutantCount}`);
console.log(`original source:  ${originalBytes} bytes`);
console.log(`instrumented:     ${emitted} bytes`);
console.log(`growth:           ${ratio.toFixed(2)}x  (${(emitted / mutantCount).toFixed(0)} bytes/mutant)`);
console.log(
  ratio < mutantCount
    ? "LINEAR-ish: growth is below one full copy per mutant"
    : "WARNING: growth exceeds one copy per mutant — investigate",
);
void readFile;
```

Add to root `package.json` scripts: `"itest:growth": "bun packages/runner/itest/growth.itest.ts"`.

- [ ] **Step 2: Run it and record the numbers**

Run: `bun run itest:growth`
Record the output verbatim for the commit message and the README.

- [ ] **Step 3: Verify verdicts are unchanged, live**

Both backends must produce exactly what they did before coalescing.

```bash
LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
  bun packages/runner/src/cli.ts run --project fixtures/sandbox-app \
  --tests fixtures/sandbox-tests --backend al-runner \
  --config fixtures/sandbox-app/lethal.config.local.json
```

Expected: `killed 3, survived 13, no-coverage 0`, score `18.8%`.

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev     # expect: bcdev itest: PASS
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
  bun run itest:alrunner                      # expect: al-runner itest: PASS
```

If any verdict differs, coalescing has changed behavior — that is a bug in the emission, not an expectation to update. Report BLOCKED with the differing table.

- [ ] **Step 4: Document**

Add a short "Coalescing" section to `fixtures/README.md`: the fixture now compiles to **one** artifact (was 3), the measured growth figure from Step 2, and the statement that verdicts are identical on both backends.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/itest/growth.itest.ts package.json fixtures/README.md
git commit -m "test(runner): measure instrumented-source growth; document coalescing results"
```

---

## Self-Review

**Spec coverage.** §2 containment tree → Task 1; §2 validation invariant → Task 4; §3 flat dispatch → Tasks 2–3; §4 lift rejected → Task 3 records it in a comment, no code routes to lift; §5 composition/components → Task 1; §6 batching retained as splitting seam + bisection → Tasks 5–6; §7 id allocation → already fixed in `4ec2095`, no task needed; §8 ternary gap → explicitly out of scope; §11 exit criteria → Task 5 Step 6 (one artifact), Task 7 Steps 2–3 (growth, live verdicts), Task 6 Step 5 (bisection names the mutant), Task 1 Step 1 (non-interference is covered by the component ordering test plus Task 3's chain test).

**Known gap, deliberate.** The spec's exit criterion "a test proves mutants in one component do not interfere" is covered structurally — flat dispatch makes interference impossible by construction, since branches are independent — and behaviourally by the unchanged live verdicts in Task 7. There is no unit test that activates one mutant and asserts another is inert, because that requires executing AL. Task 7's live runs are the real check.

**Type consistency.** `Component`/`ComponentMember` are defined in Task 1 and consumed under those names in Tasks 2–3. `buildComponents`, `emitDispatch`, `bisectFailingMutant` keep their signatures across tasks. `batchIndex`/`batch_count` are explicitly retained, so no later task references a removed field.

**Placeholder scan.** No TBD/TODO. Every code step carries its code. Task 3 Step 4 and Task 5 Step 5 instruct updating existing tests that assert the old emission shape — those are real edits the implementer must enumerate in the commit, not deferred work.
