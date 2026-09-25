# GH-07: `repeat ... until false` collision, and the `while true do` twin it left behind, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No project that contains a loop whose whole condition is a boolean literal (`repeat ... until false`, `until true`, `while true do`, `while false do`, with or without parentheses) crashes `dedupeSpecs` at planning, and none of them ships a mutant that turns a terminating loop into one that never ends.

**Architecture:** One predicate changes, in one operator. `flip-boolean-literal`'s `isRepeatExitCondition` becomes `isLoopCondition` and also accepts a `while` statement. `loop-skip` keeps `while true do` (it already emits the same `false` there), exactly as `loop-truncate` keeps `until false`. `dedupeSpecs` is not touched.

**Tech Stack:** Bun + TypeScript, `bun test`, tree-sitter-al through `@lethal/engine`.

**Spec:** GitHub issue #7 (StefanMaron) and the owner's comment on it.

## What already landed, and what this plan is for

The reported bug is FIXED on `master` in `a407344` (2026-09-08), which is after `v0.1.0-alpha.3`, so it is unreleased. Verified on HEAD `5420201` today:

- `flip-boolean-literal` refuses a literal that is a `repeat`'s whole exit condition (`isRepeatExitCondition`). `loop-truncate` keeps `until false`. `until true` gets no mutant at all, since its flip was a hang.
- `packages/builtin-tier1/tests/operator-collisions.test.ts` runs every Tier-1 operator over every conformance source and asserts `dedupeSpecs` never throws. It also carries the issue's repro by name: `"plans \`repeat ... until false;\` without a collision (issue #7)"`, which also asserts `loop-truncate` is the only claimant, so a fix that silenced both operators would go red.
- `bun test packages/builtin-tier1/tests/operator-collisions.test.ts packages/builtin-tier1/tests/flip-boolean-literal.test.ts`: 8 pass, 0 fail.

So the issue's repro is already a unit test. **This plan exists because the fix left the same crash one loop kind over.** Probed on HEAD, all Tier-1 operators over one procedure each:

| Source | `dedupeSpecs` | Claims at the literal |
|---|---|---|
| `while true do begin N += 1; if N > 3 then exit; end;` | **THROWS**: `operators "lethal.loop-skip" and "lethal.flip-boolean-literal" both claim the same mutation at boolean at 61-65` | `loop-skip` true -> false, `flip-boolean-literal` true -> false |
| `while false do N += 1;` | ok | `flip-boolean-literal` false -> **true**, no `hangCapable` tag. The only mutant at the site, and it never ends unless the body exits |
| `repeat Done := true; until Done and true;` | ok | `flip-boolean-literal` at the condition's `true` -> `false`, untagged: `until Done and false` never exits through its condition |
| `while X or false do X := false;` | ok | `flip-boolean-literal` at the condition's `false` -> `true`, untagged: `while X or true` never exits through its condition |

Why `a407344` missed row 1: its doc comment and its test `"still claims a \`while\` condition, whose flip terminates"` both say `loop-truncate is repeat-only and would not cover it`. True, but `loop-skip` (R179, `d0e6c6c`, 2026-08-27, twelve days earlier) does cover it, with the identical replacement. That test runs `flip-boolean-literal` ALONE, so it cannot see a collision, and the sweep's corpus contains no `while true do`. The test pinned the collision as correct behaviour. That is this repo's "test passes for the wrong reason" hazard, in its "wrong belief encoded in the code and the test" form (see `docs/mutation-testing-ourselves.md` on R175).

## Decisions

