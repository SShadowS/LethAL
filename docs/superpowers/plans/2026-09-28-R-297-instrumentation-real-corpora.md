# R-297: real corpora instrument (R297, R298 writer half, split procedures) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r3 (2026-09-28), final.** Revised per review r2 (`H:/lethal-coord/reviews/R-297-plan/review-r2.md`) and the coordinator's rulings. What changed: the H1/H2 branch is gone. By DEFAULT the scorer REFUSES coverage for a `#if`-wrapped object, per object, as a named refusal in both coverage paths (line map and al-runner): no crash, no attribution, and unaffected objects keep scoring (C, Task 4). The live measurement and real scoring of wrapped objects move to follow-up R-298b, filed as the first execution step; R298 stays OPEN until R-298b, and this landing needs no container. Split procedures are narrowed to "no throw" plus the manifest fields and coverage span that project-local walks can give; semantic resolution (symbol-table indexing, `types.ts`'s own procedure walk, the engine's `findEnclosingProcedure` that feeds `semantic/receiver.ts`, `empty-block`'s parent test) is OUT, and the sites it loses are filed, not claimed (I1, Task 5). `a-preamble` keeps throwing and is filed; only its selector position is tested, in isolation (I2). Two-arm tests use a different procedure name per arm and reject the inactive arm's name (I3). The alc harness copies the repro `app.json`, applies `injectControlDependency`, then sets each symbol configuration; the Control minimum is 1.0.0.20 (I4). The corpus hash check names the R297 selector move (the attribute-only `#if` shape) as an expected change, computed mechanically (I5).

r2 summary, still in force: the selector anchor is an allowlist prefix rule; every placement shape the landing admits is alc-proven under both symbol sets; whole BaseApp is proven only by a whole-corpus run, else UNMET; emitted-file equality excludes only `app.json`; corpora are fingerprinted at both captures. Rulings on the r1 open questions: upstream grammar issue #29 is already filed and the LethAL workaround stays until a grammar bump removes it; inactive-arm mutants, per-file refusal and `describeObjectKinds` are filed, not fixed; the whole-run abort stays.

**Goal:** `generateMutationSet` + `writeInstrumentedProject` complete on DC/Cloud, System Application, BusinessFoundation and whole BaseApp; a wrapped object's coverage is refused by name instead of crashing or misattributing; a split-header procedure instruments with correct manifest name, scope, gap and coverage span; every fixture's sites, hashes, identity keys and emitted files are unchanged.

**Architecture:** Every defect here is one of two kinds: a walk that stops at a preprocessor wrapper node it does not know (`preproc_conditional_object`, `preproc_split_procedure`), or an edit that assumes a `var_section` holds only declarations. The object-container rule lives once in `@lethal/engine` (`isObjectContainer`, `objectDeclarationsOf`) and the writer and both coverage indexes use it. The split-procedure rule (`isProcedureLike`) is used by the writer, the manifest and the line map, but deliberately NOT by the engine's `findEnclosingProcedure`, whose semantic consumers stay unchanged. The selector var is inserted, never replaces the section.

**Tech Stack:** Bun, TypeScript, tree-sitter-al (WASM), `bun:test`, `alc` (offline compile). No container, no live run.

**Spec:** `docs/roadmap/R297.md`, `docs/roadmap/R298.md`, `docs/roadmap/R251.md`, reviews r1 and r2 above. The "Root causes, measured at plan time" section is the design.

## Root causes, measured at plan time (2026-09-28, HEAD `b463d8c`)

Found by a scratch per-file locator (Task 0 Step 1) that runs the real `generateMutationSet`, then `compileSchemataForFile` per file inside `try/catch`, so one corpus reports every failing file, not the first. File names only; every repro below is hand-written.

