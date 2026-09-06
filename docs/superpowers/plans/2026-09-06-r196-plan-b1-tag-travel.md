# R196 Plan B1: the tag, and how it travels

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the hang-capable classification from the four operators that can produce a non-terminating loop all the way to the report, and announce how many such sites were deployed, before any of it forces anything.

**Architecture:** `classifyHangCapable` already exists and is measured (Plan A). This plan gives its answer a home on `MutationSpec`, teaches four operators to emit it, makes the conformance harness able to assert it (without which all four could silently stop emitting it and stay green), and walks it down the path `platformKillMechanism` already proves: operator to `MutationSpec` to `MutantManifestEntry` to `MutantOutcome` to the report. It ends with the pre-deploy announcement. Nothing in this plan changes a verdict, ends a session, or alters a score.

**Tech Stack:** Bun, TypeScript, tree-sitter-al. Workspaces `engine`, `operator-sdk`, `builtin-tier1`, `schemata`, `runner`.

**Spec:** `docs/superpowers/specs/2026-09-06-r196-hang-capable-design.md`, sections 4, 4.1 and 5.3. Read section 3.3 too: it says precisely what a tag claims, and the wording rules in Global Constraints come from it.

## Scope: why this is B1 and not all of Plan B

Spec sections 4 to 10 were originally going to be one plan. They are split because the boundary between them is where the risk changes and where the software is independently useful:

- **B1, this plan.** Sections 4, 4.1 and 5.3. Entirely offline and unit-testable. It ships something real on its own: `lethal run` reports which mutants sit at hang-capable sites and says how many were deployed. No behaviour changes.
- **B2, written after B1 lands.** Sections 5.1, 5.2, 5.4, 5.5, 6, 7 and 8: the per-dispatch stop control, the backend capability, the `hang-capable-auto-stop` caveat, the confirmation, resume eligibility, and the live hang gate. All of it needs a running BC container.