1. **`flip-boolean-literal` cedes, in both loop kinds.** It is the generic operator; `loop-truncate` and `loop-skip` exist to own loop bounding (R164, R179). At `until false` and `while true` the loop operator already emits the same text, so no coverage is lost.
2. **The other polarity is refused, not tagged.** `until true` -> `until false` and `while false` -> `while true` both turn a loop that ends into one that ends only if the body exits. R164: a hang-capable site must not enter a scored gate. `a407344` refused `until true` on this reasoning, so `while false` follows it. `loop-skip` refuses `while false` (it is already the skipped form), so that site ends with NO mutant. That is acceptable: `while false do` is dead code, and the only mutant it had was a hang. Owner ruling asked below.
3. **`dedupeSpecs` keeps its throw.** Two same-tier operators emitting an identical mutation is an operator seam bug. It is not a precedence question: each would score the same, so silently picking one hides the seam, and the next seam (two operators emitting the SAME text with different claimed meaning, hang tags or equivalence hints) would then resolve by registration order, which is exactly what the throw exists to prevent. The cost of the throw is paid offline now, by the collision sweep, not by a user. `a407344` already ruled this way; this plan does not reopen it.
4. **Nested literals stay claimed (unchanged).** `a407344` kept `until Done or false` on purpose. Rows 3 and 4 above show the OTHER polarity of a nested literal is an untagged hang. Zero sites in either reference corpus (725 `repeat` loops measured in `a407344`) and in every fixture. Filed as a roadmap item (Task 5), not fixed here: the rule would have to reason about `and`/`or` chains, and there is no site to measure it on. It also covers the shapes gpt-6-sol named: a unary `not` around the literal (`while not true` flips to `while not false`, `until not false` to `until not true`, both non-terminating), and a literal in the BODY that governs the only exit (`while true do if true then exit;`). None carries a condition-side hang tag.

## Task 2 addendum: parentheses in the two loop operators

In the same commit as the `flip-boolean-literal` change, `loop-skip.ts`'s `skipCondition` and
`loop-truncate.ts`'s `exitCondition` compare the condition with its parentheses stripped, not its
raw text: add one module-private helper per file (or one shared in `loop-hazard.ts` if it already
exports a parenthesis walk; check first) that unwraps `parenthesized_expression` nodes, and compare
the innermost node's text (`false` for loop-skip, `true` for loop-truncate). The existing bare-form
checks keep working through the same helper.

## Gate impact: none, pre-committed

`grep -rniE` over every `.al` under `fixtures/` and `examples/` for a `while` or `until` whose condition is, or contains, a bare `true`/`false` finds only comment lines (`fixtures/sandbox-hang/src/HangLogic.Codeunit.al` and `fixtures/sandbox-hang-tests/src/HangTests.Codeunit.al`). All eight `until` clauses in those trees are comparisons (`until CodeCoverage.Next() = 0`, `until Counter >= Limit`, and similar).

**Pre-commitment:** no mutant is added, removed or changed on any gate fixture. Every frozen figure in `CLAUDE.md` stays as it is: `itest:bcdev`, `itest:alrunner` and `itest:envtool` 3 / 12 / 4; `itest:tables` 299 / 63 / 15; `itest:chunked` 17 / 7 / 2 per leg; `itest:hang` and `examples/gift-card` unchanged. Task 4 proves this mechanically, offline, per mutant. No live gate run is needed; if Task 4's diff is non-empty, STOP and bring it to the owner, because the grep was wrong.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. Compare spans by POSITION, never node identity (R209, as the existing predicate already does).
- Do not touch `packages/schemata/src/dedup.ts`.
- Do not bump `flip-boolean-literal`'s `OPERATOR_VERSION` unless the owner rules so. `a407344` changed the emitted set without a bump, and the version has never tracked cessions (R164's `negate-conditional` cession did not bump either). Asked below.
- Roadmap prose cites names, never `file.ts:<line>` (R117, `scripts/line-citations.test.ts`).
- No em dashes in any file this plan writes.

## Review Focus

