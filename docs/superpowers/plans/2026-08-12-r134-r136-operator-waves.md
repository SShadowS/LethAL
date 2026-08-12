# R134 + R136 Operator Waves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship the four executable operator candidates from R134 and R136 — extend `lethal.swap-modify-flag` to `Insert`/`Delete`, add `lethal.swap-find-direction` (FindFirst <-> FindLast), add `lethal.validate-to-assign` (`Validate(F, V)` -> `F := V`), and add `lethal.flip-filter-literal` (mutations inside `SetFilter`'s filter string) — each admitted through the house procedure: spec, adversarial review, TDD implementation, fixture arms with pre-committed per-mutant verdicts, tables-gate growth.

**Architecture:** two waves, each ending in ONE live tables-gate re-record. Wave A is the R136 trio (they share one new fixture table and one precommitment doc, mirroring how tier2-phase1 shipped four operators under one frozen baseline). Wave B is R134 alone (it needs a new filter-expression mini-parser, the highest-risk unit). A final confirmation wave re-runs the other three gates, which are expected UNCHANGED because `fixtures/sandbox-app` has zero sites for any of these operators (measured 2026-08-12: no FindFirst/FindLast/Validate/Insert(true)/Delete(true)/SetFilter anywhere in its two codeunits).

**Tech Stack:** Bun + TypeScript monorepo, tree-sitter-al 4.0.1 AST, `bun:test`, env-gated live gates against a real BC container.

**Specs this plan produces:** `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md` and `docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md` (Tasks A1/B1), each reviewed by the `spec-adversary` agent before any code.

## Model assignment (the user's standing instruction for this plan)

Execution is by subagents, not the main thread. Per-task model overrides:

| Work | Agent type | Model |
|---|---|---|
| Spec writing (A1, B1) | general-purpose | opus |
| Spec adversarial review (A2, B2) | spec-adversary | opus |
| Operator + test implementation (A3-A5, B3-B4) | general-purpose | sonnet |
| Red-checks (folded into A3-A5, B3-B4; independent pass A6/B5) | mutation-red-checker | sonnet |
| Fixture AL + test app (A7, B6) | general-purpose | sonnet |
| AL offline compile verification | al-compiler | (default) |
| Census + precommitment doc (A8-A9, B7-B8) | general-purpose | opus |
| Live gate re-record (A10, B9, C1) | general-purpose | sonnet |
| Docs/roadmap close-out (A11, B10) | general-purpose | sonnet |

## Global Constraints

- No `!` non-null assertions (biome `noNonNullAssertion: error`). Destructure, then check `undefined`. `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on (optional props via `...(v !== undefined ? { k: v } : {})`).
- **Fail loudly on caller-contract violations — throw, never return a plausible empty default.** But an operator PREDICATE that cannot prove its claim returns `false`/refuses (that is the Tier-2 posture, not a contract violation).
- **Matching is case-insensitive.** AL is case-insensitive: `INSERT(TRUE)`, `FindFirst`, `FINDFIRST` are the same site.
- **A test that passes for the wrong reason is the recurring hazard.** Red-check every predicate guard: revert it, confirm its specific test goes RED, restore.
- Per-mutant equality is the gate. Aggregate counts matching for the wrong mutants is a failure.
- Build loop, order matters: `bun run typecheck` -> `rm -rf packages/*/dist` -> `bun test` -> `bunx biome check <touched files only>`.
- After touching ANY `.al` under `fixtures/`: `bun run compile:fixtures` (nothing else compiles them; R56).
- Git bash on Windows; never `2>nul` — use `2>/dev/null`.
- **Baseline re-record procedure** (the only sanctioned one): commit the precommitment doc FIRST, update the gate's `EXPECTED` aggregates, then `rm packages/runner/itest/tables.baseline.json`, run `LETHAL_ITEST_TABLES=1 bun run itest:tables` (auto-records on missing file), review the per-mutant diff against the precommitment table, run the gate AGAIN to prove the new baseline compares against itself (R29), then commit. The `LETHAL_RERECORD_BASELINE=1` env var is only the escape hatch for the Edit/Write hook — this plan never edits a baseline by hand, so it is never needed.
- Dedup identity is `${before.kind}:${before.startIndex}:${before.endIndex}:${after.text}` — two operators producing DIFFERENT replacement text at the same span coexist; identical text at the same span with same tier THROWS. Every operator here emits non-empty replacement text distinct from any deletion, so all four ADD mutants and displace none.
- Mutant identity for baselines is `astHash|codeunitName|operatorName|operatorMajor`, where `operatorMajor = Number(operatorVersion.split(".")[0])`. A MINOR bump does not move identity.
- Docs in plain English (project rule). No `file.ext:<line>` citations in roadmap/docs (R117). No em dashes in any file.
- Fixture test data: every new arm uses its own key prefix (`FLAG-`, `FIND-`, `VAL-`, `FILT-`) and scopes queries with `SetRange` before counting, so no arm's verdict depends on another test's rows.

---

# Wave A — the R136 trio

### Task A1: Write the trio spec

**Files:**
- Create: `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md`

**Interfaces:**
- Consumes: `docs/roadmap/R136.md`, `docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md` (the house format template), `packages/builtin-tier2/src/{swap-modify-flag,remove-setrange,receiver,mutate-helpers}.ts`.
- Produces: the spec later tasks implement. Section shape follows R82's: status line, "0. What is settled", "1. Claims table", "2. The operators" (one subsection each), "3. The fixture arms" (table: arm | shape | what it is for | predicted verdict), "4. What the live run may and may not conclude".

- [ ] **Step 1: Write the spec** with these decisions stated and defended (the plan proposes them; the spec ratifies or amends with reasons):

1. **`lethal.swap-modify-flag` extension.** `targets()` claims `claimsRecordMethod(node, ctx, m)` for `m` in `["Modify", "Insert", "Delete"]` (today: `Modify` only), still requiring `booleanTrueArgument(node) !== null`. Direction stays `true -> false` only (matches existing semantics; `false -> true` is a different bug class, out of scope, recorded as such). Version goes `1.0.0 -> 1.1.0` — a MINOR bump, because every existing `Modify` mutant is byte-identical and `operatorMajor` stays 1, so existing baseline identities DO NOT move; the baseline gains rows and loses none. The operator name keeps its historical `swap-modify-flag` even though it now covers three methods; the doc comment carries the explanation. If the spec instead chooses a MAJOR bump or a rename, it must also schedule the full baseline re-key that decision costs.
2. **`lethal.swap-find-direction`** (new, tier 2, version 1.0.0): `FindFirst()` <-> `FindLast()`, both directions, one mutant per site. Guards: `claimsRecordMethod` for the specific method name, and `countArguments(node) === 0` (a `Find('-')` or `FindSet(...)` is NOT claimed — those are different operations, refused, and the refusal recorded). NOT statement-position-restricted: `if Rec.FindFirst() then` is a real and common form and the swap preserves the expression shape, so `parentContext` is computed honestly the way `swap-modify-flag` does it.
3. **`lethal.validate-to-assign`** (new, tier 2, version 1.0.0): `R.Validate(F, V)` -> `R.F := V` (and implicit-receiver `Validate(F, V)` -> `F := V`). Guards: `claimsRecordMethod(node, ctx, "Validate")`, `countArguments(node) === 2`, `isStatementPosition(node)` (an assignment cannot sit in expression position), and the FIRST argument must be a bare or quoted field identifier (no member access, no expression — refuse anything else). The single-argument `Validate(F)` has no assignment equivalent and is refused, recorded in the spec.
4. **Dedup interplay stated per operator:** all three emit non-empty replacement text, so each COEXISTS with `void-method-call`'s deletion at the same span (the swap-call-arguments precedent). None displaces a Tier-1 mutant.
5. **The fixture arms table** — from Task A7 below, with each arm's intended verdict and the mechanism (the per-LINE prediction table is NOT in this spec; it goes in the Task A9 precommitment doc once the fixture code exists, the R72 pattern).
6. **Refusals recorded:** `Next()` mutation and `IsEmpty` negation stay refused per R136's own text; `FindSet` direction swap deferred (no `FindLast`-equivalent for sets without `Ascending(false)`, which is a property rewrite, i.e. R135 territory).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md
git commit -m "spec: R136 tier-2 trio design (swap-modify-flag extension, swap-find-direction, validate-to-assign)"
```

### Task A2: Adversarial review of the trio spec

- [ ] **Step 1:** Dispatch the `spec-adversary` agent (model: opus) on `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md`. Its brief: hunt sequences that produce a false kill, a wrong verdict, or a silently-empty confirmation. Known attack surfaces to point it at: the MINOR-vs-MAJOR version-bump claim (does any consumer read more than the major segment?), quoted-identifier fields in `Validate`, receivers that shadow `Insert`/`Delete`/`FindFirst` with project procedures (rule 3 of `claimsRecordMethod` should already refuse — verify the spec says so), `Validate` first arguments that are expressions, and the arm-isolation prefixes.
- [ ] **Step 2:** Adopt or explicitly reject each finding IN the spec (amendment log at the top, R82 style: "Reviewed by <agent> <date> (N amendments adopted: ...)"). Commit the amended spec.

```bash
git add docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md
git commit -m "spec: adopt spec-adversary amendments on the R136 trio design"
```

### Task A3: Extend `lethal.swap-modify-flag` to Insert/Delete

**Files:**
- Modify: `packages/builtin-tier2/src/swap-modify-flag.ts`
- Test: `packages/builtin-tier2/tests/swap-modify-flag.test.ts`

**Interfaces:**
- Consumes: `claimsRecordMethod(node, ctx, methodName)` from `../src/receiver`; `soleArgument` from `../src/mutate-helpers`; test harness `parseClean`/`contextFor` from `tests/parse-clean.ts`.
- Produces: same exported `swapModifyFlag: MutationOperator`, now `version: "1.1.0"`, claiming `Modify|Insert|Delete` with a sole `true` argument.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to packages/builtin-tier2/tests/swap-modify-flag.test.ts
describe("swap-modify-flag extension to Insert/Delete (R136)", () => {
  it("claims Insert(true) and Delete(true) on a proven record receiver", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Insert(true);
        Rec.Delete(true);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.Insert(true)", "Rec.Delete(true)"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.Insert(false)", "Rec.Delete(false)"]);
  });

  it("still refuses Insert(false) — the direction is true->false only", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Insert(false);
        Rec.Insert();
        Rec.Insert(true, true);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("reports version 1.1.0 so existing Modify mutant identities do not move", () => {
    expect(swapModifyFlag.version).toBe("1.1.0");
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Modify(true);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    const only = specs[0];
    expect(only?.operatorVersion).toBe("1.1.0");
  });
});
```

Reuse the file's existing `specsFor` helper. If the existing tests assert `version === "1.0.0"` anywhere, update them — that change is the point.

- [ ] **Step 2: Run to verify failure:** `bun test packages/builtin-tier2 -t "swap-modify-flag"` — expect the new describe block RED (Insert/Delete produce no specs today).

- [ ] **Step 3: Implement.** In `swap-modify-flag.ts`: replace the single `claimsRecordMethod(node, ctx, "Modify")` call with

```typescript
const RUN_TRIGGER_METHODS = ["Modify", "Insert", "Delete"] as const;

function claimedRunTriggerMethod(node: ALSyntaxNode, ctx: SemanticContext): string | null {
  for (const m of RUN_TRIGGER_METHODS) {
    if (claimsRecordMethod(node, ctx, m)) return m;
  }
  return null;
}
```

and use `claimedRunTriggerMethod(node, ctx) !== null` in `targets()` (everything downstream — `booleanTrueArgument`, `replaceArgument`, `synthesizeAfter` — is method-name-agnostic and stays untouched). Bump `version` and the `operatorVersion` literal in `generate()` to `"1.1.0"`. Add conformance cases for `Insert(true)` and `Delete(true)` to `conformanceTests` mirroring the existing `Modify(true)` case. Update the operator doc comment: name is historical, coverage is the three run-trigger flag methods, direction is true->false only, and WHY the bump is minor (identity stability).

- [ ] **Step 4: Verify:** `bun run typecheck && rm -rf packages/*/dist && bun test packages/builtin-tier2` — all green, including conformance.

- [ ] **Step 5: Red-check** (inline): revert the `claimedRunTriggerMethod` change (restore `"Modify"`-only), confirm the new describe block goes RED, restore, confirm green. Report both outputs in the task summary.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier2/src/swap-modify-flag.ts packages/builtin-tier2/tests/swap-modify-flag.test.ts
git commit -m "feat(tier2): extend swap-modify-flag to Insert(true)/Delete(true) (R136), minor bump to 1.1.0"
```

