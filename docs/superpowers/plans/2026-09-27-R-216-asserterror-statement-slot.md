# R-216: `asserterror_statement.body` as a statement slot, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** r3 (final). r2 applied every finding of gpt-6-sol review r1 (`H:/lethal-coord/reviews/R-216-plan/review-r1.md`) under the coordinator's rulings C, I1 to I5 and Minor. r3 applies review r2 (`H:/lethal-coord/reviews/R-216-plan/review-r2.md`) under the coordinator's rulings 1 to 3. Both change lists are at the end.

**Goal:** Decide, by measurement, whether `isStatementSlot` should treat the body of an `asserterror` statement as a statement slot. Land it (census, pre-commitment, TDD, alc proof, red-check) if deployable product sites exist, or STOP and close R216 as a scoped, measured non-admission. Correct the roadmap texts either way.

**Architecture:** One entry in `SINGLE_STATEMENT_SLOTS` (`packages/engine/src/ast/tree-walks.ts`). That set feeds `isStatementSlot` (seven slot-gated operators plus two schemata emission paths) and `gapBlockOf` (gap grouping). The measurement runs `scripts/census-operator-sites.ts` before and after the one-line change, diffs with `scripts/probe-census-diff.ts` (a multiset diff), and classifies every gained row with one new script, `scripts/r216-classify-gained.ts`, which checks AST ancestry, runs the runner's own deployment checks, and classifies the enclosing app as product, test or unknown. One more new script, `scripts/r216-emit-proof.ts`, compiles a real instrumented `remove-assignment` mutant inside an `asserterror` body before the engine change is committed.

**Tech Stack:** Bun + TypeScript, web-tree-sitter with vendored tree-sitter-al 4.4.1, `alc` 18.0.2668733.

**Spec:** `docs/roadmap/R216.md`, read with `docs/roadmap/R217.md`, `docs/roadmap/R283.md`, `docs/measurements/2026-09-27-gh06-grammar-crosscheck.md` section 10 (run 003, cluster C4), `docs/superpowers/specs/2026-09-27-tsal441-grammar-bump-precommitment.md` (AMENDMENT 1: the 8 `toggle-blank-string` rows), and the precedent `docs/superpowers/specs/2026-08-19-r161-branch-slot-precommitment.md` with `scripts/r161-slot-census.ts` and `scripts/r161-emit-proof.ts`.

## Global Constraints