B2 is deliberately not written yet. Its tasks depend on the exact field names and the capability shape B1 lands, and Plan A demonstrated the cost of writing a task against an interface that has not been built: that plan's Task 1 specified a resolver from scratch against an API that did not exist, and the whole task had to be re-ruled before a line was written. B2 gets written against B1's real code.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **A tag must come from a resolved symbol, never a name match.** Spec section 9 lists "a tag emitted from a name match rather than a resolved symbol" as refusing the design. `classifyHangCapable` compares declarations positionally, per Plan A's ruling R2a; do not add a spelling comparison anywhere.
- **Never write, in code, comment or report, that an excluded shape cannot hang, or that a tag proves the mutation prevents progress.** Spec sections 3.2 and 3.3. The honest claim is that the enclosing loop's condition reads what this site writes. Section 3.2's exclusions are *unclassified*, which is not the same as *safe*.
- **`hangCapable` is a named union, never a boolean.** v1 has exactly one value, `"loop-condition-target"`. The section 3.2 widenings would add `"loop-body-target"`, `"loop-preheader"` and `"callee-global"`, each with a different confidence that a boolean would flatten.
- **No verdict may move** on `itest:tables`, `itest:bcdev` or `itest:alrunner`. A tag is metadata; it changes which mutants exist not at all. If a mutant count or an operator name moves in any unit test, that is a defect in the change, not a baseline to re-record.
- **No `!` non-null assertions** (biome `noNonNullAssertion: error`). Destructure, then check `undefined`.
- **`exactOptionalPropertyTypes` is on.** Build optional props with `...(v !== undefined ? { k: v } : {})`. This matters in every task here, because every field added is optional.
- **Fail loudly on caller-contract violations**: throw, never return a plausible empty default. Empty-vs-empty "matches" is this project's signature bug, and the conformance harness in Task 2 is the exact place it has bitten before (R137, R142).
- **Build loop order, and it bites every session:** `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. `tsc --build` regenerates `packages/*/dist` whose stale compiled `*.test.js` get picked up by `bun test` and cause about 21 phantom failures.
- **Lint only what you touched:** `bunx biome check <paths>`. A repo-wide `biome check .` is noisy with pre-existing debt.
- Plain English in comments and commit messages. **No em dashes**, use commas, colons or a full stop.
- Git bash with Windows paths. **Never `2>nul`**, which creates undeletable files; use `2>/dev/null`.

## A note on line numbers

Every code reference in this plan was verified against the tree at commit `d24fa3d`, but the spec's own line numbers had drifted by up to 900 lines in one case. **Search by symbol name, not by line number.** Where this plan gives a line, treat it as a hint about which region of the file to read.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/engine/src/operator/interface.ts` | modify | Owns `HangCapableReason` and `MutationSpec.hangCapable`; `ConformanceCase.expectedSpecs` gains the assertion |
| `packages/engine/src/index.ts` | modify | Re-export `HangCapableReason` |
| `packages/operator-sdk/src/index.ts` | modify | Re-export `HangCapableReason` beside its sibling engine types |
| `packages/builtin-tier1/src/loop-hazard.ts` | modify | Stops declaring the type, gains `hangCapableForMutatedNode` |
| `packages/builtin-tier1/src/remove-assignment.ts` | modify | Emits the tag; real `ctx`; `requiresSemantic` corrected |
| `packages/builtin-tier1/src/shift-integer.ts` | modify | Emits the tag; `requiresSemantic` corrected |
| `packages/builtin-tier1/src/swap-additive.ts` | modify | Emits the tag; `requiresSemantic` corrected |
| `packages/builtin-tier1/src/flip-boolean-literal.ts` | modify | Emits the tag |
| `packages/operator-sdk/src/conformance.ts` | modify | Matches on the tag, reports it in failures |
| `packages/schemata/src/project.ts` | modify | `MutantManifestEntry.hangCapable` and its population |
| `packages/runner/src/hang-capable.ts` | create | `HANG_CAPABLE_EXPLANATIONS`, one sentence per reason |
| `packages/runner/src/report.ts` | modify | `MutantOutcome.hangCapable`, builder, banner |
| `packages/runner/src/events.ts` | modify | `mutation-set-generated.hangCapableCount` |
| `packages/runner/src/orchestrator.ts` | modify | Computes the count, emits the announcement |

---

### Task 1: The type moves to the engine, and operators get a helper that fits their node

`HangCapableReason` currently lives in `packages/builtin-tier1/src/loop-hazard.ts:24`. `MutationSpec` lives in `packages/engine/src/operator/interface.ts:67`. The engine cannot import from `builtin-tier1` (the dependency runs the other way), so the type moves to the engine and `loop-hazard.ts` re-exports it for its existing consumers.

The second half of this task exists because `classifyHangCapable(node, ctx)` answers about an **assignment statement**, and only one of the four operators mutates one. `shift-integer`, `swap-additive` and `flip-boolean-literal` all mutate a node *inside* an assignment's right-hand side. The spec's own example is this shape:

```al
Remaining := 1;
while Remaining > 0 do
    Remaining := 0;        // shift-integer mutates the literal `0`, not the assignment
```

**Files:**
- Modify: `packages/engine/src/operator/interface.ts` (near `MutationSpec`, around line 67 to 78)
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/operator-sdk/src/index.ts`
- Modify: `packages/builtin-tier1/src/loop-hazard.ts`
- Test: `packages/builtin-tier1/tests/loop-hazard.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `classifyHangCapable(node: ALSyntaxNode, ctx: SemanticContext): HangCapableReason | null` and `assignmentTargetOf(node: ALSyntaxNode): ALSyntaxNode | null`, both already in `loop-hazard.ts`.
- Produces:
  - `type HangCapableReason = "loop-condition-target"` exported from `@lethal/engine` and re-exported from `@lethal/operator-sdk`
  - `MutationSpec.hangCapable?: HangCapableReason`
  - `hangCapableForMutatedNode(node: ALSyntaxNode, ctx: SemanticContext): HangCapableReason | null` from `packages/builtin-tier1/src/loop-hazard.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/builtin-tier1/tests/loop-hazard.test.ts`. These use the file's existing setup helpers; follow whatever `describe`/`beforeAll` shape is already there.

```ts
describe("hangCapableForMutatedNode", () => {
  const ctxFor = (src: string) => {
    const root = wrapRoot(parseAL(src));
    return { root, ctx: buildSemanticContext([{ path: "fixture.al", root }]) };
  };

  // The assignment itself, which is remove-assignment's shape.
  it("claims the assignment statement it is given", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := 0;
    end;
}`);
    const assignments = findAll(root, ALNodeKind.assignment_statement);
    const inLoop = assignments[assignments.length - 1];
    expect(inLoop).toBeDefined();
    if (inLoop === undefined) throw new Error("fixture has no assignment");
    expect(hangCapableForMutatedNode(inLoop, ctx)).toBe("loop-condition-target");
  });

  // A literal inside the assignment's right-hand side, which is shift-integer's shape.
  it("claims a literal on the value side of an in-loop assignment", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := 0;
    end;
}`);
    const literals = findAll(root, ALNodeKind.integer).filter((n) => n.text === "0");
    const lit = literals[0];
    if (lit === undefined) throw new Error("fixture has no `0` literal");
    expect(hangCapableForMutatedNode(lit, ctx)).toBe("loop-condition-target");
  });

  // The target side is not a value written to the target.
  it("DECLINES a node inside the assignment's target expression", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Slots: array[5] of Integer;
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Slots[2] := 0;
    end;
}`);
    const twos = findAll(root, ALNodeKind.integer).filter((n) => n.text === "2");
    const two = twos[0];
    if (two === undefined) throw new Error("fixture has no `2` literal");
    expect(hangCapableForMutatedNode(two, ctx)).toBeNull();
  });

  // A node in a statement that is not an assignment must not borrow a neighbour's answer.
  it("DECLINES a literal in a non-assignment statement beside an in-loop assignment", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do begin
            Remaining := 0;
            Message('%1', 7);
        end;
    end;
}`);
    const sevens = findAll(root, ALNodeKind.integer).filter((n) => n.text === "7");
    const seven = sevens[0];
    if (seven === undefined) throw new Error("fixture has no `7` literal");
    expect(hangCapableForMutatedNode(seven, ctx)).toBeNull();
  });

  // No enclosing loop at all.
  it("DECLINES a literal in an assignment outside any loop", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 3;
    end;
}`);
    const threes = findAll(root, ALNodeKind.integer).filter((n) => n.text === "3");
    const three = threes[0];
    if (three === undefined) throw new Error("fixture has no `3` literal");
    expect(hangCapableForMutatedNode(three, ctx)).toBeNull();
  });

  // The walk must not leave the procedure it started in.
  it("DECLINES when the only loop is in a different procedure", () => {
    const { root, ctx } = ctxFor(`codeunit 50000 P
{
    procedure Spin()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := Remaining - 1;
    end;

    procedure Other()
    var
        Remaining: Integer;
    begin
        Remaining := 9;
    end;
}`);
    const nines = findAll(root, ALNodeKind.integer).filter((n) => n.text === "9");
    const nine = nines[0];
    if (nine === undefined) throw new Error("fixture has no `9` literal");
    expect(hangCapableForMutatedNode(nine, ctx)).toBeNull();
  });
});
```

Add `hangCapableForMutatedNode` to the file's import from `../src/loop-hazard`, and `findAll` to its import from `@lethal/engine` if it is not there already.

- [ ] **Step 2: Run the tests and confirm they fail for the right reason**

Run: `bun test packages/builtin-tier1/tests/loop-hazard.test.ts`
Expected: FAIL, `hangCapableForMutatedNode is not a function` or a TypeScript error that the export does not exist. If any test fails for a different reason, read it before writing code: a fixture that does not parse the way you expected is worth knowing about now.

- [ ] **Step 3: Move the type into the engine**

In `packages/engine/src/operator/interface.ts`, above `MutationSpec`:

```ts
/**
 * R196: which rule decided this site can make a loop run forever.
 *
 * A named union rather than a boolean so the report can say WHICH rule fired. v1 has one value.
 * The design's section 3.2 widenings would add `"loop-body-target"`, `"loop-preheader"` and
 * `"callee-global"`, each carrying a different confidence that a boolean would flatten into one
 * undifferentiated flag.
 */
