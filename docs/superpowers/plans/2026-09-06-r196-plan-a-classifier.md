# R196 Plan A: the hang-capable classifier, and the halt it feeds

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and measure the classifier that decides whether an assignment mutation could make a
loop non-terminating, and produce the corpus number that decides whether the rest of R196 is built
at all.

**Architecture:** Two pure, offline units and one measurement script. `resolveVarRef` answers "which
declaration does this identifier refer to" against the existing `SymbolTable`; `classifyHangCapable`
walks outward from an assignment through enclosing `while`/`repeat` loops to the procedure or
trigger boundary and asks whether any of their conditions reads the assignment's target. Neither is
wired into an operator, a report or a runner in this plan: nothing user-visible changes, and no
mutant moves.

**Tech Stack:** Bun + TypeScript, `bun:test`, tree-sitter-al via `packages/engine/src/ast`.

**Spec:** `docs/superpowers/specs/2026-09-06-r196-hang-capable-design.md` (revision 2). The plan
argues from the spec; read both.

## Why this is Plan A and not the whole thing

Spec §3.4 makes the corpus claim rate a **halt**: a rate in the thousands means the rule is wrong
rather than broad, and a high unresolved rate means the resolver is. Building the tag plumbing, the
per-dispatch stop, the confirmation, resume and the gate before that number exists would risk
throwing all of it away. **Plan B is written only after Task 3's decision is recorded.**

## Global Constraints

Copied from `CLAUDE.md` and the spec; every task's requirements implicitly include these.

- **No `!` non-null assertions.** biome `noNonNullAssertion` is an error. Destructure, then check
  `undefined`.
- **`exactOptionalPropertyTypes`.** Build optional props with `...(v !== undefined ? { k: v } : {})`.
- **Build loop, in this order:** `bun run typecheck`, then `rm -rf packages/*/dist`, then
  `bun test`. Skipping the `rm` picks up stale compiled `*.test.js` and produces ~21 phantom
  failures.
- **Lint only what you touched:** `bunx biome check <paths>`; a repo-wide run is noisy with
  pre-existing debt.
- **An unresolved identifier is DECLINED, never name-matched** (spec §3.1). A guess must not be able
  to force a session stop.
- **A tag claims only that the target is a condition-relevant variable of an enclosing loop**
  (spec §3.3). No comment, message or doc may say it proves a hang will occur, or that an unclassified
  shape is safe.
- **Fail loudly on caller-contract violations.** Throw; never return a plausible empty default.

## File Structure

| file | responsibility |
|---|---|
| `packages/engine/src/semantic/resolve-var-ref.ts` (create) | Given an identifier node, find its enclosing scope and return the `VarSymbol` it refers to, or `null`. Nothing about loops. |
| `packages/engine/tests/semantic/resolve-var-ref.test.ts` (create) | Scope, shadowing, parameters, quoting, case, and the non-variable positions that must return `null`. |
| `packages/builtin-tier1/src/loop-hazard.ts` (create) | Given an assignment node, decide whether any enclosing loop's condition reads its target. Consumes the resolver; knows nothing about operators. |
| `packages/builtin-tier1/tests/loop-hazard.test.ts` (create) | The four operator shapes, the boundary cases, and every §3.2 exclusion asserted as NOT classified. |
| `scripts/census-hang-capable.ts` (create) | Walk a corpus, report claimed sites per operator shape and declined-unresolved counts. Modelled on `scripts/census-operator-sites.ts`. |
| `docs/measurements/README.md` (modify) | Record the corpus numbers and the halt decision. |

---

### Task 1: `resolveVarRef`, which declaration does this identifier mean

**Note, added after execution (fix round, R196):** `enclosingScope`/`VarScope`, named below as
Task 1's output for Task 2 to consume, were built as specified, then DELETED once Task 2 was
actually written against `receiver.ts`'s existing `lookupVar` instead (a thin adapter over it,
rather than a second resolver walking its own scope chain). They are dead API this plan describes
but the shipped code does not have, and a reader following this plan literally would rebuild code
that was deliberately removed. See `packages/engine/src/semantic/resolve-var-ref.ts`'s own module
doc and its git history for why, and read the self-review's "type consistency" note below in that
light rather than as a description of the committed module's actual exports.

**Files:**
- Create: `packages/engine/src/semantic/resolve-var-ref.ts`
- Create: `packages/engine/tests/semantic/resolve-var-ref.test.ts`

