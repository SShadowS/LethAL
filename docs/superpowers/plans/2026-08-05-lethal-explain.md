# `lethal explain` Implementation Plan (subsystem B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A projection of a finished `SessionReport` that tells its consumer what the data MEANS, so a reader does not have to re-derive interpretations that already exist in the codebase.

**Architecture:** `lethal explain <report.json>` reads a committed report and emits a structured projection. Every interpretation is **keyed** to a machine value the report already carries, **co-located** as an exported constant in the module that owns that value, and carries a **basis** naming its evidence. Nothing is authored fresh; existing doc comments are promoted.

**Tech Stack:** Bun + TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-05-observability-and-campaign-method-design.md`, section B. Read it before starting.

**Scope:** Subsystem B only. Tool features (C) and `lethal campaign` + the skill (D) have their own plans. None depend on this one.

## Why this exists, in one measurement

During the 2026-08-03 DO campaign, an agent given a mutation report derived this insight itself, at a cost of **$18.56**:

> *"'survived' here means 'some test touched the codeunit', not 'a test executed this line'. Do not read those 87 as weak assertions."*

That sentence already existed in the repository, in `packages/runner/src/selection.ts`'s doc comment on `CoverageAttribution`:

> *`object` — FALLBACK 1. The tests executed something in this OBJECT; whether they reached the mutated member is unknown. "Covered but survived" here may be no finding at all, and **telling an agent to strengthen one of these tests can send it chasing a test that never ran the code.**"*

The report cannot emit it. A weaker reader would have written ~87 pointless tests.

**So the danger is not "prose about data rots". It is: the prose lives where the rule lives, the projection cannot reach it, so someone writes a SECOND copy that rots.** This plan promotes; it does not author.

## Global Constraints

- **No `!` non-null assertions** — biome `noNonNullAssertion: error`.
- **`exactOptionalPropertyTypes`** — `...(v !== undefined ? { k: v } : {})`.
- **Fail loudly on caller-contract violations.** Throw; never return a plausible empty default.
- **Build order:** `bun run typecheck` FIRST, THEN clear each package's `dist` (six literal deletes — the globbed form is blocked by a safety hook, and `packages/builtin-tier2/dist` is not in CLAUDE.md's list but goes stale), THEN `bun test`.
- **Report the FULL `bun run typecheck` output in every task report.**
- **An interpretation may exist ONLY if it is keyed, co-located, and based.** Anything that cannot satisfy the first clause is refused automatically — no taste required.
- **Refuse operator-keyed claims about the TARGET's code; admit them about the TOOL.** See Task 4.

## File Structure

| path | responsibility |
|---|---|
| `packages/runner/src/selection.ts` | **Modify.** Promote the `CoverageAttribution` doc comment to an exported `Record<CoverageAttribution, Interpretation>`. |
| `packages/runner/src/report.ts` | **Modify.** Promote `caveats` from `readonly string[]` to a `Caveat` literal union; export `Record<Caveat, Interpretation>`. |
| `packages/runner/src/interpretation.ts` | **New.** The `Interpretation` type and the basis-resolution rule. Pure. |
| `packages/runner/src/explain.ts` | **New.** The projection: `SessionReport` in, `ExplainOutput` out. Pure. |
| `packages/runner/src/cli.ts` | **Modify.** The `explain` subcommand. |
| `packages/runner/tests/interpretation.test.ts` | **New.** Exhaustiveness and basis-resolution tests. |
| `packages/runner/tests/explain.test.ts` | **New.** Projection tests. |

---

### Task 1: `Interpretation`, and the rule that every basis resolves

**Files:**
- Create: `packages/runner/src/interpretation.ts`
- Test: `packages/runner/tests/interpretation.test.ts`

**Interfaces:**
- Produces: `Interpretation = { readonly meaning: string; readonly entailedNegative?: string; readonly basis: string }`, and `assertBasisResolves(basis: string, deps): void`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { assertBasisResolves } from "../src/interpretation";

describe("every basis resolves — the roadmap-auditor discipline, applied to prose", () => {
  test("a roadmap id that exists is accepted", () => {
    expect(() => assertBasisResolves("R29", { roadmapIds: new Set(["R29"]), files: new Set() })).not.toThrow();
  });

  test("a roadmap id that does NOT exist throws, naming it", () => {
    expect(() => assertBasisResolves("R999", { roadmapIds: new Set(["R29"]), files: new Set() })).toThrow(/R999/);
  });

  test("a measurement file that does not exist throws", () => {
    expect(() =>
      assertBasisResolves("docs/measurements/README.md#gone", { roadmapIds: new Set(), files: new Set() }),
    ).toThrow(/docs\/measurements/);
  });

  test("an empty basis is refused — 'never a bare claim'", () => {
    expect(() => assertBasisResolves("", { roadmapIds: new Set(), files: new Set() })).toThrow(/bare|empty/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

The `basis` field name and its rule are **adopted, not invented**: `SessionReport`'s `ExecutionContext.basis` already carries the doc comment *"How that is known — measured, inferred from the runner's shape, or (for a carried verdict) named as coming from an earlier run. **Never a bare claim.**"* Cite that in `interpretation.ts`'s own doc comment so the next reader knows this is a house pattern rather than a new one.

`assertBasisResolves` cannot verify SEMANTICS — only that the pointer resolves. Say so in the comment. It kills dangling-pointer rot and forces every new interpretation to arrive with evidence; it cannot tell you the evidence supports the claim.

- [ ] **Step 3: Suite, lint, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/engine/dist && rm -rf packages/operator-sdk/dist && rm -rf packages/builtin-tier1/dist && rm -rf packages/builtin-tier2/dist && rm -rf packages/schemata/dist && rm -rf packages/runner/dist && bun test packages/runner/tests/interpretation.test.ts
bunx biome check packages/runner/src/interpretation.ts packages/runner/tests/interpretation.test.ts
git add packages/runner/src/interpretation.ts packages/runner/tests/interpretation.test.ts
git commit -m "feat(explain): the Interpretation type, and a test that every basis resolves"
```