1. **`while true do` plans, and `loop-skip` is the only claimant.** The crash is gone AND the site keeps its mutant, so a fix that silenced both operators goes red. Pinned by `"plans \`while true do\` without a collision (GH-07 follow-up)"` (Task 1, `operator-collisions.test.ts`).
2. **`while false do` emits no flip.** The half that crashes nothing and is the worse bug: its only mutant was a loop that never ends. Pinned by `"REFUSES \`while false\`, whose flip is a loop that never ends"` (Task 1, `flip-boolean-literal.test.ts`).
3. **Parentheses do not dodge it, for ANY operator.** `loop-skip` and `loop-truncate` compare the condition's text, so today they emit equivalent mutants on `while (false)` (`(false) -> false`) and `until (true)` (`(true) -> true`). Both strip parentheses before comparing, pinned by `"no operator emits an equivalent mutant on a parenthesised loop literal"`, with a red-check that restores the raw-text comparison. `while (true) do` and `while (false) do` are refused like the bare form, the same way `until (false)` already is. Pinned by `"REFUSES a parenthesised while condition too"` (Task 1).
4. **No over-refusal.** A literal nested in a compound `while` condition stays claimed: `while Go and true do` flips to `while Go and false do`, which runs the body zero times and ends. Pinned by `"does NOT over-refuse a boolean nested inside a compound while condition"` (Task 1). The existing `repeat` guard `"does NOT over-refuse a boolean nested inside a compound exit condition"` must stay green unchanged.
5. **The sweep now carries the shape, so deleting the named test cannot delete the guard.** A new conformance case on `flip-boolean-literal` puts `while true do` in the corpus that `"no two Tier-1 operators claim the same mutation on any conformance source"` sweeps. Pinned by that sweep going red in red-check RC1 (Task 3) through the conformance case alone, with the named test temporarily skipped.

---

### Task 1: The failing tests