export type HangCapableReason = "loop-condition-target";
```

Then add the field to `MutationSpec`, beside `platformKillMechanism`:

```ts
  /**
   * R196: set when an enclosing loop's condition reads the variable this site writes.
   *
   * This claims exactly that relationship and nothing more. It does NOT claim the mutation
   * prevents progress, and an absent tag does NOT mean the site is safe: the design's section 3.2
   * lists shapes that are unclassified rather than cleared. See section 3.3.
   */
  readonly hangCapable?: HangCapableReason;
```

Export the type from `packages/engine/src/index.ts` beside the other `operator/interface` exports, and re-export it from `packages/operator-sdk/src/index.ts` beside `MutationSpec` and `SemanticContext`, because the four operator files import their engine types through `@lethal/operator-sdk`.

- [ ] **Step 4: Make `loop-hazard.ts` consume the moved type**

Replace its own `export type HangCapableReason = "loop-condition-target";` with an import from `@lethal/engine` plus a re-export, so existing importers of `loop-hazard` keep working:

```ts
import { type HangCapableReason } from "@lethal/engine";

export type { HangCapableReason };
```

- [ ] **Step 5: Add `hangCapableForMutatedNode`**

In `packages/builtin-tier1/src/loop-hazard.ts`, beside `classifyHangCapable`:

```ts
/**
 * The hang-capable reason for the site an OPERATOR is mutating, or null.
 *
 * `classifyHangCapable` answers about an assignment statement. Only one of the four operators that
 * need an answer mutates one: `shift-integer`, `swap-additive` and `flip-boolean-literal` all
 * mutate a node inside an assignment's right-hand side. This walks out to the enclosing assignment
 * and asks about that, because the value written is what an enclosing loop's condition reads.
 *
 * Two refusals, both deliberate. A node inside the assignment's `left` field is part of the target
 * expression, not a value written to the target, so `Slots[2] := 0` does not become hang-capable
 * through its subscript. And the walk stops at the enclosing procedure or trigger, so a node in a
 * loop-free procedure never borrows an answer from a loop elsewhere in the object.
 *
 * Containment is tested by POSITION rather than by node identity, for the reason recorded in
 * [[R209]]: `resolveVarRef` returns freshly built `VarSymbol` objects for trigger-local variables,
 * and the AST wrapper nodes are reconstructed on access, so reference equality is not reliable
 * here. Positions are unique within a file, and this walk never leaves one.
 */
export function hangCapableForMutatedNode(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): HangCapableReason | null {
  if (node.rawKind === ALNodeKind.assignment_statement) return classifyHangCapable(node, ctx);

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null) {
    if (cur.rawKind === ALNodeKind.assignment_statement) {
      const right = cur.childForFieldName("right");
      if (right === null) return null;
      const insideValueSide = node.startIndex >= right.startIndex && node.endIndex <= right.endIndex;
      return insideValueSide ? classifyHangCapable(cur, ctx) : null;
    }
    if (SCOPE_KINDS.has(cur.rawKind)) return null;
    cur = cur.parent;
  }
  return null;
}
```

`SCOPE_KINDS` is the private constant `classifyHangCapable` already uses to stop at a procedure or trigger boundary. If it is named differently in the file, use the existing name rather than adding a second constant: the file already had three copies of a walk factored down to one, and a fourth would undo that.

- [ ] **Step 6: Run the tests**

Run: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test packages/builtin-tier1 packages/engine`
Expected: PASS, including the six new tests, with no existing test changed.

- [ ] **Step 7: Red-check the value-side refusal**