### Task A4: New operator `lethal.swap-find-direction`

**Files:**
- Create: `packages/builtin-tier2/src/swap-find-direction.ts`, `packages/builtin-tier2/tests/swap-find-direction.test.ts`
- Modify: `packages/builtin-tier2/src/index.ts` (append to `tier2Operators`)

**Interfaces:**
- Consumes: `claimsRecordMethod`, `countArguments`, `synthesizeAfter`, `ALNodeKind`, `isStatementPosition`.
- Produces: `export const swapFindDirection: MutationOperator` — `name: "lethal.swap-find-direction"`, `version: "1.0.0"`, `tier: 2`, `targetNodeKinds/producesNodeKinds: [ALNodeKind.procedure_call]`, `requiresSemantic: ["symbol-table"]`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/builtin-tier2/tests/swap-find-direction.test.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, initParser } from "@lethal/operator-sdk";
import { swapFindDirection } from "../src/swap-find-direction";
import { contextFor, parseClean } from "./parse-clean";

beforeAll(async () => {
  await initParser();
});

function specsFor(src: string) {
  const root = parseClean(src);
  const ctx = contextFor(root);
  return findAll(root, ALNodeKind.procedure_call)
    .filter((n) => swapFindDirection.targets(n, ctx))
    .flatMap((n) => [...swapFindDirection.generate(n, ctx)]);
}

describe("swap-find-direction", () => {
  it("swaps FindFirst to FindLast and FindLast to FindFirst, preserving receiver and casing context", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.FindFirst();
        if Rec.FindLast() then;
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.FindFirst()", "Rec.FindLast()"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.FindLast()", "Rec.FindFirst()"]);
  });

  it("computes parentContext honestly — the guarded form is expression position", () => {
    const src = `codeunit 50100 T {
      procedure P(): Boolean
      var Rec: Record Customer;
      begin
        Rec.FindFirst();
        exit(Rec.FindLast());
      end;
    }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.parentContext)).toEqual(["statement-position", "expression-position"]);
  });

  it("refuses arguments — Find('-') and FindSet variants are different operations", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Find('-');
        Rec.FindSet(true);
        Rec.FindSet();
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses an unproven receiver", () => {
    const src = `codeunit 50100 T {
      procedure P(Mystery: Variant)
      begin
        Mystery.FindFirst();
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("matches case-insensitively and emits canonical replacement text", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.FINDFIRST();
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe("Rec.FindLast()");
  });
});
```

- [ ] **Step 2: Run to verify failure:** `bun test packages/builtin-tier2 -t "swap-find-direction"` — module not found.

- [ ] **Step 3: Implement** `src/swap-find-direction.ts`, modeled line-for-line on `swap-modify-flag.ts`'s structure:

```typescript
const DIRECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["FindFirst", "FindLast"],
  ["FindLast", "FindFirst"],
];