**Class A, R297, "overlapping rewrites".** The grammar's `var_body` accepts `preproc_conditional_var`, whose arms accept any `_body_element` (procedures, triggers, `preproc_split_procedure`, `preproc_split_procedure_preamble`, attributes), and it also accepts a bare `preproc_split_procedure` (tree-sitter-al `grammar.js`, `var_body` and `preproc_conditional_var`). So a `#if` block holding a procedure right after the object's `var` section becomes part of that section. `injectSelectorVarIntoObject` REPLACES the whole `var_section` text, so any edit inside the swallowed procedure (a dispatch chain, or a latch's zero-width insert) overlaps it and `assertNoOverlap` throws. dc's `130..9494` is `CDCCaptureRTCLibrary.Codeunit.al` lines 8..213 (var section through `#endif`), its insert a latch at line 27. Without the throw the emission is still wrong AL: the selector would land after `#endif`, after a procedure. Not R251's mechanism (no double injection); `assertNoOverlap` is right to refuse. A LATENT sibling found by the census: a `#if` holding only an ATTRIBUTE at the end of the var section (dc: 1 file) belongs to the procedure after the section, so today's append puts the selector between an attribute and its procedure, with no throw.

Var-section child census (files with a `var_body` child other than a plain declaration): BaseApp 4,129 `pragma`, 375 `var_attribute_item`, 73 `comment`, 113 `preproc_conditional_var` of declarations, 18 `preproc_conditional_var` holding `attribute_item`+`procedure`; sysapp 1 holding `procedure`, 1 `attribute_item`+`procedure`, 1 `preproc_region`; dc 2 `attribute_item`+`procedure`, 1 `attribute_item` alone, 64 holding `pragma`. `preproc_split_procedure_preamble`: 0 in every corpus.

**Class B, R298, a guard inside `preproc_conditional_object`.** A `#if`-wrapped object parses as `source_file > preproc_conditional_object > <object>_declaration`, one declaration per arm. Four walks stop at `source_file`'s direct children and so miss it or misname it:
1. `enclosingObjectDeclaration` (`compile.ts`) returns the wrapper, so the injector throws;
2. `latchNameFor` (`compile.ts`) walks the same way (over-avoids names, harmless, but a second copy of the rule);
3. `fileLineMapEntries` (`packages/runner/src/line-map.ts`) iterates `fileRoot.children`, so the object gets NO line map; if the artifact declares it and coverage arrives, `LineMap.lookup` throws "declared but unmapped" (review C);
4. `objectsOf` (`packages/runner/src/al-runner-coverage.ts`) reads `root.namedChildren`, so al-runner coverage silently drops the file; flattened naively, a two-arm file would count as TWO objects and trip the upstream #3713 "multi-object file disables coverage for the whole run" guard.

`canCarryMutationSelectorVar` uses recursive `findFirst` and is already right. Shape census (wrapped objects by declarations inside): dc 4 single-arm; sysapp 22 two-arm; bcf 10 two-arm; BaseApp 9 single-arm, 132 two-arm, 1 nested. **Two-arm is the dominant shape.** Mapping two arms of ONE object needs to know how BC and al-runner number the compiled arm (does the other arm's TEXT count as a previous object?), which is unmeasured and needs a container; so this landing REFUSES wrapped-object coverage by name and R-298b measures and scores it.

**Class C (new, to be filed), split-header procedures.** `preproc_split_procedure` (header per arm, shared `var_section` and `code_block` as direct children, measured) is neither `procedure` nor `trigger_declaration`. `injectReachLatches` finds no owner and throws `a reach marker sits outside any procedure or trigger body`. The same blindness, silent: `findEnclosingProcedure` (engine) returns null, so `procedureName` is `""`, `enclosingMemberOf` gives no member, `procedureScopeOf` cannot see `local` (the node text starts with `#if`), `gapBlockOf` misses the body block and can return the file root, and `spansOf` (line-map) gives the procedure no coverage span. R297/R298 masked the throw. Semantic resolution is blind too, in three places this landing does NOT touch (ruling I1): `buildSymbolTable.indexMembers` indexes only direct `procedure` children, `semantic/types.ts` has its own procedure walk, and `empty-block` excludes a body whose parent is `preproc_split_procedure`. The engine's `findEnclosingProcedure` also feeds `semantic/receiver.ts` and `builtin-tier1/src/return-value.ts`, so it stays unchanged here too. The sites those lose in split procedures are filed (Task 8), not claimed.

**Per-file failures at plan time:**

| corpus | class A | class B | class C |
| --- | --- | --- | --- |
| dc | `CDCCaptureRTCLibrary`, `CDCXmlLibrary` | `CDCCreateWebServices`, `CDCUpgrade2800Functions`, `CDCContiniaCompanySetup.Page`, `CDCContiniaOnlineMgt` | `CDCApprovalForwardSubscr`, `CDCApprovalManagement` |
| sysapp | `AOAIDeployments`, `AOAIDeploymentsImpl` | 10 files | none |
| bcf | none | 4 files (`NoSeriesLinePurchase.Table`, ...) | none |
| baseapp | not run at plan time | | |

Other preprocessor shapes no completed run has exercised: BaseApp `preproc_split_if_else_statement` 14 files, `preproc_split_if_statement` 3, `preproc_split_begin` 1, `preproc_conditional_var_block` under a procedure 11 and under a trigger 3; dc `preproc_split_case_extended`, `preproc_split_call_statement`, `preproc_split_if_begin_asymmetric`; sysapp `preproc_split_declaration`. **Every `fixtures/*` project contains zero `preproc_*` nodes of any kind** (census, all 13 fixture directories).

## Global Constraints

- Plain English, short sentences, no em dashes, in every file this plan writes.
- No corpus source text in any committed file. File names, procedure names and counts are fine. Every repro is hand-written.
- Build/test loop, in order: `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`. `bunx biome check` only on touched files. No `!` non-null assertions; `exactOptionalPropertyTypes` rules apply.
- Fail loudly. `assertNoOverlap`, the injector's unsupported-kind throw, the latch's no-owner throw and `LineMap`'s declared-but-unmapped throw all STAY, and the whole run still aborts on one bad file (ruling 5). No failing file is skipped.
- Red-check every fix: revert only that fix, confirm the named test goes red with the named message, restore; report both outputs (`mutation-red-checker` subagent).
- Every placement shape a task admits is **alc-proven**: its emitted target compiles with exit 0 AND produces a `.app`, once as written and once with the `#if` symbol defined, so both arms compile once each (Task 0 Step 5's harness). `a-preamble` is not admitted (it keeps throwing, filed), so no compile is claimed for it.
- Fixtures cannot move: byte-identical `probe-fixture-hashes.ts` output, identity-key listing, and emitted files other than `app.json` (its version is minted per run), before vs after. Any difference is a STOP, never a re-record. No fixture figure moves, so no pre-commitment and no live gate.
- No live run and no container in this landing (the containers are blocked; ruling C). Live measurement and scoring of wrapped objects are R-298b's, which needs Control app **1.0.0.20** (`MIN_CONTROL_VERSION`, `packages/runner/src/harness.ts`) on the container. R298 stays OPEN until R-298b lands.
- Memory: RUST-01 W4 (`run --dry-run` on Base Application) peaked at **16.8 GB**. Not fixed here (RUST-01 and R292 own it). Not made worse: Task 7 compares peak RSS before and after on sysapp and dc; a rise above 10% is a STOP.
- **Whole BaseApp is proven only by a whole-corpus run.** If memory aborts it, the result is **UNMET** in the report and in R297/R298's closing text, never "complete". A per-folder run may be recorded as exploratory evidence, labelled as such.
- Corpus identity is the fingerprint (`bun scripts/corpus-fingerprint.ts <dir>`, R187), recorded at BEFORE and AFTER capture; a mismatch voids that corpus's comparison.
- `ROADMAP.md` is generated: edit `docs/roadmap/R<nnn>.md`, then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`. Re-check the next free id with `ls docs/roadmap/` immediately before each filing (R300 was free at plan time).
- Commit with explicit paths (`git commit -- <paths>`). Never stage the unrelated working-tree edits to `packages/runner/itest/tables.baseline.json` and `packages/runner/itest/tables.itest.ts`.
- R299 (mixed injectable and non-injectable objects in one file) is out of scope.

## Review Focus

1. **A wrapped object's coverage row reaching attribution anyway.** A refusal that only returns `undefined` from `lookup` still lets the bcdev fenced loop add an object-level entry, which feeds `byObjectUnnamed` and the local-procedure fallback in `selection.ts`: attribution by the back door. Task 4 skips refused objects' rows entirely in both paths and tests that NO entry of any grain is produced, while an unaffected object in the same run still yields a named entry.
2. **The selector landing inside a construct that is not a declaration list** (after a swallowed procedure, between an attribute and its procedure, inside a split preamble). Task 2's prefix rule anchors only after declaration-only content, and each shape is alc-proven under both symbol sets.
3. **A split procedure's scope when arms disagree** (`local` in one arm, public in the other). Scope `local` widens coverage to object grain (`selection.ts`, R63), which can manufacture a vacuous `survived`; public at worst reads `no-coverage`. Task 5 rules: `local` only when every arm is `local`, and tests the mixed case.
4. **Byte-identity of ordinary var sections** (trailing `#pragma`, comment, `#if` of declarations, `var_attribute_item`). Task 2 pins HEAD's exact output for each, captured from HEAD before the change.
5. **Newly admitted shapes that are wrong without throwing.** Task 6 checks sites, `procedureName` and emission for every other split shape against a de-preprocessed twin, not just "no FAIL line"; Task 5 asserts the manifest fields of split procedures, and records (does not fix) the sites semantic blindness loses there.

---

### Task 0: Scratch tools, BEFORE captures, and the alc harness (no product change)

**Files (scratch, never committed):** `$S/locate.ts`, `$S/identity-keys.ts`, `$S/shapes.ts`, `$S/anchors.ts`, `$S/alc-both.ts`, `$S/repro/<shape>/`. `$S` is the session scratchpad; set it in every call. **Committed:** `docs/roadmap/R<next>.md` (R-298b), `ROADMAP.md`.

- [ ] **Step 0: File R-298b first (ruling C).** Run `ls docs/roadmap/` for the next free id (R300 at plan time). Copy `docs/roadmap/_template.md`. Title: "R298 follow-up (R-298b): measure how BC and al-runner number a `#if`-wrapped object's lines, then score wrapped objects instead of refusing their coverage". Status `open, filed <date>`, section `correctness-risks`. Body: this landing instruments wrapped objects but REFUSES their coverage by name (Task 4), so every mutant in one reads `no-coverage`; the open question is whether the compiled arm's base line is "previous COMPILED object's end + 1" (H2, predicted: the inactive arm is disabled text) or "previous object TEXT's end + 1" (H1); the measurement needs a container (al-probe on Cronus28, Control 1.0.0.20) and al-runner with the ELSE arm compiled; the two-arm probe must name procedures differently per arm; the bcdev hub path (`AppMethodIndex`, names from the server) needs the same decision; shape counts from this plan (sysapp 22 two-arm, bcf 10, BaseApp 132). R298 closes only when R-298b does. Then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts` and `git commit -m "roadmap: file R<next>, R-298b, wrapped-object coverage is refused until measured" -- docs/roadmap/R<next>.md ROADMAP.md`.

- [ ] **Step 1: The per-file locator.**

```ts
// $S/locate.ts. Usage: bun locate.ts <project-dir>. Scratch, never committed.
import { createHash } from "node:crypto";
import { generateMutationSet, operatorTiers } from "U:/Git/LethAL/packages/runner/src/orchestrator";
import { compileSchemataForFile } from "U:/Git/LethAL/packages/schemata/src/compile";
import { buildComponents } from "U:/Git/LethAL/packages/schemata/src/components";
import { dedupeSpecs } from "U:/Git/LethAL/packages/schemata/src/dedup";
import { assignMutantIds } from "U:/Git/LethAL/packages/schemata/src/ids";
const dir = process.argv[2] ?? "";
const set = await generateMutationSet(dir);
const byFile = new Map(set.files.map((f) => [f.path, dedupeSpecs(f.specs, (n) => operatorTiers.get(n))]));
const ided = assignMutantIds(byFile);
for (const f of [...set.files].sort((a, b) => a.path.localeCompare(b.path))) {
  const line = (i: number) => f.source.slice(0, i).split("\n").length;
  const specs = byFile.get(f.path) ?? [];
  try {
    const out = compileSchemataForFile(f.source, f.root, specs, ided.get(f.path), f.path);
    console.log(`OK ${f.path} specs=${specs.length} ${createHash("sha256").update(out).digest("hex").slice(0, 16)}`);
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`FAIL ${f.path}: ${msg.slice(0, 240)}`);
    const m = /at (\d+)\.\.(\d+)/.exec(msg);
    if (m === null) continue;
    const [a, b] = [Number(m[1]), Number(m[2])];
    console.log(`  wide ${a}..${b} (lines ${line(a)}..${line(b)})`);
    for (const comp of buildComponents(ided.get(f.path) ?? [])) {
      const r = comp.root;
      if (r.endIndex < a || r.startIndex > b) continue;
      console.log(`  component ${r.rawKind} ${r.startIndex}..${r.endIndex}: ${comp.members
        .map((x) => `${x.spec.operatorName} ${x.spec.before.rawKind} ${x.spec.before.startIndex}..${x.spec.before.endIndex}`)
        .join("; ")}`);
    }
  }
}
console.log(`maxRSS_KB ${process.resourceUsage().maxRSS}`);
```

- [ ] **Step 2: Identity keys.** Copy `$S/identity-keys.ts` verbatim from `docs/superpowers/plans/2026-09-27-TSAL-441-grammar-bump.md` Task 3 Step 3; append `console.log(\`maxRSS_KB ${process.resourceUsage().maxRSS}\`);`.

- [ ] **Step 3: Shape census.** `$S/shapes.ts` parses every `.al` under a directory with `parseAL`, walks named children, and prints per-kind file counts for: every `preproc_*` kind; `preproc_conditional_object` by number of declarations inside; each `var_body` child kind other than `variable_declaration`, and for a `preproc_conditional_var` the non-marker kinds it holds. It deletes each tree after walking.

- [ ] **Step 4: Repros.** One directory per shape under `$S/repro/`, each with this `app.json` (the `preprocessorSymbols` line is added only by the harness):

```json
{"id":"00000000-0000-0000-0000-000000000001","name":"repro","publisher":"repro","version":"1.0.0.0","runtime":"16.0","idRanges":[{"from":50100,"to":50149}]}
```

Shapes, all hand-written, every procedure with at least one assignment (so a statement-grain latch is emitted) and one call:
- `a-swallow`: object var section, then `#if not CLEAN27` + procedure `A` with locals + `#endif`, then procedure `B` (the class A repro).
- `a-only-swallow`: as `a-swallow` with no declaration before the `#if`.
- `a-mixed`: var section whose `#if` holds a declaration `H: Integer;` and then procedure `A`.
- `a-attr`: var section ending with `#if not CLEAN27` `[Obsolete('x', '27.0')]` `#endif`, then procedure `A` (the latent sibling).
- `a-bare-split`: var section followed directly by a split-header procedure (grammar puts it in `var_body`; Step 6 confirms the tree).
- `a-preamble`: var section followed by `#if` header + its own var section `#else` header + var section `#endif` shared body (`preproc_split_procedure_preamble`). Expected to keep THROWING when a spec sits inside the preamble procedure (no latch owner; filed). Used only for the isolated selector-position test, with a spec in another procedure.
- `a-ordinary-*`: controls, each a var section ending in: a plain declaration; `#if` of declarations; `#pragma warning disable AL0432`; a `// comment`; a `[NonDebuggable]` variable attribute.
- `b-single`: `#if not CLEAN27` codeunit 50101 `#endif` (the class B repro).
- `b-two-arm`: `#if CLEAN27` codeunit 50103 `#else` codeunit 50103 `#endif`, the SAME object type and id in both arms, and a DIFFERENT procedure name per arm (`AIf` in the IF arm, `AElse` in the ELSE arm), so a test can reject the inactive arm's name.
- `b-mixed-file`: a bare codeunit 50104 `Plain`, then a `#if` wrapper holding codeunit 50105, then a bare codeunit 50106 `After` (the per-object refusal boundary for Task 4).
- `c-split`: codeunit with a split-header procedure, public in one arm and `internal` in the other (the class C repro).
- `c-split-local`: both arms `local`. `c-split-mixed`: `local` in one arm only.

- [ ] **Step 5: The alc harness** `$S/alc-both.ts <repro-dir> <symbol>`. `writeInstrumentedProject` writes AL and the manifest, NOT `app.json`, and the target must DECLARE the Control dependency, not only have its symbols staged (`packages/runner/src/harness.ts`). So, in order: run `identity-keys.ts` into `$S/emit-<name>`; read the REPRO's `app.json`, pass it through `injectControlDependency` (imported from `U:/Git/LethAL/packages/runner/src/harness`), and write the result to `$S/emit-<name>/app.json`; stage the built `LethAL Control` `.app` (1.0.0.20 or newer, see `.claude/skills/control-app`) in `$S/emit-<name>/.alpackages`; compile with `alc` (discovery as in `.claude/skills/al-compile`) with `preprocessorSymbols` ABSENT; then rewrite `app.json` with `"preprocessorSymbols": ["<symbol>"]` and compile again. Print per compile the exit code and whether a new `.app` exists. PASS means both compiles exit 0 with an artifact.

- [ ] **Step 6: BEFORE captures.**

```bash
S=<scratchpad>; cd /u/Git/LethAL
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-before-$f.txt"
  rm -rf "$S/target-before-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-before-$f" > "$S/ids-before-$f.txt"
done
for d in fixtures/*/; do bun "$S/shapes.ts" "$d"; done
for r in "$S"/repro/*/; do echo "== $r"; bun "$S/locate.ts" "$r" 2>&1 | grep -v '^\[lethal\]'; bun "$S/tree.ts" "$r"/*.al | head -40; done
declare -A C=([dc]="U:/Git/DC/Cloud" [sysapp]="U:/Git/BC.History/System Application" [bcf]="U:/Git/BC.History/BusinessFoundation" [baseapp]="U:/Git/BC.History/BaseApp" [do]="U:/Git/do-rel2/Cloud" [sentinel]="U:/Git/BusinessCentral.Sentinel")
for k in "${!C[@]}"; do bun scripts/corpus-fingerprint.ts "${C[$k]}" > "$S/fp-before-$k.txt"; done
for k in dc sysapp bcf do sentinel; do bun "$S/locate.ts" "${C[$k]}" 2>&1 | grep -v '^\[lethal\]' > "$S/locate-before-$k.txt"; done
for k in do sentinel; do rm -rf "$S/target-before-$k"; bun "$S/identity-keys.ts" "${C[$k]}" "$S/target-before-$k" > "$S/ids-before-$k.txt"; done
bun "$S/locate.ts" "${C[baseapp]}" > "$S/locate-before-baseapp.txt" 2>&1; echo "baseapp exit $?"
```

(`$S/tree.ts` prints `rawKind start..end` per named node; write it alongside `shapes.ts`.) Also run `$S/anchors.ts` (Step 8) over dc, sysapp, bcf and BaseApp. Expected: every fixture has zero `preproc_*` nodes; each repro's tree shows the shape its name claims (e.g. `a-bare-split` has `preproc_split_procedure` under `var_body`; if the grammar parses a repro differently, rewrite the repro until it does, and record the final shape); `a-*` swallow repros and `b-*`, `c-*` print `FAIL` with the class's message; the `a-ordinary-*` controls and `a-attr` print `OK`; the corpus lists match the plan-time table. BaseApp: record exit and `maxRSS_KB`; an abort is recorded, not fatal here.

- [ ] **Step 7: HEAD's output for the controls.** For each `a-ordinary-*` repro and `a-attr`, save HEAD's emitted file to `$S/head-emit-<name>.al`. Task 2's byte-identity tests use these, so the expectation comes from the old code. Also run `$S/alc-both.ts` on `a-attr` at HEAD and record the result (predicted: a compile failure, the latent defect; if it compiles, record that and keep the shape as a control).

- [ ] **Step 8: The expected-change list for R297's selector move (ruling I5).** `$S/anchors.ts <dir>` parses every `.al` and, for every carrier object with an object-level `var_section`, compares the OLD anchor (`var_section.endIndex`, what HEAD appends at) with the NEW one (Task 2's rule: end of the leading declaration-only run of `var_body`, else the `var` keyword). It prints `file object old new firstBlockingKind` for every object where they differ. This is the complete list of files whose emitted AL R297 may legitimately change, and why. Save it as `$S/anchor-moves-<k>.txt`. Expected: only the shapes in "Root causes" (swallowed procedures, the attribute-only `#if`); an unexpected blocking kind is recorded and examined before Task 2.

---

### Task 1: The overlap error names the file and both node kinds

**Files:** Modify `packages/engine/src/ast/printer.ts`, the `printWithRewrites` call in `packages/schemata/src/compile.ts`. Test `packages/engine/tests/ast/printer.test.ts`.

**Interfaces:** Produces `printWithRewrites(source, root, rewrites, where?: string): string`; message `overlapping rewrites in <where> at <a>..<b> (<rawKind>) and <c>..<d> (<rawKind>)`, ` in <where>` omitted when undefined.

- [ ] **Step 1: Failing test.**

```ts
it("names the file and both node kinds when two rewrites overlap (R297)", async () => {
  await initParser();
  const source = "codeunit 50100 X\n{\n    procedure P()\n    begin\n        Message('a');\n    end;\n}\n";
  const root = wrapRoot(parseAL(source));
  const proc = findFirst(root, ALNodeKind.procedure);
  const call = findFirst(root, ALNodeKind.procedure_call);
  if (proc === null || call === null) throw new Error("fixture shape");
  expect(() => printWithRewrites(source, root, new Map([[proc, "x"], [call, "y"]]), "src/X.Codeunit.al")).toThrow(
    `overlapping rewrites in src/X.Codeunit.al at ${proc.startIndex}..${proc.endIndex} (procedure) and ${call.startIndex}..${call.endIndex} (${call.rawKind})`,
  );
});
```

- [ ] **Step 2:** `bun test packages/engine/tests/ast/printer.test.ts`. Expected FAIL (old message).
- [ ] **Step 3:** Carry `kind: node.rawKind` per edit, add `where`, build the message; `compileSchemataForFile` passes `filePath ?? "<file>"`. Update any test asserting the old text (`grep -rn "overlapping rewrites" packages --include=*.test.ts`).
- [ ] **Step 4:** `bun test packages/engine packages/schemata`. Expected PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(engine): an overlapping-rewrites error names the file and both node kinds (R297)" -- <the files above>`

---

### Task 2: R297, insert the selector after the leading declaration-only run of the var section

**Decision.** Not a dedup or §3.2 precedence matter (no two operators collide) and `assertNoOverlap` is not too strict. The injector must stop replacing the section and insert at a point that is provably inside a declaration list. Rule: walk `var_body`'s named children from the start while each is DECLARATION-ONLY, and insert right after the last one of that leading run; if the run is empty (or there is no `var_body`), insert right after the `var` keyword. DECLARATION-ONLY is an allowlist: `variable_declaration`, `var_attribute_item`, `comment`, `multiline_comment`, `pragma`, `preproc_region`, `preproc_endregion`, and a `preproc_conditional_var` whose every named child is a `preproc_if`/`preproc_elif`/`preproc_else`/`preproc_endif` marker or itself declaration-only. Everything else (a procedure, a trigger, either split kind, an `attribute_item`, anything the grammar adds later) ends the run. Why an allowlist: the grammar admits any `_body_element` inside a conditional var, so a list of "member kinds" (r1's `holdsMember`) is always one kind short; `preproc_split_procedure_preamble` was the one it missed. For an ordinary section every child is on the allowlist, so the anchor is the section's last child and the text equals HEAD's.

The position-keyed object map closes R251's concern at the one place it could bite: `injectMutationSelectorVar` keys objects by `startIndex` (R209), because the `rewrites.has(existingVar)` identity guard disappears with the replace.

**Files:** Modify `packages/schemata/src/compile.ts` (`injectSelectorVarIntoObject`, `injectMutationSelectorVar`). Test `packages/schemata/tests/compile.test.ts`; create `packages/runner/tests/preproc-instrumentation.test.ts`.

**Interfaces:** Produces the runner test helper `instrument(files: Record<string, string>, appJsonExtra?: Record<string, unknown>): Promise<{ manifest: MutantManifest; emitted: Map<string, string> }>`, used by Tasks 3 to 6.

- [ ] **Step 1: Failing unit tests.** `describe("R297: the selector var is inserted after the leading declarations")` in `compile.test.ts`, one test per `a-*` repro (source inlined as a template literal, spec on the assignment inside `A` or `B` via the file's `spec` helper, one tree walk per source). Each test FIRST asserts the parse shape it relies on (e.g. `a-swallow`: the object `var_body`'s second named child is `preproc_conditional_var` and it holds a `procedure`), so a grammar change cannot make it vacuous. Then:
  - `a-swallow`, `a-mixed`, `a-attr`, `a-bare-split`: no throw; exactly one `MutationSelector: Codeunit` line; its offset is before the first `#if` of the var section and after the last declaration of the leading run (for `a-mixed`: before the `#if`, so before `H`).
  - `a-preamble`, IN ISOLATION (ruling I2): the only spec sits in procedure `B`, outside the preamble, so no latch is needed there; assert the selector's offset only (before the `#if`). No pipeline or compile success is claimed for this shape: a spec inside the preamble procedure still throws (no latch owner), which is filed (Task 8) and pinned by one more test expecting that throw.
  - `a-only-swallow`: the selector directly follows `var`.
  - each `a-ordinary-*`: output `toBe` the saved `$S/head-emit-<name>.al` contents, inlined as the expected string.
  - R251's decider: specs for one object taken from TWO separate `findFirst` walks; exactly one selector line.
- [ ] **Step 2: Run** `bun test packages/schemata/tests/compile.test.ts -t "R297|R251"`. Expected: swallow-shaped tests FAIL with `overlapping rewrites in ... (var_section)`; `a-attr` FAILS on the offset assertion (selector after the attribute); controls PASS; record whether R251's test fails at HEAD.
- [ ] **Step 3: Implement.**

```ts
const DECLARATION_ONLY: ReadonlySet<string> = new Set([
  "variable_declaration", "var_attribute_item", "comment", "multiline_comment",
  "pragma", "preproc_region", "preproc_endregion",
]);
const PREPROC_MARKERS: ReadonlySet<string> = new Set(["preproc_if", "preproc_elif", "preproc_else", "preproc_endif"]);

/** R297: true when `n` can only hold declarations, so a `var` line may follow it. An allowlist:
 *  the grammar lets any body element (procedures, split procedures, attributes) into a
 *  `preproc_conditional_var`, and a denylist of member kinds is always one kind short. */
function isDeclarationOnly(n: ALSyntaxNode): boolean {
  if (DECLARATION_ONLY.has(n.rawKind)) return true;
  if (n.rawKind !== "preproc_conditional_var") return false;
  return n.namedChildren.every((c) => PREPROC_MARKERS.has(c.rawKind) || isDeclarationOnly(c));
}
```

and in `injectSelectorVarIntoObject`, replace the `existingVar` branch:

```ts
  const existingVar = members.find((c) => c.kind === ALNodeKind.var_section);
  if (existingVar !== undefined) {
    // R297: insert, never replace; see `isDeclarationOnly`. For an ordinary section the leading
    // declaration-only run is the whole section, so the emitted text is unchanged.
    const body = existingVar.children.find((c) => c.rawKind === "var_body");
    let anchor = existingVar.children.find((c) => c.rawKind === "var_keyword");
    for (const c of body?.namedChildren ?? []) {
      if (!isDeclarationOnly(c)) break;
      anchor = c;
    }
    if (anchor === undefined) {
      throw new Error(`compileSchemataForFile: cannot instrument ${filePath}: its var section has no \`var\` keyword to anchor the selector var after.`);
    }
    rewrites.set(insertionNodeAt(anchor, anchor.endIndex), `\n        MutationSelector: Codeunit "Mutation Selector";`);
    return;
  }
