# GH-04: `DeleteAll` / `ModifyAll` run-trigger flag swap, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, by measurement, whether `lethal.swap-modify-flag` should also claim `Rec.DeleteAll(true)` and `Rec.ModifyAll(Field, Value, true)`, and, only if the orchestrator admits it, extend the operator with TDD.

**Architecture:** The operator lives in `packages/builtin-tier2/src/swap-modify-flag.ts`. It claims a call when `claimedRunTriggerMethod` (a walk over `RUN_TRIGGER_METHODS` through `claimsRecordMethod` in `packages/engine/src/semantic/receiver.ts`) matches and the run-trigger argument is the literal `true`. Today that argument is always the SOLE argument (`soleArgument`). `ModifyAll`'s flag is the THIRD of exactly three arguments, so the extension replaces "the sole argument" with "the flag argument for this method". Tier-1 `lethal.flip-boolean-literal` cedes the run-trigger `true` to this operator through its own list, `CEDED_TO_MODIFY_FLAG`, which must move in the same change and must become position-aware for `ModifyAll`.

**Tech Stack:** Bun, TypeScript, tree-sitter-al (vendored), `bun:test`.

**Spec:** GitHub issue #4 (`H:/lethal-coord/tasks/GH-04/task.md`). Rulings it leans on: `docs/roadmap/R013.md` (admission bar, amended 2026-08-31), `docs/roadmap/R138.md` (platform-kill tag for `Insert`, and the "no mechanism for `Delete`/`Modify`" ruling), `docs/roadmap/R143.md` (`insertSkipCanRaise`), `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md` §2.1 (version-bump rule).

## Global Constraints

- Plain English, no em dashes anywhere (code comments included).
- No `!` non-null assertions; build optional props with `...(v !== undefined ? { k: v } : {})`.
- Order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Never `bun test` with a stale `dist`.
- Run biome only on touched files: `bunx biome check <paths>`.
- `operatorName` is part of the baseline identity key (`packages/runner/src/selection.ts`); the version bump is MINOR so no existing mutant re-keys.
- A differing live verdict is a BLOCK. Baselines are re-recorded by the owner, never by this lane.
- Red-check every fix: revert it, show the named test goes RED, restore, show GREEN. Report both.

## Review Focus

1. `ModifyAll(Flag, true, true)`: a Boolean VALUE argument beside the flag. Expected: only the third argument flips; the value `true` stays and stays mutable by `flip-boolean-literal`. (Measured: 24 of 74 `ModifyAll` calls on the reference corpus pass a Boolean literal as the value.) Pinned in Task 1 and Task 2.
2. `ModifyAll(Field, true)`: two arguments, a `true` VALUE and no flag. Expected: `swap-modify-flag` refuses AND `flip-boolean-literal` keeps the `true` (no orphan). Pinned in Task 1 and Task 2.
3. Argument-less `DeleteAll()` and two-argument `ModifyAll(F, V)`: the R165 FORWARD direction must NOT start claiming them by accident. Expected: no mutant. `resolveForcedTrigger`'s `TRIGGER_OF` has no `deleteall`/`modifyall` key, and that absence is now load-bearing. Pinned in Task 1.
4. A project that declares its own `DeleteAll`/`ModifyAll` procedure on the table. Expected: refused, same as `Delete` (rule 3 in `claimsRecordMethod`). Pinned in Task 1.
5. A comment inside the argument list, `ModifyAll(F, V, true /* why */)`. Expected: claimed, comment kept. Pinned in Task 1.

---

## Task 0: Measure first (DONE 2026-09-27, result: STOP)

**Why not `scripts/census-node-kind-coverage.ts`:** it counts raw node KINDS (`call_expression`, `boolean`), so it cannot tell a `DeleteAll(true)` from any other call with a `true` in it. The question is method-grain, which is what `scripts/r165-probe/census.ts` answered for R165. A probe of the same shape was written for this task (verbatim below) and run from the repo root.

**Reference corpus identity (R013 §3, R187):** `U:/Git/do-rel2/Cloud`, 417 `.al` files, `scripts/corpus-fingerprint.ts` prints sha256 `9a8e8831449208cc48bdbc8f04ae1db42d6050ca67bd7487350f48cc6b933962`. Matches the floor's corpus, so the numbers below are comparable to the floor.

**Result on the reference corpus:**