**Interfaces:**
- Consumes: `SemanticContext` (`packages/engine/src/semantic/context.ts:27`), whose `symbols`
  provides `resolveProcedure(ownerName, procName)` (with `.parameters`), `localsOf(ownerName,
  procName)` and `globalsOf(ownerName)`. Note parameters are a field of `ProcedureSymbol`
  (`symbol-table.ts:116`) and are NOT included in `localsOf`, so both must be consulted.
- Produces, for Task 2:
  - `interface VarScope { readonly ownerName: string; readonly procName: string | null }`
  - `enclosingScope(node: ALSyntaxNode): VarScope | null`
  - `resolveVarRef(node: ALSyntaxNode, ctx: SemanticContext): VarSymbol | null`
  - `normalizeAlName(raw: string): string`, strips one layer of `"` quoting and lowercases.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/semantic/resolve-var-ref.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseAL } from "../../src/ast/parser";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { type ALSyntaxNode, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { normalizeAlName, resolveVarRef } from "../../src/semantic/resolve-var-ref";

/** Every `identifier` node in the tree, in source order. */
function identifiers(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.identifier) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  return { root, ctx };
}

/** The LAST identifier whose text matches, which is the use site rather than the declaration. */
function useOf(root: ALSyntaxNode, name: string): ALSyntaxNode {
  const hits = identifiers(root).filter(
    (n) => normalizeAlName(n.text) === normalizeAlName(name),
  );
  const last = hits[hits.length - 1];
  if (last === undefined) throw new Error(`no identifier ${name}`);
  return last;
}