```

In `injectMutationSelectorVar`: `const objects = new Map<number, ALSyntaxNode>();`, `objects.set(object.startIndex, object);`, iterate `objects.values()`; doc comment says "deduped by start offset (R209)".

- [ ] **Step 4: Pipeline test.** Create `packages/runner/tests/preproc-instrumentation.test.ts` modelled on `gap-id-fixtures.test.ts`: `instrument` writes `app.json` (plus `appJsonExtra`) and the files to a `mkdtemp` dir, runs `generateMutationSet` and `writeInstrumentedProject` (selector ids 50147 / 50148 / 50149, artifact id `0123456789abcdef0123456789abcdef`), reads `mutant-manifest.json` and each emitted file, and removes both temp dirs in `finally`. First test: `a-swallow` yields a manifest entry with `procedureName === "A"` and one selector line. If field names or the emitted layout differ, read `packages/schemata/src/project.ts` and fix the test.
- [ ] **Step 5: Run** the loop; expected PASS.
- [ ] **Step 6: alc-proven.** `bun $S/alc-both.ts $S/repro/<name> CLEAN27` for every `a-*` repro except `a-preamble`. Expected: PASS (both compiles, exit 0, artifact) for all, including `a-attr`, which Task 0 Step 7 recorded failing at HEAD.
- [ ] **Step 7: Red-check.** Restore the old replace branch: swallow tests and the pipeline test FAIL with `overlapping rewrites in ... (var_section)`, `a-attr` fails its offset assertion, controls stay green. Restore. Then make `isDeclarationOnly` return true for `preproc_conditional_var` unconditionally: `a-swallow`, `a-mixed`, `a-attr` and the isolated `a-preamble` position test go red on the offset. Restore. Then restore the identity-keyed set: report whether R251's test goes red. Report all outputs.
- [ ] **Step 8: Commit.** `git commit -m "fix(schemata): the selector var is inserted after the var section's leading declarations, never replaces the section (R297)" -- packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts`

---

### Task 3: R298 writer side, one shared "object container" rule

**Decision.** Instrument, do not drop: a wrapped carrier is a carrier, `canCarryMutationSelectorVar` already says so, and each arm's object gets the var inside its own braces. Mutants in an arm the build compiles out are a known, separately filed issue (ruling 2, Task 8). The rule lives once, in the engine, and every walk that asks "is this a top-level object" uses it.

**Files:** Modify `packages/engine/src/ast/tree-walks.ts` (+ export in `packages/engine/src/index.ts`), `packages/schemata/src/compile.ts` (`enclosingObjectDeclaration`, `latchNameFor`). Test `packages/engine/tests/ast/tree-walks.test.ts`, `packages/schemata/tests/compile.test.ts`, `packages/runner/tests/preproc-instrumentation.test.ts`.

**Interfaces:** Produces, from `@lethal/engine`:
- `isObjectContainer(n: ALSyntaxNode): boolean`: `source_file`, or `preproc_conditional_object`.
- `objectDeclarationsOf(root: ALSyntaxNode): ALSyntaxNode[]`: the named children of `root` with every `preproc_conditional_object` flattened recursively and `preproc_*` markers dropped, in source order.

- [ ] **Step 1: Failing tests.** Engine: `objectDeclarationsOf` on `b-single` returns one `codeunit_declaration`; on `b-two-arm`, two, in order; on the nested BaseApp-like shape (a wrapper inside a wrapper), the inner declaration. Schemata: `b-single` compiles with one selector line inside the codeunit's braces; `b-two-arm` with specs in both arms (one walk) has two selector lines, one before `#else` and one after; a statement-grain spec in `b-single` emits `LethALReachLatch: Boolean;`. Pipeline: `b-single` and `b-two-arm` manifests have entries with `objectType` `codeunit` and the right `objectId`; in `b-two-arm`, every entry whose `startLine` is before the `#else` line has `procedureName` `AIf` and NOT `AElse`, and every entry after it has `AElse` and NOT `AIf` (ruling I3: a wrong-arm attribution fails by name); all identity keys (`serializeKey(identityKeyOf(m))` from `../src/selection`) are distinct. `b-mixed-file`: entries carry `objectId` 50104, 50105 and 50106 by position.
- [ ] **Step 2: Run.** Expected: engine tests fail (no export); schemata and pipeline tests FAIL with `a mutation guard sits inside preproc_conditional_object`.
- [ ] **Step 3: Implement.**