- Plain English, short sentences, **no em dashes** anywhere (plan, specs, roadmap, code comments, commit messages).
- No `!` non-null assertions; destructure then check `undefined`.
- Build loop order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`.
- Biome only on touched files: `bunx biome check <paths>`.
- Roadmap: edit `docs/roadmap/R<nnn>.md` only; regenerate with `bun scripts/roadmap-index.ts`; never hand-edit `ROADMAP.md`.
- Customer AL (do, dc) is never committed. Only counts, operator names, object names, file names and line numbers go in a committed file.
- The pre-commitment is committed ALONE, before any census under the changed predicate. Nothing above its OUTCOME heading changes after a run.
- The STOP/CONTINUE decision uses DEPLOYABLE PRODUCT counts only (ruling C, r3 rulings 1 and 2). Test counts are reported beside them and decide nothing.
- The classifier has exactly three outcomes: `product`, `test`, `unknown` (r3 ruling 1). `unknown` never counts as product: if any `unknown` row exists, the lane STOPS and returns to the coordinator with those rows listed.
- A row counts toward CONTINUE only after the runner's own deployment checks: `isEnumeratedAl`, `validateSpec`, `isMutableSite`, `dedupeSpecs` and `canCarryMutationSelectorVar` (so query and XMLport objects are excluded) (r3 ruling 2).
- Any product site that appears only in Microsoft BaseApp or System Application product objects is CONTINUE evidence, and goes back to the coordinator BEFORE anything is built (ruling I4).
- `census-operator-sites.ts` aborts on all of BaseApp in one pass (wasm heap). Run BaseApp as two halves, `BaseApp/Source` and `BaseApp/Test` (TSAL-441 AMENDMENT 1, R292). The halves are an input split, not a role classification: rows are classified by app role in both.

## Facts established while writing this plan (read, not assumed)

1. **Consumers of `isStatementSlot`** (grep of `packages/*/src`, dist excluded):
   - Operators that GATE on it (these gain sites): `lethal.void-method-call` (`packages/builtin-tier1/src/void-method-call.ts:24`), `lethal.remove-assignment` (`packages/builtin-tier1/src/remove-assignment.ts:71`), and in `packages/builtin-tier2/src/`: `lethal.remove-calcfields`, `lethal.remove-commit`, `lethal.remove-setrange`, `lethal.remove-testfield`, `lethal.validate-to-assign`. Six are deletions; `validate-to-assign` is a REWRITE (it turns `Rec.Validate(F, V)` into `Rec.F := V`, skipping `OnValidate`).
   - Emission: `packages/schemata/src/dispatch.ts` `placeReach` (about lines 117 and 136) and `emptiedSlotFiller` (about line 207).
   - Grouping: `gapBlockOf` in `tree-walks.ts` reads `SINGLE_STATEMENT_SLOTS` directly, so an existing mutant inside an `asserterror` body moves to a smaller gap block. No identity key reads the gap block.
   - NOT consumers: `swap-call-arguments`, `swap-find-direction`, `swap-modify-flag`, `swap-enum-member`, `flip-filter-literal` only COMPUTE `parentContext` from `isStatementPosition`; `write-txn-codeunit-run` and schemata `wrapIfSingleStatementSlot` read `isStatementPosition`. None changes behaviour.
2. **Non-slot-gated operators already plant mutants inside `asserterror` bodies.** Measured 2026-09-27 on vendored 4.4.1 with `census-operator-sites.ts` over the two committed repros (`scripts/lib/al-kind-mapping-asserterror-*.al`) plus a hand-written probe (scratch, not committed): `lethal.swap-call-arguments` (`Pair(A, B)` to `Pair(B, A)`), `lethal.swap-modify-flag` (`Cust.Modify(true)` to `(false)`), `lethal.swap-find-direction` (`FindFirst` to `FindLast`), `lethal.flip-boolean-literal` (the `true` in `asserterror Buckets[1].Delete(true)`), `lethal.swap-additive` on call arguments. What the seven gated operators lack is a site AT the body itself. R283's closing sentence ("no mutation operator plants a mutant on a call inside an `asserterror` body") and R216's "a call inside `asserterror` is still not a mutation site" are false as written. Task 4 fixes both in place.
3. **`findEnclosingStatement` does not know `asserterror_statement`** (not in `STATEMENT_KINDS`). For a CALL in the body, the component root climbs past the `asserterror` to the next statement kind or the procedure body block. For an ASSIGNMENT in the body, the root is the `assignment_statement` itself, which sits in the slot, so `wrapIfSingleStatementSlot` braces it: expected text `asserterror begin <chain> end;`. No proof has compiled that shape. The 8 `toggle-blank-string` rows in `BaseApp/Test` already produce it, but no run targets that code. Task 6 compiles it before the engine commit.
4. **Fixture product code holds no `asserterror` statement.** `grep -rni asserterror` over `fixtures/sandbox-app`, `sandbox-data/src`, `sandbox-hang`, `sandbox-harden`, `sandbox-coverage-probe` finds only `//` comments (DataMain.Table.al 35, 58, 59; DataMainExt.TableExt.al 27, 28; DataOps.Codeunit.al 50). `examples/credit-limit` and `examples/gift-card` hold none; only their `-tests` twins do.
5. **do-rel2 and DC hold no `asserterror` at all.** `grep -rliE "^[^/]*\basserterror\b" --include=*.al` finds 0 files in `U:/Git/do-rel2/Cloud` and 0 in `U:/Git/DC/Cloud` (this grep includes `.dependencies`). R216 records 0 non-test files in 16,898 BC.History files, a file-level count that Task 2 replaces with an object-role count.
6. **What a mutant there means, per operator.**
   - The six DELETIONS: `asserterror ;` compiles (R216, alc 18.0.2668733; codeunit subtype not recorded, see Task 2 Step 1). If the body normally raises, the mutant makes the `asserterror` raise its own error: killed whenever a test reaches the line and does not expect that failure. If the body normally does not raise, original and mutant both raise: equivalent. These mutants mostly report reach.
   - `validate-to-assign` is different: skipping `OnValidate` can change WHETHER the body raises, so its mutant can carry real information.
   - So STOP is NOT justified by "no information per site". It is justified only by the measured absence of deployable product sites (ruling I4). R216's line "it tests whether the `asserterror` actually asserts anything" is true only for `asserterror` in TEST code, which LethAL does not mutate; Task 4 qualifies it in place.
   - R013's floor (>= 36 marginal sites on `do-rel2/Cloud`, sha256 `9a8e8831449208cc...`) prices new OPERATORS, not a predicate fix; R161 was not held to it. It is context only.
7. **The fingerprint and the census read different file lists.** `scripts/corpus-fingerprint.ts` (`corpusEntries`) excludes any path containing `.dependencies`; `scripts/census-operator-sites.ts` reads every `.al` file recursively, `.dependencies` included (the existing measurement records 137 extra files on do-rel2 and 660 on DC). Task 1 therefore fingerprints the census's ACTUAL input list, and prints the reference `corpusEntries` fingerprint beside it for identity only.
8. **The runner's target enumeration does NOT exclude `.dependencies`.** `generateMutationSet` (`packages/runner/src/orchestrator.ts` about line 560) reads `readdir(projectDir, { recursive: true })` filtered by `isEnumeratedAl` (`packages/runner/src/line-filter.ts:115`), which is `.al` and a basename not starting with `Mutation`, nothing else. So a `.dependencies` file under a project IS enumerated and can be mutated when LethAL is pointed at that directory. r2's `dependency` role ("never mutated") was wrong and is gone: such rows are classified by their own app like any other, and the census input list is filtered by `isEnumeratedAl` for parity (the corpora hold no `Mutation*` file, so the lists should be equal; Task 1 Step 3 prints both counts).
9. **Test-library app names**, read off BC.History app.json files 2026-09-27: `Library Assert`, `Test Runner`, `Any`, `Library Variable Storage`, `Permissions Mock` (all publisher `Microsoft`). One id is verified from `BaseApp/Test/Tests-Bank/app.json`: `Library Variable Storage` = `5095f467-0a01-4b99-99d1-9ff1237d286f`. Other ids are added to the classifier only after being read off an app.json by name, never guessed.
10. **`census-fixture-mutants.ts` and `probe-fixture-hashes.ts` read only top-level `.al` files** of the directory they are given, so neither alone covers `fixtures/sandbox-data/src`. The fixture check uses `census-operator-sites.ts`, which is recursive.

## Review Focus

1. **A test-support object that is not `Subtype = Test`** (a `Library - ...` codeunit, a helper in a test app) classified as product and flipping the decision to CONTINUE. The classifier decides by APP, not object: every object in a test app is `test`; an object with no decidable app is `unknown`, which stops the lane. Task 1 Step 2 red-checks both failure modes (a non-subtype helper in a test app; a file with no app.json).
2. **A deletion that empties the slot**, or `then ; else` inside the dispatch chain. Task 6 compiles every shape with `alc`, with a negative control.
3. **An assignment root that IS the slot** (fact 3): `asserterror begin <chain> end;` must compile, and a following sibling must keep its `;`. Task 6 asserts the text and compiles it.
4. **`gapBlockOf` moving existing mutants** (fact 2) to a new gap block. Task 5 pins it.
5. **A non-`asserterror` slot regressing.** The existing SLOT_CASES and NON_SLOT_CASES stay green (Task 5); Task 2 requires 0 rows LOST on every input.

---

## File Structure

- Create: `docs/superpowers/specs/2026-09-27-r216-asserterror-slot-precommitment.md` (predictions, stop rule, then OUTCOME).
- Create: `scripts/r216-classify-gained.ts` (multiset gained/lost, AST ancestry check, the runner's deployment checks, app role product / test / unknown).
- Create (CONTINUE only): `scripts/r216-emit-proof.ts` (exactly one real direct-body `remove-assignment` or `void-method-call` spec per case, the real `emitStaticSelector` with `Reached`, pass only on alc exit 0 plus an artifact; fails loudly when `alc` or packages are missing).
- Modify (CONTINUE only): `packages/engine/src/ast/tree-walks.ts` (one set entry plus its doc comment).
- Modify (CONTINUE only): `packages/engine/tests/ast/tree-walks.test.ts`, `packages/engine/tests/ast/grammar-shapes.test.ts`.
- Modify: `docs/roadmap/R216.md`, `R217.md`, `R283.md`; regenerate `ROADMAP.md`.

---

### Task 1: Pre-commitment and the classifier, committed alone

**Files:**
- Create: `scripts/r216-classify-gained.ts`
- Create: `docs/superpowers/specs/2026-09-27-r216-asserterror-slot-precommitment.md`

The classifier is committed WITH the pre-commitment, because the pre-commitment names it as the instrument. It is written and tested against the committed repros before any corpus is counted under the change.

- [ ] **Step 1: Write the classifier**

It runs WITH the predicate change applied in the working tree (Task 2 Step 4, before Step 5 reverts it), because it regenerates the gained specs to put them through the runner's deployment checks.

```ts
#!/usr/bin/env bun
/**
 * R216: which census rows did the `asserterror_statement.body` slot ADD, are they really at that
 * body, would the runner deploy them, and is each one product or test code?
 *
 *   bun scripts/r216-classify-gained.ts <before.json> <after.json> <corpus-dir>
 *
 * Run with the predicate change applied, so regenerated specs match the AFTER census.
 *
 * 1. Gained/lost is a MULTISET diff keyed like `probe-census-diff.ts`.
 * 2. Ancestry: a gained row counts only when its node (start position plus squashed text) IS the
 *    `body` field of an `asserterror_statement`. Otherwise BAD, exit 1.
 * 3. Deployable: the row survives the runner's own checks, in the runner's order: the file passes
 *    `isEnumeratedAl`; the spec passes `validateSpec` and `isMutableSite`; it survives
 *    `dedupeSpecs` over every operator's specs for that file; and the file passes
 *    `canCarryMutationSelectorVar` (query and XMLport objects fail it). Mirrors
 *    `census-fixture-mutants.ts`, which mirrors `generateMutationSet`.
 * 4. Role, by APP (ruling 1), exactly three outcomes:
 *    test     the nearest app.json (searched up to, and not above, <corpus-dir>) declares a
 *             dependency whose name or id is in TEST_APP_NAMES / TEST_APP_IDS, exact match; OR
 *             that app holds any codeunit with `Subtype = Test` or `TestRunner`; OR there is no
 *             app.json and the enclosing object is itself such a codeunit.
 *    product  an app.json was found, parsed, and the app is not a test app.
 *    unknown  anything else (no app.json and not a test codeunit, or an app.json that fails to
 *             parse). Never counted as product; any unknown row stops the lane.
 * Prints counts, operator names, object names, files and lines only, never source text.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { declarationMembers } from "../packages/engine/src/ast/tree-walks";
import type { MutationSpec } from "../packages/engine/src/operator/interface";
import { buildSpanIndex, validateSpec } from "../packages/engine/src/operator/spec-validation";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { isEnumeratedAl } from "../packages/runner/src/line-filter";
import { canCarryMutationSelectorVar } from "../packages/schemata/src/compile";
import { dedupeSpecs } from "../packages/schemata/src/dedup";
import { isMutableSite } from "../packages/schemata/src/enclosing";

interface Row {
  readonly operator: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly before: string;
  readonly after: string;
}

/** Microsoft test-library apps (plan fact 9). Exact, case-sensitive; no regex. */
const TEST_APP_NAMES = new Set([
  "Library Assert",
  "Test Runner",
  "Any",
  "Library Variable Storage",
  "Permissions Mock",
]);
/** Only ids read off a real app.json by name. Add others the same way, never by guess. */
const TEST_APP_IDS = new Set(["5095f467-0a01-4b99-99d1-9ff1237d286f"]);