---

### Task 2: Promote `caveats` to a `Caveat` union

**Prerequisite refactor.** `caveats` is `readonly string[]` (`report.ts:115`) with **11** free `caveats.push(` literals. A union is what makes Task 3's exhaustiveness check possible, and it kills a whole rot vector: the projection never restates a caveat, it emits the shared constant keyed on the flag, so there is exactly one statement of each fact.

**Files:**
- Modify: `packages/runner/src/report.ts`
- Test: `packages/runner/tests/report.test.ts`

- [ ] **Step 1: Enumerate the real members**

```bash
cd U:/Git/LethAL && grep -n 'caveats.push(' packages/runner/src/report.ts
```

There are 11. **Derive the union members from what this actually pushes — do not invent names.** A previous plan hit this exact hazard: an implementer wrote `"permissions-refused"` (missing an `s`) that never matched the real `"tests-permission-refused"`, and the typo lived in a test until a reviewer caught it.

- [ ] **Step 2: Write the failing test**

```ts
import type { Caveat } from "../src/report";

test("every caveat the report can push is a member of the union", () => {
  // Compile-time: this object must be exhaustive or tsc fails.
  const all: Record<Caveat, true> = {
    "narrowed": true,
    "tests-narrowed": true,
    "baseline-red": true,
    // ...the rest, derived from the grep in Step 1
  };
  expect(Object.keys(all).length).toBe(11);
});
```

- [ ] **Step 3: Change the type, fix the fallout**

`readonly caveats: readonly Caveat[]`. Every `caveats.push(...)` now typechecks against the union — a typo becomes a compile error rather than a silently-never-matching string.

- [ ] **Step 4: Suite, then commit.** The full suite must stay green; this is a type-only change.

---

### Task 3: Co-locate the interpretations, exhaustively

**Files:**
- Modify: `packages/runner/src/selection.ts`, `packages/runner/src/report.ts`
- Test: `packages/runner/tests/interpretation.test.ts`

**Interfaces:**
- Produces: `ATTRIBUTION_INTERPRETATIONS: Record<CoverageAttribution, Interpretation>` from `selection.ts`; `CAVEAT_INTERPRETATIONS: Record<Caveat, Interpretation>` from `report.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { ATTRIBUTION_INTERPRETATIONS } from "../src/selection";
import { CAVEAT_INTERPRETATIONS } from "../src/report";

test("adding an attribution variant fails to COMPILE until its interpretation exists", () => {
  // The Record<> type is the real assertion — this test documents it and pins the count.
  expect(Object.keys(ATTRIBUTION_INTERPRETATIONS).sort()).toEqual(["all-green", "exact", "object"]);
});

test("every caveat has an interpretation", () => {
  expect(Object.keys(CAVEAT_INTERPRETATIONS).length).toBe(11);
});

test("every shipped interpretation's basis resolves", () => {
  for (const i of [...Object.values(ATTRIBUTION_INTERPRETATIONS), ...Object.values(CAVEAT_INTERPRETATIONS)]) {
    expect(() => assertBasisResolves(i.basis, realDeps())).not.toThrow();
  }
});
```

- [ ] **Step 2: PROMOTE, do not author**

For `object`, the `meaning` and `entailedNegative` come from the existing doc comment at `selection.ts`'s `CoverageAttribution` — the one the agent paid $18.56 to re-derive. Move the words; do not rewrite them. `basis: "R29"` (its ten false survivors out of twenty are already cited in that same comment).