```ts
/** R298: the nodes whose children are AL object declarations. A `#if`-wrapped object sits under a
 *  `preproc_conditional_object` (one declaration per arm), never directly under `source_file`. */
export function isObjectContainer(n: ALSyntaxNode): boolean {
  return n.kind === ALNodeKind.source_file || n.rawKind === "preproc_conditional_object";
}

export function objectDeclarationsOf(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (const c of root.namedChildren) {
    if (c.rawKind === "preproc_conditional_object") out.push(...objectDeclarationsOf(c));
    else if (!c.rawKind.startsWith("preproc_")) out.push(c);
  }
  return out;
}
```

`enclosingObjectDeclaration` returns `current` when `current.parent !== null && isObjectContainer(current.parent)`; update its doc comment. `latchNameFor` uses `const object = enclosingObjectDeclaration(owner) ?? owner;`.
- [ ] **Step 4: Run** the loop; expected PASS.
- [ ] **Step 5: alc-proven.** `bun $S/alc-both.ts` on `b-single` (symbol `CLEAN27`: the second compile has an empty file, which must still exit 0 with an artifact), `b-two-arm` and `b-mixed-file` (each compile builds one arm). Expected PASS.
- [ ] **Step 6: Red-check.** Revert `enclosingObjectDeclaration` to the `source_file` test: schemata and pipeline tests FAIL with `preproc_conditional_object`. Restore; report both.
- [ ] **Step 7: Commit.** `git commit -m "fix(schemata): one object-container rule, so #if-wrapped objects instrument (R298, writer)" -- <files above>`

---

### Task 4: R298 coverage side, wrapped objects are REFUSED by name, per object (ruling C)

**Decision.** How BC and al-runner number the lines of a compiled `#if` arm is unmeasured (R-298b, filed in Task 0 Step 0), and a guessed base names the wrong procedure with full confidence (R29's shape). So by default the scorer refuses coverage for a wrapped object: no crash (today `LineMap.lookup` throws "declared but unmapped"), and no attribution of ANY grain (an object-level entry would feed `byObjectUnnamed` and `selection.ts`'s local-procedure fallback, which is attribution by the back door). Its mutants then read `no-coverage`. Objects not affected keep scoring. The refusal is NAMED: one warning per object per session with a fixed prefix, in the style the backends already use (`console.warn("[lethal] ...")`), so no `SessionReport` field and none of its ripples; a report field is R-298b's to decide.