This is the one branch a plausible wrong implementation gets wrong, and the array-subscript test is the only thing pinning it. Delete the `insideValueSide` check so the function returns `classifyHangCapable(cur, ctx)` unconditionally, run `bun test packages/builtin-tier1/tests/loop-hazard.test.ts`, and confirm the "DECLINES a node inside the assignment's target expression" test goes RED and nothing else does. Restore it and confirm green. Report both outputs.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/operator/interface.ts packages/engine/src/index.ts packages/operator-sdk/src/index.ts packages/builtin-tier1/src/loop-hazard.ts packages/builtin-tier1/tests/loop-hazard.test.ts
git commit -m "feat(engine): MutationSpec carries hangCapable, and operators get a node-shaped helper (R196)"
```

---

### Task 2: The conformance harness can assert the tag

Spec section 4.1: `ConformanceCase.expectedSpecs` can assert only `parentContext`, `beforeText` and `afterText`. **All four operators could ship untagged with every conformance test green.** This task closes that before Task 3 relies on it, so that Task 3's operator work has something that can actually fail.

The harness has been the site of this exact failure twice. R137: a refusal case with no expected specs passed on any input at all. R142: a case expecting one spec passed when the operator emitted that spec plus an unwanted one. Both were the empty-vs-empty shape, inside the harness meant to catch it. This is the third instance of the same shape and should be treated with the same suspicion.

**Files:**
- Modify: `packages/engine/src/operator/interface.ts` (the `ConformanceCase` interface, around line 81 to 88)
- Modify: `packages/operator-sdk/src/conformance.ts` (the matcher around line 68 to 73, and `ConformanceFailure`)
- Test: `packages/operator-sdk/tests/conformance.test.ts` (create if the package has no test directory yet; follow the layout of `packages/builtin-tier1/tests/`)

**Interfaces:**
- Consumes: `HangCapableReason` and `MutationSpec.hangCapable` from Task 1.
- Produces: `ConformanceCase.expectedSpecs[].hangCapable?: HangCapableReason | null`, where `undefined` does not assert, a reason asserts equality, and `null` asserts the spec carries no tag.

- [ ] **Step 1: Write the failing test**

Create `packages/operator-sdk/tests/conformance.test.ts`. The synthetic operators here exist so the harness is tested against something whose tagging behaviour the test controls, rather than against a real operator whose behaviour would also have to be right.

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationOperator,
  type MutationSpec,
  type SemanticContext,
  initParser,
} from "@lethal/engine";
import { runConformance } from "../src/conformance";

const SOURCE = `codeunit 50000 P
{
    procedure Go()
    var
        N: Integer;
    begin
        N := 1;
    end;
}`;

/** Emits one spec per integer literal, tagged or not according to `tag`. */
const probeOperator = (tag: "loop-condition-target" | undefined): MutationOperator => ({
  name: "test.probe",
  version: "1.0.0",
  tier: 1,
  targetNodeKinds: [ALNodeKind.integer],
  producesNodeKinds: [ALNodeKind.integer],
  requiresSemantic: [],
  targets: (node: ALSyntaxNode) => node.rawKind === ALNodeKind.integer,
  generate: (node: ALSyntaxNode, _ctx: SemanticContext): readonly MutationSpec[] => [
    {
      operatorName: "test.probe",
      operatorVersion: "1.0.0",
      astNodeId: `${node.startIndex}-${node.endIndex}`,
      before: node,
      after: node,
      parentContext: "statement-position",
      ...(tag !== undefined ? { hangCapable: tag } : {}),
    },
  ],
  conformanceTests: [],
});

const caseWith = (expected: { hangCapable?: "loop-condition-target" | null }) => ({
  name: "probe",
  sourceAL: SOURCE,
  expectedSpecs: [
    {
      parentContext: "statement-position" as const,
      beforeText: "1",
      afterText: "1",
      ...expected,
    },
  ],
});

describe("runConformance hangCapable assertion", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("passes when the expected reason matches the emitted tag", async () => {
    const op = { ...probeOperator("loop-condition-target"), conformanceTests: [caseWith({ hangCapable: "loop-condition-target" })] };
    expect((await runConformance(op)).allPassed).toBe(true);
  });

  it("FAILS when a tag is expected and the operator emits none", async () => {
    const op = { ...probeOperator(undefined), conformanceTests: [caseWith({ hangCapable: "loop-condition-target" })] };
    expect((await runConformance(op)).allPassed).toBe(false);
  });

  it("FAILS when no tag is expected and the operator emits one", async () => {
    const op = { ...probeOperator("loop-condition-target"), conformanceTests: [caseWith({ hangCapable: null })] };
    expect((await runConformance(op)).allPassed).toBe(false);
  });

  it("passes when absence is asserted and none is emitted", async () => {
    const op = { ...probeOperator(undefined), conformanceTests: [caseWith({ hangCapable: null })] };
    expect((await runConformance(op)).allPassed).toBe(true);
  });

  // The compatibility arm: every existing case in the repo omits the field entirely.
  it("does not assert either way when the field is omitted", async () => {
    const tagged = { ...probeOperator("loop-condition-target"), conformanceTests: [caseWith({})] };
    const untagged = { ...probeOperator(undefined), conformanceTests: [caseWith({})] };
    expect((await runConformance(tagged)).allPassed).toBe(true);
    expect((await runConformance(untagged)).allPassed).toBe(true);
  });

  it("names the tag in the failure it reports", async () => {
    const op = { ...probeOperator("loop-condition-target"), conformanceTests: [caseWith({ hangCapable: null })] };
    const result = await runConformance(op);
    const first = result.failures[0];
    if (first === undefined) throw new Error("expected a failure");
    expect(JSON.stringify(first.produced)).toContain("loop-condition-target");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/operator-sdk/tests/conformance.test.ts`
Expected: FAIL. The two "FAILS when" cases will report `allPassed: true`, because the matcher ignores the tag today. That is exactly the hole this task closes, and seeing it is the point of running this first.

- [ ] **Step 3: Extend the case shape**

In `packages/engine/src/operator/interface.ts`, inside `ConformanceCase.expectedSpecs`:

```ts
    /**
     * R196: `undefined` asserts nothing, a reason asserts the spec carries exactly it, and `null`
     * asserts the spec carries NO tag.
     *
     * The `null` arm is the load-bearing one. Without it an operator that quietly stopped emitting
     * the tag would keep every conformance case green, which is the failure this field exists to
     * prevent, and the third appearance in this harness of the shape R137 and R142 closed.
     */
    readonly hangCapable?: HangCapableReason | null;
```