**Files:**
- Modify: `packages/builtin-tier1/tests/operator-collisions.test.ts` (add one `it` after the issue #7 test)
- Modify: `packages/builtin-tier1/tests/flip-boolean-literal.test.ts` (REPLACE `"still claims a \`while\` condition, whose flip terminates"` and its doc comment; add three tests)
- Modify: `packages/builtin-tier1/src/flip-boolean-literal.ts` (`conformanceTests` only in this task: one new case)

- [ ] **Step 1: The named repro.** In `operator-collisions.test.ts`:

```ts
  /**
   * GH-07's twin, found while verifying the issue #7 fix. `while true do` is the same idiom as
   * `repeat ... until false;`: a loop whose exits all sit in the body. `loop-skip` rewrites a while's
   * condition to `false`, and `flip-boolean-literal` flipped the same `true` to the same `false` at
   * the same span. The issue #7 fix reasoned that no loop operator claims a `while`, which stopped
   * being true when `loop-skip` landed (R179).
   */
  it("plans `while true do` without a collision (GH-07 follow-up)", () => {
    const source = `codeunit 50000 ReproLoopSkip
{
    procedure CountToThree(): Integer
    var
        I: Integer;
    begin
        I := 0;
        while true do begin
            I += 1;
            if I >= 3 then
                exit(I);
        end;
    end;
}`;
    const specs = allSpecsFor(source);
    expect(() => dedupeSpecs(specs, tierOf)).not.toThrow();

    // A cession, not a silence: the site keeps exactly one mutant, and it is loop-skip's.
    const atCondition = specs.filter((s) => s.before.text === "true");
    expect(atCondition.map((s) => s.operatorName)).toEqual(["lethal.loop-skip"]);
  });
```

- [ ] **Step 2: Replace the wrong `while` test.** In `flip-boolean-literal.test.ts`, delete `"still claims a \`while\` condition, whose flip terminates"` and its doc comment (it encodes the belief that caused the bug). Add, reusing the file's existing `findAll` / `wrapRoot` / `buildSemanticContext` pattern through a local helper:

```ts
  function flipsIn(src: string): string[] {
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    return findAll(root, ALNodeKind.boolean_literal)
      .filter((n) => flipBooleanLiteral.targets(n, ctx))
      .flatMap((n) => flipBooleanLiteral.generate(n, ctx))
      .map((s) => `${s.before.text}->${s.after.text}`);
  }

  /**
   * `while true do` is loop-skip's site (R179): it emits the same `false` at the same span, and two
   * operators on one identity make dedupeSpecs throw. The collision itself is pinned in
   * operator-collisions.test.ts; this pins the refusal on this operator alone.
   */
  it("REFUSES a `while` loop's whole condition, which loop-skip owns (GH-07 follow-up)", () => {
    expect(
      flipsIn(`codeunit 50000 R { procedure P() var I: Integer; begin while true do begin I += 1; if I > 3 then exit; end; end; }`),
    ).toEqual([]);
  });

  /**
   * `while false do` never runs its body. Flipped to `while true do`, it runs until the body exits,
   * and this body never does. loop-skip refuses `while false` (it is already the skipped form), so
   * before this refusal the site's ONLY mutant was a hang (R164).
   */
  it("REFUSES `while false`, whose flip is a loop that never ends", () => {
    expect(flipsIn(`codeunit 50000 R { procedure P() var I: Integer; begin while false do I += 1; end; }`)).toEqual([]);
  });

  it("REFUSES a parenthesised while condition too", () => {
    expect(flipsIn(`codeunit 50000 R { procedure P() var I: Integer; begin while (true) do exit; while (false) do I += 1; end; }`)).toEqual([]);
  });

  /**
   * The over-refusal guard. `while Go and true do` flips to `while Go and false do`, which runs the
   * body zero times and ends. The literal is not the whole condition, so it stays claimed.
   */
  it("does NOT over-refuse a boolean nested inside a compound while condition", () => {
    expect(
      flipsIn(`codeunit 50000 R { procedure P() var Go: Boolean; begin while Go and true do Go := false; end; }`),
    ).toEqual(["true->false", "false->true"]);
  });
```

The last expectation includes the body's `Go := false` literal: it is an assignment in the loop, not the condition, so it is claimed (with a `hangCapable` tag, which the existing R196 test already pins). If the executor finds the order differs, fix the expectation's ORDER only, never its contents, and say so in the submit note.

- [ ] **Step 3: Put the shape in the sweep's corpus.** In `flip-boolean-literal.ts`, next to the issue #7 conformance case:

```ts
    {
      // GH-07 follow-up. `loop-skip` owns a while's condition and rewrites it to `false`; flipping
      // `while true` emitted the same `false` at the same span, the issue #7 collision one loop kind
      // over. The refusal also removes the `while false` flip, which never terminates.
      name: "REFUSES a while loop's condition, which loop-skip owns",
      sourceAL: `codeunit 51709 "C" { procedure P() var I: Integer; begin while true do begin I += 1; if I > 3 then exit; end; end; }`,
      expectedSpecs: [],
    },
```

Check `51709` is unused in `flip-boolean-literal.ts` first (`grep -n "5170" packages/builtin-tier1/src/flip-boolean-literal.ts`); pick the next free one if not.

- [ ] **Step 4: Run and confirm RED.** `bun test packages/builtin-tier1`. Expected failures, and only these: the named repro (it THROWS at `dedupeSpecs`), the corpus sweep (one collision, naming `lethal.flip-boolean-literal / REFUSES a while loop's condition, which loop-skip owns`), the conformance run of the new case, `REFUSES a \`while\` loop's whole condition`, `REFUSES \`while false\``, `REFUSES a parenthesised while condition too`, and Task 1b's `no operator emits an equivalent mutant on a parenthesised loop literal (GH-07 r1)`. The over-refusal test must PASS already (it pins behaviour that does not change). If it fails, stop: the expectation is wrong, not the code.

### Task 1b: The all-operator parenthesis test (in `operator-collisions.test.ts`, which has `allSpecsFor`)

Add inside the existing `describe`, next to the named issue #7 repro:

```ts
  it("no operator emits an equivalent mutant on a parenthesised loop literal (GH-07 r1)", () => {
    const emitted = (source: string) =>
      allSpecsFor(source).map((s) => `${s.operatorName}: ${s.before.text} -> ${s.after.text}`);
    // Already-mutated forms: NOTHING may be emitted on the condition by ANY operator.
    // Today loop-skip emits `(false) -> false` and loop-truncate `(true) -> true`: unkillable.
    expect(
      emitted(`codeunit 50000 R { procedure P() var I: Integer; begin while (false) do I += 1; end; }`)
        .filter((e) => e.includes("(false) ->")),
    ).toEqual([]);
    expect(
      emitted(`codeunit 50000 R { procedure P() var I: Integer; begin repeat I += 1; until (true); end; }`)
        .filter((e) => e.includes("(true) ->")),
    ).toEqual([]);
    // The useful counterparts stay, from exactly the owning operator.
    expect(
      emitted(`codeunit 50000 R { procedure P() begin while (true) do exit; end; }`)
        .filter((e) => e.includes("(true) ->")),
    ).toEqual(["lethal.loop-skip: (true) -> false"]);
    expect(
      emitted(`codeunit 50000 R { procedure P() var I: Integer; begin repeat I += 1; until (false); end; }`)
        .filter((e) => e.includes("(false) ->")),
    ).toEqual(["lethal.loop-truncate: (false) -> true"]);
  });
```

If the emitted `after.text` spells the replacement differently (for example keeps the parentheses), adjust the EXPECTED strings to what the operator really emits for the useful case, never the two `toEqual([])` assertions. This test must be RED before Task 2 (the two equivalent mutants exist today) and is added to Task 1 Step 4's expected-failure list.

### Task 2: The fix

**Files:**
- Modify: `packages/builtin-tier1/src/flip-boolean-literal.ts` (`flipped`, `isRepeatExitCondition` and its doc comment)

- [ ] **Step 1:** Rename `isRepeatExitCondition` to `isLoopCondition` and let it stop at either loop kind:

```ts
/** The loop kinds whose WHOLE condition this operator refuses: see `isLoopCondition`. */
const LOOP_STATEMENTS: ReadonlySet<string> = new Set([
  ALNodeKind.repeat_statement,
  ALNodeKind.while_statement,
]);

function isLoopCondition(node: ALSyntaxNode): boolean {
  let current = node;
  for (let p: ALSyntaxNode | null = node.parent; p !== null; p = p.parent) {
    if (LOOP_STATEMENTS.has(p.kind)) {
      const condition = p.childForFieldName("condition");
      return (
        condition !== null &&
        condition.startIndex === current.startIndex &&
        condition.endIndex === current.endIndex
      );
    }
    if (p.kind !== ALNodeKind.parenthesized_expression) return false;
    current = p;
  }
  return false;
}
```

and in `flipped`: `if (isLoopCondition(node)) return null;`.

A literal in a loop BODY is unaffected: its parent chain meets an assignment, call or statement before the loop, which is not a `parenthesized_expression`, so the walk returns `false`. The body-literal case in Task 1 Step 2's over-refusal test pins it.

- [ ] **Step 2: Correct the doc comment.** Keep the issue #7 paragraphs. Replace the `**\`repeat\` only, deliberately.**` paragraph with a statement of the rule as it now is: both loop kinds, the whole condition only; `until false` is `loop-truncate`'s and `while true` is `loop-skip`'s (same replacement, same span); `until true` and `while false` are refused because their flip only ends if the body exits (R164), and at `while false` that leaves the site with no mutant, which is dead code. Record the mistake plainly, one sentence: the first version reasoned that no loop operator claims a `while`, which `loop-skip` had already made false. Keep the nested-literal paragraph and add that the opposite polarity of a nested literal can hang and is filed (Task 5's id).

- [ ] **Step 3:** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`. Expected: all green, including every Task 1 test. `bunx biome check packages/builtin-tier1/src/flip-boolean-literal.ts packages/builtin-tier1/tests/flip-boolean-literal.test.ts packages/builtin-tier1/tests/operator-collisions.test.ts`.

- [ ] **Step 4: Commit** `fix(operators): flip-boolean-literal also cedes a while loop's condition (GH-07 follow-up)`. The body says: the `while true do` crash, the `while false` hang, that `loop-skip` keeps the site, that no gate fixture moves (Task 4's result), and the red-checks from Task 3.

