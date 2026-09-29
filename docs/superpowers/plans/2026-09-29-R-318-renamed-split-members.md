# R-318: coverage attribution for a split-header procedure whose `#if` arms rename it

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A split-header procedure whose `#if` arms give it different names gets coverage attributed to it in every build, so a public one's mutants stop reading `no-coverage` while its tests run it, with no identity key moving and no chance of borrowing another member's coverage.

**Architecture:** `procedureName` stays `""` for a renamed member, so identity keys are untouched. A new engine function, `renamedMemberCoverageNames`, lists the member's arm names minus any name another declaration of the same object also uses. The manifest carries that list as a new optional field, `coverageArmNames`. The line map (fenced bcdev and al-runner's Cobertura index) spans the member under the list's first name. `coverageFilter` looks the mutant up under every name in the list. Nothing in the emitted AL changes.

**Tech Stack:** Bun, TypeScript, tree-sitter-al through the native addon (`packages/engine/native`), `bun:test`, `alc` (offline compile), and a local al-runner probe that is planned here and run only when al-runner is usable again (R338).

**Spec:** `docs/roadmap/R318.md`, `H:/lethal-coord/tasks/R-318/task.md`. Background read for this plan: `docs/roadmap/R301.md`, `R302.md`, `R316.md`, `R330.md`, `R331.md`, `R214.md`; `docs/superpowers/plans/2026-09-28-R-316-preamble-member.md` (its scratch tools are reused).

## Global Constraints

- Identity keys must not move. `IDENTITY_SCHEME` stays `2` (`packages/schemata/src/project.ts:104`). This design never changes `procedureName`, `triggerName`, `astHash`, `codeunitName`, the operator, or ordinals, which are everything `identityTupleOf` and `assignIdentityOrdinals` read. Pinned by literal keys in Task 2 and by the Task 5 key diff. If any key moves, STOP: the design is wrong, not the scheme.
- No wrong-member attribution. A coverage row may reach a renamed member's mutants only under a name that no other declaration in the same object carries, in any arm, anywhere the grammar put it (`allProcedureLikes`), and no trigger of the object carries. An object that did not parse cleanly gets no names at all. Fail toward "say less".
- No wrong-type class (R302, R330). This change touches no semantic resolution: `procedureLikeNameNode`, the symbol table, `uniqueProcedure`, `declaresProcedure` and every operator stay as they are. A renamed member is still "positional only" to the semantic layer. Nothing new is emitted, so no new `alc` failure is possible; Task 5 proves the emitted AL is byte-identical anyway.
- Emitted AL byte-identical for every repro, fixture and corpus. Manifests byte-identical except the new field on renamed members' mutants.
- No `SessionReport` field is added (see Decision 4). The stream schema gains one optional property, regenerated with `bun scripts/generate-schemas.ts`.
- No `!` non-null assertions. Optional props built as `...(v.length > 0 ? { k: v } : {})`.
- Build and test order (CLAUDE.md): `LLVM_BIN="C:/Program Files/LLVM/bin" bun scripts/build-native-parser.ts` once on a fresh worktree; `bun run typecheck`; `rm -rf packages/*/dist`; then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>`.
- No al-runner run and no live gate until the orchestrator says al-runner is usable (R338 fixed). Cronus28 is OFF; a live leg runs only if plan review asks for it. Offline `alc` is fine.
- Scratch lives under `$R` = `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318`. Nothing under `$R` is committed. Repros are hand-written with invented names; no corpus source is quoted.
- Plain English, short sentences, no em dash character anywhere (code comments and roadmap text included).
- Red-check every fix: revert the one change, show the named test go red, restore, show green. Report both outputs.

## Review Focus

1. **An arm name that another declaration of the same object also uses** (a plain overload, a `#if`-wrapped procedure, another renamed split member, a split member swallowed by the global `var` section, a trigger). Expected: that name is dropped from the member's list, the other names stay. Pinned by Task 1's collision tests and Task 3's cross-split line-map test.
2. **An object that does not parse cleanly.** Expected: no names, the member reads as today. Pinned by Task 1's `hasError` test.
3. **A coverage source reports the compiled arm's name in a different case or without quotes** (al-runner `--server`'s `st.scope`, the legacy hub). Expected: still matches (`memberKeyOf` lowercases; the list is stored unquoted). Pinned by Task 4's `CHOOSE` case and Task 1's quoted-name case.
4. **A manifest or event stream written before R318** (no `coverageArmNames`). Expected: behaves exactly as today. Pinned by Task 4's "field absent" test.
5. **Two objects in one file, only the other one declaring the colliding name.** Expected: no collision (the rule is per object). Pinned by Task 1's two-object test.

---

## Design

### Decision 1: the names live in a new manifest field, not in `procedureName`

`procedureName` is part of the identity key (`identityTupleOf`: `astHash|codeunitName|procedureName-or-triggerName|operator|major`, then an ordinal among twins). Giving a renamed member a name there moves its keys, and it moves OTHER members' ordinals too: on the dry run below, `r4-cross-split`'s second member holds the key `40277aa1...|Repro R||lethal.return-value|1|1`, ordinal 1 in the shared `""` group, which would drop to 0 the moment either member left that group. That needs a scheme bump and it breaks every stored history, resume and equivalence mark for the file.