- [ ] **Step 4: Match on it**

In `packages/operator-sdk/src/conformance.ts`, add to the `findIndex` predicate:

```ts
          hangCapableMatches(e.hangCapable, spec.hangCapable),
```

and define, near `describe`:

```ts
/** `undefined` asserts nothing; `null` asserts the tag is absent; a reason asserts equality. */
function hangCapableMatches(
  expected: HangCapableReason | null | undefined,
  actual: HangCapableReason | undefined,
): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === undefined;
  return actual === expected;
}
```

Add `hangCapable` to `ConformanceFailure.produced`'s element type and to whatever `describe` returns, so a failure message says which tag was actually emitted rather than leaving the reader to guess:

```ts
  produced: ReadonlyArray<{
    beforeText: string;
    afterText: string;
    parentContext: MutationSpec["parentContext"];
    hangCapable?: HangCapableReason;
  }>;
```

- [ ] **Step 5: Run the tests**

Run: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`
Expected: PASS, all six new tests, and **every existing conformance test still green**. Every case in the repo omits the new field, so the compatibility arm in Step 1 is what proves they are unaffected. If an existing operator's conformance suite goes red here, stop: it means the matcher change altered matching for cases that do not use the field, which is a defect in the predicate.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/operator/interface.ts packages/operator-sdk/src/conformance.ts packages/operator-sdk/tests/conformance.test.ts
git commit -m "feat(operator-sdk): conformance cases can assert hangCapable, including its absence (R196)"
```

---

### Task 3: The four operators emit the tag

Spec sections 4.1 and 9. Four operators can produce a mutant that makes a loop run forever, and each needs the tag on the specs it emits at a hang-capable site.

Two of them also carry declaration defects that this task fixes, because a spec that depends on symbols while declaring `requiresSemantic: []` has an undeclared dependency:

| Operator | `requiresSemantic` now | after | why |
|---|---|---|---|
| `remove-assignment` | `[]` | `["symbol-table"]` | the tag resolves symbols |
| `shift-integer` | `[]` | `["symbol-table"]` | same |
| `swap-additive` | `["type-info"]` | `["type-info", "symbol-table"]` | adds to what it already declares |
| `flip-boolean-literal` | `["symbol-table"]` | unchanged | already correct |

`remove-assignment` has a third defect: `generate` ignores its `_ctx` and calls `targets(node, {} as SemanticContext)` (`remove-assignment.ts:72-73`). A context-dependent tag cannot be produced from a fabricated empty context. `targets` does not currently read `ctx`, so the fabrication is harmless today, which is exactly why it survived.

`shift-integer` stays in scope and its relationship to R164 is complementary, not overlapping: it already refuses a loop-exit CONDITION, while this design classifies the ASSIGNMENT position. Do not widen or narrow that existing refusal.

**Files:**
- Modify: `packages/builtin-tier1/src/remove-assignment.ts`, `shift-integer.ts`, `swap-additive.ts`, `flip-boolean-literal.ts`
- Test: the four matching files under `packages/builtin-tier1/tests/`

**Interfaces:**
- Consumes: `hangCapableForMutatedNode(node, ctx)` from Task 1; the `hangCapable` assertion in `ConformanceCase` from Task 2.
- Produces: `MutationSpec.hangCapable` populated by all four operators.

- [ ] **Step 1: Write the failing test for one operator first**

Do `shift-integer` first: it is the operator whose hang the spec names, and it exercises the value-side walk rather than the trivial assignment case. Add to `packages/builtin-tier1/tests/shift-integer.test.ts`:

```ts
it("tags a literal assigned inside a loop whose condition reads the target (R196)", async () => {
  const src = `codeunit 50000 P
{
    procedure Go()
    var
        Remaining: Integer;
    begin
        Remaining := 1;
        while Remaining > 0 do
            Remaining := 0;
    end;
}`;
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const specs = findAll(root, ALNodeKind.integer)
    .filter((n) => shiftInteger.targets(n, ctx))
    .flatMap((n) => shiftInteger.generate(n, ctx));

  const inLoop = specs.filter((s) => s.before.text === "0");
  expect(inLoop.length).toBeGreaterThan(0);
  for (const s of inLoop) expect(s.hangCapable).toBe("loop-condition-target");

  // The initialiser above the loop is section 3.2's excluded preheader shape: unclassified, and
  // deliberately NOT tagged. It must not acquire a tag by accident.
  const preheader = specs.filter((s) => s.before.text === "1");
  expect(preheader.length).toBeGreaterThan(0);
  for (const s of preheader) expect(s.hangCapable).toBeUndefined();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/builtin-tier1/tests/shift-integer.test.ts`
Expected: FAIL, `expected "loop-condition-target", received undefined`.

- [ ] **Step 3: Make `shift-integer` emit it**

In each place `shift-integer.ts` builds a `MutationSpec`, compute the reason once at the top of `generate` and spread it in:

```ts
    const hangCapable = hangCapableForMutatedNode(node, ctx);
```

then, in the returned spec object:

```ts
        ...(hangCapable !== null ? { hangCapable } : {}),
```

Change `requiresSemantic: []` to `requiresSemantic: ["symbol-table"]`. Import `hangCapableForMutatedNode` from `./loop-hazard`.

- [ ] **Step 4: Run it**