### Task 3: Red-checks (use the `mutation-red-checker` subagent)

Each: apply the reversal, run `bun test packages/builtin-tier1`, record the named red lines, restore, record green.

- [ ] **RC1, the fix.** Make `LOOP_STATEMENTS` hold `repeat_statement` only. Expected red: all six Task 1 Step 4 failures. Then, still reverted, add `.skip` to the named repro in `operator-collisions.test.ts` and re-run: the corpus sweep must STILL be red, through the conformance case alone (Review Focus 5). Restore both.
- [ ] **RC2, over-refusal.** In `isLoopCondition`, delete the `parenthesized_expression` early return AND replace the span comparison with `return true`, so any literal with a loop ancestor is refused. (Deleting only the span check reddens nothing: the walk already returns `false` at the first non-parenthesis parent, so a nested literal never reaches it. Say so in the submit note.) Expected red: `"does NOT over-refuse a boolean nested inside a compound while condition"`, the existing `repeat` guard `"does NOT over-refuse a boolean nested inside a compound exit condition"`, and the R196 conformance case `"tags an in-loop boolean guard that advances the condition (R196), ..."`. Restore.
- [ ] **RC3, cession not silence.** In `loop-skip.ts`'s `skipCondition`, also return `null` when the condition text is `true`. Expected red: the named repro's `toEqual(["lethal.loop-skip"])`, and `loop-skip`'s own conformance stays green (it has no `while true` case), which is why the named assertion is the one that matters. Restore.
- [ ] **RC5, parentheses.** Restore the raw-text comparison (`cond.text.trim().toLowerCase() === ...`) in `loop-skip.ts` only, then in `loop-truncate.ts` only. Expected red each time: `"no operator emits an equivalent mutant on a parenthesised loop literal (GH-07 r1)"`. Restore.
- [ ] **RC4, the existing issue #7 guard still bites.** Remove `ALNodeKind.repeat_statement` from `LOOP_STATEMENTS`. Expected red: `"plans \`repeat ... until false;\` without a collision (issue #7)"`, the sweep, and the `repeat` refusal tests. Restore.