**Which objects are affected.** Every object declared inside a `preproc_conditional_object`, AND every object declared after the first such wrapper in the same file: a bare object's base is "previous object's end + 1", and whether the wrapper's inactive arm counts as that previous object is exactly R-298b's unknown. Objects before the first wrapper, and every object in other files, are unaffected. In the al-runner path coverage is already per FILE (a file must hold one object, upstream #3713), so there a file holding any wrapper is refused whole.

**Files:** Modify `packages/runner/src/line-map.ts` (`LineMapEntry`, `fileLineMapEntries`, `LineMap`), `packages/runner/src/bcdev-backend.ts` (the fenced-coverage row loop around `lineMap.lookup`, about line 1030, and its `warnOnThinFencedCoverage` call), `packages/runner/src/al-runner-coverage.ts` (`buildAlRunnerCoverageIndex`, `AlRunnerCoverageIndex`). Tests `packages/runner/tests/line-map.test.ts`, the bcdev fenced-coverage test file (`grep -ln "namingGaps" packages/runner/tests`), the al-runner coverage test file (`grep -ln buildAlRunnerCoverageIndex packages/runner/tests`).

**Interfaces:** Consumes `objectDeclarationsOf` (Task 3). Produces:
- `LineMapEntry.refused?: string`, the reason, set by `fileLineMapEntries` on affected objects.
- `LineMap.isRefused(objectType: string, objectId: number): boolean`; `lookup` returns `undefined` for a refused object and never throws for it; `isNamingGap` returns `false` for it.
- `AlRunnerCoverageIndex.refusedFiles: readonly string[]` (forward slashes, like `multiObjectFiles`); a refused file is in none of `byFile`, `declared`, `multiObjectFiles`.
- The warning text, fixed: `[lethal] coverage refused for <Type>:<id> (<file>): it is declared inside, or after, a #if ... #endif object wrapper, and how the compiled arm's lines are numbered is not yet measured (R<R-298b id>). Its mutants read no-coverage.`