| Measure | `DeleteAll` | `ModifyAll` |
|---|---|---|
| calls whose receiver is a proven record (`claimsRecordMethod`) | 68 | 74 |
| SKIP sites: literal `true` in the flag position | **6** | **0** |
| of those, `flip-boolean-literal` ALREADY emits the identical edit | **6** | n/a |
| of those, receiver table unresolved or base-app | 0 | n/a |
| of those, project table declares `OnDelete` | 1 | n/a |
| of those, project table has no `OnDelete` (near-equivalent mutant) | 5 | n/a |
| argument-less / two-argument calls (flag defaults to `false`) | 62 | 74 (all 74 are two-argument) |
| FORWARD candidates (R165 scoping: project table declares the trigger) | 6 | 0 |
| `ModifyAll` calls whose VALUE argument is a Boolean literal | n/a | 24 |

Sanity check against known figures: the same probe reports 13 `Modify(true)` skip sites, which is R013's recorded calibrator "`swap-modify-flag` = 13". It also reports `flip-boolean-literal` emitting the edit at 0 of the 13 `Delete(true)` and 13 `Modify(true)` sites, which is the existing cession working.

For context only (R013 §3: a number from another corpus is NOT comparable to the floor): `U:/Git/DC/Cloud` (475 files) has 24 `DeleteAll(true)` and 2 `ModifyAll(..., true)` skip sites, all 26 already emitted by `flip-boolean-literal`.

**Fixture census (every non-test target under `fixtures/`):** zero `DeleteAll(true)` and zero `ModifyAll(..., true)` sites. The only `DeleteAll` calls in any mutated target are two argument-less ones in `fixtures/sandbox-harden-answers`, which neither direction claims. The `DeleteAll(false)` lines in `fixtures/sandbox-data-tests` are in a TEST app, which is never mutated.

**Verdict against R013's amended bar:**

- **Ground 1 (coverage), floor >= 36 marginal SITES: REFUSED, twice over.** The site count is 6 (6 + 0), and the MARGINAL count on the canonical-minimal-edit grain is **0**: `flip-boolean-literal` already rewrites every one of those six `true` literals to `false`, which is byte-for-byte the same edit. Adding the forward direction would not rescue it: 6 more sites, 12 total.
- **Ground 2 (attribution): arguable, and not this lane's call.** The run-trigger flag of `DeleteAll` is a named BC operation with its own semantics (the same class as `Delete`'s, which the operator already owns), so the partition is platform-semantic rather than arbitrary. Admitting on this ground would move 6 mutants on the reference corpus from `flip-boolean-literal` to `swap-modify-flag` and add nothing new. R013 says such an admission "CHANGES gate identities and is paid deliberately"; on the fixtures the cost is zero (no sites), on real-project campaign baselines it re-keys those 6.
- **Ground 3 (hazard removal): does not apply.**

**STOP.** Report to the orchestrator: under the bar on ground 1 with a marginal of zero. Tasks 1 to 4 below run ONLY if the orchestrator admits on ground 2. Task S runs on the stop path. Task C is recommended either way.

The probe (kept in the session scratchpad, not committed; commit it as `scripts/gh04-probe/census.ts` only if the orchestrator wants the measurement reproducible from the repo):

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { claimsRecordMethod, resolveReceiverTable } from "U:/Git/LethAL/packages/engine/src/semantic/receiver";
import { exactArguments, countArguments } from "U:/Git/LethAL/packages/builtin-tier2/src/mutate-helpers";
import { resolveForcedTrigger } from "U:/Git/LethAL/packages/builtin-tier2/src/forced-trigger-raise";
import { flipBooleanLiteral } from "U:/Git/LethAL/packages/builtin-tier1/src/flip-boolean-literal";
import { initParser, parseAL } from "U:/Git/LethAL/packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "U:/Git/LethAL/packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "U:/Git/LethAL/packages/engine/src/semantic/context";
import type { SourceFile } from "U:/Git/LethAL/packages/engine/src/semantic/symbol-table";