### Task 4: Offline per-mutant census of every gate fixture (not committed)

The pre-commitment in "Gate impact" is checked here, per mutant, not by count.

- [ ] **Step 1:** Before Task 2 (or with Task 2 stashed: `git stash push packages/builtin-tier1/src/flip-boolean-literal.ts`), write a TEMPORARY test file `packages/builtin-tier1/tests/zz-census.test.ts` that, for each project directory under `fixtures/` and `examples/`, parses every `.al` file with `parseAL`, builds ONE `buildSemanticContext` over all of that project's files, walks every node with every `tier1Operators` entry (the same walk as `allSpecsFor` in `operator-collisions.test.ts`), runs `dedupeSpecs`, and writes one sorted line per surviving spec, `<project>\t<file>\t<start>-<end>\t<operatorName>\t<before.text> -> <after.text>`, to the session scratchpad as `census-before.tsv`. A `dedupeSpecs` throw is recorded as a line, not swallowed.
- [ ] **Step 2:** Apply Task 2, re-run into `census-after.tsv`, `diff` the two. Expected: EMPTY. Delete `zz-census.test.ts`; `git status --short` must show it gone.
- [ ] **Step 3:** Put the line count and "diff empty" in the commit body and the submit note. A non-empty diff is a STOP.

### Task 5: File the nested-literal residual, and fix the user-facing prose

**Files:**
- Create: `docs/roadmap/R<next>.md` (re-check with `ls docs/roadmap/` immediately before writing; R234 is TAKEN since 2026-09-25, so expect R235 or later)
- Modify: `docs/using-lethal-from-an-agent.md` (section "Which mutants can fail to terminate")
- Regenerate: `ROADMAP.md` via `bun scripts/roadmap-index.ts`

- [ ] **Step 1: The roadmap item.** Proposed text:

```markdown
---
id: "R<next>"
title: "`flip-boolean-literal` can still make a loop that never exits: a literal NESTED in its condition, under a unary `not`, or governing its only exit from the body"
section: "product-gaps"
status: "open"
order: 946
---

The GH-07 fixes refuse a boolean literal that is a `repeat` or `while` loop's WHOLE condition
(`flip-boolean-literal`'s `isLoopCondition`). A literal nested in a compound condition stays claimed
on purpose, because one polarity terminates: `until Done or false` flips to `until Done or true`.

The other polarity does not. `until Done and true` flips to `until Done and false`, and
`while Go or false do` flips to `while Go or true do`. Neither condition can ever end the loop, so
only the body can, and the mutant carries no `hangCapable` tag: `hangCapableForMutatedNode` tags a
literal only on an assignment's value side. Probed 2026-09-25 on HEAD `5420201` with every Tier-1
operator; recorded in `docs/superpowers/plans/2026-09-25-GH-07-repeat-until-false-collision.md`.

Two more shapes behave the same way. A unary `not` around the literal: `while not true` flips to
`while not false`, and `until not false` to `until not true`, and neither can end the loop. And a
literal in the loop BODY that governs the only exit: `while true do if true then exit;` flips the
guard to `if false`, so the body never exits. The whole-condition refusal does not cover these,
because `isLoopCondition` walks through parentheses only.

**Sites: zero measured for the CONDITION shapes** (nested and `not`): `a407344` counted 0
literal-in-condition shapes across 725 `repeat` loops on both reference corpora, and no `.al` under
`fixtures/` or `examples/` has one. **The body-guard shape was not counted**, so it has no site
figure; the next corpus census should count it. That is why this
is filed and not fixed: the rule would follow `and`/`or` chains and unary `not` (in an `until`, refuse a flip to
`false` reachable only through `and`; in a `while`, a flip to `true` reachable only through `or`),
and there is no site to measure it on. Close it with a ruling if the next corpus census still finds
none.
```