const [beforePath, afterPath, corpusArg] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined || corpusArg === undefined) {
  console.error("usage: bun scripts/r216-classify-gained.ts <before.json> <after.json> <corpus-dir>");
  process.exit(2);
}
const corpusDir = resolve(corpusArg);

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const key = (r: Row): string =>
  JSON.stringify([r.operator, r.file, r.line, r.column, r.before, r.after]);
const load = async (p: string): Promise<Row[]> => JSON.parse(await readFile(p, "utf8")) as Row[];

// 1. Multiset diff.
const remaining = new Map<string, number>();
for (const r of await load(beforePath)) remaining.set(key(r), (remaining.get(key(r)) ?? 0) + 1);
const gained: Row[] = [];
for (const r of await load(afterPath)) {
  const n = remaining.get(key(r)) ?? 0;
  if (n > 0) remaining.set(key(r), n - 1);
  else gained.push(r);
}
let lost = 0;
for (const n of remaining.values()) lost += n;

// Parse the corpus exactly as the census does (sorted, recursive), for one semantic context.
await initParser();
const rels = (await readdir(corpusDir, { recursive: true }))
  .filter((f) => f.toLowerCase().endsWith(".al"))
  .sort();
const roots = new Map<string, ALSyntaxNode>();
for (const rel of rels) {
  roots.set(rel, wrapRoot(parseAL(await readFile(join(corpusDir, rel), "utf8"))));
}
const ctx = buildSemanticContext([...roots].map(([path, root]) => ({ path, root })));
const operators = [...tier1Operators, ...tier2Operators];
const tiers = new Map(operators.map((op) => [op.name, op.tier]));

// 4. App roles.
function subtypeOf(obj: ALSyntaxNode): string | null {
  for (const m of declarationMembers(obj)) {
    if (m.rawKind !== "property") continue;
    if (m.childForFieldName("name")?.text.toLowerCase() !== "subtype") continue;
    return m.childForFieldName("value")?.text.trim() ?? null;
  }
  return null;
}
const isTestCodeunit = (obj: ALSyntaxNode): boolean =>
  obj.rawKind === "codeunit_declaration" && /^(Test|TestRunner)$/i.test(subtypeOf(obj) ?? "");

function appRootOf(rel: string): string | null {
  let d = dirname(join(corpusDir, rel));
  for (;;) {
    if (existsSync(join(d, "app.json"))) return d;
    if (resolve(d) === corpusDir) return null;
    const up = dirname(d);
    if (up === d || relative(corpusDir, up).startsWith("..")) return null;
    d = up;
  }
}
const appsWithTestCodeunit = new Set<string>();
for (const [rel, root] of roots) {
  let has = false;
  visit(root, (n) => {
    if (isTestCodeunit(n)) has = true;
  });
  const app = appRootOf(rel);
  if (has && app !== null) appsWithTestCodeunit.add(app);
}
/** true = test app, false = product app, null = app.json unreadable. */
function appIsTest(app: string): boolean | null {
  try {
    const j = JSON.parse(readFileSync(join(app, "app.json"), "utf8").replace(/^\uFEFF/, "")) as {
      dependencies?: { name?: string; id?: string; appId?: string }[];
    };
    const deps = j.dependencies ?? [];
    const declares = deps.some(
      (d) =>
        (d.name !== undefined && TEST_APP_NAMES.has(d.name)) ||
        (d.id !== undefined && TEST_APP_IDS.has(d.id.toLowerCase())) ||
        (d.appId !== undefined && TEST_APP_IDS.has(d.appId.toLowerCase())),
    );
    return declares || appsWithTestCodeunit.has(app);
  } catch {
    return null;
  }
}