- [ ] **Step 1: Failing tests.**
  - Line map (`lineMapFromSources`, all objects declared): sources `b-two-arm` (50103), `b-mixed-file` (50104 bare, 50105 wrapped, 50106 bare after) and a plain file with codeunit 50107. `isRefused` is true for 50103, 50105, 50106 and false for 50104, 50107. `lookup` on every line of 50103 returns `undefined` WITHOUT throwing (at HEAD it throws "declared ... but no line map"). `lookup` names 50104's and 50107's procedures at their lines: unaffected objects still score.
  - bcdev fenced conversion: rows for 50103 (several lines) and 50107: `entries` hold 50107 with its `procedure`, and NO entry of any grain for 50103; the refusal warning is printed exactly once for 50103 (`spyOn(console, "warn")`); the thin-coverage warnings do not blame the base-line frame when the only declared rows were refused.
  - al-runner: `buildAlRunnerCoverageIndex` over a temp dir holding `b-two-arm`'s file and the plain file: the wrapped file is in `refusedFiles` and absent from `byFile` and `multiObjectFiles`; both the Cobertura conversion and `alRunnerCoverageFromServer`, given hits in both files, return entries for 50107 only; the refusal warning is printed once.
- [ ] **Step 2: Run.** Expected: the line-map and bcdev tests FAIL with the "declared but no line map" throw; the al-runner test FAILS on `refusedFiles` (undefined) and the missing warning.
- [ ] **Step 3: Implement.** `fileLineMapEntries` walks `fileRoot`'s named children in order: a bare object declaration gets an entry as today (base `previousEndLine + 1`), carrying `refused` once a wrapper has been seen earlier in the file; a `preproc_conditional_object` yields an entry per declaration in `objectDeclarationsOf(child)`, each with `refused` set; `previousEndLine` advances to each node's end. The `LineMap` constructor puts refused keys in a `refused: Map<string, string>` and builds no spans for them; `lookup`, `isNamingGap` and `isRefused` read it first. In the bcdev loop, right after the `declares` check: `if (lineMap.isRefused(objectType, row.objectId)) { this.warnRefusedOnce(...); refusedRows += 1; continue; }`, with a per-backend `Set` of warned keys; pass `refusedRows` to `warnOnThinFencedCoverage` and skip its base-line blame when `declaredRows === 0 && refusedRows > 0`. In `buildAlRunnerCoverageIndex`, before `objectsOf`, a file whose root has a `preproc_conditional_object` child holding a declaration is pushed to `refusedFiles`, warned once, and skipped.
- [ ] **Step 4: Run** the loop; PASS.
- [ ] **Step 5: Red-check.** (a) Drop the `isRefused` early `continue` in the bcdev loop: the bcdev test goes red. (b) Drop `refused` from wrapper entries in `fileLineMapEntries`: the line-map test goes red (50103 gets spans, `isRefused` false). (c) Drop the al-runner wrapper check: the al-runner test goes red on `refusedFiles`. Restore each; report all.
- [ ] **Step 6: Fixtures untouched by construction.** No fixture contains a wrapper (Task 0), so no fixture object is refused and no coverage behaviour on a fixture changes; Task 7 Step 2's byte-identity is the proof. For that reason no `coverage-differential` run is needed; say so in the commit message.
- [ ] **Step 7: Commit.** `git commit -m "fix(runner): coverage for #if-wrapped objects is refused by name, per object, in the line-map and al-runner paths (R298; scoring is R-298b)" -- packages/runner/src/line-map.ts packages/runner/src/bcdev-backend.ts packages/runner/src/al-runner-coverage.ts <the three test files>`