function claimedDirection(node: ALSyntaxNode, ctx: SemanticContext): readonly [string, string] | null {
  if (countArguments(node) !== 0) return null;
  for (const pair of DIRECTIONS) {
    if (claimsRecordMethod(node, ctx, pair[0])) return pair;
  }
  return null;
}
```

`generate()` finds the method-name identifier inside the call — the LAST identifier-kind named descendant that starts before the argument list and whose text case-insensitively equals the claimed method — and splices the replacement over that identifier's span within `node.text` (same byte-offset splice discipline as `replaceArgument`: compute `id.startIndex - node.startIndex`, guard that the span falls inside the call text, return no mutant rather than guess if it does not). Before writing that extraction, check whether `receiver.ts` already exposes (or can trivially export) its own callee-name resolution; reuse it if so rather than re-deriving. `parentContext` via the same `parentContextOf` pattern as swap-modify-flag (`isStatementPosition` -> honest hint). One `MutationSpec`, `astNodeId: `${node.startIndex}-${node.endIndex}``, `after: synthesizeAfter(node, mutatedText)`. Two conformance cases (one per direction). Register in `index.ts` by appending `swapFindDirection` to `tier2Operators`.

- [ ] **Step 4: Verify:** `bun run typecheck && rm -rf packages/*/dist && bun test packages/builtin-tier2`.

- [ ] **Step 5: Red-check** the `countArguments(node) !== 0` guard: remove it, confirm the `Find('-')`/`FindSet` refusal test goes RED, restore, green.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier2/src/swap-find-direction.ts packages/builtin-tier2/tests/swap-find-direction.test.ts packages/builtin-tier2/src/index.ts
git commit -m "feat(tier2): swap-find-direction operator — FindFirst <-> FindLast (R136)"
```

### Task A5: New operator `lethal.validate-to-assign`

**Files:**
- Create: `packages/builtin-tier2/src/validate-to-assign.ts`, `packages/builtin-tier2/tests/validate-to-assign.test.ts`
- Modify: `packages/builtin-tier2/src/index.ts`, and `packages/builtin-tier2/src/mutate-helpers.ts` (add `argumentAt`)

**Interfaces:**
- Consumes: `claimsRecordMethod`, `countArguments`, `synthesizeAfter`, `isStatementPosition`.
- Produces: `export const validateToAssign: MutationOperator` (`name: "lethal.validate-to-assign"`, `version: "1.0.0"`, `tier: 2`); and in mutate-helpers: `export function argumentAt(call: ALSyntaxNode, index: number): ALSyntaxNode | null` — the Nth VALUE argument, comment-filtered with the same `COMMENT_KINDS` discipline as `soleArgument` (the `SetRange("No." /* comment */)` bug class applies here identically).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/builtin-tier2/tests/validate-to-assign.test.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, initParser } from "@lethal/operator-sdk";
import { validateToAssign } from "../src/validate-to-assign";
import { contextFor, parseClean } from "./parse-clean";

beforeAll(async () => {
  await initParser();
});

function specsFor(src: string) {
  const root = parseClean(src);
  const ctx = contextFor(root);
  return findAll(root, ALNodeKind.procedure_call)
    .filter((n) => validateToAssign.targets(n, ctx))
    .flatMap((n) => [...validateToAssign.generate(n, ctx)]);
}

describe("validate-to-assign", () => {
  it("rewrites a qualified two-argument Validate into a receiver-preserving assignment", () => {
    const src = `codeunit 50100 T {
      procedure P(NewName: Text)
      var Rec: Record Customer;
      begin
        Rec.Validate(Name, NewName);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.before.text).toBe("Rec.Validate(Name, NewName)");
    expect(specs[0]?.after.text).toBe("Rec.Name := NewName");
  });

  it("keeps quoted field identifiers quoted", () => {
    const src = `codeunit 50100 T {
      procedure P(NewNo: Code[20])
      var Rec: Record Customer;
      begin
        Rec.Validate("No.", NewNo);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs[0]?.after.text).toBe('Rec."No." := NewNo');
  });

  it("accepts an arbitrary expression as the value argument", () => {
    const src = `codeunit 50100 T {
      procedure P(Base: Decimal)
      var Rec: Record Customer;
      begin
        Rec.Validate("Credit Limit (LCY)", Base * 2 + 1);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs[0]?.after.text).toBe('Rec."Credit Limit (LCY)" := Base * 2 + 1');
  });

  it("refuses the single-argument form — Validate(F) has no assignment equivalent", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.Validate(Name);
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("refuses a first argument that is not a bare or quoted field identifier", () => {
    const src = `codeunit 50100 T {
      procedure P(V: Integer)
      var Rec: Record Customer;
      begin
        Rec.Validate(Rec.Name, 'x');
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.** First `argumentAt` in mutate-helpers (generalize `soleArgument`'s comment-filtered walk to return the Nth value argument; keep `soleArgument` delegating to `argumentAt(call, 0)` guarded by `countArguments === 1` so its behavior is unchanged). Then the operator:

- `targets()`: `isStatementPosition(node)` AND `claimsRecordMethod(node, ctx, "Validate")` AND `countArguments(node) === 2` AND `isFieldIdentifier(argumentAt(node, 0))`, where `isFieldIdentifier` accepts a node with no named children whose text is a bare identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`) or a double-quoted identifier (`/^".+"$/`). Anything else (member access, index, call, literal) refuses.
- `generate()`: receiver prefix is `node.text` up to the start of the `Validate` method-name identifier (the same last-identifier-before-argument-list extraction as Task A4 — pull that helper into `mutate-helpers.ts` as `methodNameIdentifier(call, name)` and share it between the two operators rather than duplicating). Mutated text: `` `${prefix}${fieldText} := ${valueText}` `` where `fieldText`/`valueText` are the two arguments' verbatim `.text`. `parentContext: "statement-position"` hardcoded (targets already required it — the remove-setrange precedent).
- Two conformance cases (bare + quoted field). Register in `index.ts`.
- Before finalizing, PROBE the actual grammar shape of `Validate("No.", X)`'s first argument with a five-line parse script (`initParser` + `parseAL` + print `kind`/`rawKind`/`namedChildren` of the argument) and adjust `isFieldIdentifier`'s kind checks to what the 4.0.1 grammar actually produces — do not trust the regex sketch above over the real tree.

- [ ] **Step 4: Verify:** `bun run typecheck && rm -rf packages/*/dist && bun test packages/builtin-tier2`.

- [ ] **Step 5: Red-check** the `isFieldIdentifier` guard: make it return `true` unconditionally, confirm the member-access refusal test goes RED, restore, green.

- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier2/src/validate-to-assign.ts packages/builtin-tier2/tests/validate-to-assign.test.ts packages/builtin-tier2/src/mutate-helpers.ts packages/builtin-tier2/src/index.ts
git commit -m "feat(tier2): validate-to-assign operator — Validate(F, V) becomes F := V (R136)"
```

### Task A6: Independent red-check pass over the trio

- [ ] **Step 1:** Dispatch `mutation-red-checker` (model: sonnet) over the three commits from A3-A5. Targets: (a) A3's method-list extension, (b) A4's zero-argument guard AND its receiver-proof dependency (`claimsRecordMethod` misuse would be caught here), (c) A5's field-identifier guard and its two-argument guard. Each: revert the specific guard, name the specific test that goes red, restore, confirm green.
- [ ] **Step 2:** If any guard has NO test that goes red, that is a finding — add the missing test before proceeding (back to the owning task's agent), re-run the check.

### Task A7: Fixture growth — `Data Trigger Probe` + three arm codeunits + tests

**Files:**
- Create: `fixtures/sandbox-data/src/DataTriggerProbe.Table.al`, `fixtures/sandbox-data/src/DataFlagOps.Codeunit.al`, `fixtures/sandbox-data/src/DataFindOps.Codeunit.al`, `fixtures/sandbox-data/src/DataValidateOps.Codeunit.al`
- Modify: `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al` (append the new `[Test]` procedures), `fixtures/sandbox-data/app.json` and `fixtures/sandbox-data-tests/app.json` (bump versions)

**Interfaces:**
- Consumes: object ids 79330 (table) and 79314-79316 (codeunits) — all free in the 79300-79399 range (existing: tables 79300-79303/79309, codeunits 79304-79308/79311-79313, pages 79320-79324).
- Produces: the arm surface Task A8's census enumerates and Task A9 pre-commits. KEEP BODIES MINIMAL — every extra statement is another Tier-1 mutant somebody must pre-commit a verdict for.

- [ ] **Step 1: Write the table** (all three operators' arms share it):

```al
table 79330 "Data Trigger Probe"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Inserted By Trigger"; Boolean) { }
        field(3; "Level"; Integer)
        {
            trigger OnValidate()
            begin
                "Level Doubled" := "Level" * 2;
            end;
        }
        field(4; "Level Doubled"; Integer) { }
        field(5; Tombstone; Boolean) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnInsert()
    begin
        "Inserted By Trigger" := true;
    end;

    trigger OnDelete()
    var
        Tomb: Record "Data Trigger Probe";
    begin
        Tomb."No." := 'TOMB-' + "No.";
        Tomb.Tombstone := true;
        Tomb.Insert(false);
    end;
}
```

(Test keys stay short — `'TOMB-' + "No."` must fit Code[20], and arm E's precedent says a length overflow is a FALSE kill; keep every seeded key under 15 characters.)

- [ ] **Step 2: Write the three arm codeunits** (each arm's header comment names its intended verdict and mechanism, the Data Swap Ops style):

```al
codeunit 79314 "Data Flag Ops"
{
    // ARM: KILL — Insert(false) skips OnInsert, the trigger field stays false,
    // and InsertRunTriggerSetsTheTriggerField asserts it.
    procedure InsertWithTrigger(No: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(true);
        exit(Probe."Inserted By Trigger");
    end;

    // ARM: SURVIVOR — the covering test only asserts a row landed; Insert(false)
    // still inserts the row. This is the weak-assertion survivor, by design.
    procedure InsertCounted(No: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(true);
        exit(Probe.Get(No));
    end;

    // ARM: KILL — Delete(false) skips OnDelete, no tombstone appears,
    // and DeleteRunTriggerLeavesTombstone asserts the tombstone.
    procedure DeleteWithTrigger(No: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
        Tomb: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(false);
        Probe.Delete(true);
        exit(Tomb.Get('TOMB-' + No));
    end;
}
```

```al
codeunit 79315 "Data Find Ops"
{
    // ARM: KILL — FindLast lands on the highest key; the test seeds two rows with
    // distinct Levels and asserts the LOW one comes back.
    procedure FirstLevelInRange(FromNo: Code[20]; ToNo: Code[20]): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", FromNo, ToNo);
        if Probe.FindFirst() then
            exit(Probe."Level");
        exit(-1);
    end;

    // ARM: KILL, other direction — FindFirst lands on the lowest key; the test
    // asserts the HIGH one comes back.
    procedure LastLevelInRange(FromNo: Code[20]; ToNo: Code[20]): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", FromNo, ToNo);
        if Probe.FindLast() then
            exit(Probe."Level");
        exit(-1);
    end;

    // ARM: SURVIVOR — the covering test only asserts SOMETHING was found; either
    // direction finds a row. The wrong-record bug this operator models is exactly
    // what an existence-only assertion cannot see.
    procedure AnyInRange(FromNo: Code[20]; ToNo: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", FromNo, ToNo);
        exit(Probe.FindFirst());
    end;
}
```

```al
codeunit 79316 "Data Validate Ops"
{
    // ARM: KILL — "Level" := NewLevel skips OnValidate, "Level Doubled" stays 0,
    // and the test asserts the doubled value.
    procedure SetLevel(No: Code[20]; NewLevel: Integer): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(false);
        Probe.Validate("Level", NewLevel);
        Probe.Modify(false);
        exit(Probe."Level Doubled");
    end;

    // ARM: SURVIVOR — the covering test asserts the field VALUE, which the plain
    // assignment also produces. The OnValidate-skip bug is invisible to it.
    procedure SetLevelWeak(No: Code[20]; NewLevel: Integer): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(false);
        Probe.Validate("Level", NewLevel);
        Probe.Modify(false);
        exit(Probe."Level");
    end;
}
```

- [ ] **Step 3: Append the covering tests** to `DataTests.Codeunit.al`, with an R136 banner comment naming this plan and the precommitment doc (mirror the R82 banner). Key prefixes: `FLAG-`, `FIND-`, `VAL-` — one prefix per arm codeunit, keys unique per test:

```al
    [Test]
    procedure InsertRunTriggerSetsTheTriggerField()
    var
        FlagOps: Codeunit "Data Flag Ops";
    begin
        if not FlagOps.InsertWithTrigger('FLAG-A') then
            Error('expected Insert(true) to run OnInsert and set the trigger field');
    end;

    [Test]
    procedure WeakInsertAssertionMissesTheFlag()
    var
        FlagOps: Codeunit "Data Flag Ops";
    begin
        if not FlagOps.InsertCounted('FLAG-B') then
            Error('expected InsertCounted to land a row');
    end;

    [Test]
    procedure DeleteRunTriggerLeavesTombstone()
    var
        FlagOps: Codeunit "Data Flag Ops";
    begin
        if not FlagOps.DeleteWithTrigger('FLAG-C') then
            Error('expected Delete(true) to run OnDelete and leave a tombstone');
    end;

    [Test]
    procedure FindFirstPicksTheLowestKey()
    var
        Probe: Record "Data Trigger Probe";
        FindOps: Codeunit "Data Find Ops";
    begin
        Probe.Init();
        Probe."No." := 'FIND-A';
        Probe."Level" := 1;
        Probe.Insert(false);
        Probe.Init();
        Probe."No." := 'FIND-B';
        Probe."Level" := 2;
        Probe.Insert(false);
        if FindOps.FirstLevelInRange('FIND-A', 'FIND-B') <> 1 then
            Error('expected FindFirst to land on FIND-A with Level 1');
    end;

    [Test]
    procedure FindLastPicksTheHighestKey()
    var
        Probe: Record "Data Trigger Probe";
        FindOps: Codeunit "Data Find Ops";
    begin
        Probe.Init();
        Probe."No." := 'FIND-C';
        Probe."Level" := 3;
        Probe.Insert(false);
        Probe.Init();
        Probe."No." := 'FIND-D';
        Probe."Level" := 4;
        Probe.Insert(false);
        if FindOps.LastLevelInRange('FIND-C', 'FIND-D') <> 4 then
            Error('expected FindLast to land on FIND-D with Level 4');
    end;

    [Test]
    procedure ExistenceOnlyAssertionMissesTheDirection()
    var
        Probe: Record "Data Trigger Probe";
        FindOps: Codeunit "Data Find Ops";
    begin
        Probe.Init();
        Probe."No." := 'FIND-E';
        Probe.Insert(false);
        if not FindOps.AnyInRange('FIND-A', 'FIND-Z') then
            Error('expected at least one row in the FIND range');
    end;

    [Test]
    procedure ValidateRunsTheFieldTrigger()
    var
        ValidateOps: Codeunit "Data Validate Ops";
    begin
        if ValidateOps.SetLevel('VAL-A', 5) <> 10 then
            Error('expected OnValidate to double 5 into 10');
    end;

    [Test]
    procedure ValueOnlyAssertionMissesTheTriggerSkip()
    var
        ValidateOps: Codeunit "Data Validate Ops";
    begin
        if ValidateOps.SetLevelWeak('VAL-B', 7) <> 7 then
            Error('expected the Level field to hold 7');
    end;
```

- [ ] **Step 4: Bump both app.json versions** (patch segment), since the container republishes on version change.

- [ ] **Step 5: Compile:** `bun run compile:fixtures` — zero errors on every fixture project. If alc rejects any construct, fix the AL here, not in the census.

- [ ] **Step 6: Commit**

```bash
git add fixtures/sandbox-data fixtures/sandbox-data-tests
git commit -m "fixture(tables): Data Trigger Probe + R136 trio arms with intended verdicts in comments"
```

### Task A8: Census — enumerate every new and changed mutant offline

**Files:**
- Create: `scripts/census-fixture-mutants.ts` (committed, reusable — Wave B and every future operator wave needs it)

**Interfaces:**
- Consumes: `generateMutationSet` is NOT needed — the script mirrors the real planning pipeline the way the session's filter probe did: `initParser`/`parseAL`/`wrapRoot` + `buildSemanticContext` over all `.al` files of a project dir, `targets`/`generate` over `tier1Operators + tier2Operators`, `validateSpec`, `isMutableSite`, `dedupeSpecs`.
- Produces: stdout listing per file/line/operator: `before` text, `after` text, displaced-or-kept — plus a summary count. Run it as `bun scripts/census-fixture-mutants.ts fixtures/sandbox-data/src`.

- [ ] **Step 1: Write the script.** This exact pipeline mirror is known to work (it ran against a probe project on 2026-08-12); commit it under `scripts/` with repo-relative imports:

```typescript
// scripts/census-fixture-mutants.ts — per-mutant offline census over a fixture project.
// Mirrors the real planning pipeline: targets -> generate -> validateSpec -> isMutableSite ->
// dedupeSpecs. Usage: bun scripts/census-fixture-mutants.ts <dir-with-al-files>
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { buildSpanIndex, validateSpec } from "../packages/engine/src/operator/spec-validation";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { dedupeSpecs } from "../packages/schemata/src/dedup";
import { isMutableSite } from "../packages/schemata/src/enclosing";

const projectDir = process.argv[2];
if (projectDir === undefined) throw new Error("usage: bun scripts/census-fixture-mutants.ts <dir>");

await initParser();
const allOperators = [...tier1Operators, ...tier2Operators];
const tiers = new Map(allOperators.map((op) => [op.name, op.tier]));

const entries = (await readdir(projectDir)).filter((f) => f.endsWith(".al")).sort();
const parsed = await Promise.all(
  entries.map(async (rel) => {
    const source = await readFile(join(projectDir, rel), "utf8");
    return { path: rel, source, root: wrapRoot(parseAL(source)) };
  }),
);
const ctx = buildSemanticContext(parsed.map(({ path, root }) => ({ path, root })));

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

let kept = 0;
for (const { path: rel, source, root } of parsed) {
  const spanIndex = buildSpanIndex(root);
  const raw: import("../packages/engine/src/operator/interface").MutationSpec[] = [];
  visit(root, (node) => {
    for (const op of allOperators) {
      if (!op.targets(node, ctx)) continue;
      for (const spec of op.generate(node, ctx)) {
        if (!validateSpec(spec, root, spanIndex).ok) continue;
        if (!isMutableSite(spec.before)) continue;
        raw.push(spec);
      }
    }
  });
  const dedupedSet = new Set(dedupeSpecs(raw, (name) => tiers.get(name)));
  for (const s of raw.sort((a, b) => a.before.startIndex - b.before.startIndex)) {
    const mark = dedupedSet.has(s) ? "" : " [DISPLACED]";
    const after = s.after.text === "" ? "(deleted)" : s.after.text.replace(/\n/g, "\\n");
    console.log(
      `${rel}:${lineOf(source, s.before.startIndex)} ${s.operatorName} | ${s.before.text.replace(/\n/g, "\\n")} => ${after}${mark}`,
    );
    if (dedupedSet.has(s)) kept++;
  }
}
console.log(`\nTOTAL deployed (post-dedup): ${kept}`);
```

(If `visit` is not exported from `syntax-node.ts`, it is exported from `@lethal/operator-sdk` and from the engine index — use whichever import typechecks; same for the `MutationSpec` type import.)
- [ ] **Step 2: Run it against `fixtures/sandbox-data/src`** twice: once on HEAD~1 (before A7's fixture commit — `git stash` or a temp worktree) and once on HEAD. The DIFF of the two outputs is the exact new-mutant list Task A9 pre-commits. Also confirm: existing mutants' lines are UNCHANGED (no operator claims moved on old code), and the new operators claim ZERO sites in old fixture files other than what the spec predicted (the spec's dedup-interplay section said none displace anything — verify `[DISPLACED]` markers show no NEW displacements of Tier-1 mutants).
- [ ] **Step 3: Commit**

```bash
git add scripts/census-fixture-mutants.ts
git commit -m "tool: offline per-mutant census over a fixture project (operator-wave preflight)"
```

### Task A9: Precommitment doc — every new mutant, a verdict, and a reason

**Files:**
- Create: `docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md`

**Interfaces:**
- Consumes: Task A8's diff (the authoritative new-mutant list), the arm intents from A7's comments, the R72 precommitment doc as the structural template (`2026-08-08-r72-value-form-arm-precommitment.md`).
- Produces: the table Task A10's live run is judged against.

- [ ] **Step 1: Write the doc.** Opening line: "Written BEFORE the live run that measures them." Sections: why the fixture grew / the change / aggregate prediction (from `killed 113 / survived 18 / no-coverage 10 over 141` to the new totals) / per-mutant prediction table covering EVERY mutant in A8's diff — not only the four operators' own mutants but every Tier-1 mutant the new fixture code produces (return-value on each `exit`, void-method-call on each statement call, empty-block on each new trigger, remove-setrange on the two `SetRange` sites, swap-call-arguments where applicable) — each with predicted verdict and mechanism. Include the trigger-coverage claim: `untargetedTriggerCount` stays 0 because every new trigger is exercised by a named test. Close with "what this wave does NOT prove" (the false->true direction, FindSet, single-argument Validate).
- [ ] **Step 2: Commit BEFORE any live run** (never "along with the results" — measurement-campaign rule 1):

```bash
git add docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md
git commit -m "spec: pre-commit per-mutant verdicts for the R136 trio tables-gate growth"
```

### Task A10: Live gate — grow `itest:tables`, re-record, self-compare

**Files:**
- Modify: `packages/runner/itest/tables.itest.ts` (the `EXPECTED` block), `packages/runner/itest/tables.baseline.json` (via the delete-and-rerun mechanism ONLY), `CLAUDE.md` (frozen figures paragraph)

- [ ] **Step 1: Update `EXPECTED`** in `tables.itest.ts` to the A9 aggregates (`totalMutantSites`, `killed`, `survived`, `noCoverage`, `mutationScore`; `platformArtifactKills` stays 1; `assertionScreenDiscrimination` stays `"vacuous"` — all new tests raise via bare `Error(...)`, so the screen still separates nothing; `untargetedTriggerCount` stays 0).
- [ ] **Step 2:** `rm packages/runner/itest/tables.baseline.json`
- [ ] **Step 3:** `LETHAL_ITEST_TABLES=1 bun run itest:tables` — foreground, full output to a log file, never piped through `head`. This run auto-records the new baseline and asserts the new aggregates.
- [ ] **Step 4: Per-mutant review:** diff the newly recorded `tables.baseline.json` against the pre-wave baseline (git shows it) AND against A9's table. Every previously existing identity must carry an UNCHANGED verdict (the minor-bump claim from A3 is proven exactly here — `operatorMajor` still 1 on old swap-modify-flag mutants). Every new mutant must match its pre-committed verdict. **Any mismatch is a BLOCK: stop, report the differing mutant(s) to the user, do not reconcile quietly.** A contradicted prediction is a finding to write down (R73 precedent), not to erase.
- [ ] **Step 5:** Run the gate AGAIN unchanged — the new baseline must compare against itself (R29).
- [ ] **Step 6:** Update CLAUDE.md's tables-gate frozen figures sentence (the "Frozen: killed 113 / survived 18 / no-coverage 10 over 141 (154 raw)" text plus a one-line R136 growth note in the existing house style).
- [ ] **Step 7: Commit**

```bash
git add packages/runner/itest/tables.itest.ts packages/runner/itest/tables.baseline.json CLAUDE.md
git commit -m "gate(tables): grow frozen baseline for the R136 trio — all pre-committed verdicts matched"
```

(If Step 4 blocked, the commit message must instead say what differed and the roadmap gets the finding.)

### Task A11: Close out Wave A

- [ ] **Step 1:** Update `docs/roadmap/R136.md` status to `done (<gate-commit>)` with one sentence per operator naming its measured arms; run `bun scripts/roadmap-index.ts`; confirm `bun test scripts/roadmap-index.test.ts` (or the full `bun test`) passes.
- [ ] **Step 2:** Full verification: `bun run typecheck && rm -rf packages/*/dist && bun test`.
- [ ] **Step 3: Commit**

```bash
git add docs/roadmap/R136.md ROADMAP.md
git commit -m "docs: close R136 — trio measured in the tables gate"
```

---

# Wave B — R134, the filter-literal operator

### Task B1: Write the filter-literal spec

**Files:**
- Create: `docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md`

- [ ] **Step 1: Write the spec** ratifying (or amending, with reasons) these proposals:

1. **Name:** `lethal.flip-filter-literal`, tier 2, version 1.0.0.
2. **Target:** a `procedure_call` where `claimsRecordMethod(node, ctx, "SetFilter")`, `countArguments(node) >= 2`, and the SECOND argument is a plain string literal (`ALNodeKind.text_literal`). `before` is the WHOLE call node; `after` is the call text with the literal's span spliced (dedup identity then coexists with `void-method-call`'s deletion — different after text — and with `remove-setrange`, which never claims SetFilter).
3. **The mini-parser** (`packages/builtin-tier2/src/filter-expression.ts`) is refuse-by-default: unquote the AL string (strip outer `'`, unescape `''` -> `'`); REFUSE the whole site if the content contains any of `* ? @ ( ) ' &` or an empty alternative; split alternatives on top-level `|`; classify each alternative as comparator (`<>`, `<=`, `>=`, `<`, `>`, `=` followed by an atom), open range (`..X` / `X..`), closed range (`X..Y`), or plain atom, where an atom is a `%N` placeholder or a bare token. Anything unclassifiable refuses the site. No mutant is ever guessed.
4. **One mutant per site**, first applicable rule in fixed precedence:
   1. `<>X` -> `=X`
   2. boundary: `<X` -> `<=X`, `<=X` -> `<X`, `>X` -> `>=X`, `>=X` -> `>X`
   3. open-range flip: `..X` -> `X..`, `X..` -> `..X`
   4. drop the first alternative containing NO `%` placeholder, only when 2+ alternatives exist
5. **Placeholder integrity is a hard invariant:** the multiset of `%N` tokens in the mutated string must equal the original's — asserted in code with a THROW (an arity change is our bug, never a mutant). Renumbering is forbidden. Rule 4's placeholder-free restriction is what guarantees the invariant; the throw is the backstop.
6. **Re-encoding:** re-escape `'` -> `''` and re-quote when splicing back (the operator-sdk `textLiteral` encoding, mirrored).
7. **Refusals recorded in the spec:** closed-range mutation (deferred — bound-swap semantics on descending ranges need their own measurement), wildcard/`@`/`&` expressions, non-literal second arguments (a variable filter string is invisible to static mutation), and `remove-setfilter` (already refused in R134's row).
8. **Fixture arms table** (from B6) with intended verdicts, including the pre-existing `SetFilter` site in `DataOps.Codeunit.al` whose shape the census will classify — its verdict (or its refusal) is pre-committed too.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md
git commit -m "spec: R134 flip-filter-literal design — refuse-by-default filter-expression mutation"
```

### Task B2: Adversarial review of the filter-literal spec

- [ ] **Step 1:** Dispatch `spec-adversary` (model: opus). Attack surfaces to name in the brief: placeholder arity (`'%1|%2'` shapes), `%1` inside a dropped alternative slipping past the multiset check, quote unescape/re-escape round-trip fidelity, filter strings containing `..` inside atoms (`'A..B|C'` ambiguity), case sensitivity of nothing (filter operators are symbols), the DataOps pre-existing site, and whether `=X` vs `X` (bare atom means equality in AL filter syntax) makes rule 1's output EQUIVALENT to a bare-atom rewrite at some sites — if `'<>%1'` -> `'=%1'` and `'%1'` are behaviorally identical filters, the spec must say why `'=%1'` is still the right emission (readability of the mutant diff) or choose the other.
- [ ] **Step 2:** Adopt/reject findings in the spec with the amendment log; commit.

```bash
git add docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md
git commit -m "spec: adopt spec-adversary amendments on flip-filter-literal"
```

### Task B3: The filter-expression mini-parser (TDD, pure function, no AST)

**Files:**
- Create: `packages/builtin-tier2/src/filter-expression.ts`, `packages/builtin-tier2/tests/filter-expression.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface FilterMutation {
  readonly mutated: string;      // the new filter CONTENT (unquoted)
  readonly rule: "flip-negation" | "shift-boundary" | "flip-open-range" | "drop-alternative";
}
/** Returns the single highest-precedence applicable mutation, or null to REFUSE the site. */
export function mutateFilterContent(content: string): FilterMutation | null;
export function unquoteALString(literal: string): string | null;  // null = not a plain 'x' literal
export function quoteALString(content: string): string;
```

- [ ] **Step 1: Write the failing tests** — the whole behavior table, one `it` per row:

```typescript
import { describe, expect, it } from "bun:test";
import { mutateFilterContent, quoteALString, unquoteALString } from "../src/filter-expression";

describe("unquoteALString / quoteALString", () => {
  it("round-trips the escaped quote", () => {
    expect(unquoteALString("'it''s'")).toBe("it's");
    expect(quoteALString("it's")).toBe("'it''s'");
  });
  it("refuses a non-literal shape", () => {
    expect(unquoteALString("Foo")).toBeNull();
  });
});

describe("mutateFilterContent — the precedence ladder", () => {
  it("rule 1: flips <>%1 to =%1", () => {
    expect(mutateFilterContent("<>%1")).toEqual({ mutated: "=%1", rule: "flip-negation" });
  });
  it("rule 2: shifts each boundary by one", () => {
    expect(mutateFilterContent("<%1")?.mutated).toBe("<=%1");
    expect(mutateFilterContent("<=%1")?.mutated).toBe("<%1");
    expect(mutateFilterContent(">%1")?.mutated).toBe(">=%1");
    expect(mutateFilterContent(">=%1")?.mutated).toBe(">%1");
  });
  it("rule 3: flips an open range", () => {
    expect(mutateFilterContent("..%1")?.mutated).toBe("%1..");
    expect(mutateFilterContent("%1..")?.mutated).toBe("..%1");
  });
  it("rule 4: drops the first placeholder-free alternative, keeping arity intact", () => {
    expect(mutateFilterContent("%1|FIXED")).toEqual({ mutated: "%1", rule: "drop-alternative" });
    expect(mutateFilterContent("A|%1|B")?.mutated).toBe("%1|B");
  });
  it("precedence: negation beats drop-alternative on a mixed expression", () => {
    expect(mutateFilterContent("<>%1|FIXED")?.rule).toBe("flip-negation");
  });
  it("refuses when every alternative carries a placeholder and no other rule applies", () => {
    expect(mutateFilterContent("%1|%2")).toBeNull();
  });
  it("refuses closed ranges as the only shape", () => {
    expect(mutateFilterContent("%1..%2")).toBeNull();
  });
  it("refuses wildcards, at-signs, ampersands, parens, and embedded quotes", () => {
    for (const bad of ["FIL*", "@name", "%1&<>%2", "(%1)", "it's"]) {
      expect(mutateFilterContent(bad)).toBeNull();
    }
  });
  it("refuses the empty and whitespace-only string", () => {
    expect(mutateFilterContent("")).toBeNull();
    expect(mutateFilterContent("  ")).toBeNull();
  });
  it("never changes the placeholder multiset (property over the table)", () => {
    const cases = ["<>%1", "<%1", "..%1", "%1..", "%1|FIXED", "A|%1|B", "<>%1|FIXED"];
    const multiset = (s: string) => (s.match(/%\d+/g) ?? []).sort().join(",");
    for (const c of cases) {
      const m = mutateFilterContent(c);
      if (m !== null) expect(multiset(m.mutated)).toBe(multiset(c));
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.
- [ ] **Step 3: Implement** the pure module. Structure: `unquoteALString` (regex `/^'((?:[^']|'')*)'$/` then replace `''` with `'`), a `classifyAlternative` returning a tagged union or `null`, `mutateFilterContent` walking rule 1 -> 4 across alternatives left-to-right, rebuilding with `|`.join, ending with the multiset assertion that THROWS on violation (fail loud — that path is unreachable if the rules are right, and reachable means our bug).
- [ ] **Step 4: Verify:** `bun run typecheck && rm -rf packages/*/dist && bun test packages/builtin-tier2 -t "filter-expression"`.
- [ ] **Step 5: Commit**

```bash
git add packages/builtin-tier2/src/filter-expression.ts packages/builtin-tier2/tests/filter-expression.test.ts
git commit -m "feat(tier2): refuse-by-default filter-expression mini-parser for R134"
```

### Task B4: The operator `lethal.flip-filter-literal`

**Files:**
- Create: `packages/builtin-tier2/src/flip-filter-literal.ts`, `packages/builtin-tier2/tests/flip-filter-literal.test.ts`
- Modify: `packages/builtin-tier2/src/index.ts`

**Interfaces:**
- Consumes: `mutateFilterContent`/`unquoteALString`/`quoteALString` from `./filter-expression`; `claimsRecordMethod`; `argumentAt` (from Task A5); `countArguments`; `synthesizeAfter`.
- Produces: `export const flipFilterLiteral: MutationOperator` (`name: "lethal.flip-filter-literal"`, `version: "1.0.0"`, `tier: 2`).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/builtin-tier2/tests/flip-filter-literal.test.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, initParser } from "@lethal/operator-sdk";
import { flipFilterLiteral } from "../src/flip-filter-literal";
import { contextFor, parseClean } from "./parse-clean";

beforeAll(async () => {
  await initParser();
});

function specsFor(src: string) {
  const root = parseClean(src);
  const ctx = contextFor(root);
  return findAll(root, ALNodeKind.procedure_call)
    .filter((n) => flipFilterLiteral.targets(n, ctx))
    .flatMap((n) => [...flipFilterLiteral.generate(n, ctx)]);
}

describe("flip-filter-literal", () => {
  it("flips the negation inside the literal and leaves everything else verbatim", () => {
    const src = `codeunit 50100 T {
      procedure P(No: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", '<>%1', No);
      end;
    }`;
    const specs = specsFor(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.after.text).toBe(`Rec.SetFilter("No.", '=%1', No)`);
  });

  it("refuses a variable filter string, a wildcard literal, and a bare SetFilter", () => {
    const src = `codeunit 50100 T {
      procedure P(F: Text)
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", F);
        Rec.SetFilter("No.", 'FIL*');
        Rec.SetFilter("No.", '%1..%2', 'A', 'B');
      end;
    }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("re-escapes embedded quotes when splicing back", () => {
    const src = `codeunit 50100 T {
      procedure P()
      var Rec: Record Customer;
      begin
        Rec.SetFilter(Name, '<>O''Brien');
      end;
    }`;
    const specs = specsFor(src);
    expect(specs[0]?.after.text).toBe(`Rec.SetFilter(Name, '=O''Brien')`);
  });

  it("emits exactly one mutant per site even when several rules could apply", () => {
    const src = `codeunit 50100 T {
      procedure P(No: Code[20])
      var Rec: Record Customer;
      begin
        Rec.SetFilter("No.", '<>%1|FIXED', No);
      end;
    }`;
    expect(specsFor(src)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `targets()`: `claimsRecordMethod(node, ctx, "SetFilter")` AND `countArguments(node) >= 2` AND second argument's kind is `ALNodeKind.text_literal` AND `unquoteALString` succeeds AND `mutateFilterContent` returns non-null. `generate()`: splice `quoteALString(mutation.mutated)` over the literal's span inside `node.text` (byte-offset splice with the same out-of-span guard as `replaceArgument`); `before` = the call node; `after: synthesizeAfter(node, mutatedCallText)`; `parentContext` computed honestly (`SetFilter` is void so it will be statement position in practice, but compute it, do not assume). One conformance case. Register in `index.ts`.
- [ ] **Step 4: Verify:** full package tests + typecheck + dist clean.
- [ ] **Step 5: Red-check** the text-literal-kind guard: accept any second argument, confirm the variable-filter-string refusal test goes RED, restore.
- [ ] **Step 6: Commit**

```bash
git add packages/builtin-tier2/src/flip-filter-literal.ts packages/builtin-tier2/tests/flip-filter-literal.test.ts packages/builtin-tier2/src/index.ts
git commit -m "feat(tier2): flip-filter-literal operator — mutations inside SetFilter's filter string (R134)"
```

### Task B5: Independent red-check pass over Wave B

- [ ] **Step 1:** `mutation-red-checker` (sonnet) on: the multiset THROW backstop (weaken rule 4 to drop a placeholder-carrying alternative — the property test AND the throw must both object), the `unquoteALString` null path, and the second-argument-kind guard.
- [ ] **Step 2:** Missing red on any guard = add the test, re-run.

### Task B6: Fixture growth — `Data Filter Ops`

**Files:**
- Create: `fixtures/sandbox-data/src/DataFilterOps.Codeunit.al`
- Modify: `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`, both app.json versions

- [ ] **Step 1: Write the arm codeunit.** Every procedure first scopes with `SetRange` to its OWN key sub-band (`FILT-P..FILT-R`, `FILT-S`, `FILT-T..FILT-U`, `FILT-W1..FILT-W9`), so no arm's count can see another arm's rows and no verdict depends on test execution order:

```al
codeunit 79317 "Data Filter Ops"
{
    // ARM: KILL — '<>%1' -> '=%1' flips which rows the count sees. The test seeds
    // FILT-P/Q/R and excludes one: original counts 2, mutant counts 1. (Two rows
    // would NOT kill — '<>' and '=' would both count 1 — hence three.)
    procedure CountOthers(No: Code[20]): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", 'FILT-P', 'FILT-R');
        Probe.SetFilter("No.", '<>%1', No);
        exit(Probe.Count());
    end;

    // ARM: SURVIVOR, the documented equivalence limit — '<%1' vs '<=%1' differ only
    // on a row AT the boundary, and the covering test seeds none there. With only
    // off-boundary data the mutant is equivalent with respect to that data.
    procedure CountBelow(Cap: Integer): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", 'FILT-S', 'FILT-S');
        Probe.SetFilter("Level", '<%1', Cap);
        exit(Probe.Count());
    end;

    // ARM: KILL — dropping the placeholder-free alternative removes FILT-U from
    // the set; the test asserts both rows are counted.
    procedure CountPair(No: Code[20]): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", 'FILT-T', 'FILT-U');
        Probe.SetFilter("No.", '%1|FILT-U', No);
        exit(Probe.Count());
    end;

    // ARM: REFUSAL negative — the wildcard makes the parser refuse, so this site
    // must produce NO flip-filter-literal mutant (void-method-call still claims it).
    procedure CountWild(): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", 'FILT-W1', 'FILT-W9');
        Probe.SetFilter("No.", 'FILT-W*');
        exit(Probe.Count());
    end;
}
```

- [ ] **Step 2: Covering tests** appended to `DataTests.Codeunit.al` (R134 banner comment naming the precommitment doc):

```al
    [Test]
    procedure NegationFlipChangesTheCount()
    var
        Probe: Record "Data Trigger Probe";
        FilterOps: Codeunit "Data Filter Ops";
    begin
        Probe.Init();
        Probe."No." := 'FILT-P';
        Probe.Insert(false);
        Probe.Init();
        Probe."No." := 'FILT-Q';
        Probe.Insert(false);
        Probe.Init();
        Probe."No." := 'FILT-R';
        Probe.Insert(false);
        if FilterOps.CountOthers('FILT-P') <> 2 then
            Error('expected 2 rows other than FILT-P, got %1', FilterOps.CountOthers('FILT-P'));
    end;

    [Test]
    procedure OffBoundaryDataCannotSeeTheBoundaryShift()
    var
        Probe: Record "Data Trigger Probe";
        FilterOps: Codeunit "Data Filter Ops";
    begin
        Probe.Init();
        Probe."No." := 'FILT-S';
        Probe."Level" := 3;
        Probe.Insert(false);
        if FilterOps.CountBelow(10) <> 1 then
            Error('expected exactly the Level-3 row below 10');
    end;

    [Test]
    procedure DroppedAlternativeLosesTheFixedRow()
    var
        Probe: Record "Data Trigger Probe";
        FilterOps: Codeunit "Data Filter Ops";
    begin
        Probe.Init();
        Probe."No." := 'FILT-T';
        Probe.Insert(false);
        Probe.Init();
        Probe."No." := 'FILT-U';
        Probe.Insert(false);
        if FilterOps.CountPair('FILT-T') <> 2 then
            Error('expected FILT-T plus the fixed alternative FILT-U to count 2');
    end;

    [Test]
    procedure WildcardSiteStillCounts()
    var
        Probe: Record "Data Trigger Probe";
        FilterOps: Codeunit "Data Filter Ops";
    begin
        Probe.Init();
        Probe."No." := 'FILT-W1';
        Probe.Insert(false);
        if FilterOps.CountWild() < 1 then
            Error('expected the wildcard filter to find FILT-W1');
    end;
```

(Careful with `CountOthers`: three seeded rows, one excluded — the flip to `'=%1'` counts 1, not 2, so the kill is real. Two rows would NOT kill: `<>` and `=` would both count 1.)

- [ ] **Step 3:** Bump app.json versions; `bun run compile:fixtures` — zero errors.
- [ ] **Step 4: Commit**

```bash
git add fixtures/sandbox-data fixtures/sandbox-data-tests
git commit -m "fixture(tables): Data Filter Ops — R134 arms including the refusal negative"
```

### Task B7: Census + precommitment for Wave B

**Files:**
- Create: `docs/superpowers/specs/2026-08-12-r134-filter-literal-precommitment.md`

- [ ] **Step 1:** `bun scripts/census-fixture-mutants.ts fixtures/sandbox-data/src` before/after B6's commit; diff = the new-mutant list. This census also settles the pre-existing `DataOps.Codeunit.al` SetFilter site: either it now carries a flip-filter-literal mutant (predict its verdict from its covering tests) or its shape is refused (record the refusal). Confirm the `CountWild` site produces NO flip-filter-literal mutant.
- [ ] **Step 2:** Write and commit the precommitment doc (R72 shape, every mutant in the diff, aggregate table from Wave A's totals to Wave B's).

```bash
git add docs/superpowers/specs/2026-08-12-r134-filter-literal-precommitment.md
git commit -m "spec: pre-commit per-mutant verdicts for the R134 tables-gate growth"
```

### Task B8: Live gate — grow, re-record, self-compare (Wave B)

**Files:**
- Modify: `packages/runner/itest/tables.itest.ts` (`EXPECTED` block), `packages/runner/itest/tables.baseline.json` (delete-and-rerun ONLY), `CLAUDE.md` (frozen figures)

- [ ] **Step 1:** Update `EXPECTED` in `tables.itest.ts` to B7's aggregates (`totalMutantSites`, `killed`, `survived`, `noCoverage`, `mutationScore`; `platformArtifactKills` stays 1; `assertionScreenDiscrimination` stays `"vacuous"`; `untargetedTriggerCount` stays 0).
- [ ] **Step 2:** `rm packages/runner/itest/tables.baseline.json`
- [ ] **Step 3:** `LETHAL_ITEST_TABLES=1 bun run itest:tables` — foreground, full output to a log file, never piped through `head`. Auto-records the new baseline and asserts the new aggregates.
- [ ] **Step 4:** Per-mutant review: diff the recorded baseline against the Wave-A baseline (git shows it) AND against B7's table. Every Wave-A identity must carry an unchanged verdict; every new mutant must match its pre-committed verdict; the `CountWild` site must show NO flip-filter-literal mutant. **Any mismatch is a BLOCK: stop and report the differing mutant(s); a contradicted prediction is a finding to write down, never to reconcile quietly.**
- [ ] **Step 5:** Run the gate AGAIN unchanged — the new baseline must compare against itself (R29).
- [ ] **Step 6:** Update CLAUDE.md's tables-gate frozen figures sentence with the R134 growth note.
- [ ] **Step 7: Commit**

```bash
git add packages/runner/itest/tables.itest.ts packages/runner/itest/tables.baseline.json CLAUDE.md
git commit -m "gate(tables): grow frozen baseline for flip-filter-literal — all pre-committed verdicts matched"
```

### Task B9: Close out Wave B

- [ ] **Step 1:** `docs/roadmap/R134.md` -> `done (<gate-commit>)`; regenerate `ROADMAP.md`; full `bun run typecheck && rm -rf packages/*/dist && bun test`.
- [ ] **Step 2: Commit**

```bash
git add docs/roadmap/R134.md ROADMAP.md
git commit -m "docs: close R134 — flip-filter-literal measured in the tables gate"
```

---

# Wave C — cross-gate confirmation

### Task C1: Prove the other three gates did not move

`fixtures/sandbox-app` has zero sites for all four operators (measured in this plan's preflight), so `itest:bcdev` (3/10/3), `itest:alrunner` (3/13/0), and `itest:envtool` (3/10/3) must come back UNCHANGED — same mutant population, same per-mutant verdicts, no baseline re-record.

- [ ] **Step 1:** `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` — foreground, expect frozen figures and a clean baseline compare.
- [ ] **Step 2:** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner` — READ THE FIRST LINE (it prints the al-runner build); a difference traced to a new al-runner release is not this wave's regression, but a differing verdict is still a BLOCK to report.
- [ ] **Step 3:** `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` — needs the gitignored `fixtures/sandbox-app/lethal.config.envtool.json`, which already points at the DK cloud environment provisioned 2026-08-12 (running, expires 2026-08-26). If the env is gone, report and skip with that stated — do not provision silently.
- [ ] **Step 4:** Report the three results to the user. Nothing to commit if unchanged (expected). Any change: BLOCK, per-mutant diff in the report.

---

## Execution notes for the orchestrator

- Tasks A3/A4/A5 are independent after A2 and may run as parallel subagents ONLY if each stays inside its own files; they all touch `packages/builtin-tier2/src/index.ts` and A4/A5 both touch `mutate-helpers.ts`, so run them SEQUENTIALLY (A3 -> A4 -> A5) to avoid merge churn. Everything else is strictly ordered within its wave.
- Wave B depends on Wave A only through `argumentAt` (Task A5) and the shared fixture table (Task A7). Do not reorder B before A.
- The live gates (A10, B8, C1) are minutes each, run foreground, output to a file, never piped through `head` (a mid-pipe SIGPIPE can kill a live run).
- Every subagent report must include: what was red-checked and both outputs, the exact test/typecheck commands run, and any deviation from this plan's code (deviations are fine when the real grammar/API disagrees with the plan sketch — say so explicitly).