// 3. Deployed specs per file, the runner's pipeline, computed only for files with gained rows.
const deployedKeys = new Map<string, Set<string>>();
function deployedIn(rel: string, root: ALSyntaxNode): Set<string> {
  const hit = deployedKeys.get(rel);
  if (hit !== undefined) return hit;
  const out = new Set<string>();
  if (isEnumeratedAl(rel) && canCarryMutationSelectorVar(root)) {
    const spanIndex = buildSpanIndex(root);
    const raw: MutationSpec[] = [];
    visit(root, (node) => {
      for (const op of operators) {
        if (!op.targets(node, ctx)) continue;
        for (const spec of op.generate(node, ctx)) {
          if (!validateSpec(spec, root, spanIndex).ok) continue;
          if (!isMutableSite(spec.before)) continue;
          raw.push(spec);
        }
      }
    });
    for (const s of dedupeSpecs(raw, (name) => tiers.get(name))) {
      out.add(
        key({
          operator: s.operatorName,
          file: rel,
          line: s.before.startPosition.row + 1,
          column: s.before.startPosition.column,
          before: squash(s.before.text),
          after: squash(s.after.text),
        }),
      );
    }
  }
  deployedKeys.set(rel, out);
  return out;
}

const counts = new Map<string, number>();
const bump = (k: string): void => {
  counts.set(k, (counts.get(k) ?? 0) + 1);
};
let bad = 0;
let unknown = 0;
for (const r of gained) {
  const root = roots.get(r.file);
  if (root === undefined) throw new Error(`r216-classify-gained: ${r.file} is not in ${corpusDir}`);
  let node: ALSyntaxNode | undefined;
  visit(root, (n) => {
    if (node !== undefined) return;
    if (
      n.startPosition.row + 1 === r.line &&
      n.startPosition.column === r.column &&
      squash(n.text) === r.before &&
      n.fieldName === "body" &&
      n.parent?.rawKind === "asserterror_statement"
    )
      node = n;
  });
  if (node === undefined) {
    bad += 1;
    console.log(`BAD\t${r.operator}\t${r.file}:${r.line}\tnot the body of an asserterror_statement`);
    continue;
  }
  let obj: ALSyntaxNode | null = node.parent;
  while (obj !== null && !obj.rawKind.endsWith("_declaration")) obj = obj.parent;
  while (obj !== null && obj.parent !== null && obj.parent.rawKind !== "source_file") obj = obj.parent;
  const objName = obj?.childForFieldName("name")?.text ?? "(no object)";
  const app = appRootOf(r.file);
  let role: "product" | "test" | "unknown";
  if (app === null) role = obj !== null && isTestCodeunit(obj) ? "test" : "unknown";
  else {
    const t = appIsTest(app);
    role = t === null ? "unknown" : t ? "test" : "product";
  }
  const deployable = deployedIn(r.file, root).has(key(r));
  bump(`${role}\t${deployable ? "deployable" : "not-deployed"}\t${r.operator}`);
  if (role === "unknown") unknown += 1;
  if (role !== "test")
    console.log(`${role}\t${deployable ? "deployable" : "not-deployed"}\t${r.operator}\t${objName}\t${r.file}:${r.line}`);
}
console.log(`\ngained ${gained.length}, lost ${lost}, bad ${bad}, unknown ${unknown}`);
for (const [k, n] of [...counts].sort()) console.log(`${k}\t${n}`);
process.exit(lost > 0 || bad > 0 ? 1 : unknown > 0 ? 3 : 0);
```

Before committing, check two grammar facts against one real parse, the way `grammar-shapes.test.ts` does: the field names `name` and `value` on `property`, and `name` on `codeunit_declaration`; and the root node's `rawKind` (the second `while` climbs to the top-level object, so a nested `_declaration` such as a procedure or trigger is not mistaken for the object). Fix the code, not the test, if either differs. Exit codes: 1 = BLOCK (lost or bad), 3 = unknown rows present (lane stops), 0 = clean.

- [ ] **Step 2: Prove the classifier on the committed repros (red and green)**

Four scratch layouts under `$S/cls/`, each a copy of `scripts/lib/al-kind-mapping-asserterror-*.al`:

| layout | app.json | expected role of every gained row |
| --- | --- | --- |
| `prod` | `{"dependencies": []}` | `product`, `deployable` |
| `testdep` | `{"dependencies": [{"name": "Library Assert", "publisher": "Microsoft"}]}` | `test` |
| `testcu` | `{"dependencies": []}` plus one extra file `T.Codeunit.al` holding `codeunit 50099 "T" { Subtype = Test; }` | `test` (a non-subtype helper in a test app, the r2 failure mode) |
| `noapp` | none | `unknown`, exit 3 |

```bash
cd U:/Git/LethAL
S=<scratchpad>/r216
for L in prod testdep testcu noapp; do
  bun scripts/census-operator-sites.ts "$S/cls/$L" "$S/cls/$L-before.json"
done
# apply the one-line change of Task 5 Step 3 in the working tree
for L in prod testdep testcu noapp; do
  bun scripts/census-operator-sites.ts "$S/cls/$L" "$S/cls/$L-after.json"
  bun scripts/r216-classify-gained.ts "$S/cls/$L-before.json" "$S/cls/$L-after.json" "$S/cls/$L"; echo "exit $?"
done
git checkout -- packages/engine/src/ast/tree-walks.ts
```

Expected in every layout: `lost 0, bad 0`; gains `lethal.remove-assignment` at `Outcome := Compute(7)` and `lethal.void-method-call` at `Compute(8)`, `Buckets[1].Delete(true)` and `Buckets[2].Validate(...)`; roles as in the table; exit 0, 0, 0, 3. Also confirm `testdep` goes back to `product` when the dependency name is changed to `library assert` (exact match, no case folding). Do not record corpus numbers yet.

- [ ] **Step 3: Fingerprint the census's actual inputs, and the reference identity**

```bash
for c in "U:/Git/do-rel2/Cloud" "U:/Git/DC/Cloud" "U:/Git/BusinessCentral.Sentinel" \
         "U:/Git/BC.History/BusinessFoundation" "U:/Git/BC.History/System Application" \
         "U:/Git/BC.History/BaseApp/Source" "U:/Git/BC.History/BaseApp/Test"; do
  echo "== $c"
  bun scripts/corpus-fingerprint.ts "$c"          # reference identity, excludes .dependencies
  bun -e '
    const {readdirSync,readFileSync}=require("fs"),{join}=require("path");const d=process.argv[1];
    const e=readdirSync(d,{recursive:true}).filter(f=>f.toLowerCase().endsWith(".al")).map(f=>f.replaceAll("\\","/")).sort();
    const h=new Bun.CryptoHasher("sha256");for(const r of e){h.update(r+"\n");h.update(readFileSync(join(d,r)));h.update("\n");}
    const m=e.filter(r=>r.split("/").pop().startsWith("Mutation")).length;
    console.log(`census-inputs files=${e.length} sha256=${h.digest("hex")} not-isEnumeratedAl(Mutation*)=${m}`);' "$c"