const [projectDir] = process.argv.slice(2);
await initParser();
const rel = (await readdir(projectDir, { recursive: true })).filter((f) => f.toLowerCase().endsWith(".al") && !f.includes(".dependencies"));
const files: SourceFile[] = [];
for (const r of rel) files.push({ path: r, root: wrapRoot(parseAL(await readFile(join(projectDir, r), "utf8"))) });
const ctx = buildSemanticContext(files);
const c: Record<string, number> = {};
const bump = (k: string) => { c[k] = (c[k] ?? 0) + 1; };
const WRITE = /\b(delete|deleteall|insert|modify|modifyall)\s*\(/i;
function nameMatch(node: ALSyntaxNode, m: string): boolean {
  const f = node.childForFieldName("function");
  if (f === null) return false;
  const t = f.rawKind === "member_expression" ? f.childForFieldName("property")?.text ?? f.namedChildren.at(-1)?.text : f.text;
  return t !== undefined && t.toLowerCase() === m.toLowerCase();
}
function isTrue(n: ALSyntaxNode | undefined): boolean { return n !== undefined && n.rawKind === "boolean" && n.text.toLowerCase() === "true"; }
function isBool(n: ALSyntaxNode | undefined): boolean { return n !== undefined && n.rawKind === "boolean"; }
const flipTargets = (lit: ALSyntaxNode) => { try { return flipBooleanLiteral.targets(lit, ctx as never); } catch { return false; } };
function walk(node: ALSyntaxNode, exec: boolean): void {
  const e = exec || node.rawKind === "procedure" || node.rawKind === "trigger_declaration";
  if (e && node.rawKind === "call_expression") {
    for (const m of ["DeleteAll", "ModifyAll", "Delete", "Modify"]) {
      if (!nameMatch(node, m)) continue;
      bump(`${m}.nameMatch`);
      const claimed = claimsRecordMethod(node, ctx, m);
      const n = countArguments(node);
      const pos = m === "ModifyAll" ? 2 : 0;
      const want = m === "ModifyAll" ? 3 : 1;
      const args = exactArguments(node, want);
      const flag = args?.[pos];
      if (!claimed) { if (isTrue(flag)) bump(`${m}.unclaimed.literalTrue`); continue; }
      bump(`${m}.claimed`);
      bump(`${m}.claimed.args${n}`);
      if (m === "ModifyAll") {
        const two = exactArguments(node, 2) ?? exactArguments(node, 3);
        if (isBool(two?.[1])) bump(`ModifyAll.claimed.valueArgIsBooleanLiteral`);
      }
      if (isTrue(flag) && flag !== undefined) {
        bump(`${m}.SKIP.site(literalTrue)`);
        if (flipTargets(flag)) bump(`${m}.SKIP.flipBooleanLiteralAlreadyEmitsSameEdit`);
        const table = resolveReceiverTable(node, ctx);
        if (table === null) bump(`${m}.SKIP.tableUnresolvedOrBaseApp`);
        const trig = resolveForcedTrigger(node, ctx, m === "DeleteAll" ? "Delete" : m === "ModifyAll" ? "Modify" : m);
        if (trig !== null) {
          bump(`${m}.SKIP.projectTableDeclaresTrigger`);
          if (m.startsWith("Delete") && WRITE.test(trig.text.replace(/^[^\n]*\n/, ""))) bump(`${m}.SKIP.triggerContainsRecordWrite(cascadeCandidate)`);
        } else if (table !== null) bump(`${m}.SKIP.projectTableNoTrigger`);
      }
      if (isBool(flag) && !isTrue(flag)) bump(`${m}.literalFalse`);
      if (flag !== undefined && !isBool(flag)) bump(`${m}.flagIsExpression`);
      if ((m === "DeleteAll" && n === 0) || (m === "ModifyAll" && n === 2)) { bump(`${m}.noFlag(default false)`); if (resolveForcedTrigger(node, ctx, m === "DeleteAll" ? "Delete" : "Modify") !== null) bump(`${m}.FORWARD.projectTableDeclaresTrigger`); }
    }
  }
  for (const ch of node.namedChildren) walk(ch, e);
}
for (const f of files) walk(f.root, false);
console.log(`files ${files.length}`);
for (const k of Object.keys(c).sort()) console.log(`${k}\t${c[k]}`);
```

Run: `cd U:/Git/LethAL && bun <path>/gh04-census.ts U:/Git/do-rel2/Cloud`. Only counts leave the process; no source text is printed.

---

## The kill-mechanism ruling (item 2 of the brief)

**The question.** Skipping `OnDelete` can leave child rows behind (the trigger usually deletes a document's lines). A later statement that re-creates a child row under the same key then raises a duplicate primary key, which the unmutated program never does. That is a platform kill, the same class as `Insert(false)`'s blank-key duplicate.

**What that does to R138.** R138 ruled that `Delete` needs no mechanism because skipping `OnDelete` "writes LESS than the unmutated program, never more, and the row is still located by the same key, so there is no error the mutation can ADD." The cascade case is a counterexample to the reasoning: writing less LEAVES rows the unmutated program removed, and a later insert collides with them. So the issue's point is not about `DeleteAll` alone; it re-opens the ruling for the `Delete(true)` mutants the operator ALREADY ships.

**Proposed ruling for this task:**

1. **The tag follows the TRIGGER, not the method.** `Delete(false)` and `DeleteAll(false)` skip the same `OnDelete` on the same table. Whatever the screen says about one it must say about the other, or a reader sees two identical platform events screened differently. So if `DeleteAll` ships, it declares exactly what `Delete` declares, which today is NOTHING. `ModifyAll` follows `Modify` (nothing) for the same reason.
2. **The cascade mechanism is real, unmeasured, and gets its own row** (Task C), covering `Delete` and `DeleteAll` together: a candidate value such as `run-trigger-skipped-delete`, a REFUSAL detector shaped like `insertSkipCanRaise` (keep the tag unless the receiver's `OnDelete` provably contains no record write; keep it for an unresolvable receiver, R143's direction for a screen), and a fixture arm that measures the kill live before the ruling changes. Rough size on the reference corpus, from the probe's crude text match: 1 of the 6 `DeleteAll(true)` sites and 2 of the 13 `Delete(true)` sites target a project table whose `OnDelete` contains a record write. Base-app receivers (none among these six) would keep the tag under that detector.
3. **The verdict never moves** (R72): a mechanism is a diagnosis, not a re-score.

**Open as a question, not ruled:** whether `DeleteAll(false)`'s BULK path differs from per-row `Delete(false)` in a way that adds its own platform error (for example with `OnBeforeDeleteEvent`/`OnAfterDeleteEvent` subscribers present). Unmeasured; answer with `/al-probe` before any claim is written into code.

---

## Task S (stop path): record the refusal

Runs if the orchestrator accepts the STOP.

**Files:**
- Create: `docs/roadmap/R<next>.md` (re-check the next free id with `ls docs/roadmap/` immediately before writing; R279 was the last at plan time)
- Modify: `ROADMAP.md` (generated only)

- [ ] **Step 1:** Write the row with `status: "closed 2026-09-27: refused on R013 ground 1: 6 sites (DeleteAll 6, ModifyAll 0) on do-rel2/Cloud sha256 9a8e8831449208cc, marginal 0 because flip-boolean-literal already emits all six edits"`, `section: "correctness-risks"` or whichever section R013 refusals use (copy from `_template.md`). Body: the Task 0 table, the corpus hash, the fixture census, the ground-2 argument left open, and the pointer to Task C.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts`. Expected: PASS.
- [ ] **Step 3:** Commit the roadmap files alone: `git add docs/roadmap/R<next>.md ROADMAP.md && git commit -m "roadmap: file R<next>, GH-04 refused on R013 ground 1 (6 sites, marginal 0)"`. Issue #4 is closed with this commit.

## Task C (recommended either way): file the cascade mechanism

**Files:** Create `docs/roadmap/R<next+1>.md` (re-check the id), regenerate `ROADMAP.md`.

- [ ] **Step 1:** Title: "Skipping OnDelete can ADD a duplicate-key error through leftover child rows; R138's no-mechanism ruling for Delete does not hold". Body: the counterexample above, the rough corpus size (1 of 6 `DeleteAll(true)`, 2 of 13 `Delete(true)`), the proposed detector and fixture arm, and that closing it needs a pre-commitment spec before any live run because it changes `platformArtifactKills` on `itest:tables` if the fixture gains an arm. `status: "open"`, evidence pointer to this plan's Task 0.
- [ ] **Step 2:** Regenerate and test the index as in Task S Step 2. Commit alone.

---

## Tasks 1 to 4: ONLY if the orchestrator admits on ground 2

### Task 1: operator claims `DeleteAll(true)` and `ModifyAll(F, V, true)`, skip direction only

**Files:**
- Modify: `packages/builtin-tier2/src/swap-modify-flag.ts` (`RUN_TRIGGER_METHODS` line 25, `OPERATOR_VERSION` line 69, `targets()`/`generate()` lines 184-225, `booleanTrueArgument` lines 394-399, conformance cases lines 227-285, the header comment)
- Test: `packages/builtin-tier2/tests/swap-modify-flag.test.ts`

**Interfaces:**
- Produces: `RUN_TRIGGER_METHODS = ["Modify", "Insert", "Delete", "DeleteAll", "ModifyAll"]`; `runTriggerFlagArgument(node: ALSyntaxNode, method: string): ALSyntaxNode | null` (file-local), replacing `booleanTrueArgument(node)`.
- Consumes: `exactArguments`, `soleArgument` from `./mutate-helpers`; `claimsRecordMethod` from `@lethal/engine`.

- [ ] **Step 1: Write the failing tests.** Append to `swap-modify-flag.test.ts`, reusing its `specsFor` and `specsForProject` helpers:

```ts
describe("swap-modify-flag extension to DeleteAll/ModifyAll (GH-04)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("claims DeleteAll(true) on a proven record receiver", () => {
    const src = `codeunit 50180 "T" { procedure P() var Rec: Record Customer; begin Rec.DeleteAll(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Rec.DeleteAll(true)"]);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.DeleteAll(false)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });

  it("claims ModifyAll's THIRD argument, not its first or second", () => {
    const src = `codeunit 50181 "T" { procedure P() var Rec: Record Customer; begin Rec.ModifyAll(Name, 'x', true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.ModifyAll(Name, 'x', false)"]);
    expect(specs[0]?.platformKillMechanism).toBeUndefined();
  });

  // The position test that matters: a Boolean VALUE beside the flag. Reading index 1 instead of 2
  // would produce `ModifyAll(Blocked, false, true)` here.
  it("flips only the flag when the value argument is also the literal true", () => {
    const src = `codeunit 50182 "T" { procedure P() var Rec: Record Customer; begin Rec.ModifyAll(Blocked, true, true); end; }`;
    expect(specsFor(src).map((s) => s.after.text)).toEqual(["Rec.ModifyAll(Blocked, true, false)"]);
  });

  it("REFUSES ModifyAll(F, true): two arguments, the true is the value and there is no flag", () => {
    const src = `codeunit 50183 "T" { procedure P() var Rec: Record Customer; begin Rec.ModifyAll(Blocked, true); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES DeleteAll(false), ModifyAll(F, V, false) and a non-literal flag", () => {
    const src = `codeunit 50184 "T" { procedure P() var Rec: Record Customer; B: Boolean; begin Rec.DeleteAll(false); Rec.ModifyAll(Name, 'x', false); Rec.DeleteAll(B); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  // R165's forward direction must not reach these two by accident: `TRIGGER_OF` in
  // forced-trigger-raise.ts has no deleteall/modifyall key, and that absence is what this pins.
  it("emits nothing for argument-less DeleteAll() or two-argument ModifyAll(F, V), even with the trigger declared", () => {
    const src = `table 50185 "T5" { fields { field(1; "No."; Code[20]) { } field(2; Name; Text[30]) { } } trigger OnDelete() begin Error('x'); end; trigger OnModify() begin Error('y'); end; procedure P() begin DeleteAll(); ModifyAll(Name, 'x'); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("claims DeleteAll(true) as an un-braced then-branch, hinting expression-position", () => {
    const src = `codeunit 50186 "T" { procedure P() var Rec: Record Customer; begin if Rec.FindFirst() then Rec.DeleteAll(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.after.text)).toEqual(["Rec.DeleteAll(false)"]);
    expect(specs[0]?.parentContext).toBe("expression-position");
  });

  it("matches case-insensitively and keeps a comment inside ModifyAll's arguments", () => {
    const src = `codeunit 50187 "T" { procedure P() var Rec: Record Customer; begin Rec.DELETEALL(True); Rec.ModifyAll(Name, 'x', true /* run it */); end; }`;
    expect(specsFor(src).map((s) => s.after.text)).toEqual([
      "Rec.DELETEALL(false)",
      "Rec.ModifyAll(Name, 'x', false /* run it */)",
    ]);
  });

  it("REFUSES DeleteAll(true) when the project declares its own DeleteAll on the table", () => {
    const table = `table 50188 "Own DeleteAll" { fields { field(1; "No."; Code[20]) { } } procedure DeleteAll(RunTrigger: Boolean) begin end; }`;
    const caller = `codeunit 50189 "C" { procedure P() var Other: Record "Own DeleteAll"; begin Other.DeleteAll(true); end; }`;
    expect(specsForProject([caller, table])).toEqual([]);
  });
});
```

Check `specsForProject`'s real signature in the test file before using it (it is used at line 302 with a `caller(...)` helper that returns source text); adapt the call, not the assertion.

- [ ] **Step 2: Run, expect RED.** `bun test packages/builtin-tier2/tests/swap-modify-flag.test.ts`. Expected: the claim tests fail with `[]` where one spec was expected; the refusal tests pass already (that is fine, they pin behaviour the change must keep).

- [ ] **Step 3: Implement.** In `swap-modify-flag.ts`:

```ts
const RUN_TRIGGER_METHODS = ["Modify", "Insert", "Delete", "DeleteAll", "ModifyAll"] as const;

/**
 * GH-04. Where each method's run-trigger flag sits, as (exact argument count, flag index).
 * `ModifyAll(Field, Value, RunTrigger)` is the one whose flag is not its sole argument. An
 * exact count, never an index alone, for the reason `exactArguments` documents: an index reads
 * whatever is first, trivia included, and refuses nothing.
 */
const FLAG_POSITION: Readonly<Record<string, readonly [count: number, index: number]>> = {
  modifyall: [3, 2],
};
const SOLE_FLAG: readonly [number, number] = [1, 0];

function runTriggerFlagArgument(node: ALSyntaxNode, method: string): ALSyntaxNode | null {
  const [count, index] = FLAG_POSITION[method.toLowerCase()] ?? SOLE_FLAG;
  const flag = exactArguments(node, count)?.[index];
  if (flag === undefined || flag.kind !== ALNodeKind.boolean_literal) return null;
  return flag.text.toLowerCase() === TRUE_LITERAL ? flag : null;
}
```

Then in `targets()` replace `booleanTrueArgument(node) !== null` with `runTriggerFlagArgument(node, method) !== null`. In `generate()`, compute `const method = claimedRunTriggerMethod(node, ctx); if (method === null) return [];` FIRST, then `const arg = runTriggerFlagArgument(node, method); if (arg === null) return generateForced(node, ctx);`, and drop the second `claimedRunTriggerMethod` call (keep the `insertSkipCanRaise` tag expression unchanged). Delete `booleanTrueArgument` and move its doc comment's still-true parts onto `runTriggerFlagArgument`. Drop `soleArgument` from the import if unused. Leave `forced-trigger-raise.ts`'s `TRIGGER_OF` untouched.

- [ ] **Step 4: Run, expect GREEN.** Same command. Expected: all pass, including every pre-existing test in the file (the R138 "tags exactly the Insert mutant" and the R136 cases must not move).

- [ ] **Step 5: Red-checks** (use the `mutation-red-checker` subagent; record each RED and the restored GREEN):
  - remove `"DeleteAll"` from `RUN_TRIGGER_METHODS`: "claims DeleteAll(true)..." goes RED.
  - remove the `modifyall` entry from `FLAG_POSITION`: "claims ModifyAll's THIRD argument..." goes RED.
  - change `[3, 2]` to `[3, 1]`: "flips only the flag when the value argument is also the literal true" goes RED. (If it stays green, the test is passing for the wrong reason: stop and fix the test.)
  - add `deleteall: "OnDelete"` to `TRIGGER_OF` in `forced-trigger-raise.ts`: "emits nothing for argument-less DeleteAll()..." goes RED.

- [ ] **Step 6: Conformance arms.** Append to `conformanceTests`:

```ts
    {
      name: "rewrites DeleteAll(true) to DeleteAll(false) in statement position",
      sourceAL: `codeunit 50145 "C" { procedure P() var Cust: Record Customer; begin Cust.DeleteAll(true); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Cust.DeleteAll(true)", afterText: "Cust.DeleteAll(false)" },
      ],
    },
    {
      name: "rewrites ModifyAll's third argument only, leaving a Boolean value alone",
      sourceAL: `codeunit 50146 "C" { procedure P() var Cust: Record Customer; begin Cust.ModifyAll(Blocked, true, true); end; }`,
      expectedSpecs: [
        { parentContext: "statement-position", beforeText: "Cust.ModifyAll(Blocked, true, true)", afterText: "Cust.ModifyAll(Blocked, true, false)" },
      ],
    },
```

Run `bun test packages/builtin-tier2` (the conformance runner covers every registered operator). Expected: PASS. Note: `Blocked` on base-app `Customer` is an Enum in real BC; the conformance harness parses, it does not compile, so the snippet is fine. Do not copy it into a fixture.

- [ ] **Step 7: Version bump 1.2.0 to 1.3.0 (MINOR).** Set `OPERATOR_VERSION = "1.3.0"` and add a comment beside R165's: "GH-04 bumped this to 1.3.0: MINOR. The operator GAINED two methods and changed nothing about the mutants it already emitted." Update the test at `swap-modify-flag.test.ts:247-262` ("reports version 1.2.0 ...") to `1.3.0`. `packages/runner/tests/operator-version-invariant.test.ts` must stay green unmodified.

- [ ] **Step 8: Header comment.** Update the doc block (lines 19-25, 71-83, 112-127, 152-155): three methods become five; state the `ModifyAll` position rule; state that `DeleteAll`/`ModifyAll` declare no mechanism because the tag follows the trigger (`OnDelete`/`OnModify`), pointing at the Task C row; state that the forward direction does not cover them because `TRIGGER_OF` has no key for them, deliberately.

- [ ] **Step 9:** `bun run typecheck && rm -rf packages/*/dist && bun test packages/builtin-tier2`, then `bunx biome check packages/builtin-tier2/src/swap-modify-flag.ts packages/builtin-tier2/tests/swap-modify-flag.test.ts`. Expected: clean.

- [ ] **Step 10: Commit.** `git add packages/builtin-tier2/src/swap-modify-flag.ts packages/builtin-tier2/tests/swap-modify-flag.test.ts && git commit -m "feat(tier2): swap-modify-flag 1.3.0 claims DeleteAll(true) and ModifyAll(F, V, true) (GH-04)"`

### Task 2: `flip-boolean-literal` cedes exactly those flags, position-aware

Without this, all six reference-corpus sites carry TWO mutants with the identical edit under two names. With a naive list entry, the VALUE `true` of `ModifyAll(Blocked, true)` and `ModifyAll(Blocked, true, true)` is ceded to an operator that never claims it: an orphan, R171's seam bug.

**Files:**
- Modify: `packages/builtin-tier1/src/flip-boolean-literal.ts` (`CEDED_TO_MODIFY_FLAG` line 33, `isCededRunTriggerFlag` lines 334-347)
- Test: `packages/builtin-tier1/tests/flip-boolean-literal.test.ts`

- [ ] **Step 1: Failing tests.** Add (reuse that file's own spec-collecting helper; read its top first for the name):

```ts
describe("cession to swap-modify-flag, DeleteAll/ModifyAll (GH-04)", () => {
  it("cedes DeleteAll(true)'s flag", () => {
    const src = `codeunit 50190 "T" { procedure P() var Rec: Record Customer; begin Rec.DeleteAll(true); end; }`;
    expect(afterTexts(src)).toEqual([]);
  });
  it("cedes ModifyAll's third-argument true but keeps a true VALUE", () => {
    const src = `codeunit 50191 "T" { procedure P() var Rec: Record Customer; begin Rec.ModifyAll(Blocked, true, true); end; }`;
    expect(afterTexts(src)).toEqual(["false"]); // the value literal only
  });
  it("keeps the true VALUE of a two-argument ModifyAll, which nobody else claims", () => {
    const src = `codeunit 50192 "T" { procedure P() var Rec: Record Customer; begin Rec.ModifyAll(Blocked, true); end; }`;
    expect(afterTexts(src)).toEqual(["false"]);
  });
});
```

`afterTexts` stands for the file's existing helper mapped to `s.after.text`; if the helper returns specs, write `.map((s) => s.after.text)`. For the three-argument case, also assert the surviving spec's `before.startIndex` is the SECOND argument's, so a cession of the wrong literal cannot pass.

- [ ] **Step 2: RED.** `bun test packages/builtin-tier1/tests/flip-boolean-literal.test.ts`. Expected: the first two fail (flip emits for both `true`s today); the third passes (pins the no-orphan side).

- [ ] **Step 3: Implement.**

```ts
const CEDED_TO_MODIFY_FLAG = ["Modify", "Insert", "Delete", "DeleteAll"] as const;
```

and in `isCededRunTriggerFlag`, after the `"true"` check:

```ts
  // GH-04: ModifyAll's flag is its THIRD of exactly three arguments; any other true in the call is
  // a VALUE that swap-modify-flag never claims, so ceding it would orphan it.
  if (claimsRecordMethod(call, ctx, "ModifyAll")) {
    const argsOnly = args.namedChildren.filter((n) => n.rawKind !== "comment" && n.rawKind !== "multiline_comment");
    return argsOnly.length === 3 && argsOnly[2]?.startIndex === node.startIndex;
  }
```

Update the list's comment: it still has to track `RUN_TRIGGER_METHODS`, and `ModifyAll` is handled separately because of its position. No version bump for `flip-boolean-literal`: R171's cession fix to `remove-not` did not bump either (`remove-not.ts` is still 1.0.0); see open question 4.

- [ ] **Step 4: GREEN**, then red-checks: remove `"DeleteAll"` from the list (first test RED); replace the position check with `return true` (second AND third tests RED); change index 2 to 1 (second test RED).
- [ ] **Step 5:** typecheck, clean dist, `bun test packages/builtin-tier1`, biome on the two files, commit: `fix(tier1): flip-boolean-literal cedes DeleteAll and ModifyAll run-trigger flags by position (GH-04)`.

### Task 3: prove no frozen gate moves, offline

Every gate's figures come from its fixture's mutants. Task 0 found zero `DeleteAll(true)`/`ModifyAll(..., true)` sites in any mutated fixture target, so no gate should move. Prove it per site rather than argue it.

- [ ] **Step 1:** On the commit BEFORE Task 1, for each target (`fixtures/sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-harden`, `sandbox-harden-answers`, `sandbox-probes`, `sandbox-coverage-probe`, `do-campaign`, `grammar-probe`): `bun scripts/census-operator-sites.ts fixtures/<t> <scratch>/before-<t>.json`.
- [ ] **Step 2:** On the Task 2 commit, the same into `after-<t>.json`.
- [ ] **Step 3:** Diff each pair (`diff <(jq -S . before) <(jq -S . after)` or a sorted row compare). Expected: EMPTY for every target. Any non-empty diff is a site this plan did not predict: STOP, and write a pre-commitment spec (below) before any live run.
- [ ] **Step 4:** Run the same script on `U:/Git/do-rel2/Cloud` before and after. Expected diff: exactly 6 rows leave `lethal.flip-boolean-literal` and exactly 6 rows appear under `lethal.swap-modify-flag` with the same file/line and `after` text ending `DeleteAll(false)`; nothing else. Record the counts (never the source text, the corpus is customer AL) in the task report.
- [ ] **Step 5:** Full suite: `bun run typecheck && rm -rf packages/*/dist && bun test`. Expected: PASS. `bun run compile:fixtures` is NOT needed (no `.al` changes).

**If Step 3 is empty, no live gate is required and none is re-recorded.** If the orchestrator still wants live evidence, that means a new fixture arm (for example a `DataFlagOps` arm with `DeleteAll(true)` on a table with an `OnDelete`), which moves `itest:tables`. That path needs, in order: (a) a pre-commitment spec at `docs/superpowers/specs/2026-09-27-gh04-precommitment.md`, committed ALONE before any container run, predicting each new mutant's verdict, operator name, `killingTest` and `platformKillMechanism` (absent), plus the new totals, following `docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md`'s layout (aggregate prediction, per-mutant prediction, where genuinely uncertain, what must also hold, what the run does not prove); (b) `bun run compile:fixtures` and the fixture symbol/test-app republish steps from CLAUDE.md; (c) the gate run under a coord lease on Cronus28; (d) the new baseline handed to the OWNER, never recorded by this lane. Also note `itest:chunked` runs `--only src/DataMain.Table.al` and would move only if that file changes.

### Task 4: docs

**Files:** `README.md:577`, `design.md:155`, `CHANGELOG.md` (`## [Unreleased]`).

- [ ] **Step 1:** In both catalogue rows set the version to `1.3.0` and widen the example column to `Cust.Modify(true)` → `Cust.Modify(false)` (also `Insert`, `Delete`, `DeleteAll`, `ModifyAll`'s 3rd arg). Keep the arrow character the rows already use.
- [ ] **Step 2:** CHANGELOG under `## [Unreleased]`, `### Changed`: "`lethal.swap-modify-flag` 1.3.0 also flips the run-trigger flag of `DeleteAll(true)` and `ModifyAll(Field, Value, true)` (GH-04). These six-per-reference-corpus edits were already emitted by `flip-boolean-literal`, which now cedes them; no new edit exists."
- [ ] **Step 3:** `grep -rn "three AL record methods\|Modify, Insert and Delete\|Modify\`/\`Insert\`/\`Delete" README.md design.md docs/*.md .claude/skills` and fix any claim that is now incomplete.
- [ ] **Step 4:** `bun test scripts/changelog-section.test.ts`. Expected: PASS. Commit docs alone.
- [ ] **Step 5:** File the landing on the roadmap: `docs/roadmap/R<next>.md` with `status: "done (<commit>)"`, regenerate, commit.

---

## Open questions for the orchestrator

1. **Accept the STOP?** 6 sites against a floor of 36, and a ground-1 marginal of 0 because `flip-boolean-literal` already emits every one of those edits. Recommended: yes, run Task S and close issue #4 with that commit.
2. **Or admit on ground 2 (attribution)?** The case: the run-trigger flag is a platform-semantic class the operator already owns for `Delete`, so the 6 edits are arguably mis-attributed today. Cost: 6 re-keyed mutants per reference-corpus campaign baseline, zero on the fixtures, plus the Task 2 cession change. Benefit: attribution only, no new edit.
3. **File Task C regardless?** The issue's kill-mechanism point re-opens R138's ruling for the `Delete(true)` mutants that ship today, independent of this task's outcome.
4. **Does a cession-only change to `flip-boolean-literal` need a version bump?** Precedent (R171, `remove-not` still 1.0.0) says no. Say so if that precedent should not carry.
5. **Forward direction for `DeleteAll()` (6 candidates on the reference corpus, 0 for `ModifyAll`)** is also under the floor and is not in this plan. Confirm it stays out.
6. **Pre-existing orphan, noticed while reading:** `flip-boolean-literal` cedes every `true` of a claimed `Insert`/`Modify`/`Delete` call, but `swap-modify-flag` claims only a SOLE argument, so a `true` in the two-argument `Insert(true, true)` overload is claimed by nobody. Not measured. File it as its own row, or ignore?