Run: `bun test packages/builtin-tier1/tests/shift-integer.test.ts`
Expected: PASS, and every other test in that file unchanged.

- [ ] **Step 5: Repeat for the other three**

Same pattern in each. Write the test first, watch it fail, then implement.

- `remove-assignment.ts`: also replace `removeAssignment.targets(node, {} as SemanticContext)` with `removeAssignment.targets(node, ctx)` and rename the parameter from `_ctx` to `ctx`. Its node IS the assignment, so `hangCapableForMutatedNode` takes the first branch. Its test fixture should be an in-loop assignment that advances the condition, `Remaining := Remaining - 1` inside `while Remaining > 0 do`, because deleting it is the classic hang.
- `swap-additive.ts`: `requiresSemantic` becomes `["type-info", "symbol-table"]`. Its fixture is `Remaining := Remaining - 1` inside the same loop, where swapping to `+` never terminates.
- `flip-boolean-literal.ts`: `requiresSemantic` unchanged. Its fixture is a boolean loop guard:

```al
Continue := true;
while Continue do
    Continue := false;      // flipped to `true`, the loop never ends
```

- [ ] **Step 6: Add a conformance case asserting the tag, for each of the four**

This is what Task 2 was built for. Each operator's `conformanceTests` gains one case whose `expectedSpecs` declares `hangCapable: "loop-condition-target"` at the in-loop site, and `hangCapable: null` at a site in the same source that must not be tagged. A case that asserts only the presence proves half of what is needed: the absence arm is what catches an operator that tags everything.

- [ ] **Step 7: Run the full suite**

Run: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`
Expected: PASS. **No existing test's expected mutant count, operator name or before/after text may change.** A tag is metadata; it adds no mutant and removes none. If a count moves, the change is wrong.

- [ ] **Step 8: Red-check the absence arm**

Pick one operator. Make `hangCapableForMutatedNode` return `"loop-condition-target"` unconditionally, run that operator's conformance test, and confirm the `hangCapable: null` case goes RED. Restore and confirm green. This proves the conformance assertion is load-bearing rather than decorative, which is the whole reason Task 2 came first. Report both outputs.

- [ ] **Step 9: Commit**

```bash
git add packages/builtin-tier1/src packages/builtin-tier1/tests
git commit -m "feat(operators): remove-assignment, shift-integer, swap-additive and flip-boolean-literal emit hangCapable (R196)"
```

---

### Task 4: The tag reaches the manifest

Spec section 4: the tag travels the path `platformKillMechanism` already proves. This task is that field's twin, and should read like it.

**Files:**
- Modify: `packages/schemata/src/project.ts` (the `platformKillMechanism` declaration around line 169 to 178, and its population around line 479)
- Test: the existing `packages/schemata/tests/` file that covers manifest entry construction

**Interfaces:**
- Consumes: `MutationSpec.hangCapable` from Task 1.
- Produces: `MutantManifestEntry.hangCapable?: string`.

Note the type widening to `string`, which is deliberate and matches `platformKillMechanism`: the manifest is a serialised artifact read by code that must not have to know the union's current members.

- [ ] **Step 1: Write the failing test**

In the schemata test file that already covers `platformKillMechanism` carrying through, add the parallel case: a `MutationSpec` carrying `hangCapable: "loop-condition-target"` produces a manifest entry carrying `hangCapable: "loop-condition-target"`, and a spec without it produces an entry where the key is absent, not present-and-undefined. Assert absence with `expect("hangCapable" in entry).toBe(false)` rather than `toBeUndefined()`, because `exactOptionalPropertyTypes` is on and the two are different facts in a serialised artifact.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/schemata`
Expected: FAIL on the carried case.

- [ ] **Step 3: Add the field and its population**

Beside `platformKillMechanism` in the interface:

```ts
  /**
   * R196: carried verbatim from `MutationSpec.hangCapable` (engine). An enclosing loop's
   * condition reads the variable this site writes, so a timeout here is expected rather than
   * surprising. It does NOT claim the mutation prevents progress, and its absence does not mean
   * the site is safe. Widened to `string` for the same reason `platformKillMechanism` is: the
   * manifest is read by code that should not have to track the union's members.
   */
  readonly hangCapable?: string;
```

and at the population site:

```ts
        ...(spec.hangCapable !== undefined ? { hangCapable: spec.hangCapable } : {}),
```

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test packages/schemata`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schemata/src/project.ts packages/schemata/tests
git commit -m "feat(schemata): MutantManifestEntry carries hangCapable (R196)"
```

---

### Task 5: The tag reaches the report

Spec section 4, including its explicit warning that `explain` is NOT in the ripple: `ExplainOutput` has survivors, not-measured mutants, caveats and tool conditions, and no killed-mutant list, so adding a field to `MutantOutcome` puts nothing in `lethal explain`. Do not add one. It is filed in section 10 as separate work with its own schema-version decision.

**`CLAUDE.md` warns that adding a `SessionReport` field ripples and that several guards fail far from the change.** Work the list in order:

1. `packages/runner/src/events.ts`
2. `packages/runner/src/report-fold.ts`'s accumulator
3. `packages/runner/src/report.ts`'s type, builder and banner
4. `bun scripts/generate-schemas.ts`
5. `packages/runner/tests/schemas.test.ts`, both the pinned root-required list and the older-reports expectation
6. `bun test <file> --update-snapshots` for `report-equality`

Item 7 on that list, regenerating every committed sample report live, **should not be needed here**, because `hangCapable` is optional at every level and an older report without it still validates. Do not take that on trust: `schemas.test.ts` asserts the gift-card sample validates, so run it and confirm. If it fails, stop and report rather than regenerating a sample report offline, because those samples are live measurements.