done
git rev-parse HEAD
```

The second line hashes exactly the list `census-operator-sites.ts` reads (all `.al`, recursive, sorted), with the same algorithm as `fingerprintCorpus`. The `Mutation*` count must be 0; if not, the census reads files the runner would not enumerate, and those rows are `not-deployed` by the classifier's `isEnumeratedAl` check. Expected reference identities: do `9a8e8831449208cc`, dc `dcad155c4ecdb38e`, sentinel `9363656ed52020e0`, bcf `a56a8435136fc21f`, sysapp `7fae1831fda03a89`. A differing reference hash means a different corpus: stop and ask.

- [ ] **Step 4: Write the pre-commitment**

```markdown
# R216 pre-commitment: `asserterror_statement.body` as a statement slot

Written and committed at HEAD <sha> before any corpus census under the changed predicate.
Nothing above OUTCOME changes after a run.
Plan: docs/superpowers/plans/2026-09-27-R-216-asserterror-statement-slot.md (r3)

## Change under test
`asserterror_statement.body` added to SINGLE_STATEMENT_SLOTS (packages/engine/src/ast/tree-walks.ts).

## Instruments
census-operator-sites.ts before and after; probe-census-diff.ts (multiset, per operator);
scripts/r216-classify-gained.ts (multiset gained/lost; AST ancestry; the runner's deployment
checks isEnumeratedAl, validateSpec, isMutableSite, dedupeSpecs, canCarryMutationSelectorVar;
app role product / test / unknown, test = exact test-library dependency name or id, or any
Subtype = Test/TestRunner codeunit in the app).

## Corpora
<table: key, path, census-inputs files and sha256 (first 16), reference corpusEntries sha256 (first 16)>
Fixture targets (census-operator-sites.ts, recursive): sandbox-app, sandbox-data, sandbox-hang,
sandbox-harden, sandbox-coverage-probe, examples/gift-card, examples/credit-limit.

## P1. Legality
`alc` on `asserterror Raise();` and `asserterror ;` in a codeunit with NO Subtype.
Predicted: <compiles | refused>.

## P2. Census
- LOST: 0 on every input. BAD (a gained row not at an asserterror body): 0. Either is a BLOCK.
- Every gained row is from one of the seven gated operators.
- Fixtures: 0 gained.
- do, dc: 0 gained, any role.
- sentinel: 0 gained.
- DEPLOYABLE PRODUCT gained, per corpus and operator: predicted 0 on every corpus.
- UNKNOWN: predicted 0 on every corpus (every BC.History half holds app.json files; do and dc
  gain nothing to classify). Any unknown row stops the lane (see P4).