---

### Task 5: Split-header procedures, no throw plus manifest fields (class C, narrowed by ruling I1)

**Scope.** In: the latch owner (the throw), and the manifest fields and coverage span that project-local walks can give (`procedureName`, member, `procedureScope`, gap block, line-map span). Out, and filed (Step 1): semantic resolution inside a split procedure. `buildSymbolTable.indexMembers` indexes only direct `procedure` children, `semantic/types.ts` has its own procedure walk, `empty-block` refuses a body whose parent is `preproc_split_procedure`, and the engine's `findEnclosingProcedure` feeds `semantic/receiver.ts` and `builtin-tier1/src/return-value.ts`. None of those change, so a split procedure keeps HEAD's site set; its lost sites are recorded, not claimed. `preproc_split_procedure_preamble` is also out: each arm has its own `var_section`, so one latch declaration cannot serve both arms; it keeps throwing (pinned in Task 2) and is filed.

Each fix below is its own commit, so the coordinator can drop any of Steps 4b to 4d at verification without touching the rest.

**Files:** Create `docs/roadmap/R<next>.md` (class C) and `docs/roadmap/R<next+1>.md` (the semantic blind spots). Modify `packages/engine/src/ast/tree-walks.ts` (`isProcedureLike`, `gapBlockOf`; NOT `findEnclosingProcedure`), `packages/engine/src/index.ts`, `packages/schemata/src/compile.ts` (`injectReachLatches`, `latchNameFor`), `packages/schemata/src/project.ts` (`procedureNameOf`, `procedureScopeOf`, `enclosingMemberOf`), `packages/runner/src/line-map.ts` (`spansOf`). Tests: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/schemata/tests/compile.test.ts`, `packages/runner/tests/preproc-instrumentation.test.ts`, `packages/runner/tests/line-map.test.ts`.

**Interfaces:** Produces `isProcedureLike(n: ALSyntaxNode): boolean` from `@lethal/engine`: `n.kind === ALNodeKind.procedure || n.rawKind === "preproc_split_procedure"`. Consumed by the latch owner walk, `latchNameFor`, `gapBlockOf`, a new project-local `enclosingProcedureLike(node)` in `project.ts`, and `spansOf`. Deliberately NOT consumed by `findEnclosingProcedure`.

- [ ] **Step 1: File both items** (re-check `ls docs/roadmap/` first). Class C: "A split-header procedure (`preproc_split_procedure`) has no reach-latch owner, so the injector throws", the cause, dc's `CDCApprovalForwardSubscr` and `CDCApprovalManagement`, found by R-297's per-file locator. Semantic blind spots: "Semantic resolution does not see inside a split-header procedure, so its type-dependent sites are lost", naming the four places above and the corpus file counts from Task 0's census (dc 3, BaseApp 4). Regenerate the index; commit both with `ROADMAP.md`.
- [ ] **Step 2: Failing tests.**
  - Compile (4a): `c-split` with a spec on `L := X` does not throw and emits `L: Integer; LethALReachLatch: Boolean;`.
  - Pipeline (4b): `instrument({ "Split.Codeunit.al": C_SPLIT })` gives entries whose `procedureName` is `A` (HEAD: `""`), and whose member fields (the ones `enclosingMemberOf` fills; read `project.ts` for their names) name `A`.
  - Scope (4c): `procedureScope` is `public` for `c-split` and `c-split-mixed`, `local` for `c-split-local`.
  - Gap (4d): `gapBlockOf` of a top-level statement in the split body returns its `code_block`, not the root; in the pipeline, `blockStartLine`/`blockEndLine` are the body's lines and two body statements share a `gapId`.
  - Line map (4d): a covered line inside the split body names `A`.
  - Sites unchanged (control): after Step 4a lands, record `c-split`'s `operatorName` multiset; after Steps 4b to 4d it must be identical. Those steps change fields, never sites.
- [ ] **Step 3: Run.** Each FAILS for its reason: reach-marker throw, `""` name, `public` for `c-split-local`, root gap block, `undefined` line-map name.
- [ ] **Step 4a: Latch.** `injectReachLatches`' owner loop stops at `isProcedureLike(owner) || owner.kind === ALNodeKind.trigger`; `latchNameFor`'s skip uses the same test. Run; alc-proven: `bun $S/alc-both.ts` on `c-split`, `c-split-local`, `c-split-mixed` with symbol `CLEAN27`, PASS. Red-check: revert the loop condition, the compile test goes red with the reach-marker message. Commit.
- [ ] **Step 4b: Name and member.** In `project.ts`, `enclosingProcedureLike(node)` walks `node.parent` upward to the first `isProcedureLike` node; `procedureNameOf` and `enclosingMemberOf` use it instead of `findEnclosingProcedure`. For a split node, `childForFieldName("name")` returns the first arm's name (measured on `c-split`'s tree); an arm that renames the procedure is outside this landing (no corpus case seen) and is noted in the class C item. Run; red-check (revert to `findEnclosingProcedure`: name test red). Commit.
- [ ] **Step 4c: Scope.**

```ts
/** A split procedure is `local` only when EVERY arm is: `local` widens coverage to object grain
 *  (selection.ts, R63), so a public arm read as local could manufacture a vacuous `survived`. */