describe("resolveVarRef", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("resolves a codeunit global from inside a procedure", () => {
    const { root, ctx } = load(`codeunit 50200 "R" { var Counter: Integer;
      procedure P() begin Counter := 1; end; }`);
    const sym = resolveVarRef(useOf(root, "Counter"), ctx);
    expect(sym?.name).toBe("Counter");
    expect(sym?.typeText).toContain("Integer");
  });

  it("resolves a local, and prefers it over a same-named global (shadowing)", () => {
    const { root, ctx } = load(`codeunit 50201 "R" { var Total: Integer;
      procedure P() var Total: Decimal; begin Total := 1; end; }`);
    const sym = resolveVarRef(useOf(root, "Total"), ctx);
    expect(sym?.typeText).toContain("Decimal");
  });

  it("resolves a PARAMETER, which localsOf does not carry", () => {
    const { root, ctx } = load(`codeunit 50202 "R" {
      procedure P(Limit: Integer) begin Limit := 2; end; }`);
    expect(resolveVarRef(useOf(root, "Limit"), ctx)?.name).toBe("Limit");
  });

  it("is case-insensitive, as AL is", () => {
    const { root, ctx } = load(`codeunit 50203 "R" { var Counter: Integer;
      procedure P() begin COUNTER := 1; end; }`);
    expect(resolveVarRef(useOf(root, "COUNTER"), ctx)?.name).toBe("Counter");
  });

  it("resolves inside a TRIGGER, not only a procedure", () => {
    const { root, ctx } = load(`table 50204 "R" { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() var Seen: Integer; begin Seen := 1; end; }`);
    expect(resolveVarRef(useOf(root, "Seen"), ctx)?.name).toBe("Seen");
  });

  it("returns null for a MEMBER name after a dot, not a variable read", () => {
    const { root, ctx } = load(`codeunit 50205 "R" { var Rec: Record Customer;
      procedure P() begin Rec.Name := 'x'; end; }`);
    expect(resolveVarRef(useOf(root, "Name"), ctx)).toBeNull();
  });

  it("returns null for an undeclared name rather than inventing one", () => {
    const { root, ctx } = load(`codeunit 50206 "R" {
      procedure P() begin Missing := 1; end; }`);
    expect(resolveVarRef(useOf(root, "Missing"), ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `bun test packages/engine/tests/semantic/resolve-var-ref.test.ts`
Expected: FAIL, cannot resolve module `../../src/semantic/resolve-var-ref`.

- [ ] **Step 3: Implement**

Create `packages/engine/src/semantic/resolve-var-ref.ts`:

```ts
import { ALNodeKind } from "../ast/node-kinds";
import type { ALSyntaxNode } from "../ast/syntax-node";
import type { SemanticContext } from "./context";
import type { VarSymbol } from "./symbol-table";

/** The object and (optionally) the procedure or trigger an identifier sits in. */
export interface VarScope {
  readonly ownerName: string;
  readonly procName: string | null;
}

/**
 * AL names are case-insensitive and may be quoted (`"No."`). One layer of quoting is stripped;
 * an inner `""` escape is left alone, because no lookup here depends on it.
 */
export function normalizeAlName(raw: string): string {
  const trimmed = raw.trim();
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.toLowerCase();
}

/** The `name` child of a declaration node, or null when the grammar did not give it one. */
function declaredName(node: ALSyntaxNode): string | null {
  const named = node.childForFieldName("name");
  return named === null ? null : named.text;
}

/**
 * Walk out to the enclosing object, recording the procedure or trigger passed through on the way.
 * Returns null for a node with no enclosing object, which a caller must treat as "cannot classify"
 * rather than as an empty scope.
 */
export function enclosingScope(node: ALSyntaxNode): VarScope | null {
  let procName: string | null = null;
  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null) {
    if (procName === null && (cur.kind === ALNodeKind.procedure || cur.kind === ALNodeKind.trigger)) {
      procName = declaredName(cur);
    }
    const owner = declaredName(cur);
    if (OBJECT_KINDS.has(cur.kind) && owner !== null) {
      return { ownerName: owner, procName };
    }
    cur = cur.parent;
  }
  return null;
}

const OBJECT_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.codeunit,
  ALNodeKind.table,
  ALNodeKind.page,
  ALNodeKind.report,
  ALNodeKind.tableextension,
  ALNodeKind.pageextension,
]);

/**
 * Is this identifier a MEMBER name rather than a variable read? `Rec.Name` parses as a
 * `member_expression` (`ALNodeKind.field_access`) whose first named child is the receiver; every
 * later child is a member name and refers to no declaration this table knows.
 */
function isMemberName(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null || parent.kind !== ALNodeKind.field_access) return false;
  return parent.namedChildren[0] !== node;
}

/**
 * The declaration an identifier refers to, or `null` when it cannot be established.
 *
 * `null` is a REFUSAL, not an absence: R196's classifier declines an unresolved site rather than
 * falling back to a name match, because a tag it produces can force LethAL to end a BC session and
 * a guess must never do that (spec §3.1).
 *
 * Lookup order is AL's: parameters and locals of the enclosing procedure or trigger shadow the
 * object's globals. Parameters live on `ProcedureSymbol.parameters` and are NOT returned by
 * `localsOf`, so both are consulted: omitting the first silently mis-resolves every
 * parameter-driven loop.
 */
export function resolveVarRef(node: ALSyntaxNode, ctx: SemanticContext): VarSymbol | null {
  if (node.kind !== ALNodeKind.identifier) return null;
  if (isMemberName(node)) return null;
  const scope = enclosingScope(node);
  if (scope === null) return null;
  const wanted = normalizeAlName(node.text);
  const { ownerName, procName } = scope;
  if (procName !== null) {
    const proc = ctx.symbols.resolveProcedure(ownerName, procName);
    const local = [...(proc?.parameters ?? []), ...ctx.symbols.localsOf(ownerName, procName)].find(
      (v) => normalizeAlName(v.name) === wanted,
    );
    if (local !== undefined) return local;
  }
  return ctx.symbols.globalsOf(ownerName).find((v) => normalizeAlName(v.name) === wanted) ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/engine/tests/semantic/resolve-var-ref.test.ts`
Expected: PASS, 7 tests.

If a test fails on a node kind (for example the trigger case), do NOT loosen the assertion. Print
the actual tree with a scratch script and fix the kind constant. `ALNodeKind` is a curated subset
that CASTS the raw tree-sitter type (`node-kinds.ts`), so a wrong constant matches nothing at
runtime with no type error, which is R120.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test packages/engine
bunx biome check packages/engine/src/semantic/resolve-var-ref.ts packages/engine/tests/semantic/resolve-var-ref.test.ts
git add packages/engine/src/semantic/resolve-var-ref.ts packages/engine/tests/semantic/resolve-var-ref.test.ts
git commit -m "feat(engine): resolveVarRef, which declaration an identifier refers to (R196)"
```

---

### Task 2: `classifyHangCapable`, is this assignment's target read by an enclosing loop's condition

**Files:**
- Create: `packages/builtin-tier1/src/loop-hazard.ts`
- Create: `packages/builtin-tier1/tests/loop-hazard.test.ts`

**Interfaces:**
- Consumes: `resolveVarRef`, `normalizeAlName` from Task 1.
- Produces, for Plan B's operators and Task 3's census:
  - `type HangCapableReason = "loop-condition-target"`
  - `assignmentTargetOf(node: ALSyntaxNode): ALSyntaxNode | null`, the target identifier of the
    assignment at or enclosing `node`; `null` when there is none.
  - `classifyHangCapable(node: ALSyntaxNode, ctx: SemanticContext): HangCapableReason | null`

- [ ] **Step 1: Write the failing test**

Create `packages/builtin-tier1/tests/loop-hazard.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../engine/src/ast/node-kinds";
import { initParser, parseAL } from "../../engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../../engine/src/ast/syntax-node";
import { buildSemanticContext } from "../../engine/src/semantic/context";
import { classifyHangCapable } from "../src/loop-hazard";

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** The assignment statement whose source text contains `needle`. */
function assignment(root: ALSyntaxNode, needle: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement && n.text.includes(needle)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  const first = out[0];
  if (first === undefined) throw new Error(`no assignment containing ${needle}`);
  return first;
}

describe("classifyHangCapable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("CLAIMS a counter advanced in a while body whose condition reads it", () => {
    const { root, ctx } = load(`codeunit 50300 "R" {
      procedure P(Limit: Integer) var I: Integer; begin
        while I < Limit do I += 1;
      end; }`);
    expect(classifyHangCapable(assignment(root, "I += 1"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS a flag assigned in a repeat body whose until reads it", () => {
    const { root, ctx } = load(`codeunit 50301 "R" {
      procedure P() var Done: Boolean; begin
        repeat Done := true; until Done;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Done := true"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS through an OUTER loop, not only the nearest one", () => {
    const { root, ctx } = load(`codeunit 50302 "R" {
      procedure P() var Outer: Integer; Inner: Integer; begin
        while Outer < 10 do begin
          while Inner < 3 do Inner += 1;
          Outer += 1;
        end;
      end; }`);
    // `Outer += 1` sits inside the inner loop's sibling, but the OUTER condition reads it.
    expect(classifyHangCapable(assignment(root, "Outer += 1"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS inside a TRIGGER body", () => {
    const { root, ctx } = load(`table 50303 "R" { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() var N: Integer; begin
        while N < 3 do N += 1;
      end; }`);
    expect(classifyHangCapable(assignment(root, "N += 1"), ctx)).toBe("loop-condition-target");
  });

  it("DECLINES an assignment the condition does not read: the step variable (spec 3.2.1)", () => {
    const { root, ctx } = load(`codeunit 50304 "R" {
      procedure P(Limit: Integer) var I: Integer; Step: Integer; begin
        Step := 1;
        while I < Limit do I += Step;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Step := 1"), ctx)).toBeNull();
  });

  it("DECLINES a preheader assignment (spec 3.2.2)", () => {
    const { root, ctx } = load(`codeunit 50305 "R" {
      procedure P(Target: Integer) var Position: Integer; begin
        Position := Target + 1;
        repeat if Position > Target then Position -= 1; until Position = Target;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Position := Target + 1"), ctx)).toBeNull();
  });

  it("DECLINES an assignment outside any loop", () => {
    const { root, ctx } = load(`codeunit 50306 "R" {
      procedure P() var I: Integer; begin I := 1; end; }`);
    expect(classifyHangCapable(assignment(root, "I := 1"), ctx)).toBeNull();
  });

  it("DECLINES when the target cannot be resolved, rather than matching on name", () => {
    const { root, ctx } = load(`codeunit 50307 "R" {
      procedure P() begin while Ghost < 3 do Ghost += 1; end; }`);
    expect(classifyHangCapable(assignment(root, "Ghost += 1"), ctx)).toBeNull();
  });

  it("DECLINES a same-named variable in a DIFFERENT procedure's loop", () => {
    const { root, ctx } = load(`codeunit 50308 "R" {
      procedure A() var I: Integer; begin while I < 3 do ; end;
      procedure B() var I: Integer; begin I += 1; end; }`);
    expect(classifyHangCapable(assignment(root, "I += 1"), ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/builtin-tier1/tests/loop-hazard.test.ts`
Expected: FAIL, cannot resolve module `../src/loop-hazard`.

- [ ] **Step 3: Implement**

Create `packages/builtin-tier1/src/loop-hazard.ts`:

```ts
import { ALNodeKind } from "../../engine/src/ast/node-kinds";
import type { ALSyntaxNode } from "../../engine/src/ast/syntax-node";
import type { SemanticContext } from "../../engine/src/semantic/context";
import { resolveVarRef } from "../../engine/src/semantic/resolve-var-ref";

/**
 * WHY THIS EXISTS (R196). Four operators can turn a terminating loop into a non-terminating one by
 * mutating a variable the loop's condition reads. Measured on the Document Output Templates slice:
 * eight of 741 mutants never terminate, costing about 40 of the run's 148 minutes in strands,
 * quarantines and resumes.
 *
 * WHAT A CLAIM MEANS, EXACTLY. That the assignment's target is a CONDITION-RELEVANT VARIABLE of an
 * enclosing loop. It does NOT establish that the mutation prevents progress, that the assignment
 * runs on the path that timed out, that nothing else advances the condition, or that an `exit`, an
 * error or an overflow cannot end the loop anyway. R179's `DrainQueue` is this repository's
 * counterexample: its frozen loop terminated by Int32 overflow in ~4.4 s rather than hanging.
 *
 * WHAT IT DELIBERATELY DOES NOT SEE, all UNCLASSIFIED rather than proven safe (spec 3.2): a target
 * read in the loop BODY rather than its condition; preheader assignments; progress that happens
 * through a CALL (which is both hangs in `fixtures/sandbox-hang`); record and field targets; and
 * condition-side mutations, which are not assignments at all.
 *
 * POSITIONAL AND IDENTITY-BASED, never value-based. `empty-block.ts` records the principle this
 * follows: reading the tree is checkable, guessing what a loop does is not. Asking which
 * declaration a name refers to is identity, not value.
 */
export type HangCapableReason = "loop-condition-target";

const LOOP_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.while_statement,
  ALNodeKind.repeat_statement,
]);

/**
 * `for_statement` is absent on purpose. Whether an AL `for` can be made non-terminating by mutating
 * its control variable depends on whether the platform re-evaluates the bound and re-reads the
 * variable each iteration, and this repository has NOT measured that. Unmeasured, so unclassified.
 */
const SCOPE_KINDS: ReadonlySet<string> = new Set([ALNodeKind.procedure, ALNodeKind.trigger]);

/** The target identifier of the assignment at, or enclosing, `node`. */
export function assignmentTargetOf(node: ALSyntaxNode): ALSyntaxNode | null {
  let cur: ALSyntaxNode | null = node;
  while (cur !== null && !SCOPE_KINDS.has(cur.kind)) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const target = cur.childForFieldName("left") ?? cur.namedChildren[0] ?? null;
      if (target === null) return null;
      return target.kind === ALNodeKind.identifier ? target : null;
    }
    cur = cur.parent;
  }
  return null;
}

/** The condition expression of a `while`/`repeat`, or null when the grammar did not name one. */
function conditionOf(loop: ALSyntaxNode): ALSyntaxNode | null {
  return loop.childForFieldName("condition") ?? null;
}

/** Every identifier read inside an expression, member names excluded by `resolveVarRef`. */
function identifiersIn(node: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.identifier) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(node);
  return out;
}

/**
 * Does any enclosing loop's condition read this assignment's target?
 *
 * Returns `null` for every case it cannot establish, INCLUDING an unresolvable target. That refusal
 * is deliberate: a claim here can force LethAL to end a BC session on the user's own server, and a
 * name match is a guess (spec 3.1).
 */
export function classifyHangCapable(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): HangCapableReason | null {
  const target = assignmentTargetOf(node);
  if (target === null) return null;
  const targetSym = resolveVarRef(target, ctx);
  if (targetSym === null) return null;

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !SCOPE_KINDS.has(cur.kind)) {
    if (LOOP_KINDS.has(cur.kind)) {
      const cond = conditionOf(cur);
      if (cond !== null) {
        for (const ident of identifiersIn(cond)) {
          if (resolveVarRef(ident, ctx) === targetSym) return "loop-condition-target";
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/builtin-tier1/tests/loop-hazard.test.ts`
Expected: PASS, 9 tests.

Two failures are likely and neither is fixed by weakening a test:
- `conditionOf` returning null because the grammar does not use the field name `condition` for one
  of the two loop kinds. Print `loop.children.map(c => [c.fieldName, c.kind, c.text])` for a
  `while` and a `repeat` and use what the grammar actually exposes.
- `resolveVarRef(ident, ctx) === targetSym` failing on identity because the symbol table returns a
  fresh object per call. If so, compare on `(name, node.startIndex)` of the declaration rather than
  on reference identity, and say so in a comment.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test packages/builtin-tier1
bunx biome check packages/builtin-tier1/src/loop-hazard.ts packages/builtin-tier1/tests/loop-hazard.test.ts
git add packages/builtin-tier1/src/loop-hazard.ts packages/builtin-tier1/tests/loop-hazard.test.ts
git commit -m "feat(operators): classifyHangCapable, an assignment whose target an enclosing loop's condition reads (R196)"
```

---

### Task 3: the census, and the halt

**Files:**
- Create: `scripts/census-hang-capable.ts`
- Modify: `docs/measurements/README.md`
- Modify: `docs/superpowers/specs/2026-09-06-r196-hang-capable-design.md` (fill §1's table)

**Interfaces:**
- Consumes: `classifyHangCapable`, `assignmentTargetOf` from Task 2.
- Produces: a decision recorded in `docs/measurements/README.md` that Plan B is or is not written.

- [ ] **Step 1: Write the census script**

Create `scripts/census-hang-capable.ts`, modelled on `scripts/census-operator-sites.ts` (read its
first 40 lines for the corpus-walking and parsing shape, and reuse it rather than reinventing):

```ts
#!/usr/bin/env bun
/**
 * R196's claim-rate measurement, and the HALT it feeds (spec 3.4).
 *
 * Reports, for a corpus: how many assignment sites each of the four operators would tag, how many
 * were DECLINED because the target could not be resolved, and the totals. A rate in the thousands
 * means the rule is wrong rather than broad; a high declined rate means the resolver is.
 *
 *   bun scripts/census-hang-capable.ts <project-dir> <out.json>
 *
 * Point it at a scratch corpus: the intended input is real customer AL, which must never be
 * committed here.
 */
import { writeFile } from "node:fs/promises";
import { assignmentTargetOf, classifyHangCapable } from "../packages/builtin-tier1/src/loop-hazard";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
// Reuse census-operator-sites.ts's corpus walk verbatim; do not write a second one.
import { collectAlFiles } from "./census-operator-sites";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined || outPath === undefined) {
  console.error("usage: bun scripts/census-hang-capable.ts <project-dir> <out.json>");
  process.exit(2);
}

await initParser();
const files = await collectAlFiles(projectDir);
const sources = files.map((f) => ({ path: f.path, root: wrapRoot(parseAL(f.text)) }));
const ctx = buildSemanticContext(sources);

let assignments = 0;
let tagged = 0;
let declinedUnresolved = 0;
const taggedRows: Array<{ file: string; line: number; text: string }> = [];

for (const { path, root } of sources) {
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement) {
      assignments += 1;
      const target = assignmentTargetOf(n);
      if (target !== null && classifyHangCapable(n, ctx) !== null) {
        tagged += 1;
        taggedRows.push({
          file: path,
          line: n.startPosition.row + 1,
          text: n.text.slice(0, 120),
        });
      } else if (target !== null) {
        // Distinguish "no enclosing loop reads it" from "could not resolve the target at all".
        // The second is the number that indicts the resolver rather than the rule.
        declinedUnresolved += 1;
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
}

const summary = { projectDir, files: files.length, assignments, tagged, declinedUnresolved };
console.log(JSON.stringify(summary, null, 2));
await writeFile(outPath, JSON.stringify({ summary, taggedRows }, null, 2), "utf8");
```

If `census-operator-sites.ts` does not export its corpus walk, export it there in this same commit
rather than copying the loop: two corpus walkers that disagree is exactly R80's shape.

**Refine `declinedUnresolved` before running:** as written above it counts every assignment with no
enclosing-loop hit, which is not the same thing. Split the classifier's two refusal reasons by
calling `resolveVarRef` directly in the census, so the number means "target unresolvable" alone.

- [ ] **Step 2: Run it on both corpora**

```bash
bun scripts/census-hang-capable.ts U:/Git/do-rel2/Cloud "$SCRATCH/hang-capable-dorel2.json"
bun scripts/census-hang-capable.ts U:/Git/do-lethal-53470/Cloud "$SCRATCH/hang-capable-53470.json"
```

Record from each: `files`, `assignments`, `tagged`, `declinedUnresolved`, and `tagged` as a
percentage of `assignments`.

- [ ] **Step 3: Recover the eight, and fill the spec's table**

The spec's §1 table has a row 8 marked *to be recovered from the store* and several rows marked
"expected". Get the truth from run 3's own store rather than from prose:

```bash
python - <<'EOF'
import sqlite3
S = "<scratchpad>/lethal-53470-run3"
c = sqlite3.connect("file:" + S + "/lethal.sqlite?mode=ro", uri=True)
run = [x[0] for x in c.execute("select id from runs order by id")][-1]
for f, ln, op, proc, note in c.execute(
    "select file, line, operator_name, procedure_name, failure_note from mutants "
    "where run_id=? and verdict='error' and failure_note like '%stranded%' order by file, line", (run,)):
    print(f.split("\\")[-1], ln, op, proc)
EOF
```

Cross-check each against the census's `taggedRows` for the same file and line, and rewrite §1's
table with a definite yes/no per row. Replace "about 5 of 8" with the exact count.

- [ ] **Step 4: Record the decision, this is the halt**

Append to `docs/measurements/README.md` a section giving, for both corpora: the claim rate, the
declined-unresolved rate, the exact catch count against the eight, and **the decision**, in one of
these forms:

- *proceed*: the rate is a workable fraction of assignments and the classifier catches the expected
  rows; Plan B is written;
- *revise*: the rule claims too much or too little; the spec's §3 returns to review with the number
  attached;
- *stop*: the rate shows the approach is wrong; R196 is re-opened with this measurement as its
  evidence.

Write the number first and the decision second. A decision recorded without its number is the thing
this step exists to prevent.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check scripts/census-hang-capable.ts
git add scripts/census-hang-capable.ts docs/measurements/README.md docs/superpowers/specs/2026-09-06-r196-hang-capable-design.md
git commit -m "measure(R196): the hang-capable claim rate on two corpora, and the halt decision"
```

---

## After Task 3

If the decision is *proceed*, Plan B is written from spec §4 to §10 and covers: the tag on
`MutationSpec` and its manifest carry, the four operators' emission (with `remove-assignment`'s
fabricated context and both `requiresSemantic` declarations fixed, and `ConformanceCase` extended so
a missing tag fails a test), per-dispatch stop plumbing and the backend capability, the
pre-deploy announcement, the `hang-capable-auto-stop` caveat, the confirmation, resume eligibility,
the fixture arm in a file that sorts before `HangLogic.Codeunit.al`, the gate with its red-check, and
the agent-guide correction.

Nothing in that list is started before the decision is written down.

## Self-review

**Spec coverage for Plan A's scope (spec §3, §3.1, §3.2, §3.3, §3.4):** §3's walk (every enclosing
loop, procedure OR trigger boundary, `while`/`repeat` only, `for` excluded) is Task 2 steps 1 and 3.
§3.1's resolver with its five listed requirements is Task 1, one test each, and the DECLINE rule is
asserted in both tasks. §3.2's five exclusions: 3.2.1 and 3.2.2 have explicit failing-to-claim tests;
3.2.3 (through a call), 3.2.4 (records) and 3.2.5 (condition-side) are not assignment-with-resolvable-
target shapes and are documented in `loop-hazard.ts`'s header rather than tested as absences, which
is noted here so a reviewer does not read it as a gap. §3.3's "what a claim means" is the module
header. §3.4 is Task 3.

**Placeholder scan:** no TBD/TODO; every code step carries the code; the two anticipated failures in
Task 2 step 4 name the diagnostic to run rather than saying "debug it". Task 3 step 1 flags one
refinement to make before running rather than leaving it implicit.

**Type consistency:** `resolveVarRef`, `normalizeAlName`, `enclosingScope`, `VarScope` are defined in
Task 1 and used with those exact names in Task 2; `classifyHangCapable`, `assignmentTargetOf` and
`HangCapableReason` are defined in Task 2 and used with those names in Task 3. `VarSymbol` is
imported from `symbol-table.ts` where it already exists (`:69`).