- [ ] **Step 2: The agent guide.** Under "Fixed, and listed so an older report reads correctly", add one bullet: `flip-boolean-literal` at a loop's whole-condition literal. `until true` and `while false` flipped to loops whose condition never ends; both are refused (issue #7 and its follow-up). `until false` and `while true` are ceded to `loop-truncate` and `loop-skip`, which emit the same text. Under "Remaining", add one bullet naming all three shapes (nested, unary `not`, a body literal guarding the only exit) and the new roadmap id, with "zero sites measured for the condition shapes; the body-guard shape is not yet counted".
- [ ] **Step 3:** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit** `roadmap: file R<next>, a boolean literal inside or governing a loop condition can still hang` (the guide edit rides in the same commit).

## Out of scope, on purpose

- **Changing `dedupeSpecs`.** See Decision 3.
- **Fixing the nested-literal residual.** Filed as the new roadmap item, zero sites.
- **Resume across this change.** A ceded twin shifts later twins' identity ordinals (R234, filed 2026-09-25); not fixed here, and the submit note must say so.
- **A sweep over real corpora or fixtures inside the unit suite.** The conformance corpus plus named repros is the committed guard; Task 4's census is a one-off check, not a new test.
- **Tagging instead of refusing** (`hangCapable` on the `until true` / `while false` flips). `a407344` chose refusal for `until true`; this plan stays consistent with it.
- **A CHANGELOG entry.** `[Unreleased]` is empty despite many commits since alpha.3, so entries look like they are written at release time. Asked below.
- **Closing issue #7.** The owner closes it.

## Submit note must say

- That issue #7's reported bug was already fixed in `a407344` with the repro as a named test, and this change is the `while` twin that fix missed, with the four-row probe table.
- That the old test `"still claims a \`while\` condition, whose flip terminates"` was DELETED on purpose, and why: it pinned the collision as correct, because it ran one operator alone.
- Every red-check (RC1 to RC4) with its red and restored-green lines, including RC1's second run with the named test skipped.
- Task 4's census: both line counts and that the diff was empty. It is a Tier-1 SPEC INVENTORY, not a gate oracle (it skips Tier 2, validation and the instrumentability filter, and records no tags). The orchestrator runs `itest:bcdev`, `itest:hang` and `itest:alrunner` on the merged tree as the gate evidence; the orchestrator verified by grep that no `.al` under `fixtures/` or `examples/` has a literal `while`/`until` condition.
- That `dedup.ts` is unchanged, and whether `OPERATOR_VERSION` moved (per the owner's ruling).

## Orchestrator rulings (2026-09-25)

1. **`while false do` gets no mutant at all.** Accepted: the body is dead code, and the only mutant (`while true`) can hang, which R164 keeps out of scored gates.
2. **The nested-literal residual (new item, next free id; R234 is taken by the resume-ordinal item) is filed and deferred.** No site exists on any fixture or example. The lane files it (re-check the next free id right before writing; cite names, not lines).
3. **`flip-boolean-literal`'s `OPERATOR_VERSION` stays 1.0.0**, as earlier cessions of this kind did. Identity keys use only the major.
4. **No CHANGELOG entry now**; the release pass writes it.
5. **The close comment on issue #7** names `a407344` for the reported `repeat ... until false` and this task's commit for `while true do`, so the reporter sees why a fixed issue got a second commit.