function splitIsLocal(proc: ALSyntaxNode): boolean {
  const arms = proc.children.filter((c) => c.rawKind === "procedure_keyword").length;
  const localArms = proc.children.filter(
    (c) => c.rawKind === "procedure_modifier" && c.children.some((k) => k.rawKind === "local_keyword"),
  ).length;
  return arms > 0 && localArms === arms;
}
```

`procedureScopeOf` returns `splitIsLocal(proc) ? "local" : "public"` when `proc.rawKind === "preproc_split_procedure"`. Check the modifier shape against `$S/tree.ts` output for `c-split-local` first and adjust the child test to it. Run; red-check (return `LOCAL_SCOPE_PREFIX.test(proc.text)` for split nodes too: the `c-split-local` test goes red). Commit.
- [ ] **Step 4d: Gap and span.** `gapBlockOf`: a `code_block` whose parent is `isProcedureLike` or a trigger. `spansOf`: `isProcedureLike` nodes are procedures. Run; red-check each separately. Commit.
- [ ] **Step 5:** Full loop PASS after each commit.

---

### Task 6: The other preprocessor split shapes, focused checks, fix if small

For each shape, a hand-written repro in `$S/repro/d-<kind>/` that parses as that kind (assert the tree first): `preproc_split_if_else_statement`, `preproc_split_if_statement`, `preproc_split_begin`, `preproc_split_if_begin_asymmetric`, `preproc_split_case_extended`, `preproc_split_call_statement`, `preproc_split_declaration`, and a procedure and a trigger each with a `preproc_conditional_var_block` (`#if var ... #else var ... #endif` before `begin`) plus a statement-grain site. Each has a de-preprocessed twin (the same code with one arm kept and no directives) written alongside.

- [ ] **Step 1: Check each** through `instrument` and `bun $S/alc-both.ts`: (a) no throw; (b) the manifest's `operatorName` multiset equals the twin's for the statements both contain (a site lost or duplicated without a throw is caught here, per review r2); (c) `procedureName` and `gapId` match the twin's; (d) both-symbol compile PASS.
- [ ] **Step 2: Decide per shape.** SMALL = one walk in one function, fixed by one condition, with one red-checked test. Fix small ones here, one commit per shape. Anything larger (a new placement rule, per-arm edits, a semantic-index change) is filed as its own roadmap item with the failing check and the corpus file counts. The latch with a `preproc_conditional_var_block` is expected to be larger: HEAD emits a second `var` section before `begin`; if alc rejects it under either symbol set, it is a defect today (BaseApp: 14 members) and is filed.
- [ ] **Step 3:** Record a table (shape, checks a to d, fixed / filed R<n>) for Task 8.

---

### Task 7: Prove it, fixtures unchanged, corpora complete, memory not worse

- [ ] **Step 1: Full suite.** `bun run typecheck && rm -rf packages/*/dist && bun test`; green, counts equal HEAD's plus this plan's tests. `bunx biome check` on touched files.
- [ ] **Step 2: Fixtures.**

```bash
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-after-$f.txt"
  rm -rf "$S/target-after-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-after-$f" > "$S/ids-after-$f.txt"
  cmp "$S/hashes-before-$f.txt" "$S/hashes-after-$f.txt" && echo "$f hashes identical"
  diff <(grep -v maxRSS "$S/ids-before-$f.txt") <(grep -v maxRSS "$S/ids-after-$f.txt") && echo "$f identity keys identical"
  diff -r -x app.json "$S/target-before-$f" "$S/target-after-$f" && echo "$f emitted files other than app.json byte-identical"
done
```

Expected: 15 `identical` lines. The claim is exactly "byte-identical emitted files other than `app.json`" (its version is minted per run), not "the whole project". Anything else is a STOP: a fixture figure would move, which needs a pre-commitment and live gates this plan does not contain.
- [ ] **Step 3: Fingerprints.** `bun scripts/corpus-fingerprint.ts` per corpus into `$S/fp-after-$k.txt`; `cmp` against `fp-before-$k.txt`. A mismatch voids that corpus's before/after comparison: recapture BEFORE on the same source with HEAD's code (`git worktree add $S/head b463d8c`).
- [ ] **Step 4: Corpora that already passed.** `do`, `sentinel`: identity keys identical to BEFORE (ignoring `maxRSS_KB`).
- [ ] **Step 5: The four target corpora.** For dc, sysapp, bcf: `locate.ts` has 0 `FAIL`, and `identity-keys.ts` exits 0 and prints `raw / deployed / skippedFiles`. Every file `OK` before has the same emitted hash after, except the EXPECTED-CHANGE set, which is named in advance and inspected one by one:
  - **R297 selector moves** (ruling I5): the files in `$S/anchor-moves-<k>.txt` (Task 0 Step 8) that were `OK` before, e.g. dc's attribute-only `#if` file. For each, the emitted diff must be exactly the one `MutationSelector: Codeunit` line moving from its old anchor to its new one; any other difference is a STOP.
  - **Split procedures** (Task 5): files containing `preproc_split_procedure`; the diff must be confined to manifest fields and the latch line, with the `operatorName` multiset unchanged (Task 5 changes no sites).
  - **Task 6 fixes**: files containing a shape fixed there, each diff explained by that fix.
  A changed file outside the set is a STOP.
  Then **whole BaseApp**: `locate.ts` and `identity-keys.ts` on `U:/Git/BC.History/BaseApp`, recording exit and `maxRSS_KB`. If memory aborts either, try once with the RUST-01 Task 0 Step 6 validated capture worktree if it still exists; if that also cannot complete, whole BaseApp is **UNMET**. A per-top-level-folder locator run may be added as EXPLORATORY evidence, labelled so. Any new failure class is a STOP: file it and hand it back.
- [ ] **Step 6: Memory.** `maxRSS_KB` before vs after on dc and sysapp within 10%. Record BaseApp's peak beside W4's 16.8 GB, as a figure only.

---

### Task 8: Roadmap

- [ ] **Step 1: Close.** R297 `done (<Task 2 commit>)`: the cause, the allowlist rule, the latent attribute sibling, corpus figures, whole BaseApp MET or UNMET verbatim from Task 7 Step 5, and a link to upstream grammar issue #29 (the LethAL workaround stays until a grammar bump removes the need). Class C `done (<Task 5 Step 4a commit>)`. R251 `done (<Task 2 commit>)` if its test was red at HEAD, else a dated note that the position keying landed as defence.
- [ ] **Step 2: R298 stays OPEN** (ruling C). Add a dated paragraph: writer fixed (<Task 3 commit>); coverage for wrapped objects refused by name, per object, in both paths (<Task 4 commit>), so their mutants read `no-coverage`; scoring waits for R-298b (R<id>); whole BaseApp MET or UNMET.
- [ ] **Step 3: File** (re-check `ls docs/roadmap/` before each): inactive-arm mutants (ruling 2: guards in an arm the build's symbols compile out still get specs; in a wrapped object they now read `no-coverage` by refusal; in an in-body `#if` inside a covered procedure they are predicted, not measured, to read `survived` with reach `covered-but-unreached` where a statement marker exists); per-file refusal instead of a whole-run abort (ruling 5, with the `SessionReport` ripple list from CLAUDE.md); `describeObjectKinds` blind to wrapped objects (ruling 6; `objectDeclarationsOf` is the fix); the `preproc_split_procedure_preamble` latch (per-arm var sections, 0 corpus files); every Task 6 shape filed rather than fixed.
- [ ] **Step 4:** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`; `git commit -- docs/roadmap/<each file> ROADMAP.md`.

---

## Open questions

1. Ruling I1 says split procedures get "whatever manifest fields the existing walks support". This plan reads that as: fix the MANIFEST and line-map walks through a project-local helper, and leave every semantic walk (including the engine's `findEnclosingProcedure`) alone. If the intended reading is "no walk changes at all", drop Task 5 Steps 4b to 4d (separate commits) and file those fields in the class C item.