**Files:**
- Create: `packages/runner/src/hang-capable.ts`
- Modify: `packages/runner/src/report.ts` (`MutantOutcome` around line 1419 to 1428, the builder around 1905, the banner near 2027)
- Modify: `packages/runner/src/events.ts`, `packages/runner/src/report-fold.ts`
- Test: `packages/runner/tests/report.test.ts`, `packages/runner/tests/schemas.test.ts`

**Interfaces:**
- Consumes: `MutantManifestEntry.hangCapable?: string` from Task 4.
- Produces: `MutantOutcome.hangCapable?: string`; `HANG_CAPABLE_EXPLANATIONS: Record<HangCapableReason, string>` from `packages/runner/src/hang-capable.ts`.

- [ ] **Step 1: Write the failing tests**

In `packages/runner/tests/report.test.ts`: an outcome built from a manifest entry carrying `hangCapable` has it on the report row; one built from an entry without it does not have the key at all. And one test on the explanation table:

```ts
it("explains every hang-capable reason it can carry", () => {
  for (const reason of ["loop-condition-target"] as const) {
    expect(HANG_CAPABLE_EXPLANATIONS[reason]).toBeTruthy();
  }
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/runner/tests/report.test.ts`
Expected: FAIL, module `../src/hang-capable` not found.

- [ ] **Step 3: Write the explanation table**

Create `packages/runner/src/hang-capable.ts`, shaped like `platform-artifact-kills.ts`'s `PLATFORM_KILL_MECHANISM_EXPLANATIONS`:

```ts
import type { HangCapableReason } from "@lethal/engine";

/**
 * R196: what each hang-capable reason means, in one sentence a report reader can act on.
 *
 * The wording is bound by the design's section 3.3. Each sentence says what was OBSERVED about the
 * code, never that the mutation prevents progress and never that an untagged site is safe.
 */
export const HANG_CAPABLE_EXPLANATIONS: Record<HangCapableReason, string> = {
  "loop-condition-target":
    "an enclosing loop's condition reads the variable this site writes, so a mutation here can leave that condition unchanged and the loop running",
};
```

- [ ] **Step 4: Thread it through the ripple**

Add `hangCapable?: string` to `MutantOutcome` beside `platformKillMechanism`, with a doc comment pointing at `HANG_CAPABLE_EXPLANATIONS` the way its neighbour points at its own table. Populate it in the builder with the same `...(o.mutant.hangCapable !== undefined ? { hangCapable: o.mutant.hangCapable } : {})` shape. Then walk the six numbered items above in order.

- [ ] **Step 5: Regenerate schemas and snapshots**

```bash
bun scripts/generate-schemas.ts
bun test packages/runner/tests/report-equality.test.ts --update-snapshots
```

Read the snapshot diff before accepting it. A snapshot that changed in a way you cannot explain is a finding, not a formality.

- [ ] **Step 6: Run everything**

Run: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`
Expected: PASS, including `schemas.test.ts` with the committed sample reports still validating. If a sample report fails to validate, stop and report: it means the field was added as required somewhere, and the fix is to make it optional, not to regenerate the sample.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src packages/runner/tests schemas
git commit -m "feat(runner): MutantOutcome carries hangCapable, with an explanation table (R196)"
```

---

### Task 6: The pre-deploy announcement

Spec section 5.3. The count must be of **deployed, post-dedup** mutants and must be emitted **before** deployment, so it cannot be derived from scored outcomes: a quarantine truncates those and the number would silently shrink.

`generateMutationSet` already computes `deployedCount` the right way (`orchestrator.ts:3059`, `allFiles.reduce((n, f) => n + dedupeSpecs(f.specs, tierOf).length, 0)`). `hangCapableCount` is computed over the same deduped specs, in the same place, so the two can never disagree about what "deployed" means.

Make the field **required** on the event, not optional. `mutation-set-generated.declarativeSiteFiles` already carries the rule in its own comment: an absent list and a measured zero must not look alike. A project with no hang-capable site reports `0`, and that is a measurement.

**Files:**
- Modify: `packages/runner/src/events.ts` (`mutation-set-generated`, around line 123 to 135)
- Modify: `packages/runner/src/orchestrator.ts` (near `deployedCount`, around line 3059)
- Test: `packages/runner/tests/orchestrator.test.ts` or whichever existing test asserts on `mutation-set-generated`

**Interfaces:**
- Consumes: `MutationSpec.hangCapable` from Task 1.
- Produces: `mutation-set-generated.hangCapableCount: number`; a `warning` event with code `hang-capable-sites-deployed`.

- [ ] **Step 1: Write the failing tests**

Three of them, on a project fixture containing one hang-capable site:

```ts
it("counts deployed hang-capable sites on mutation-set-generated", async () => {
  const events = await runAndCollectEvents(fixtureWithOneHangCapableSite);
  const generated = events.find((e) => e.type === "mutation-set-generated");
  if (generated === undefined) throw new Error("no mutation-set-generated event");
  expect(generated.hangCapableCount).toBe(1);
});

it("reports zero rather than nothing on a project with no hang-capable site", async () => {
  const events = await runAndCollectEvents(fixtureWithNoHangCapableSite);
  const generated = events.find((e) => e.type === "mutation-set-generated");
  if (generated === undefined) throw new Error("no mutation-set-generated event");
  expect(generated.hangCapableCount).toBe(0);
});

it("announces before deployment, not after scoring", async () => {
  const events = await runAndCollectEvents(fixtureWithOneHangCapableSite);
  const warnAt = events.findIndex(
    (e) => e.type === "warning" && e.code === "hang-capable-sites-deployed",
  );
  const firstDeploy = events.findIndex((e) => e.type === "mutant-deployed");
  expect(warnAt).toBeGreaterThanOrEqual(0);
  expect(warnAt).toBeLessThan(firstDeploy);
});
```