Same for `exact` and `all-green`, both of which the comment already describes.

For caveats, `baseline-red`'s interpretation must carry **R55's consequence**, because that is what a reader needs to act: *baseline-red dropped N tests from the green set; mutants covered only by them read `no-coverage`. Resolve this before reading survivors.*

- [ ] **Step 3: Add the drift tripwire**

Semantic drift — `object` becoming precise while keeping its name — is **not** mechanically provable against prose, and no test here should pretend otherwise. Two real defences, and the plan takes both:

1. **Co-location.** Whoever changes `byObject` precedence is editing the file whose exported constant states the interpretation. Commit `0a463fd`'s author would have had it on screen.
2. **A behavioural tripwire.** Add a fixture test where the covering test provably does not execute the mutated member yet attribution returns `object`, with a comment naming the interpretation constant that must be re-reviewed if this test ever moves. This is the R70 pattern: you cannot assert "never regresses", you plant a detector at the one site that moves.

- [ ] **Step 4: Suite, commit.**

---

### Task 4: The projection, and the line that decides what ships

**Files:**
- Create: `packages/runner/src/explain.ts`
- Test: `packages/runner/tests/explain.test.ts`

**Interfaces:**
- Produces: `explain(report: SessionReport): ExplainOutput`, `EXPLAIN_SCHEMA_VERSION`.

- [ ] **Step 1: Write the failing tests**

```ts
test("every survivor carries a machine field beside its prose", () => {
  const out = explain(reportFixture());
  for (const s of out.survivors) {
    expect(typeof s.executionProven).toBe("boolean"); // derived from attribution !== "exact"
    expect(s.interpretation.basis.length).toBeGreaterThan(0);
  }
});

test("the header records BOTH schema versions", () => {
  const out = explain(reportFixture());
  expect(out.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
  expect(out.derivedFromReportSchemaVersion).toBe(2); // REPORT_SCHEMA_VERSION
});

test("it states what is proven and what is not — never what test to write", () => {
  const out = explain(reportFixture());
  const text = JSON.stringify(out).toLowerCase();
  expect(text).not.toMatch(/write a test|add an assertion|you should test/);
});

test("it does NOT restate a caveat in fresh prose — it emits the shared constant", () => {
  const out = explain(reportWithCaveat("baseline-red"));
  expect(out.caveats[0]?.interpretation).toBe(CAVEAT_INTERPRETATIONS["baseline-red"]);
});
```

- [ ] **Step 2: Implement, holding the admissibility line**

**About the TARGET**: state what is proven, what is not, and what the data cannot support. **Never what test to write.** The measured reason: the weak reader's failure (~87 pointless tests) is prevented by a meaning statement with its entailed negative; the strong reader's *win* was reframing the task entirely, and a projection saying "strengthen these 19" would have anchored against it. The campaign's own pre-commitment framed "kill survivors" and the agent did better by ignoring that frame.

**About the TOOL**: be fully prescriptive — those steps are deterministic and LethAL's own domain. *"This file's guard count exceeds the measured publish ceiling; it cannot be published"* (R90). *"Stranded error, not a verdict — re-run with `--mutant-timeout-ms` raised"* (R91).

**The line is target-semantics vs tool-mechanics, not "no operator-specific advice".** An equivalence guess is a claim about the customer's code that no LethAL machinery measures — there is no report field to key on, so clause 1 excludes it automatically. R91's slow-not-hung finding is a claim about LethAL's own timeout machinery, keyed on the verdict distinction, with a basis.

**This matters because the campaign's own pre-commitment carried "surviving `remove-setrange` is often equivalent" and rung 3 DISPROVED it** — the agent killed them legitimately with decoy rows. Future proposals get decided by the mechanism, not by whoever remembers that.

- [ ] **Step 3: The split contract, stated in the output itself**

**Structure** is versioned and stable under `EXPLAIN_SCHEMA_VERSION`, with the header also recording the `REPORT_SCHEMA_VERSION` it derived from — the same two-version pattern the event stream uses. **Prose strings are explicitly non-contractual**: consumers must not parse them, and they may improve without a version bump. The keying rule makes that safe rather than aspirational — every machine-usable atom appears as a structured field by construction, so no consumer has a reason to regex prose. Say all of this in the output.

- [ ] **Step 4: Wire `lethal explain <report.json>`**, add to help and `README.md`.

- [ ] **Step 5: Suite, lint, commit.**

---

## What this plan does NOT do

No live gate is required — `explain` reads a committed report and touches no execution path. Run the full unit suite and typecheck; that is sufficient.

**Do not add an interpretation that cannot be keyed to an existing machine value.** If a useful thing to say has no field to hang on, the fix is to add the field to the report first (a separate change, with its own justification), not to let the projection assert something free-floating.