Picking the compiled arm's name from the session's `preprocessorSymbols` (R318's first option) has the same key problem, plus a preprocessor-expression evaluator (`not`, `and`, `or`, parentheses) in two places, plus a key that differs between two sessions of the same source.

So `procedureName` stays `""` and a new optional field carries what coverage needs:

```ts
readonly coverageArmNames?: readonly string[];
```

Written only on the mutants of a renamed member that has at least one usable name. Absent everywhere else, so every other manifest is byte-identical.

### Decision 2: which names are in the list (the wrong-member guard)

`renamedMemberCoverageNames(member)` in `packages/engine/src/ast/tree-walks.ts`:

1. `[]` unless `member` is a split-header shape whose arms disagree (`procedureLikeNameNode` is `null`).
2. Find the member's object declaration (walk up until the parent is an object container, the same walk as `schemata/compile.ts`'s `enclosingObjectDeclaration`). `[]` if none, or if the object node `hasError`.
3. Collect every name any OTHER declaration of that object uses: every arm name of every other procedure-like in `allProcedureLikes(object)` (R330's list: direct members, `#if`-wrapped ones, swallowed ones), and every trigger's name.
4. Return the member's own arm names, quotes stripped, deduplicated case-insensitively (first spelling kept), in source order, minus the collected names.

Why this cannot attribute a DIFFERENT procedure's coverage: in any one build, exactly one arm of the member is compiled, so the member carries exactly one of its names. A coverage row naming `X` in object `O` comes from the compiled member called `X` in `O` (overloads share a name, so name-keyed coverage cannot tell them apart, which is why an overload also counts as a collision). If no other declaration of `O`, in any arm, carries `X`, the only thing in any build that can be called `X` in `O` is this member. So a row naming `X` is this member's row. A name that fails that test is dropped. The list is the member's own names, not a guess at one of them.

What it deliberately does not cover: an object that did not parse (a procedure hidden in an ERROR node could carry the name, so no names at all), and a `#if`-wrapped OBJECT (already refused whole for coverage by R298 before any lookup).

Dropping only the colliding names, not the whole list, is safe for the same reason: a kept name still passes the test. In a build where the dropped arm is compiled, the member reads `no-coverage`, which is today's behaviour, never a borrowed verdict.

### Decision 3: how each coverage source matches

- **Line-based sources** (fenced bcdev's line map, al-runner's Cobertura index; both use `spansOf` in `packages/runner/src/line-map.ts`): a line inside the member belongs to the member whichever arm was compiled, so the member is spanned under its list's first name. The line map is built from the EMITTED source and the manifest from the ORIGINAL; both call the same function, and Task 3 pins that the line map's name is `coverageArmNames[0]`. These paths are fixed in EVERY build, even where a name was dropped.
- **Name-based sources** (al-runner `--server` and resource legs, `st.scope`; the legacy hub, `AppMethodIndex`): they report the compiled arm's name. `coverageFilter` looks the mutant up under every name in its list and takes the union. In one build at most one of the names has rows, so the union is that one set.
- Attribution is reported `exact`: a member-level hit, as for any named procedure.
- A local renamed member on the hub still misses by name (the hub cannot name locals) and takes the existing unnamed-local path, unchanged.

The change in `coverageFilter` is the only lookup site (`packages/runner/src/selection.ts:408`, grep-verified: no other `byMember.get` or `memberKeyOf` caller outside index building).

### Decision 4: what a report shows

Nothing new in the report shape. For a public renamed member the report row changes from `verdict: "no-coverage"` to a scored verdict with `coverageAttribution: "exact"` and `coveringTests` naming the tests that ran it. `procedureName` stays `""` (the report groups such rows under `<object>`, as today). The arm names are in `mutant-manifest.json` and in the event stream (which embeds `MutantManifestEntry`). Adding them to `SessionReport` would ripple through `report.ts`, the schemas, snapshots and live-regenerated sample reports (CLAUDE.md), which cannot be done while Cronus28 is off; it is an open question, not part of this plan.

### What this plan does NOT fix

- **R214's inactive-arm mutants.** A mutant inside a `#if` arm that the build skipped is deployed but not compiled, so it cannot be killed. The dry run shows two such shapes (`r5`'s `exit(Pick(X))` / `exit(Choose(X))`, and `r3`'s `#if`-wrapped `Choose(T: Text)`). R-318 changes neither. Task 6 records them so a reader does not mistake them for R-318 regressions, and Task 7 notes the name-path variant on R214 (see Task 6, `r3` server leg).
- The killer-first test order (`test-order.ts`) keys "kills in the same procedure" on `procedureName || triggerName`, so renamed members still share the `""` bucket. Unchanged, and it never changes a verdict.

---

## Pre-commitment (measured at plan time, HEAD `b184dd5d`)

### Repros (`$R/repro/`)

Each is a target (`codeunit 50100 "Repro R"`) plus a test app (`codeunit 50150 "Repro Tests"`, `tests-<name>/`). Symbols: `R318A` (and `R318B` for `r6`).

| repro | shape |
|---|---|
| `r1-split-renamed` | `preproc_split_procedure` (shared `var`), public, `Pick` / `Choose`; plain `Plain`. Tests `PickFive`, `PickZero` (each calls the compiled arm), `PlainOnly`. |
| `r2-preamble-renamed` | the same body as a `preproc_split_procedure_preamble` (own `var` per arm). Same tests. |
| `r3-wrapped-collision` | `r1`'s member plus a `#if R318A`-wrapped plain `Choose(T: Text)`. Tests `PickFive`, `ChooseText` (calls the wrapped one under `R318A`, empty otherwise), `PlainOnly`. |
| `r4-cross-split` | two renamed split members: `Alpha` / `Beta`, then `Beta` / `Gamma`. Tests `FirstMember`, `SecondMember`. |
| `r5-local-renamed` | a `local` renamed split member `Pick` / `Choose`, called from public `Caller` through `#if` arms; public `Unused` no test calls. Test `CallerOne`. |
| `r6-elif-repeat` | three arms `#if R318A Pick` / `#elif R318B Choose` / `#else Pick`. Test `One`. |

Unit-only shapes (parse only, `$R/unit/`): `t1-trigger` (an arm named like the object's trigger), `t2-error` (a parse error elsewhere in the object), `t3-swallowed` (the member after the global `var` section, plus a plain `Choose(T: Text)`), `t4-quoted` (quoted arm names, a plain `CHOOSE` overload).

### Un-instrumented pairs compile in every build

`bun $R/alc-pair.ts <repro> tests-<repro> <symbols>` (target, then tests against it): all PASS. `r1` to `r5`: `[]` and `[R318A]`; `r6`: `[]`, `[R318A]`, `[R318B]`, `[R318A,R318B]`. 14 builds, 28 compiles, exit 0 each.

### Instrumented targets compile in every build (HEAD)

`bun $R/alc-all.ts <repro> <symbols>`: all 14 builds PASS. Emitted dirs saved to `$R/emit-before/<repro>/`.

### Dry run at HEAD (`bun $R/members.ts <repro>`, logs `$R/logs/head-members-<repro>.log`)

63 mutants. Every mutant in a renamed member has `procedureName` `""`, no `coverageArmNames`, and the line map (`lm=`) says `<unmapped>` for its line:

| repro | mutants | in renamed member(s) | named members | key-column sha256 (first 16) |
|---|---|---|---|---|
| `r1` | 13 | 10 (M0001-M0010, lines 10-15) | `Plain` 3 | `e162f7f823fcb637` |
| `r2` | 13 | 10 (M0001-M0010, lines 13-18) | `Plain` 3 | `e162f7f823fcb637` |
| `r3` | 15 | 10 (M0001-M0010) | `Choose` 2 (wrapped), `Plain` 3 | `6c221c6a064720ae` |
| `r4` | 8 | 4 + 4 (M0001-M0004, M0005-M0008) | none | `c0bfc23d1a3faf39` |
| `r5` | 10 | 4 (M0004-M0007) | `Caller` 3, `Unused` 3 | `14c9c85dc97624f7` |
| `r6` | 4 | 4 | none | `3dd6039dfabe9016` |

(`r1` and `r2` share a key sha: identical bodies, identical keys.) The key sha is `grep '^M0' <log> | sed 's/.* key=//' | sha256sum`.

### Predicted after the change (pre-committed)

`coverageArmNames` and line-map name, per member (prototype `$R/names-proto.ts`, `$R/logs/names-proto.log` and `names-proto-unit.log`, already matches):

| repro / unit | member | `coverageArmNames` | line map names its lines |
|---|---|---|---|
| `r1`, `r2` | the renamed one | `["Pick","Choose"]` | `Pick` |
| `r3` | the renamed one | `["Pick"]` (`Choose` taken by the wrapped overload) | `Pick` |
| `r3` | wrapped `Choose(T)` | absent | `Choose` (unchanged) |
| `r4` | first | `["Alpha"]` | `Alpha` |
| `r4` | second | `["Gamma"]` | `Gamma` |
| `r5` | the local one | `["Pick","Choose"]` | `Pick` |
| `r6` | the only one | `["Pick","Choose"]` | `Pick` |
| `t1-trigger` | the renamed one | `["OnRun2"]` | |
| `t2-error` | the renamed one | `[]`, field absent | |
| `t3-swallowed` | the renamed one | `["Pick"]` | |
| `t4-quoted` | the renamed one | `["Pick","Choose Me"]` | |

Every other field of every mutant, every identity key (all six key shas above), and every emitted `.al` file are unchanged. `alc-all` stays PASS for all 14 builds.

### Fixtures and corpora

`bun $R/renamed-census.ts <dir>` (split members, and renamed ones), `$R/logs/renamed-census.log`:

| corpus | `.al` files | split members | renamed |
|---|---|---|---|
| `fixtures/` (all, `sandbox-symbols` included) | 70 | 0 | 0 |
| DC/Cloud | 1135 | 11 | 0 |
| System Application | 1718 | 0 | 0 |
| BusinessFoundation | 104 | 0 | 0 |
| BaseApp | 9620 | 11 | 0 |

So no fixture or corpus manifest, emission, line map or identity key can change, and no frozen itest figure can move. Task 5 re-runs the census and diffs fixture manifests to prove it rather than argue it.

---

## Files

- Modify: `packages/engine/src/ast/tree-walks.ts` (add `renamedMemberCoverageNames`), `packages/engine/src/index.ts` (export it).
- Modify: `packages/schemata/src/project.ts` (the `coverageArmNames` field and its writer).
- Modify: `packages/runner/src/line-map.ts` (`spansOf`).
- Modify: `packages/runner/src/selection.ts` (`coverageFilter`'s member lookup).
- Regenerate: `schemas/stream-v1.schema.json`.
- Tests: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/preproc-instrumentation.test.ts`, `packages/runner/tests/selection.test.ts`.
- Roadmap: `docs/roadmap/R318.md`, `docs/roadmap/R214.md` (a dated note), regenerated `ROADMAP.md`.

---

### Task 0: Scratch toolkit and pre-commitment re-check

**Files:** scratch only. Then commit THIS PLAN, unchanged, before Task 1's first edit (the pre-commitment rule: the predictions above are on record before any code).

- [ ] **Step 1: Confirm HEAD still matches the plan's measurements.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
cd /u/Git/LethAL-wt/lane-code
test -f packages/engine/vendor/native/lethal-parser.win32-x64.node || LLVM_BIN="C:/Program Files/LLVM/bin" bun scripts/build-native-parser.ts
if grep -n "LethAL-wt/r316" "$R"/*.ts; then exit 1; fi
cd "$R/repro"
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat; do
  bun "$R/members.ts" "$r" > "$R/logs/t0-members-$r.log" 2>&1
  a=$(grep '^M0' "$R/logs/head-members-$r.log" | sed 's/.* key=//' | sha256sum)
  b=$(grep '^M0' "$R/logs/t0-members-$r.log" | sed 's/.* key=//' | sha256sum)
  test "$a" = "$b" || { echo "KEYS MOVED BEFORE CODE: $r"; exit 1; }
done
echo T0 OK
```

Expected: `T0 OK`. If HEAD moved and a key sha differs, STOP and re-measure the pre-commitment before any code.

- [ ] **Step 2: Commit the plan.**

```bash
git add docs/superpowers/plans/2026-09-29-R-318-renamed-split-members.md
git commit -m "plan(R-318): coverage attribution for renamed split members, pre-committed counts and keys"
```

---

### Task 1: `renamedMemberCoverageNames` (engine)

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts` (after `procedureLikeNameNode`, around line 186)
- Modify: `packages/engine/src/index.ts` (the `./ast/tree-walks` export list)
- Test: `packages/engine/tests/ast/tree-walks.test.ts`

**Interfaces:**
- Produces: `export function renamedMemberCoverageNames(member: ALSyntaxNode): string[]`, exported from `@lethal/engine`. `[]` for anything but a renamed split member with a usable name.

- [ ] **Step 1: Write the failing tests.** Add `renamedMemberCoverageNames` to the file's `../../src` import list, then append:

```ts
describe("R318: renamedMemberCoverageNames", () => {
  beforeAll(async () => {
    await initParser();
  });

  /** Every procedure-like node of `src`, in source order, with its coverage names. */
  const namesOf = (src: string): string[][] => {
    const out: string[][] = [];
    visit(wrapRoot(parseAL(src)), (n) => {
      if (isProcedureLike(n)) out.push(renamedMemberCoverageNames(n));
    });
    return out;
  };
  const obj = (body: string, id = 50100): string => `codeunit ${id} "Repro R${id}"\n{\n${body}\n}\n`;
  const split = (a: string, b: string, param = "X: Integer"): string =>
    `#if R318A\n    procedure ${a}(${param}): Integer\n#else\n    procedure ${b}(${param}): Integer\n#endif\n    begin\n        exit(1);\n    end;\n`;
  const plain = (name: string, param = "T: Text"): string =>
    `    procedure ${name}(${param}): Integer\n    begin\n        exit(2);\n    end;\n`;

  it("a plain procedure and an agreeing split member have none", () => {
    expect(namesOf(obj(plain("Solo") + split("Same", "same")))).toEqual([[], []]);
  });

  it("a renamed member lists each arm's name once, in source order, first spelling kept", () => {
    expect(namesOf(obj(split("Pick", "Choose")))).toEqual([["Pick", "Choose"]]);
    const three =
      "#if R318A\n    procedure Pick(X: Integer): Integer\n#elif R318B\n    procedure Choose(X: Integer): Integer\n#else\n    procedure PICK(X: Integer): Integer\n#endif\n    begin\n        exit(1);\n    end;\n";
    expect(namesOf(obj(three))).toEqual([["Pick", "Choose"]]);
  });

  it("quotes are stripped", () => {
    expect(namesOf(obj(split('"Pick"', '"Choose Me"')))).toEqual([["Pick", "Choose Me"]]);
  });

  it("a name a plain overload also uses is dropped, compared case-insensitively", () => {
    expect(namesOf(obj(split("Pick", "Choose") + plain("CHOOSE")))).toEqual([["Pick"], []]);
  });

  it("a name a #if-wrapped procedure uses is dropped", () => {
    const wrapped = `#if R318A\n${plain("Choose")}#endif\n`;
    expect(namesOf(obj(split("Pick", "Choose") + wrapped))).toEqual([["Pick"], []]);
  });

  it("two renamed members that share a name across builds each drop it", () => {
    expect(namesOf(obj(split("Alpha", "Beta") + split("Beta", "Gamma")))).toEqual([
      ["Alpha"],
      ["Gamma"],
    ]);
  });

  it("a member swallowed by the global var section still sees a later overload (R327)", () => {
    const src = obj(`    var\n        Glob: Integer;\n\n${split("Pick", "Choose")}\n${plain("Choose")}`);
    expect(namesOf(src)).toEqual([["Pick"], []]);
  });

  it("a trigger's name is taken", () => {
    const src = obj(`    trigger OnRun()\n    begin\n    end;\n\n${split("OnRun2", "OnRun")}`);
    expect(namesOf(src)).toEqual([["OnRun2"]]);
  });

  it("an object that did not parse cleanly gives no names", () => {
    const src = obj(`${split("Pick", "Choose")}\n    procedure Broken(\n    begin\n    end;\n`);
    const got = namesOf(src);
    expect(got[0]).toEqual([]);
  });

  it("the rule is per object: another object in the same file does not collide", () => {
    const src = obj(split("Pick", "Choose")) + obj(plain("Choose"), 50101);
    expect(namesOf(src)).toEqual([["Pick", "Choose"], []]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/engine/tests/ast/tree-walks.test.ts -t R318`. Expected: FAIL, `renamedMemberCoverageNames` is not exported (import error), every test red.

- [ ] **Step 3: Implement.** In `tree-walks.ts`, directly after `procedureLikeNameNode`:

```ts
/**
 * R318: the names coverage may attribute a RENAMED split member under (one whose `#if` arms give it
 * different names, so `procedureLikeNameNode` is `null`). Each arm's name once, quotes stripped,
 * compared as AL compares names (case-insensitive), first spelling kept, in source order, MINUS any
 * name another declaration of the same object uses: every arm of every other procedure-like
 * (`allProcedureLikes`, so `#if`-wrapped and swallowed ones count) and every trigger.
 *
 * Why that is safe: one arm is compiled per build, so the member carries exactly one of its names,
 * and coverage names the compiled member. A name no other declaration of the object carries, in any
 * arm, can only be this member in any build, so a coverage row under it is this member's row. A
 * shared name (an overload included, since name-keyed coverage cannot split overloads) is dropped;
 * in a build that compiles the dropped arm the member reads `no-coverage`, as before R318, never a
 * borrowed verdict. An object that did not parse gets `[]`: a declaration inside an ERROR node could
 * carry the name. `[]` for anything that is not a renamed split member.
 */
export function renamedMemberCoverageNames(member: ALSyntaxNode): string[] {
  if (member.kind === ALNodeKind.procedure || procedureLikeNameNode(member) !== null) return [];
  let object: ALSyntaxNode | null = member;
  while (object !== null && !(object.parent !== null && isObjectContainer(object.parent))) {
    object = object.parent;
  }
  if (object === null || object.hasError) return [];
  const unquote = (t: string): string => t.replace(/^"|"$/g, "");
  const key = (t: string): string => unquote(t).toLowerCase();
  const armNames = (n: ALSyntaxNode): string[] =>
    n.children.filter((c) => c.fieldName === "name").map((c) => c.text);
  const taken = new Set<string>();
  for (const p of allProcedureLikes(object)) {
    if (p.startIndex === member.startIndex && p.endIndex === member.endIndex) continue;
    for (const t of armNames(p)) taken.add(key(t));
  }
  const walk = (n: ALSyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (c.kind === ALNodeKind.trigger) {
        const name = c.childForFieldName("name");
        if (name !== null) taken.add(key(name.text));
      } else if (!isProcedureLike(c)) {
        walk(c);
      }
    }
  };
  walk(object);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of armNames(member)) {
    const k = key(t);
    if (k === "" || seen.has(k) || taken.has(k)) continue;
    seen.add(k);
    out.push(unquote(t));
  }
  return out;
}
```

`allProcedureLikes` and `isObjectContainer` are defined later in the same file; function declarations are hoisted, so no reordering is needed. In `packages/engine/src/index.ts`, add `renamedMemberCoverageNames,` after `procedureLikeNameNode,` in the `./ast/tree-walks` export list.

- [ ] **Step 4: Run, expect PASS.** `bun test packages/engine/tests/ast/tree-walks.test.ts`. Expected: every test passes, the ten R318 tests included.

- [ ] **Step 5: Red-checks.** Each: revert ONE piece, run `bun test packages/engine/tests/ast/tree-walks.test.ts -t R318`, record the red test, restore, record green.
  - Delete the `for (const p of allProcedureLikes(object))` loop: expect red on "plain overload", "#if-wrapped", "two renamed members", "swallowed".
  - Delete the trigger `walk(object)` call: expect red on "a trigger's name is taken".
  - Delete `|| object.hasError`: expect red on "did not parse cleanly".
  - Replace `object` with `member.parent` as the scope of the collision search (walk the wrong node): expect red on "#if-wrapped" at least.
  - Remove the `seen` check: expect red on the three-arm case.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/engine/src/ast/tree-walks.ts packages/engine/src/index.ts packages/engine/tests/ast/tree-walks.test.ts
git add packages/engine/src/ast/tree-walks.ts packages/engine/src/index.ts packages/engine/tests/ast/tree-walks.test.ts
git commit -m "R-318: renamedMemberCoverageNames, a renamed split member's arm names that no other declaration of its object carries"
```

---

### Task 2: the manifest field `coverageArmNames`

**Files:**
- Modify: `packages/schemata/src/project.ts` (the `MutantManifestEntry` interface after `procedureScope`; a helper beside `procedureNameOf`; the row literal in `writeInstrumentedProject`)
- Regenerate: `schemas/stream-v1.schema.json`
- Test: `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- Consumes: `renamedMemberCoverageNames(member: ALSyntaxNode): string[]` (Task 1).
- Produces: `MutantManifestEntry.coverageArmNames?: readonly string[]`, set only when non-empty.

- [ ] **Step 1: Write the failing tests.** Append to `preproc-instrumentation.test.ts`:

```ts
/** R318 repros, hand-written. `R318_R1`: a public renamed split member (lines 3-16) and `Plain`.
 *  `R318_R4`: two renamed members that share `Beta` across builds (lines 3-13 and 15-25). */
const R318_R1 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;
const R318_R4 = `codeunit 50100 "Repro R"
{
#if R318A
    procedure Alpha(X: Integer): Integer
#else
    procedure Beta(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := X + 1;
        exit(K);
    end;

#if R318A
    procedure Beta(X: Integer): Integer
#else
    procedure Gamma(X: Integer): Integer
#endif
    var
        L: Integer;
    begin
        L := X + 2;
        exit(L);
    end;
}
`;

describe("R318: a renamed split member carries its coverage names, and no identity key moves", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("r1: the renamed member's mutants list both arm names; Plain's carry none", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R1 });
    const inMember = manifest.mutants.filter((m) => m.startLine >= 3 && m.startLine <= 16);
    expect(inMember).toHaveLength(10);
    for (const m of inMember) {
      expect(m.procedureName).toBe("");
      expect(m.coverageArmNames).toEqual(["Pick", "Choose"]);
    }
    for (const m of manifest.mutants.filter((x) => x.startLine > 16)) {
      expect(m.procedureName).toBe("Plain");
      expect(m.coverageArmNames).toBeUndefined();
    }
  });

  test("r4: each member keeps only the name the other never uses", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": R318_R4 });
    const got = manifest.mutants
      .sort((a, b) => a.startIndex - b.startIndex)
      .map((m) => `L${m.startLine} ${(m.coverageArmNames ?? []).join("/")}`);
    expect(got).toEqual([
      "L10 Alpha",
      "L11 Alpha",
      "L11 Alpha",
      "L12 Alpha",
      "L22 Gamma",
      "L23 Gamma",
      "L23 Gamma",
      "L24 Gamma",
    ]);
  });

  // The pre-commitment: exactly HEAD b184dd5d's keys, measured by the R-318 plan's dry run. The
  // renamed members stay in the "" group, so r4's second return-value keeps ordinal 1.
  test("identity keys are HEAD's, byte for byte", async () => {
    const keysOf = async (src: string): Promise<string[]> => {
      const { manifest } = await instrument({ "Repro.Codeunit.al": src });
      return [...manifest.mutants]
        .sort((a, b) => a.startIndex - b.startIndex || a.mutantId.localeCompare(b.mutantId))
        .map((m) => serializeKey(identityKeyOf(m)));
    };
    expect(await keysOf(R318_R1)).toEqual([
      "1bdfa00ed4f9f5b66393ce5fa68726410673f75c945f991bd88595fd5bcc3bef|Repro R||lethal.empty-block|1",
      "8c55bdb8637a08951045fee707015dc789f78464ec2849c92df3f575da6ac6df|Repro R||lethal.remove-assignment|1",
      "bfde8a9e5399719cb19619ee057c24eedd9306fcf2d76c657c6b4a4378b24f00|Repro R||lethal.shift-integer|1",
      "42f3c401fde31149e055dfec5842326f020390b03c7018fe168a642644df6a58|Repro R||lethal.conditional-boundary|1",
      "833313f8bb3ff0f9a49296706144f2ae48dacc26d9ccab4a6105590536136497|Repro R||lethal.remove-assignment|1",
      "7b5887f1e890752bf8945f1c1173b9d1f3eba13794951eafea141f3006c040a1|Repro R||lethal.swap-additive|1",
      "2f655ef42c7141d41be438ef0a09db0588720672f6a87a7d107927722cfa2e29|Repro R||lethal.remove-assignment|1",
      "eef6d8e81fd4fed479dc4d361b5659773e7bc7701c4979e492d5698229e30863|Repro R||lethal.swap-additive|1",
      "c9159b460433d7e0187b40a3e9f1c6b24fa17f5d81145d1a4f5e81e464586890|Repro R||lethal.return-value|1",
      "78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89|Repro R||lethal.swap-additive|1",
      "d1f83cdca147307b5525047ab73ef3b96e89e7d274d898a8a0c3975ef32aa9ca|Repro R|Plain|lethal.empty-block|1",
      "cf8233fb4c95eb8f641cac7ecd90d8bfc2f40fd8ec1a247b4cc9bbbc601c6528|Repro R|Plain|lethal.return-value|1",
      "1c7f31c8ee6e40da96b0888e7c02e8a3484f8cf46ecf000ca6650d3453cfa251|Repro R|Plain|lethal.swap-additive|1",
    ]);
    expect(await keysOf(R318_R4)).toEqual([
      "13926bb4e72d79aead21ac9263d2735b6aacd45904fbe9b058371f9115262cb2|Repro R||lethal.empty-block|1",
      "833313f8bb3ff0f9a49296706144f2ae48dacc26d9ccab4a6105590536136497|Repro R||lethal.remove-assignment|1",
      "7b5887f1e890752bf8945f1c1173b9d1f3eba13794951eafea141f3006c040a1|Repro R||lethal.swap-additive|1",
      "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Repro R||lethal.return-value|1",
      "d25d06cde1e1a4a5557adb12f3773916f28b8e80b8c21b4a9f8a158463163c1e|Repro R||lethal.empty-block|1",
      "37276285a29d8c4a38baf6d602a495db9e97d227b9b18c9b00901b65b1d5e2ab|Repro R||lethal.remove-assignment|1",
      "eef6d8e81fd4fed479dc4d361b5659773e7bc7701c4979e492d5698229e30863|Repro R||lethal.swap-additive|1",
      "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Repro R||lethal.return-value|1|1",
    ]);
  });
});
```

Also extend R301's existing test `"a renamed arm names neither arm: the writer cannot tell which one is compiled"` (around line 1506): inside its loop, after `expect(m.procedureName).toBe("");`, add `expect(m.coverageArmNames).toEqual(["AIf", "AElse"]);`. Its title stays true: `procedureName` still names neither arm.

The sort order in the keys test (`startIndex`, then `mutantId`) is the order the HEAD log lists them (`startLine`, then `mutantId`); at plan time the two agree on both repros. If the first run shows only a reordering, compare as sets and say so in the commit; any differing KEY is a STOP.

- [ ] **Step 2: Run, expect FAIL.** If `bun run typecheck` covers the runner's test files it fails here (`coverageArmNames` does not exist on `MutantManifestEntry`); that is an expected red, not a blocker. Then `rm -rf packages/*/dist` and `bun test packages/runner/tests/preproc-instrumentation.test.ts -t "R318|renamed arm"`: the two field tests and the R301 test fail (`undefined`, not the list); the keys test PASSES already. It passes before the change on purpose: it is the pin that the change does not move a key, and Step 5 red-checks it.

- [ ] **Step 3: Implement.** In `packages/schemata/src/project.ts`:

Add `renamedMemberCoverageNames` to the `@lethal/engine` import. In `MutantManifestEntry`, directly after `procedureScope`:

```ts
  /**
   * R318: the names coverage may attribute this mutant under, set ONLY when its member is a
   * split-header procedure whose `#if` arms RENAME it (`procedureName` is then `""`): each arm's
   * name once, minus any name another declaration of the same object uses
   * (`renamedMemberCoverageNames`, engine). One arm is compiled per build and coverage names that
   * build's member, so a row under one of these names is this member's row in whichever build ran.
   * `procedureName` stays `""` on purpose, so identity keys do not move (IDENTITY_SCHEME unchanged).
   * Absent everywhere else and on manifests written before R318, which read as before: no member
   * hit, so a public renamed member is `no-coverage`.
   */
  readonly coverageArmNames?: readonly string[];
```

Beside `procedureNameOf`:

```ts
/** R318: see `MutantManifestEntry.coverageArmNames`. `[]` outside a renamed split member. */
function coverageArmNamesOf(spec: MutationSpec): string[] {
  const proc = enclosingProcedureLike(spec.before);
  return proc === null ? [] : renamedMemberCoverageNames(proc);
}
```

In `writeInstrumentedProject`'s loop, next to `const procedureScope = procedureScopeOf(spec, f.source);`:

```ts
      const coverageArmNames = coverageArmNamesOf(spec);
```

and in the row literal, directly after `...(procedureScope !== undefined ? { procedureScope } : {}),`:

```ts
        ...(coverageArmNames.length > 0 ? { coverageArmNames } : {}),
```

Then regenerate the stream schema: `bun scripts/generate-schemas.ts`, and confirm `bun scripts/generate-schemas.ts --check` exits 0. Expected diff: `coverageArmNames` (array of string) added as an optional property in each place `stream-v1.schema.json` describes a mutant entry (three, like `procedureScope` at lines 818, 1035, 1213), and nothing else.

- [ ] **Step 4: Run, expect PASS.** `bun run typecheck`, `rm -rf packages/*/dist`, then `bun test packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/schemas.test.ts`. Expected: all green.

- [ ] **Step 5: Red-checks.**
  - Delete the `coverageArmNames` spread line from the row literal: the two field tests and the R301 assertion go red. Restore.
  - Key pin: temporarily make `procedureNameOf` return `coverageArmNamesOf(spec)[0] ?? ""` when the member has no agreed name (the rejected Decision 1 design): the keys test goes red (the procedure part becomes `Pick` / `Alpha`, and `r4`'s `|1|1` becomes `|1`). Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/schemata/src/project.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/schemata/src/project.ts schemas/stream-v1.schema.json packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "R-318: the manifest carries a renamed split member's coverage names (coverageArmNames); procedureName and every identity key unchanged"
```

---

### Task 3: the line map spans a renamed member under its first coverage name

**Files:**
- Modify: `packages/runner/src/line-map.ts` (`spansOf`, around lines 298-310; the import list)
- Test: `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- Consumes: `renamedMemberCoverageNames` (Task 1). The name the line map uses must equal `coverageArmNames[0]` (Task 2) for the same member.
- Produces: `LineMap.lookup` returns that name for a renamed member's lines, in fenced bcdev and in al-runner's Cobertura index (both call `spansOf`).

- [ ] **Step 1: Write the failing test, and flip R316's pin.** Append to the R318 describe from Task 2:

```ts
  const R318_R3 = R318_R1.replace(
    "    procedure Plain(",
    "#if R318A\n    procedure Choose(T: Text): Integer\n    begin\n        exit(StrLen(T) + 1);\n    end;\n#endif\n\n    procedure Plain(",
  );

  test("both line maps, from the EMITTED target, name a renamed member by its first coverage name", async () => {
    // Line-based sources place a line by position, so this holds in EVERY build, a dropped name
    // included. The boundaries are the `#if R318A` / `procedure Plain(` lines of the emitted text.
    const cases: [string, string, string[]][] = [
      ["r1", R318_R1, ["Pick", "Plain"]],
      ["r3", R318_R3, ["Pick", "Choose", "Plain"]],
      ["r4", R318_R4, ["Alpha", "Gamma"]],
    ];
    for (const [label, src, owners] of cases) {
      const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": src });
      const text = emitted.get("Repro.Codeunit.al") ?? "";
      const dir = await mkdtemp(join(tmpdir(), "lethal-r318-"));
      try {
        await writeFile(join(dir, "Repro.Codeunit.al"), text);
        const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
        const alr = await buildAlRunnerCoverageIndex(dir);
        expect(alr.refusedFiles).toEqual([]);
        const out = text.split("\n");
        const starts = out.flatMap((l, k) =>
          l.startsWith("#if R318A") || l.startsWith("    procedure Plain(") ? [k + 1] : [],
        );
        expect([label, starts.length]).toEqual([label, owners.length]);
        const ends = [...starts.slice(1), out.length + 1];
        let checked = 0;
        for (const [i, who] of owners.entries()) {
          for (let n = starts[i] ?? 0; n < (ends[i] ?? 0); n++) {
            if (!(out[n - 1] ?? "").includes("MutationSelector.Active(")) continue;
            expect([label, n, bcdev.lookup("Codeunit", 50100, n)]).toEqual([label, n, who]);
            expect([label, n, alr.lineMap.lookup("Codeunit", 50100, n)]).toEqual([label, n, who]);
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(owners.length);
        // The line map's name is the manifest's first coverage name, for every renamed mutant.
        for (const m of manifest.mutants) {
          const first = m.coverageArmNames?.[0];
          if (first !== undefined) expect(owners).toContain(first);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
```

In R316's test `"both line maps, built from the EMITTED target, name every dispatch line of a named split member and none of a renamed one"` (around line 2306): rename it to `"... name every dispatch line of a split member, a renamed one by its first coverage name (R318)"`, and replace both `x.name || undefined` with `x === renamed ? "Pick2" : x.name`. `Pick2` is the renamed member's `#if` arm name in that fixture, and no other declaration there uses it or `Choose`.

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/preproc-instrumentation.test.ts -t "line maps"`. Expected: the new test fails on the first renamed line (`undefined`, want `Pick`), and the flipped R316 test fails the same way (`undefined`, want `Pick2`).

- [ ] **Step 3: Implement.** In `line-map.ts`, add `renamedMemberCoverageNames` to the `@lethal/engine` import. In `spansOf`, replace the comment and the name line of the `isProcedureLike` branch:

```ts
    // R301, R316: a split-header procedure, either shape, is one procedure (one shared body). Its
    // span starts at the `#if` line, which holds no code, so no covered line can land there.
    // R318: an arm that renames the procedure is spanned under its first coverage name, one no
    // other declaration of the object uses (`renamedMemberCoverageNames`), which the manifest
    // lists in `coverageArmNames`. A line belongs to the member whichever arm was compiled, so
    // this holds in every build. No such name: no span, as before R318.
    if (isProcedureLike(n)) {
      const nameNode = procedureLikeNameNode(n);
      const name =
        nameNode === null ? (renamedMemberCoverageNames(n)[0] ?? null) : stripQuotes(nameNode.text);
```

The rest of the branch (`if (name !== null && name !== "")`, `procedures.push(span(n, name))`, `return`) is unchanged. `renamedMemberCoverageNames` already returns unquoted names.

- [ ] **Step 4: Run, expect PASS.** `bun test packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/line-map.test.ts packages/runner/tests/al-runner-coverage.test.ts`. Expected: all green.

- [ ] **Step 5: Red-check.** Put back `const name = nameNode === null ? null : stripQuotes(nameNode.text);`: both line-map tests go red (`undefined`). Restore. Then replace `[0]` with `.at(-1)` (a name that disagrees with the manifest's first): the new test goes red on `r1` (`Choose`, want `Pick`). Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/runner/src/line-map.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/runner/src/line-map.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "R-318: the line map spans a renamed split member under its first coverage name (fenced bcdev and al-runner Cobertura)"
```

---

### Task 4: `coverageFilter` looks a renamed member up under every coverage name

**Files:**
- Modify: `packages/runner/src/selection.ts` (the member-level lookup, lines 407-410)
- Test: `packages/runner/tests/selection.test.ts`

**Interfaces:**
- Consumes: `MutantManifestEntry.coverageArmNames` (Task 2).
- Produces: no new export. A renamed member's mutant is `covered` with attribution `exact` when any of its names has member-level coverage.

- [ ] **Step 1: Write the failing tests.** Append to `selection.test.ts` (it already defines `entry`, `t1`, `t2`):

```ts
describe("R318: a renamed split member is attributed under its coverage names", () => {
  const covNaming = (procedure: string) => ({
    granularity: "procedure" as const,
    entries: [{ objectType: "Codeunit", objectId: 70000, procedure }],
  });
  const renamed = () =>
    entry({ procedureName: "", procedureScope: "public", coverageArmNames: ["Pick", "Choose"] });

  test("either arm's name covers it, in any case, with exact attribution", () => {
    for (const compiled of ["Pick", "CHOOSE"]) {
      const index = buildCoverageIndex([
        { ref: t1, coverage: covNaming(compiled) },
        { ref: t2, coverage: covNaming("Plain") },
      ]);
      const split = coverageFilter([renamed()], index, [t1, t2], undefined, false);
      expect([compiled, split.covered.get("M0001")]).toEqual([compiled, [t1]]);
      expect(split.attribution.get("M0001")).toBe("exact");
    }
  });

  test("a name outside its list does not cover it (the negative control)", () => {
    const index = buildCoverageIndex([{ ref: t1, coverage: covNaming("Take") }]);
    const m = renamed();
    const split = coverageFilter([m], index, [t1, t2], undefined, false);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });

  test("without the field (a manifest from before R318) it reads as before: uncovered", () => {
    const index = buildCoverageIndex([{ ref: t1, coverage: covNaming("Pick") }]);
    const m = entry({ procedureName: "", procedureScope: "public" });
    const split = coverageFilter([m], index, [t1, t2], undefined, false);
    expect(split.covered.size).toBe(0);
    expect(split.uncovered).toEqual([m]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/selection.test.ts -t R318`. Expected: the first test fails (`undefined`, want `[t1]`); the other two pass already (they pin what must NOT change; Step 5 red-checks them).

- [ ] **Step 3: Implement.** In `coverageFilter`, replace

```ts
    // Member-level first: precise, and correct for every ordinary procedure.
    let testKeys = index.byMember.get(
      memberKeyOf(m.objectType, m.codeunitId, m.procedureName, context),
    );
```

with

```ts
    // Member-level first: precise, and correct for every ordinary procedure. R318: a split member
    // whose `#if` arms rename it has `procedureName` "" and lists its coverage names instead; one
    // arm is compiled per build and no other declaration of the object carries any of them
    // (`MutantManifestEntry.coverageArmNames`), so the union is that build's member only. Without
    // the field, the "" key below is today's lookup exactly.
    const memberNames = m.procedureName !== "" ? [m.procedureName] : (m.coverageArmNames ?? [""]);
    let testKeys: ReadonlySet<string> | undefined;
    for (const name of memberNames) {
      const hit = index.byMember.get(memberKeyOf(m.objectType, m.codeunitId, name, context));
      if (hit === undefined) continue;
      testKeys = testKeys === undefined ? hit : new Set([...testKeys, ...hit]);
    }
```

If `tsc` rejects a later assignment to `testKeys` (from `byObject.get` / `byObjectUnnamed.get`) because those maps' value type differs from `ReadonlySet<string>`, widen the declared type to that map's value type union; do not add a cast.

- [ ] **Step 4: Run, expect PASS.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test packages/runner/tests/selection.test.ts`. Expected: all green, every pre-existing coverage test included.

- [ ] **Step 5: Red-checks.**
  - Put the old single lookup back: the first R318 test goes red. Restore.
  - Replace `(m.coverageArmNames ?? [""])` with `(m.coverageArmNames ?? ["Pick"])` (a guessed name): the "without the field" test goes red. Restore.
  - Make the loop cover by ANY member of the object (replace the `memberKeyOf` lookup with `index.byObject.get(objectKeyOf(m.objectType, m.codeunitId, context))`): the negative-control test goes red. Restore.

- [ ] **Step 6: Commit.**

```bash
bunx biome check packages/runner/src/selection.ts packages/runner/tests/selection.test.ts
git add packages/runner/src/selection.ts packages/runner/tests/selection.test.ts
git commit -m "R-318: coverageFilter attributes a renamed split member under its coverage names (exact), never under a name outside the list"
```

---

### Task 5: offline verification (keys, emission, alc every subset, fixtures, corpora, full suite)

**Files:** scratch only; nothing committed.

- [ ] **Step 1: The dry run after the change.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
cd "$R/repro"
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat; do
  bun "$R/members.ts" "$r" > "$R/logs/after-members-$r.log" 2>&1
  a=$(grep '^M0' "$R/logs/head-members-$r.log" | sed 's/.* key=//' | sha256sum)
  b=$(grep '^M0' "$R/logs/after-members-$r.log" | sed 's/.* key=//' | sha256sum)
  test "$a" = "$b" || { echo "KEY MOVED: $r"; exit 1; }
  test "$(grep -c '^M0' "$R/logs/head-members-$r.log")" = "$(grep -c '^M0' "$R/logs/after-members-$r.log")"
done
grep -h "^M0" "$R"/logs/after-members-*.log | sed -E 's/.* arms=([^ ]*) lm=([^ ]*) .*/\1 \2/' | sort | uniq -c
```

Expected: no `KEY MOVED`, counts unchanged (63), and the `arms lm` tally exactly (the line map is read on the ORIGINAL source here, so `lm` for a renamed member is its first name):

```
      3 - Caller
      2 - Choose
      9 - Plain
      3 - Unused
      4 Alpha Alpha
      4 Gamma Gamma
     10 Pick Pick
     28 Pick/Choose Pick
```

(`Pick/Choose`: 10 in `r1`, 10 in `r2`, 4 in `r5`, 4 in `r6`. `Pick`: `r3`'s 10.) Any other tally is a STOP: compare against the pre-commitment table, find the cause, do not adjust the expectation.

- [ ] **Step 2: Emission unchanged, manifests changed only by the new field, alc every subset.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
cd "$R/repro"
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat; do
  syms=R318A; test "$r" = r6-elif-repeat && syms=R318A,R318B
  bun "$R/alc-all.ts" "$r" "$syms" > "$R/logs/after-alc-$r.log" 2>&1
  tail -1 "$R/logs/after-alc-$r.log" | grep -q " PASS$" || { echo "ALC FAIL: $r"; exit 1; }
  for f in "$R/emit-before/$r"/*.al; do cmp "$f" "$R/emit-$r/$(basename "$f")"; done
  bun "$R/manifest-diff.ts" "$R/emit-before/$r/mutant-manifest.json" "$R/emit-$r/mutant-manifest.json"
done
echo T5S2 OK
```

Expected: every `alc-all` line PASS (14 builds), every `cmp` silent, and each `manifest-diff` prints `MANIFEST EQUAL apart from coverageArmNames` after listing exactly the renamed members' mutants with the arms from the pre-commitment table. Then `T5S2 OK`.

- [ ] **Step 3: Fixtures and corpora.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
for d in U:/Git/LethAL-wt/lane-code/fixtures "U:/Git/DC/Cloud" "U:/Git/BC.History/System Application" "U:/Git/BC.History/BusinessFoundation" "U:/Git/BC.History/BaseApp"; do
  bun "$R/renamed-census.ts" "$d" | tail -1
done > "$R/logs/after-census.log"
diff "$R/logs/renamed-census.log" "$R/logs/after-census.log" || true
if grep -v " renamed=0$" "$R/logs/after-census.log"; then echo "RENAMED MEMBER FOUND"; exit 1; fi
```

Expected: every line ends `renamed=0` (the fixtures line is new in the after-log; the four corpus lines equal the plan-time ones). With no renamed member, `renamedMemberCoverageNames` returns `[]` for every member, so no field is written and no span changes: fixture and corpus manifests, emissions, line maps and keys are unchanged by construction. For direct evidence on the fixtures, also run `bun "$R/members.ts" U:/Git/LethAL-wt/lane-code/fixtures/sandbox-symbols | grep -c "arms=-"` and expect it to equal that file's mutant count (`grep -c '^M0'`).

- [ ] **Step 4: Full suite in CLAUDE.md order.**

```bash
cd /u/Git/LethAL-wt/lane-code
bun run typecheck
rm -rf packages/*/dist
bun test
bun scripts/generate-schemas.ts --check
bunx biome check packages/engine/src/ast/tree-walks.ts packages/engine/src/index.ts packages/schemata/src/project.ts packages/runner/src/line-map.ts packages/runner/src/selection.ts packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/selection.test.ts
```

Expected: typecheck clean, every test green (report the pass count), schemas fresh, biome clean on touched files. `bun run compile:fixtures` is not needed: no `.al` under `fixtures/` changed.

- [ ] **Step 5: Optional, `bun run mutate`.** Only if the orchestrator wants it; it does not cover `selection.ts`'s new lines unless they fall inside its configured files (`selection.ts` is one of them). Read `docs/mutation-testing-ourselves.md` before reading a score.

---

### Task 6: al-runner coverage probe (PLANNED; run only when the orchestrator says al-runner is usable, R338)

**Files:** scratch only. `$R/alrunner-probe.ts` (R-316's, repointed to this worktree; `COV=1` turns on al-runner coverage, `SERVER=1` the `--server` leg, `RESOURCE=1` the server plus `selectorMode: "resource"` leg; each mutant line prints `attr=` and `tests=`).

This is the two-build test R318's closing text asks for, and the coverage-differential for this attribution change: the coverage-OFF one-shot run is the oracle (it runs every test, so its verdicts do not depend on attribution).

- [ ] **Step 1: Record the build.** `"$LETHAL_ALRUNNER_PATH" --version` (or the first line the probe prints) into `$R/logs/ar-version.log`. If it is not the build R338 was fixed against, stop and ask.

- [ ] **Step 2: Run, serially, one session at a time.**

```bash
set -euo pipefail
R=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r318
export LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
cd "$R/repro"
for r in r1-split-renamed r2-preamble-renamed r3-wrapped-collision r4-cross-split r5-local-renamed r6-elif-repeat; do
  syms=R318A; test "$r" = r6-elif-repeat && syms=R318A,R318B
  bun "$R/alrunner-probe.ts" "$r" "tests-$r" "$syms" > "$R/logs/ar-$r-off.log" 2>&1 || true
  COV=1 bun "$R/alrunner-probe.ts" "$r" "tests-$r" "$syms" > "$R/logs/ar-$r-cov.log" 2>&1 || true
  COV=1 SERVER=1 bun "$R/alrunner-probe.ts" "$r" "tests-$r" "$syms" > "$R/logs/ar-$r-server.log" 2>&1 || true
  COV=1 RESOURCE=1 bun "$R/alrunner-probe.ts" "$r" "tests-$r" "$syms" > "$R/logs/ar-$r-resource.log" 2>&1 || true
done
grep -H "SUBSET\|baselineGreen\| PASS$\| FAIL$\|THREW" "$R"/logs/ar-*.log
```

56 sessions (14 builds, four legs). Every session must print `baselineGreen=true` and `errors=0`. A `THREW` or a red baseline is a STOP (R-303's rule): report it; do not re-run it into a pass.

- [ ] **Step 3: Compare with the predictions.** Hand-derived from the repros (the test values are chosen so each mutant's effect on the returned number is visible); the coverage-OFF logs are the check on the hand derivation. Per subset, per leg, `killed / survived / no-coverage`:

| repro | subset | coverage OFF (oracle) | one-shot Cobertura, ON | `--server` and resource, ON |
|---|---|---|---|---|
| `r1` | `[]`, `[R318A]` | 12 / 1 / 0 | 12 / 1 / 0 | 12 / 1 / 0 |
| `r2` | `[]`, `[R318A]` | 12 / 1 / 0 | 12 / 1 / 0 | 12 / 1 / 0 |
| `r3` | `[R318A]` | 14 / 1 / 0 | 14 / 1 / 0 | 14 / 1 / 0 |
| `r3` | `[]` | 12 / 3 / 0 | 12 / 1 / 2 | 3 / 2 / 10 |
| `r4` | `[]`, `[R318A]` | 8 / 0 / 0 | 8 / 0 / 0 | 4 / 0 / 4 |
| `r5` | `[]`, `[R318A]` | 6 / 4 / 0 | 6 / 1 / 3 | 6 / 1 / 3 |
| `r6` | all four | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |

Per mutant (coverage ON; every covered mutant `attr=exact`):

- `r1`, `r2`: the member's 10 mutants covered by exactly `PickFive,PickZero`; all killed except the `conditional-boundary` (`X > 1` to `X >= 1`: no test passes 1), which survives. `Plain`'s 3 covered by exactly `PlainOnly`, killed.
- `r3`, `[R318A]`: the member's 10 covered by exactly `PickFive` (9 killed, the boundary survives); the wrapped `Choose`'s 2 by exactly `ChooseText`, killed; `Plain` as above.
- `r3`, `[]`, one-shot: the member as in `[R318A]` (line-based, so the dropped name does not matter); the wrapped `Choose`'s 2 are `no-coverage` (not compiled in this build, never executed).
- `r3`, `[]`, server and resource: the compiled member is called `Choose`, which is not in its list (`["Pick"]`), so its 10 read `no-coverage`, as before R318. The wrapped `Choose`'s 2 are attributed `PickFive` through `st.scope` "Choose" and SURVIVE: they are in the arm this build skipped, so they are not compiled. That is R214's class reached through a name-reporting source, it is the same at HEAD, and it is exactly the borrow R-318's collision rule refuses to add for the renamed member. Record it; it is not an R-318 regression.
- `r4`: one-shot, the first member's 4 covered by exactly `FirstMember`, the second's 4 by exactly `SecondMember`, all killed (the negative control: `SecondMember` never covers the first member). Server and resource: in `[R318A]` the first member (compiled `Alpha`) is covered and killed, the second (compiled `Beta`, dropped) reads `no-coverage`; in `[]` the reverse (compiled `Beta` dropped, compiled `Gamma` covered).
- `r5`: the local member's 4 covered by exactly `CallerOne`, killed, attribution `exact` (it was `no-coverage` at HEAD). `Caller`'s 3 covered by `CallerOne`: the `empty-block` killed; of the two `return-value` mutants in `Caller`'s `#if` arms, the one in the compiled arm is killed and the other SURVIVES (R214, unchanged). `Unused`'s 3 `no-coverage`.
- `r6`: 4 covered by exactly `One`, killed, in every subset and leg (`[R318B]` compiles `Choose`, the others `Pick`; both are in the list).

At HEAD the same run gives every renamed member's mutants `no-coverage` with coverage ON (R318's measurement on `p10-renamed` and `p9-all`); a HEAD run is not required, since the coverage-OFF oracle is the same before and after.

Pass rule: every coverage-ON verdict equals that mutant's coverage-OFF verdict, except the mutants named `no-coverage` above; every covered mutant's `tests=` equals the list above; the counts equal the table. Any difference is a STOP. A difference that is only a hand-derivation slip (the OFF oracle disagrees with the table for a mutant R-318 does not touch) is reported with the OFF log, and the table is corrected in a dated addendum before the next step; a difference in a mutant R-318 touches is a defect.

---

### Task 7: roadmap closure

**Files:** `docs/roadmap/R318.md`, `docs/roadmap/R214.md`, `ROADMAP.md` (generated).

- [ ] **Step 1: R318.** Set `status` to `done (<first commit>..<last commit>)` and append a dated closing record: the design (Decisions 1 to 4, one short paragraph each), the collision rule and why it cannot borrow, "IDENTITY_SCHEME unchanged, no key moved" with the Task 5 evidence, the alc and emission evidence (14 builds, byte-identical `.al`), the census (0 renamed members in fixtures and four corpora), the red-checks, and Task 6's result (or, if the orchestrator rules that R318 closes before Task 6 runs, say so and name what is still unmeasured). Plain English, no em dash.

- [ ] **Step 2: R214 note.** Only if Task 6 measured it: append a dated paragraph saying that a name-reporting coverage source (al-runner `--server`, `st.scope`) also attributes coverage to a `#if`-wrapped member the build skipped, when a compiled member of the same name exists (measured on `r3`, subset `[]`: 2 mutants covered by a test that never reached them, scored `survived`), and that line-based sources read them `no-coverage`.

- [ ] **Step 3: Regenerate and check.**

```bash
cd /u/Git/LethAL-wt/lane-code
bun scripts/roadmap-index.ts
bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R318.md docs/roadmap/R214.md ROADMAP.md
git commit -m "roadmap(R318): close, renamed split members get coverage under their collision-free arm names; keys unchanged"
```

---

## Self-review notes

- Spec coverage: a truthful name for every build (Decisions 1 to 3, Tasks 1 to 4); identity keys (Global Constraints, Task 2's literal keys, Task 5 Step 1); no wrong-type class (no semantic change, Task 5 Step 2 byte-identical emission and alc); pre-committed counts and keys (Pre-commitment); alc every subset (Task 5 Step 2); offline al-runner probe with predicted verdicts (Task 6); roadmap closure (Task 7); build and test order (Task 5 Step 4).
- R318's second option (attribute by the name the coverage source reports) is what Decision 3 does for name-based sources; its first option (evaluate `preprocessorSymbols`) is rejected in Decision 1.
- Live Cronus28: not planned. The fenced bcdev path uses the same `spansOf` as al-runner's Cobertura index, and Task 3 pins both on the emitted source. A live leg is an open question.

## Open questions for the orchestrator

1. Close R318 after Tasks 1 to 5 (offline evidence, probe pending on R338), or hold the closure until Task 6 runs?
2. Should the arm names also reach the `SessionReport` row and `lethal explain` (a report-schema change whose committed sample reports must be regenerated live, so not while Cronus28 is off)?
3. Is a live fenced bcdev leg on Cronus28 wanted (the `coverage-differential` skill's two-mode gate), given al-runner's ON/OFF run covers the attribution offline and fenced shares `spansOf`?
4. The collision rule drops only the colliding names and keeps the rest. The stricter alternative (no names at all if any arm name collides) is one line; say if you prefer it.
5. The R214 name-path note (Task 7 Step 2): a note on R214, or a new roadmap item?