Use whatever event-collecting helper the existing orchestrator tests use, and whatever the real first-deployment event type is called; read a neighbouring test rather than assuming `mutant-deployed`. The ordering assertion is the one that matters: section 5.3 requires the announcement before deployment, and a warning emitted at the end would satisfy a presence check while being useless.

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/runner/tests/orchestrator.test.ts`
Expected: FAIL, `hangCapableCount` is not a property of the event.

- [ ] **Step 3: Add the field**

In `events.ts`, beside `deployedCount`:

```ts
      /** R196: how many DEPLOYED, post-dedup mutants sit at a hang-capable site. Required, and 0 on
       *  a project with none: an absent count and a measured zero must not look alike, the same
       *  rule `declarativeSiteFiles` and `untargetedTriggerCount` follow. Counted here rather than
       *  from outcomes because a quarantine truncates those and the number would silently shrink. */
      readonly hangCapableCount: number;
```

- [ ] **Step 4: Compute it and emit the announcement**

Beside the `deployedCount` reduce, over the same deduped specs:

```ts
  const hangCapableCount = allFiles.reduce(
    (n, f) => n + dedupeSpecs(f.specs, tierOf).filter((s) => s.hangCapable !== undefined).length,
    0,
  );
```

Put it on the event, then emit the warning when it is above zero. The text is fixed by spec section 5.3 and is not yours to reword:

```ts
  if (hangCapableCount > 0) {
    emit({
      type: "warning",
      code: "hang-capable-sites-deployed",
      message: `${hangCapableCount} hang-capable site(s) found. If one exceeds its budget LethAL will end that BC session, because the alternative is a stranded tier. This happens whether or not \`--stop-hung-sessions\` was passed.`,
    });
  }
```

The message speaks in the future tense about a stop that Plan B2 implements. That is deliberate and it is the spec's own wording. B1 ships the announcement so that B2 cannot ship a forced stop without one, which spec section 9 lists as refusing the design. Note it in your report so the reviewer knows it is intended rather than a leftover.

- [ ] **Step 5: Run everything**

Run: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`
Expected: PASS. Adding a required field to an event ripples into `report-fold.ts` and any test that constructs the event by hand; fix those constructions rather than making the field optional.

- [ ] **Step 6: Red-check the ordering assertion**

Move the `emit` to after the deployment loop, run the ordering test, and confirm it goes RED. Restore it and confirm green. Without this the ordering test could be passing because both indices are -1 or because the warning happens to land first for an unrelated reason. Report both outputs.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/events.ts packages/runner/src/orchestrator.ts packages/runner/tests
git commit -m "feat(runner): announce deployed hang-capable sites before deployment (R196)"
```

---

## Self-review

**Spec coverage.** Section 4's type, travel path and full ripple: Tasks 1, 4, 5. Section 4's "`explain` is NOT in the ripple": stated in Task 5 as a thing not to do. Section 4.1's four bullets: the fabricated context and both `requiresSemantic` corrections are Task 3, the conformance gap is Task 2, and `shift-integer` staying in scope with its R164 refusal untouched is stated in Task 3. Section 5.3's count, its pre-deploy timing and its fixed text: Task 6.

Not covered here, by design, and carried to B2: sections 5.1, 5.2, 5.4, 5.5, 6, 7, 8. Section 10 is out of scope for both.

**Two things a B2 author must not forget**, recorded here because they are easy to lose between plans:
1. Section 5.4's caveat fires when an automatic stop **actually occurred**, not when tagged sites were merely deployed. The deployed-sites fact is Task 6's announcement and is already shipped by B1. Mixing the two is the ambiguity spec revision 1 had.
2. Section 8's resume ordering problem is real and unsolved in this plan: resume resolution happens before mutation generation, so the current manifest's tag is not yet known when carry filtering runs.

**Type consistency.** `HangCapableReason` is declared once, in `packages/engine/src/operator/interface.ts`, and re-exported from `@lethal/engine`, `@lethal/operator-sdk` and `loop-hazard.ts`. It is `HangCapableReason` on `MutationSpec` and on `ConformanceCase`, and widened to `string` on `MutantManifestEntry` and `MutantOutcome`, matching `platformKillMechanism` exactly. The helper is `hangCapableForMutatedNode` in every task that names it.

**A risk checked and closed while writing this plan.** Task 3 changes `requiresSemantic` on three operators, which would matter if anything gated operator execution on declared capabilities. Nothing does: `grep -rn "requiresSemantic" packages/ scripts/ --include=*.ts` returns the interface declaration and the operators' own declarations, and no reader anywhere. The field is currently documentation. So the corrections in Task 3 are honest bookkeeping that cannot move a mutant count, and Task 3's Step 7 would catch it if that ever stopped being true.

**The risk that remains open.** `hangCapableForMutatedNode` walks out of a mutated node to its enclosing assignment, and Task 1 tests that walk against six shapes chosen because they are the ones the four operators produce. It is not a proof over the grammar. An operator mutating a shape none of those six covers could get an answer nobody predicted. The direction of harm is bounded: a wrong answer here adds or omits metadata and changes no verdict, and B1 forces nothing. B2 is where a wrong tag first costs something, and its live gate is where that would show.