- TEST gained, reported, predictions as lower bounds only: bcf void-method-call >= 35 (R216);
  sysapp remove-assignment 8 (C4); BaseApp/Test remove-assignment 72 (C4) and
  void-method-call >= 34 (R283's calls).
- Existing rows inside asserterror bodies (the operators of plan fact 2, and the 8
  toggle-blank-string rows): unchanged, which LOST 0 already implies.

## P3. Gates
No fixture product code holds an asserterror statement (grep, comments only). P2's
fixture line (0 census rows gained or lost, recursive) establishes that no operator gains or
loses a site on any fixture, so no deployed mutant can be added or removed. It does NOT prove
the emitted text of existing mutants is unchanged; that text changes only for mutants inside an
asserterror body, and fixture product code has none. Predicted: no gate figure moves, and no live
gate runs for this change.

## P4. Stop rule (decided now, before the numbers)
Deployable product site = a gained row the classifier reports as `product` AND `deployable`.
No hand review changes a role: the classifier's rule is the ruling.
- UNKNOWN STOP: any `unknown` row on any corpus. Return to the coordinator with those rows
  listed (object, file, line, operator). Unknown never counts as product.
- STOP (a): P1 shows alc refuses asserterror outside a test codeunit. Close R216: "not
  admitted: alc refuses asserterror in a non-test codeunit, so no product code can hold the site".
- STOP (b): 0 deployable product sites on every corpus. Close R216: "not admitted: measured 0
  deployable product sites on <corpora and fingerprints>; the <n> gained sites are all in test
  code, which LethAL does not mutate; reopen if a target app holds asserterror in product code".
- CONTINUE: >= 1 deployable product site. If every such site is in a Microsoft BaseApp or
  System Application product object, return to the coordinator BEFORE Task 5; that is CONTINUE
  evidence, not yet an admission.
The reason for STOP is only the measured absence of deployable product sites. It is not a claim
that the sites carry no information: validate-to-assign's rewrite can.

## OUTCOME
(empty until the run)
```

- [ ] **Step 5: Commit both alone**

```bash
bunx biome check scripts/r216-classify-gained.ts
git add scripts/r216-classify-gained.ts docs/superpowers/specs/2026-09-27-r216-asserterror-slot-precommitment.md
git commit -m "docs(R216): pre-commit the asserterror slot census, classifier and stop rule"
```

### Task 2: Legality probe and census (measurement only)

**Files:**
- Modify temporarily (reverted in Step 5): `packages/engine/src/ast/tree-walks.ts:47-54`
- Modify: the pre-commitment's OUTCOME section

- [ ] **Step 1: alc legality probe (P1).** Use `/al-compile` (or the `al-compiler` subagent) on a scratch project in the scratchpad, runtime 16, holding:

```al
codeunit 50120 "R216 Legality"
{
    procedure Probe()
    begin
        asserterror Raise();
        asserterror ;
    end;

    local procedure Raise()
    begin
        Error('x');
    end;
}
```

Record: compiles or not, and any diagnostic id. Compile the same body in a codeunit with `Subtype = Test;` as the control; if the control fails, the probe is wrong: stop.

- [ ] **Step 2: BEFORE census.** For each input `t` (the seven fixture targets and the seven corpora of Task 1 Step 3), with `k` a filename-safe key:

```bash
bun scripts/census-operator-sites.ts "$t" "$S/before/$k.json"
```

Run BEFORE twice on `BaseApp/Test` and diff with `probe-census-diff.ts`: must be 0/0 (R218's stability check).

- [ ] **Step 3: Apply the change in the working tree only** (the entry of Task 5 Step 3).

- [ ] **Step 4: AFTER census, then per input:**

```bash
bun scripts/census-operator-sites.ts "$t" "$S/after/$k.json"
bun scripts/probe-census-diff.ts "$S/before/$k.json" "$S/after/$k.json"
bun scripts/r216-classify-gained.ts "$S/before/$k.json" "$S/after/$k.json" "$t"
```

Exit 1 is a BLOCK; exit 3 means unknown rows exist. The classifier must run BEFORE Step 5 reverts the change, since it regenerates specs. Roles are not overridden by hand. Keep customer-corpus rows in the scratchpad only.

- [ ] **Step 5: Revert the working-tree change**

```bash
git checkout -- packages/engine/src/ast/tree-walks.ts
git status --short   # only the pre-commitment may be modified
```

- [ ] **Step 6: Write OUTCOME** (P1; P2 per input: gained / lost / bad / unknown, product and test counts per operator, split deployable / not-deployed, every product and unknown row by object name; matched or missed per prediction line) **and commit**

```bash
git add docs/superpowers/specs/2026-09-27-r216-asserterror-slot-precommitment.md
git commit -m "docs(R216): census outcome for the asserterror statement slot"
```

### Task 3: Apply the stop rule

- [ ] **Step 1:** Read P4 against OUTCOME. Write one line under OUTCOME: `Decision: STOP (a)`, `Decision: STOP (b)`, `Decision: UNKNOWN STOP, <n> rows`, or `Decision: CONTINUE, <n> deployable product sites in <objects>`.
- [ ] **Step 2:** A BLOCK (lost > 0 or bad > 0): stop and report; no roadmap change. UNKNOWN STOP: send the listed unknown rows to the coordinator and wait; no roadmap change until answered.
- [ ] **Step 3:** CONTINUE with every product site in Microsoft BaseApp or System Application product objects: send the OUTCOME to the coordinator and wait. Do not start Task 5 until the coordinator answers.
- [ ] **Step 4:** STOP: Task 4 (STOP variant) then Task 8. CONTINUE (cleared): Tasks 4 to 8.

### Task 4: Correct R283, R216 and R217 in place

**Files:**
- Modify: `docs/roadmap/R283.md`, `docs/roadmap/R216.md`, `docs/roadmap/R217.md`

Each fix edits the false sentence where it stands and adds a dated qualification in brackets, so a reader of that paragraph cannot miss it. Keep the distinction everywhere: non-slot-gated operators already plant mutants inside the body; the seven gated operators lack a site AT the body.

- [ ] **Step 1: R283**, "Closed" section. Replace "no mutation operator plants a mutant on a call inside an `asserterror` body, because `asserterror_statement.body` is not in `SINGLE_STATEMENT_SLOTS`" with:

```markdown
none of the seven operators that gate on `isStatementSlot` (`void-method-call`,
`remove-assignment`, `remove-calcfields`, `remove-commit`, `remove-setrange`, `remove-testfield`,
`validate-to-assign`) has a site AT a call that is an `asserterror` body, because
`asserterror_statement.body` is not in `SINGLE_STATEMENT_SLOTS`. [Corrected 2026-09-27: this
sentence first said NO operator plants there. Operators that key on the call or its arguments
do, measured on 4.4.1 with `scripts/census-operator-sites.ts` over the two
`scripts/lib/al-kind-mapping-asserterror-*.al` repros plus a hand-written probe:
`swap-call-arguments`, `swap-modify-flag`, `swap-find-direction`, `flip-boolean-literal`,
`swap-additive`.]
```

Also in R283's "Cost today" paragraph, after "no site covers the call the compiler builds", add: `[2026-09-27: true under 4.3.0 only; under 4.4.1 the call is whole and those operators see it.]`. Keep the status line; the supersession ruling still holds.

- [ ] **Step 2: R216, in place.**
  - After "it tests whether the `asserterror` actually asserts anything, which is exactly the weakness a mutation tester should surface." add: `[Qualified 2026-09-27: that holds for asserterror in TEST code, which LethAL does not mutate. In product code a deletion there mostly reports reach (killed whenever reached if the body raises, equivalent if it does not); validate-to-assign's rewrite is the exception, since skipping OnValidate can change whether the body raises. See the census section below.]`
  - In "The call-slot omission is not a grammar bug" paragraph, and in the 4.4.1 section's "a call inside `asserterror` is still not a mutation site", replace the latter with `a call inside asserterror is still not a site for the seven slot-gated operators` and add: `[Corrected 2026-09-27: non-slot-gated operators (swap-call-arguments, swap-modify-flag, swap-find-direction, flip-boolean-literal, swap-additive) already plant mutants on and inside such a call.]`
  - Replace "a test-only construct" (the corpus table's conclusion) with "test-only by file count in this corpus" and add: `[2026-09-27: replaced by an object-role count, see the census section.]`
  - Append `## Census and ruling (2026-09-27)`: P1 result, the per-corpus product/test table from OUTCOME with fingerprints, the consumer list (plan fact 1), and the pre-commitment path.
  - Status. STOP (a) or (b): `closed 2026-09-27: <the exact P4 closing sentence for (a) or (b), with corpora and fingerprints>`. CONTINUE: leave open until Task 8.
- [ ] **Step 3: R217, in place.**
  - After "in both cases `tree-sitter-al` shapes the construct correctly. The grammar is not the problem in either case" add: `[Qualified 2026-09-27: true for CALLS. For ASSIGNMENTS in an asserterror body, tree-sitter-al 4.3.0 built assignment_expression, not a statement (upstream #28, R216's U3), so the grammar WAS part of the problem there until 4.4.1.]`
  - In the table row `asserterror_statement.body`, set "cost today" to the measured product/test figure, and add below the table: STOP `ruled out as measured, not added (R216, 2026-09-27)`; CONTINUE `added (<commit>)`.
  - R217 stays open (options 1 and 2 are untouched).
- [ ] **Step 4: Regenerate and test the index**

```bash
bun scripts/roadmap-index.ts
bun test scripts/roadmap-index.test.ts
grep -cP '\x{2014}' docs/roadmap/R216.md docs/roadmap/R217.md docs/roadmap/R283.md   # new text adds none
```

Expected: PASS; the em-dash count is not higher than before the edit (older text may hold some).

- [ ] **Step 5: Commit**

```bash
git add docs/roadmap/R216.md docs/roadmap/R217.md docs/roadmap/R283.md ROADMAP.md
git commit -m "roadmap(R216): correct R283, R216 and R217 in place; record the asserterror census"
```

### Task 5 (CONTINUE only): Engine change, test first, NOT committed yet

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts:39-54`
- Test: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/engine/tests/ast/grammar-shapes.test.ts`

**Interfaces:** No new symbol. `isStatementSlot(node)` returns `true` when `node.parent.rawKind === "asserterror_statement"` and `node.fieldName === "body"`. `gapBlockOf(node)` returns that body for any node inside it.

- [ ] **Step 1: Write the failing tests.** Add to `SLOT_CASES` in `tree-walks.test.ts`:

```ts
  ["asserterror body", "codeunit 50013 T { procedure P() begin asserterror Foo(); end; }"],
```

After the SLOT_CASES loop:

```ts
  it("isStatementSlot accepts an assignment that is an asserterror body (R216)", () => {
    const root = wrapRoot(
      parseAL("codeunit 50014 T { procedure P() begin asserterror X := Foo(); end; }"),
    );
    const hits: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.kind === ALNodeKind.assignment_statement) hits.push(n);
    });
    const [assign] = hits;
    if (assign === undefined) throw new Error("no assignment_statement under asserterror");
    expect(assign.parent?.rawKind).toBe("asserterror_statement");
    expect(isStatementSlot(assign)).toBe(true);
    expect(isStatementPosition(assign)).toBe(false);
  });
```

In the `gapBlockOf (C02-09)` describe, first read its `nodeAt` and `span` helpers (`tree-walks.test.ts` about lines 163 to 215) and match their signatures, then:

```ts
  it("an asserterror body is its own gap block (R216)", () => {
    const src = "codeunit 50015 T { procedure P() begin asserterror Foo(1, 2); X := 3; end; }";
    const root = wrapRoot(parseAL(src));
    expect(span(gapBlockOf(nodeAt(root, "2")))).toEqual(span(nodeAt(root, "Foo(1, 2)")));
  });
```

In `grammar-shapes.test.ts`, rename the R216 case to `"R216: a call that is an asserterror body IS a statement slot"`, delete the "Flip to true" comment, and assert `expect(isStatementSlot(body)).toBe(true);`.

- [ ] **Step 2: Run to see them fail**

```bash
bun run typecheck && rm -rf packages/*/dist
bun test packages/engine/tests/ast/tree-walks.test.ts packages/engine/tests/ast/grammar-shapes.test.ts
```

Expected: FAIL on exactly the four new or flipped assertions.

- [ ] **Step 3: Implement.** Add `"asserterror_statement.body",` as the last entry of `SINGLE_STATEMENT_SLOTS`, and to its doc comment:

```ts
 * `asserterror_statement.body` (R216) holds one statement since tree-sitter-al 4.4.1 (#28); before
 * that an assignment there parsed as an expression. Admitted on the census in
 * docs/superpowers/specs/2026-09-27-r216-asserterror-slot-precommitment.md.
```

- [ ] **Step 4: Run to see them pass, then the full suite**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/engine/src/ast/tree-walks.ts packages/engine/tests/ast/tree-walks.test.ts packages/engine/tests/ast/grammar-shapes.test.ts
```

Expected: all pass; baseline plus 3 tests.

- [ ] **Step 5: Red-check** with the `mutation-red-checker` subagent: remove the new entry, confirm exactly those four assertions go red and nothing else, restore, confirm green. Keep both outputs for the commit message. Do not commit: Task 6 must pass first.

### Task 6 (CONTINUE only): alc emission proof BEFORE the engine commit

**Files:**
- Create: `scripts/r216-emit-proof.ts`

- [ ] **Step 1: Write the proof.** Base it on `scripts/r161-emit-proof.ts` (copy its `findAlc`, table stub and scratch-project layout; they are not exported), with these differences, each required by review r2 and ruling 3:
  1. **Fail loudly.** When `alc` or `fixtures/sandbox-app/.alpackages` is missing, print the reason and `process.exit(1)`, never 0. (`.alpackages` is gitignored; populate it the way the fixture README says.)
  2. **The real selector, with `Reached`.** Do not copy r161's `SELECTOR_AL` stub (it has `Active` only). The assignment-root case gets a reach marker from `packages/schemata/src/dispatch.ts` (`REACH_MARKER`) that calls `MutationSelector.Reached(...)`. Use the product's own emitter instead of a hand stub, so the procedure set cannot drift:

```ts
import { emitStaticSelector } from "../packages/schemata/src/selector";
const SELECTOR_AL = emitStaticSelector({
  objectId: 79189,
  activeId: "",
  artifactId: "0123456789abcdef0123456789abcdef",
  targetAppId: "b3f1aa9f-6539-4c86-a9d0-ad702b61ac9c",
});
```

  3. **Exactly one direct-body spec per case.** Build a `SemanticContext` with `buildSemanticContext([{ path: "probe.al", root }])`. Collect only nodes with `node.fieldName === "body" && node.parent?.rawKind === "asserterror_statement"`, call the case's real operator (`removeAssignment` from `packages/builtin-tier1/src/remove-assignment.ts`, or the `void-method-call` operator from `packages/builtin-tier1/src/void-method-call.ts`) with `targets` then `generate` on those nodes only, and throw unless exactly ONE spec results. Never iterate every `targets` hit: that would also instrument the `Error('x')` inside `F()`.
  4. **Assert the text before compiling.** Instrument with `compileSchemataForFile(src, root, [spec], undefined, "probe.al")` and require `mustMatch`:

```ts
const CASES = [
  {
    name: "remove-assignment, asserterror body, last statement",
    src: `codeunit 79190 "R216 Assign" { procedure P() var X: Integer; begin asserterror X := F(); end; local procedure F(): Integer begin Error('x'); end; }`,
    op: "remove-assignment",
    mustMatch: /asserterror\s+begin\b[\s\S]*MutationSelector\.Reached\([\s\S]*\bend;/i,
  },
  {
    name: "remove-assignment, asserterror body, sibling follows",
    src: `codeunit 79191 "R216 Assign Sib" { procedure P() var X: Integer; Y: Integer; begin asserterror X := F(); Y := 1; end; local procedure F(): Integer begin Error('x'); end; }`,
    op: "remove-assignment",
    mustMatch: /asserterror\s+begin\b[\s\S]*\bend;\s*Y := 1;/i,
  },
  {
    name: "void-method-call, asserterror body",
    src: `codeunit 79192 "R216 Call" { procedure P() begin asserterror F(); end; local procedure F() begin Error('x'); end; }`,
    op: "void-method-call",
    mustMatch: /asserterror\s/i,
  },
] as const;
```

  (If the first run shows the reach marker is not emitted for the first case, the regex is wrong, not the product: print the emitted text, fix `mustMatch` to what `dispatch.ts` actually emits, and note it in the commit.)
  5. **Success is the compiler's own verdict.** For each compile, run `alc` with `spawnSync` and a fresh `/out:` path deleted beforehand. A case PASSES only when `r.status === 0` AND the `.app` file exists and is non-empty afterwards. Print the first `error AL` line on failure, but never decide on parsed diagnostics alone.
  6. **Subtype.** If P1 said `asserterror` is refused outside a test codeunit, add `Subtype = Test;` to each case and print that it did.
  7. **Negative control.** The sibling case with the `;` after the chain's `end` removed (assert the replace changed the text) must FAIL by the same criterion (non-zero status or no artifact). If it passes, the proof no longer exercises the terminator rule: exit 1.

- [ ] **Step 2: Run it with the Task 5 change in the working tree**

```bash
bun scripts/r216-emit-proof.ts; echo "exit $?"
```

Expected: 3/3 exactly-one-spec checks, 3/3 text assertions, 3/3 compiles with status 0 and an artifact, negative control failed, exit 0.

- [ ] **Step 3: If anything fails:** do not patch `dispatch.ts` or `compile.ts` in this plan. Revert the working-tree engine change (`git checkout -- packages/engine/src/ast/tree-walks.ts packages/engine/tests/ast/`), file a new roadmap item (re-check the next free id with `ls docs/roadmap/` immediately before writing), and stop.
- [ ] **Step 4: Commit the proof, then the engine change**

```bash
bunx biome check scripts/r216-emit-proof.ts
git add scripts/r216-emit-proof.ts
git commit -m "test(R216): alc proof of remove-assignment and void-method-call in an asserterror body"
git add packages/engine/src/ast/tree-walks.ts packages/engine/tests/ast/tree-walks.test.ts packages/engine/tests/ast/grammar-shapes.test.ts
git commit -m "feat(engine): asserterror_statement.body is a statement slot (R216)"
```

### Task 7 (CONTINUE only): fixture check

- [ ] **Step 1:** From the committed tree, re-run `census-operator-sites.ts` on the seven fixture targets and diff against BEFORE with `probe-census-diff.ts`. Expected: 0 gained, 0 lost on every target. This establishes that no fixture site is added or removed, and nothing more (see P3).
- [ ] **Step 2:** No live gate runs: P3 predicts none can move. If Step 1 differs, that is a BLOCK: stop and report; a live gate (`/live-gate`, Cronus28 under a coord lease) runs only after the coordinator agrees.
- [ ] **Step 3:** Append the result below a dated line after OUTCOME (never above OUTCOME) and commit that file alone.

### Task 8: Close

- [ ] **Step 1:** CONTINUE: set R216 `status: "done (<engine commit>)"` and R217's line per Task 4 Step 3. STOP: already done in Task 4.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, then commit `docs/roadmap/R216.md docs/roadmap/R217.md ROADMAP.md`.

---

## Open questions

1. **Does a CONTINUE on Microsoft product objects alone justify admission?** Ruling I4 says it comes back to the coordinator; the plan waits at Task 3 Step 3. The deciding fact is whether any such site is a deletion (reach only) or a `validate-to-assign` rewrite (carries information).
2. **Is `asserterror` legal outside a test codeunit?** R216's "`asserterror ;` compiles" did not record the subtype. Task 2 Step 1 answers it; a refusal is STOP (a).
3. **App-level classification has one known edge.** A test app is decided by an exact test-library dependency (name or id) or by holding any `Subtype = Test`/`TestRunner` codeunit. A pure test-LIBRARY app that depends on none of the five named apps and holds no test codeunit reads as `product`. Microsoft's `Application Test Library` would be one; it is not in the censused corpora, and none of the censused halves is expected to hold one. If a CONTINUE rests on such an app, the coordinator sees its object names at Task 3 Step 3 before anything is built.
4. **Should `asserterror_statement` join `STATEMENT_KINDS`** (`findEnclosingStatement`)? Today a call in the body roots its component at the next outer statement, often the whole procedure body. Changing it would move component roots for the existing non-slot-gated mutants and is out of scope; file it only if Task 6 shows a problem.
5. **Tier-2 test-half blind spot.** Running BaseApp in halves (R292) under-counts Tier-2 gains in `BaseApp/Test` that resolve symbols from `Source`. Product decisions do not depend on it; test figures in OUTCOME are lower bounds.

## Changes from r1 (review r1, rulings)

- C: gained rows are classified by enclosing object role (`scripts/r216-classify-gained.ts`); product and test are reported separately; only product decides.
- I1: the census inputs are fingerprinted exactly (all `.al`, `.dependencies` included) beside the reference identity; diffs are multisets (`probe-census-diff.ts` and the classifier).
- I2: gained rows are verified by AST ancestry (the node is the `body` field of an `asserterror_statement`), not by the line's first token.
- I3: a new `scripts/r216-emit-proof.ts` compiles REAL `remove-assignment` and `void-method-call` specs, asserts the emitted text, exits 1 when `alc` or packages are missing, and runs BEFORE the engine commit.
- I4: STOP rests only on the measured absence of deployable product sites; Microsoft-only product sites go back to the coordinator; R216 closes as a scoped, measured non-admission with the specific reason.
- I5: R216's, R217's and R283's false sentences are fixed in place with dated brackets, keeping the gated versus non-gated distinction.
- Minor: the fixture check claims only what a recursive census diff establishes; the hash-listing claim is gone.

## Changes from r2 (review r2, rulings 1 to 3)

- Ruling 1: the classifier has three outcomes, `product`, `test`, `unknown`, decided by APP: exact test-library dependency name or id (no regex; `Library Variable Storage` id verified, others only when read off an app.json), or any `Subtype = Test`/`TestRunner` codeunit in the app; every object in a test app is `test`; anything undecidable is `unknown`, which never counts as product and stops the lane (exit 3). Hand review no longer assigns roles. The repro check now covers a non-subtype helper in a test app and a file with no app.json.
- Ruling 2: a row counts toward CONTINUE only after `isEnumeratedAl`, `validateSpec`, `isMutableSite`, `dedupeSpecs` and `canCarryMutationSelectorVar`, computed by the classifier with the change applied. Fact 8 states what `isEnumeratedAl` does: `.al` minus `Mutation*` basenames, so `.dependencies` IS enumerated; r2's `dependency` role is gone.
- Ruling 3: the alc proof uses the real `emitStaticSelector` (so `Reached` exists), exactly one direct-body spec per case, and passes only on alc exit status 0 plus a present, non-empty artifact.
