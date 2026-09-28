# R-303: place the reach latch in a member whose var section is split by `#if` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r3 (2026-09-28), final.** Revised per review r2 (`H:/lethal-coord/reviews/R-303-plan/review-r2.md`) and the coordinator's rulings. What changed: the al-runner probe covers EVERY admitted repro under every subset of that repro's own symbols, and backend support is claimed only for measured-green shapes; the pre-designed al-runner contingency is gone, and any probe failure is a STOP reported to the coordinator, to become its own designed task; the mixed-file tests expect R-297's real selector position (after a declaration-only `#if` block's `#endif`, on a line of its own), and the line-count checks subtract R-297's selector lines, which add lines by design; R310 closes only if the al-runner probe is fully green; the R297 correction is narrowed (HEAD emits AL0631 where such a latch is written; the parse-shape census is kept apart from affected emissions; dc's compile status is stated as verified or unverified).

**Revision r2 (2026-09-28).** Revised per gpt-6-sol review r1 (`H:/lethal-coord/reviews/R-303-plan/review-r1.md`) and the coordinator's rulings, every finding applied. What changed: a LOCAL al-runner probe of the admitted repros under both symbol settings is now a task (Task 3) and gates any claim of backend support, (r3: every admitted repro, every symbol subset; a failure is a STOP); the hoist anchor must be the ACTUAL header end (the parameter list's `)`, the return type, or a `;` right after one of them), and alc probes cover an attribute before the member and parameters spanning lines; one test and one repro hold R-297's selector insertion and both latch insertions in the same emitted file; the "columns stay put" claim is withdrawn (only line numbers stay stable; offsets and later columns move, and the corpus and fixture comparisons are the check); the refusal warning describes the real predicate; R310 closes as a ruling with a reopen trigger; R297 gets a dated correction; an offline alc compile of dc's emitted target is attempted, else recorded as unverified and filed; BaseApp evidence is labelled exploratory throughout.

**Goal:** Give a procedure or trigger whose `var` section is split by `#if` a reach latch that is valid AL under every combination of its preprocessor symbols, lift R-297's `reach-latch-refused` refusal for every shape that is proven, and fix a second, sibling emission defect this plan's census found.

**Architecture:** Two narrow edits to `injectReachLatches` (`packages/schemata/src/compile.ts`) and one predicate change in `packages/schemata/src/dispatch.ts`. (1) **Hoist:** for a member with a `preproc_conditional_var_block`, write ONE unconditional `var <latch>: Boolean;` at the end of the header line, and blank out each arm's own `var` keyword with spaces, so every arm's declarations become conditional declarations inside that one section. (2) **Keyword anchor:** for a plain `var` section whose last declaration is a `preproc_conditional_var`, put the latch right after the `var` keyword instead of after `#endif`. No newline is ever inserted, so no line number moves. A shape the rule does not cover keeps R-297's named refusal. No backend-support claim is made until the local al-runner probe (Task 3) passes.

**Tech Stack:** Bun, TypeScript, tree-sitter-al (WASM, via `@lethal/engine`), `bun:test`, `alc` (offline compile), a local `al-runner` (`C:/Users/SShadowS/.dotnet/tools/al-runner.exe`, no container). No container, no live run.

**Spec:** `docs/roadmap/R303.md` (the defect and the minimal refusal, `3c58bbb`), `docs/roadmap/R310.md` (report-visibility follow-up), and the R-297 plan `docs/superpowers/plans/2026-09-28-R-297-instrumentation-real-corpora.md` (its alc harness, Task 0 Step 5, and its corpus proof, Task 7).

---

## What was measured at plan time (2026-09-28)

All counts come from a scratch census (Task 0 Step 2's script) over the corpora. No corpus source is quoted anywhere; every repro is hand-written with invented names.

### The two member-level `#if` var shapes (tree-sitter-al grammar, `grammar.js`)

- **BLOCK:** `_routine_regular_body` is `optional(choice(var_section, preproc_conditional_var_block))` then `code_block`. `preproc_conditional_var_block` is `preproc_if [var_section] (preproc_elif [var_section])* [preproc_else [var_section]] preproc_endif`. So the `var` KEYWORD itself sits inside an arm, and any arm may have no `var_section` at all. This is R303's shape.
- **INBODY:** an ordinary `var_section` whose `var_body` holds a `preproc_conditional_var` (declarations inside `#if`). The `var` keyword is unconditional. When the `#if` is the LAST child, today's code appends the latch after its last child, which is the `#endif` line.

### A second defect, found by this plan: INBODY-last emits code on the `#endif` line

`injectReachLatches` appends ` <latch>: Boolean;` at `lastDecl.endIndex`. When `lastDecl` is a `preproc_conditional_var`, that is the end of `#endif`, and the emission is `#endif LethALReachLatch: Boolean;`. Measured through the REAL pipeline (`generateMutationSet` + `writeInstrumentedProject` + `injectControlDependency`, Control 1.0.0.20 staged) on a hand-written repro (`procedure Pick(X: Integer): Integer`, `var`, `#if not CLEAN27`, `K: Integer;`, `#endif`, body with an `if`):

| repro | alc, CLEAN27 absent | alc, CLEAN27 defined |
| --- | --- | --- |
| INBODY-only, HEAD `a513df8` | FAIL `AL0631: Single-line comment or end-of-line expected.` | FAIL, same |
| plain var section (harness control) | PASS (exit 0, `.app`) | PASS |

So this is a defect in the product today, not a corpus artefact: any statement-grain mutant in such a member breaks the whole instrumented project's compile, under every symbol set. R-297 did not see it because it proved repros, not whole-corpus emission, and its `a-ordinary-*` controls were OBJECT var sections (the selector append, which is correct). No roadmap item names it (`grep AL0631 docs/roadmap` is empty). Task 0 files it.

### Census, members only

| corpus | files | BLOCK members | INBODY with `#if` as the LAST var child | other INBODY (`#if` not last) |
| --- | --- | --- | --- | --- |
| DC/Cloud | 1135 | 0 | 40 (17 procedures, 23 triggers) | 28 |
| System Application | 1718 | 0 | 1 (procedure) | 4 |
| BusinessFoundation | 104 | 0 | 0 | 0 |
| BaseApp, half 0 (`i % 2 = 0`, 4810 files), parse-only | 4810 | 8 | 3 | 11 |
| BaseApp, half 1, parse-only | 4810 | 6 | 8 | 12 |

The BaseApp rows are a parse-only census of every file in two processes; they count shapes and prove nothing about instrumenting or compiling BaseApp. "INBODY with `#if` last" includes the `pos=only` cases (dc 12 procedures + 21 triggers, BaseApp 2 triggers). "Other INBODY" already emits correctly (the latch goes after a plain declaration) and is a control, not a target.

BLOCK arm signatures, all corpora together: **14 members, every one `[if:V]`** (a single `#if` arm holding a `var_section`, no `#else`, no `#elif`), 11 procedures whose header ends in a return type (`type_specification` is the last child before the block) and 3 triggers ending in `)`. Zero BLOCK members in dc, sysapp, bcf. Zero BLOCK members owned by a `preproc_split_procedure` in any corpus. Zero `preproc_split_procedure_body` / `preproc_split_complete_body` under a member. Pragmas are grammar extras and never showed up as the last child of a member's `var_body`.

The `#else`, `#elif`, empty-arm and `;`/comment-before-`#if` shapes below occur in NO corpus. They are hand-written, because the rule must be valid for them too and a future BaseApp may add them.

### The placement rule, alc-proven on hand-written text (plan-time scratch, `alc` 18.0.2732683, no symbols staged)

Every row compiled once per subset of the named symbols. PASS means exit 0 and an `.app`.

| text (hand-written, shows the rule's OUTPUT) | symbols, every subset | result |
| --- | --- | --- |
| second `var` before `begin` (HEAD's pre-refusal emission, negative control) | CLEAN27 | FAIL absent (`AL0104`), PASS defined |
| `#endif LethALReachLatch: Boolean;` (INBODY-last, HEAD, negative control) | CLEAN27 | FAIL both (`AL0631`) |
| hoist, procedure with return type, `[if:V]` | CLEAN27 | PASS both |
| attribute before the member; parameters spanning lines | not yet run | Task 2 Step 8 (`s9`, `s10`) |
| hoist, trigger, `[if:V, else:V]` | CLEAN27 | PASS both |
| hoist, `[if:V, elif:-, else:V]`, the else arm opens with `[NonDebuggable]` | A, B | PASS all 4 |
| hoist after `;` with a `//` comment after the insertion, nested `#if` inside the arm; and a named return `R: Integer` with `[if:-, else:V]` | CLEAN27, A | PASS all 4 |
| keyword anchor, INBODY-only | CLEAN27 | PASS both |
| keyword anchor with a `//` comment after it, then a plain declaration, then `[if, else]` declarations | CLEAN27 | PASS both |

Why not "duplicate the latch into each arm", the other candidate named in the task: an arm with no `var_section`, or a missing `#else`, has no line to hold a declaration. Writing one there needs a NEW line (a `var` line, or a whole `#else` arm), which moves every later line number and breaks coverage attribution. The hoist never needs a new line: the latch rides on the header's last line, and the arm's `var` becomes spaces. So LINE NUMBERS stay stable, which is what the line-based manifest fields and the line-map spans need. Byte offsets and the columns after the insertion on the header line DO move; that is ordinary for any insertion and is not relied on. Identity keys are built from the original sites' ASTs, not emitted offsets, so they should not move; `reachGrain` does move, on purpose, for newly admitted members. Task 4's fixture and corpus comparisons are the check, not an argument from newline counts.

Why the hoist is valid (review r1): the unconditional `var` opens one local-variable section right after the header. With an arm's `var` blanked, that arm's declarations sit in the already-open section, and `#if` then selects DECLARATIONS, not a second section. An arm with no `var` contributes none; a nested `#if` of declarations works the same way. The plan-time rows above are scratch text written by hand, not output of the implementation; Task 2 Step 8 is the proof.

---

## Global Constraints

- Plain English, short sentences, no em dashes, in code comments, commits and roadmap text.
- No corpus source text in any committed file. File names, member names and counts are fine. Every repro is hand-written.
- The LATCH edits insert no newline. R-297's object-level selector insertion DOES add lines, by design and unchanged here, so tests compare `linesWithoutSelector(out)` (defined in Task 1 Step 1) with the source's line count.
- Every admitted shape is **alc-proven through the real pipeline** with `$S/alc-all.ts`: exit 0 AND an `.app` under EVERY subset of the symbols its directives name. A shape that is not proven stays refused by name.
- Fixtures: every `fixtures/*` project has zero `preproc_*` nodes (R-297 Task 0 census), so emitted fixture files are BYTE-IDENTICAL and fixture identity keys are unchanged. No live gate is needed for that reason; say so in the commit message.
- No container, no live run. Control app minimum stays `MIN_CONTROL_VERSION = "1.0.0.20"` (`packages/runner/src/harness.ts`).
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions; destructure and check `undefined`. Fail loudly on a contract violation (throw), never emit a plausible wrong default.
- Every fix is red-checked: revert the specific line, confirm the specific test goes red, restore, report both outputs.
- Re-check the next free roadmap id with `ls docs/roadmap/` immediately before writing one (R312 at plan time). Regenerate with `bun scripts/roadmap-index.ts`; never hand-edit `ROADMAP.md`.
- No backend-support claim (in a commit, a roadmap item or a report) except for a shape Task 3 measured green under every subset of its symbols. Any al-runner probe failure is a STOP: report the failing shapes to the coordinator; the fix becomes its own designed task, not part of this plan.
- BaseApp evidence is EXPLORATORY wherever it is quoted: the census is parse-only, and the instrument/compile runs use a scratch project of selected BaseApp files outside BaseApp's own project. Whole BaseApp is never claimed (R311).
- `reachLatchRefusedOwner` and `reachLatchRefusals` keep their names and signatures (exported from `@lethal/schemata`, used by `orchestrator.ts`). The warning code stays `reach-latch-refused`, and the message keeps the `<file>: <member>'s var section` prefix the runner test splits on.

## Review Focus

1. **CRLF sources.** BaseApp and dc files are CRLF. The latch rides on a header line that ends in `\r\n`; the insertion must go before the `\r`, and the directive-line check must strip `\r`. Expected: identical behaviour to LF. Pinned in Task 2 Step 1 (`S1-crlf`).
2. **A header line ending in a `//` comment.** The insertion anchors at the end of the header TOKEN, not the end of the line, so it lands before the comment. Expected: the latch is not commented out. Pinned in Task 2 Step 1 (`S3`).
3. **An arm that already declares the default latch name.** `latchNameFor` walks every identifier in the member, arms included, so the latch becomes `LethALReachLatch2`. Expected: no redeclaration in the build where that arm is active. Pinned in Task 2 Step 1 (`S7`).
4. **One file mixing an admitted BLOCK member, a refused member and a plain member.** Expected: exactly the refused member is named in a `reach-latch-refused` warning; the other two get latches; the refused one's mutants are `unplaced`. Pinned in Task 2 Step 6 (runner test).
5. **Stale prose.** The dispatch doc comment, the orchestrator warning ("Placement rule pending") and R303's text all say the rule is not built. Expected: each says which shapes are still refused and why, and the warning states the real predicate (the token before the `#if` is not the header's end), never a guessed cause such as "after a directive". Pinned by Task 2 Step 7's grep and the runner test's message check.
6. **R-297's selector insertion and both latch insertions in one file.** An object whose own `var` section ends in `#if` declarations (the selector's R297 anchor case), a hoisted member and a keyword-anchored member. Expected: one selector declaration where R-297 puts it, one latch per member, no overlap throw, no directive line with code. Pinned in Task 2 Step 6 and the `m1-mixed` repro (Task 2 Step 8).
7. **An attribute before the member, and parameters spanning lines.** Expected: the latch goes after the header's real end, on the header's LAST line. Pinned in Task 2 Step 1 (`S9`, `S10`).

---

## File structure

- Modify `packages/schemata/src/dispatch.ts`: add `splitVarHoistAnchor(owner)`; `reachLatchRefusedOwner` refuses only when that returns `null`. Update the R303 doc comments.
- Modify `packages/schemata/src/compile.ts`, `injectReachLatches`: the hoist branch and the keyword-anchor branch.
- Modify `packages/runner/src/orchestrator.ts`: the `reach-latch-refused` warning text only.
- Modify `packages/schemata/tests/compile.test.ts`: replace the R303 describe; add the INBODY describe.
- Modify `packages/runner/tests/preproc-instrumentation.test.ts`: the R303 describe through the real pipeline.
- Roadmap: new `docs/roadmap/R<next>.md` (the AL0631 defect), `docs/roadmap/R303.md`, `docs/roadmap/R310.md`, `docs/roadmap/R297.md` (dated correction), possibly `docs/roadmap/R<next+1>.md` (dc offline compile unverified) regenerated `ROADMAP.md`.
- Scratch, never committed (`$S` = the session scratchpad): `$S/r303-census.ts`, `$S/alc-all.ts`, `$S/alrunner-probe.ts`, `$S/dc-compile.ts`, `$S/r303-oracle.ts`, `$S/repro/<shape>/`, plus R-297's `$S/locate.ts` and `$S/identity-keys.ts`.

---

### Task 0: Scratch tools, BEFORE captures, and filing the AL0631 defect (no product change)

**Files:** scratch only, plus `docs/roadmap/R<next>.md` and `ROADMAP.md`.

**Interfaces:**
- Produces: `$S/alc-all.ts <repro-dir> <SYM,SYM,...>` (prints one line per subset and a final `PASS`/`FAIL`), `$S/r303-census.ts <dir> [k/n]` (with `LIST=1`, one `SHAPE\t<file>` line per hit), `$S/r303-oracle.ts <emitted-dir>`.

- [ ] **Step 1: File the AL0631 defect.** `ls docs/roadmap/` for the next id (R312 at plan time). Copy `docs/roadmap/_template.md`. Title: "A member whose `var` section ENDS in an `#if` block of declarations gets its reach latch written on the `#endif` line, and alc rejects the artifact (AL0631)". Section `correctness-risks`, status `open, filed <date>`. Body: the mechanism (`injectReachLatches` appends at `lastDecl.endIndex`, and a `preproc_conditional_var`'s end is `#endif`); the measured table from this plan's "A second defect" section; the census column "INBODY with `#if` as the LAST var child" (dc 40, sysapp 1, bcf 0, BaseApp 11); that R-297's corpus proof ran instrumentation but never alc on corpus emission, which is why "instrumentation completes" did not catch it; zero fixtures affected. Then:

```bash
bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R<next>.md ROADMAP.md
git commit -m "roadmap: file R<next>, the reach latch lands on an #endif line when a member's var section ends in #if (AL0631)"
```

- [ ] **Step 2: The census script.** `$S/r303-census.ts`:

```ts
// Scratch, never committed. Usage: bun r303-census.ts <dir> [k/n]. LIST=1 also prints files.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initParser, parseAL } from "U:/Git/LethAL/packages/engine/src/ast/parser";
await initParser();
const dir = process.argv[2] ?? "";
const [k = 0, n = 1] = (process.argv[3] ?? "0/1").split("/").map(Number);
const all = (readdirSync(dir, { recursive: true }) as string[])
  .filter((f) => f.toLowerCase().endsWith(".al"))
  .sort();
const files = all.filter((_, i) => i % n === k);
const shapes = new Map<string, number>();
const bump = (s: string, rel: string) => {
  shapes.set(s, (shapes.get(s) ?? 0) + 1);
  if (process.env.LIST === "1") console.log(`${s.split(" ")[0]}\t${rel}`);
};
const OWNERS = new Set(["procedure", "trigger_declaration", "preproc_split_procedure", "preproc_split_procedure_preamble"]);
// biome-ignore lint/suspicious/noExplicitAny: scratch walk over raw tree-sitter nodes
type N = any;
const isComment = (c: N) => c.type === "comment" || c.type === "multiline_comment";
const arms = (blk: N): string => {
  const out: string[] = [];
  let cur = "";
  for (const c of blk.namedChildren) {
    if (["preproc_if", "preproc_elif", "preproc_else"].includes(c.type)) {
      if (cur) out.push(cur);
      cur = `${c.type.replace("preproc_", "")}:-`;
    } else if (c.type === "var_section") cur = cur.replace(":-", ":V");
    else if (c.type === "preproc_endif") {
      if (cur) out.push(cur);
    } else cur += `?${c.type}`;
  }
  return out.join(",");
};
for (const rel of files) {
  const tree = parseAL(readFileSync(join(dir, rel), "utf8"));
  const walk = (x: N): void => {
    if (OWNERS.has(x.type)) {
      const kids = x.children;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c.type === "preproc_conditional_var_block") {
          let p = i - 1;
          while (p >= 0 && isComment(kids[p])) p--;
          const note = kids.slice(p + 1, i).some(isComment) ? "+comment" : "";
          bump(`BLOCK owner=${x.type} arms=[${arms(c)}] prev=${p >= 0 ? kids[p].type : "<none>"}${note}`, rel);
        }
        if (c.type === "var_section") {
          const body = c.namedChildren.find((y: N) => y.type === "var_body");
          const last = (body?.children ?? []).filter((y: N) => !isComment(y)).at(-1);
          if (last !== undefined && last.type === "preproc_conditional_var") bump(`INBODY-LAST owner=${x.type}`, rel);
          else if ((body?.namedChildren ?? []).some((y: N) => y.type === "preproc_conditional_var"))
            bump(`INBODY-OTHER owner=${x.type}`, rel);
        }
        if (c.type === "preproc_split_procedure_body" || c.type === "preproc_split_complete_body")
          bump(`SPLITBODY owner=${x.type} ${c.type}`, rel);
      }
    }
    for (const c of x.namedChildren) walk(c);
  };
  walk(tree.rootNode);
  tree.delete?.();
}
console.log(`files ${files.length}/${all.length}`);
for (const [s, v] of [...shapes].sort()) console.log(`${v}\t${s}`);
console.log(`maxRSS_KB ${process.resourceUsage().maxRSS}`);
```

Run it over dc, sysapp, bcf whole and BaseApp in two halves (`0/2`, `1/2`; whole BaseApp in one process is not needed for a parse-only walk, but halves keep the RSS near 680 MB). Expected: the plan-time table exactly. A difference means a corpus moved: run `bun scripts/corpus-fingerprint.ts <dir>` and record it before going on. Then `LIST=1` into `$S/shape-files-<k>.txt` for each corpus; these are Task 4's expected-change sets.

- [ ] **Step 3: The alc harness.** `$S/alc-all.ts`. It is R-297's Task 0 Step 5 harness, extended from "absent, then one symbol" to EVERY subset of the named symbols:

```ts
// Scratch, never committed. Usage: bun alc-all.ts <repro-dir> <SYM,SYM,...>
// Real pipeline, Control dependency declared, symbols staged, one compile per symbol subset.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { generateMutationSet, operatorTiers } from "U:/Git/LethAL/packages/runner/src/orchestrator";
import { injectControlDependency } from "U:/Git/LethAL/packages/runner/src/harness";
import { writeInstrumentedProject } from "U:/Git/LethAL/packages/schemata/src/project";

const [repro = "", symArg = ""] = process.argv.slice(2);
const syms = symArg.split(",").filter((s) => s !== "");
const out = join(import.meta.dir, `emit-${basename(repro)}`);
rmSync(out, { recursive: true, force: true });
const set = await generateMutationSet(repro);
const app = JSON.parse(readFileSync(join(repro, "app.json"), "utf8")) as Record<string, unknown>;
await writeInstrumentedProject({
  targetDir: out,
  files: set.files,
  selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
  artifactId: "0123456789abcdef0123456789abcdef",
  targetAppId: String(app.id),
  operatorTiers,
});
const pk = join(out, ".alpackages");
mkdirSync(pk, { recursive: true });
const ctl = "U:/Git/LethAL/extensions/lethal-control";
for (const f of readdirSync(join(ctl, ".alpackages"))) copyFileSync(join(ctl, ".alpackages", f), join(pk, f));
copyFileSync(join(ctl, "lethal-control.app"), join(pk, "lethal-control.app"));
const ext = join(homedir(), ".vscode", "extensions");
const alcDir = readdirSync(ext).filter((d) => d.startsWith("ms-dynamics-smb.al-")).sort().at(-1) ?? "";
const alc = join(ext, alcDir, "bin", "alc.exe");
let pass = true;
for (let mask = 0; mask < 1 << syms.length; mask++) {
  const on = syms.filter((_, i) => mask & (1 << i));
  const withDep = injectControlDependency(app);
  writeFileSync(join(out, "app.json"), JSON.stringify({ ...withDep, ...(on.length ? { preprocessorSymbols: on } : {}) }));
  const artifact = join(out, "o.app");
  rmSync(artifact, { force: true });
  const r = spawnSync(alc, [`/project:${out}`, `/packagecachepath:${pk}`, `/out:${artifact}`], { encoding: "utf8" });
  const ok = r.status === 0 && existsSync(artifact);
  pass &&= ok;
  const errs = `${r.stdout}${r.stderr}`
    .split("\n")
    .filter((l) => /error AL/.test(l))
    .slice(0, 3)
    .map((l) => l.replace(/^.*?(error AL\d+)/, "$1").trim());
  console.log(`${basename(repro)} sym=[${on.join(",")}] exit=${r.status} app=${existsSync(artifact)} ${errs.join(" | ")}`);
}
console.log(`${basename(repro)} ${pass ? "PASS" : "FAIL"}`);
```

`extensions/lethal-control/lethal-control.app` must be 1.0.0.20 or newer (its `app.json` says 1.0.0.20 at plan time; if the staged `.app` is older, rebuild it per `.claude/skills/control-app`, compile only, no publish). If the alc directory differs, probe `bin/win32/` too (CLAUDE.md, R167).

- [ ] **Step 4: Repros.** One directory per shape under `$S/repro/`, each with this `app.json`:

```json
{"id":"00000000-0000-0000-0000-000000000001","name":"repro","publisher":"repro","version":"1.0.0.0","runtime":"16.0","idRanges":[{"from":50100,"to":50149}]}
```

and one `Repro.Codeunit.al` holding `codeunit 50100 "Repro R"` with the member below plus `var Glob: Integer;` at object level. Every member body is `begin if X > 1 then Glob := X + 1; Glob := Glob + 2; end;` (for a trigger, `Glob > 1`), so there is a statement-grain site and a latch is written. Line breaks are as written; each arm's content is on its own lines.

| repro | header | between header and `begin` | symbols |
| --- | --- | --- | --- |
| `s1-proc-if` | `procedure Pick(X: Integer): Integer` | `#if not CLEAN27` / `var` / `K: Integer;` / `#endif` | CLEAN27 |
| `s1-crlf` | as `s1-proc-if`, file saved with CRLF | same | CLEAN27 |
| `s2-trigger-ifelse` | `trigger OnRun()` | `#if not CLEAN27` / `var` / `L: Integer;` / `#else` / `var` / `M: Integer;` / `#endif` | CLEAN27 |
| `s3-semicolon-comment` | `procedure Pick(X: Integer); // header note` | `#if not CLEAN27` / `var` / `K: Integer;` / `#if A` / `N: Integer;` / `#endif` / `#endif` | CLEAN27,A |
| `s4-named-return-else` | `local procedure Named(X: Integer) R: Integer` | `#if CLEAN27` / `#else` / `var` / `K: Integer;` / `#endif` | CLEAN27 |
| `s5-elif` | `procedure E(X: Integer)` | `#if A` / `var K: Integer;` / `#elif B` / `#else` / `var` / `[NonDebuggable]` / `M: Text;` / `#endif` | A,B |
| `s6-empty-var-arm` | `procedure P(X: Integer)` | `#if A` / `var` / `#else` / `var` / `K: Integer;` / `#endif` | A |
| `s7-name-taken` | `procedure P(X: Integer)` | `#if A` / `var` / `LethALReachLatch: Integer;` / `#endif` | A |
| `s8-own-line-comment` | `procedure C(X: Integer)` | `// own-line note` / `#if not CLEAN27` / `var` / `K: Integer;` / `#endif` | CLEAN27 |
| `k1-inbody-only` | `procedure Pick(X: Integer): Integer` | `var` / `#if not CLEAN27` / `K: Integer;` / `#endif` | CLEAN27 |
| `k2-inbody-last` | `trigger OnRun()` | `var // note` / `A: Integer;` / `#if not CLEAN27` / `K: Integer;` / `#else` / `M: Integer;` / `#endif` | CLEAN27 |
| `r1-pragma-first` (stays refused) | `procedure Prag(X: Integer)` | `#if not CLEAN27` / `#pragma warning disable AL0432` / `#endif` / `#if not CLEAN27` / `var` / `K: Integer;` / `#endif` | CLEAN27 |
| `r2-split-header` (stays refused) | `#if A` / `procedure S(X: Integer)` / `#else` / `procedure S(X: Integer; Y: Integer)` / `#endif` | `#if not CLEAN27` / `var` / `K: Integer;` / `#endif` | A,CLEAN27 |
| `s9-attribute-before` | `[Scope('OnPrem')]` on its own line, then `procedure Pick(X: Integer): Integer` | `#if not CLEAN27` / `var` / `K: Integer;` / `#endif` | CLEAN27 |
| `s10-multiline-params` | `procedure Pick(X: Integer;` / `Y: Integer;` / `Z: Text): Integer` (three lines) | `#if not CLEAN27` / `var` / `K: Integer;` / `#else` / `var` / `M: Integer;` / `#endif` | CLEAN27 |
| `m1-mixed` (all insertions in one file) | object `var` section: `G: Integer;` / `#if not CLEAN27` / `H: Integer;` / `#endif` (R-297's selector anchor shape), then three members: `s1-proc-if`'s `Pick`, `k1-inbody-only`'s member renamed `Keep`, and `c1-plain`'s member renamed `Plain` | as each source repro | CLEAN27 |
| `c1-plain` (harness control) | `procedure Pick(X: Integer): Integer` | `var` / `K: Integer;` | none |

`s6-empty-var-arm`: a `var` keyword with no declarations; if the grammar or alc refuses the UN-instrumented source, drop the repro and record that (it is then not a shape AL allows). For `r2-split-header`, the body must use `X` only.

- [ ] **Step 5: Confirm each repro's tree and that the un-instrumented source compiles.** `bun $S/r303-census.ts $S/repro/<name>` for each. Expected: `s1`, `s1-crlf` `BLOCK owner=procedure arms=[if:V] prev=type_specification`; `s2` `arms=[if:V,else:V] prev=)`; `s3` `arms=[if:V] prev=;+comment`; `s4` `arms=[if:-,else:V] prev=type_specification`; `s5` `arms=[if:V,elif:-,else:V] prev=)`; `s6` `arms=[if:V,else:V] prev=)`; `s7` `arms=[if:V] prev=)`; `s8` `arms=[if:V] prev=)+comment` (the census prints `+comment` when comments sit between); `s9` `prev=type_specification`; `s10` `arms=[if:V,else:V] prev=type_specification`; `m1-mixed` one `BLOCK` and one `INBODY-LAST`; `k1`, `k2` `INBODY-LAST`; `r1` `prev=preproc_pragma_only`; `r2` `owner=preproc_split_procedure prev=preproc_endif`. A repro that parses differently is rewritten until it does, and the final shape recorded. Then compile each UN-instrumented repro under every subset (copy the repro, `alc` directly, no Control). Expected: PASS everywhere, which proves any later failure is LethAL's.

- [ ] **Step 6: HEAD's alc results (the negative controls).** At HEAD (`a513df8` or later, before any Task 1/2 change): `bun $S/alc-all.ts $S/repro/<name> <symbols>` for `c1-plain`, `k1-inbody-only`, `k2-inbody-last`, `s1-proc-if`. Expected: `c1-plain` PASS; `k1`, `k2` FAIL with `AL0631` under every subset (R<next>); `s1-proc-if` PASS, because R-297's refusal writes no latch there. Save each emitted file as `$S/head-emit-<name>.al`.

- [ ] **Step 7: BEFORE captures.** Same commands as R-297 Task 0 Step 6, with R-297's `$S/locate.ts` (its Task 0 Step 1 code) and `$S/identity-keys.ts` (copied from `docs/superpowers/plans/2026-09-27-TSAL-441-grammar-bump.md` Task 3 Step 3, plus the `maxRSS_KB` line):

```bash
S=<scratchpad>; cd /u/Git/LethAL
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-before-$f.txt"
  rm -rf "$S/target-before-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-before-$f" > "$S/ids-before-$f.txt"
done
declare -A C=([dc]="U:/Git/DC/Cloud" [sysapp]="U:/Git/BC.History/System Application" [bcf]="U:/Git/BC.History/BusinessFoundation")
for k in "${!C[@]}"; do
  bun scripts/corpus-fingerprint.ts "${C[$k]}" > "$S/fp-before-$k.txt"
  bun "$S/locate.ts" "${C[$k]}" 2>&1 | grep -v '^\[lethal\]' > "$S/locate-before-$k.txt"
  rm -rf "$S/target-before-$k"; bun "$S/identity-keys.ts" "${C[$k]}" "$S/target-before-$k" > "$S/ids-before-$k.txt"
done
```

For BaseApp, build the scratch project R303 used: copy every BaseApp file listed as `BLOCK` or `INBODY-LAST` in `$S/shape-files-baseapp-*.txt` into `$S/baseapp-r303/src/` (same relative names), add the repro `app.json`, and run `locate.ts` and `identity-keys.ts` on it into `$S/*-before-baseapp.txt`. This is EXPLORATORY evidence outside BaseApp's own context, labelled so, exactly as R303 labels its 12-file run. Whole BaseApp stays blocked on R311 and is not claimed.

Record, per corpus, the `reach-latch-refused` count: `bun "$S/locate.ts" <dir> 2>&1 | grep -c "reach-latch-refused\|var section is split by #if"`. Expected: dc 0, sysapp 0, bcf 0, baseapp-r303 12 (R303's figure).

- [ ] **Step 8: The emission oracle.** `$S/r303-oracle.ts <emitted-dir>` parses every emitted `.al` with `parseAL` and prints `BAD <file> <reason>` for: (a) any line (after stripping `\r`) that starts with `#if`/`#elif` and contains `;`, or starts with `#else`/`#endif` and has anything after it except whitespace or a `//` comment; (b) any procedure or trigger that contains a `LethALReachLatch\d*: Boolean` declaration AND still has a `preproc_conditional_var_block` child whose arms contain a `var_keyword`; (c) any member whose text contains the latch name in a marker (`if not <latch> then`) but whose declarations of that exact name are not exactly one, direct child of a top-level `var_body` (not inside a `preproc_conditional_var`). It ends with `oracle <n> files, <b> BAD`. Run it on `$S/target-before-dc`, `$S/target-before-sysapp` and `$S/target-before-baseapp` (exploratory): expected BAD lines of reason (a) for the members carrying R<next>'s shape WITH a latch written. That is the oracle's own red check against real output, and its per-member count is the AFFECTED-emissions figure Task 5 Step 4 quotes, kept apart from the parse-shape census.

---

### Task 1: The keyword anchor (closes R<next>)

**Files:**
- Modify: `packages/schemata/src/compile.ts` (`injectReachLatches`, the `vars !== undefined && lastDecl !== undefined` branch)
- Test: `packages/schemata/tests/compile.test.ts` (new describe after the R303 one)

**Interfaces:**
- Consumes: `insertionNodeAt(anchor, index)`, `isComment(n)` (both local to `compile.ts`), `REACH_LATCH`.
- Produces: no new export.

- [ ] **Step 1: Write the failing test.** Append to `compile.test.ts`:

```ts
/** R<next>: a member var section whose LAST child is `#if` of declarations. Hand-written. */
const INBODY_SRC = `codeunit 50100 "Repro K"
{
    procedure Pick(X: Integer): Integer
    var
#if not CLEAN27
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    trigger OnRun()
    var // note
        A: Integer;
#if not CLEAN27
        L: Integer;
#else
        M: Integer;
#endif
    begin
        Glob := Glob + 2;
    end;

    var
        Glob: Integer;
}
`;

/** No code after a directive on its line (alc AL0631). */
function directiveLinesClean(text: string): boolean {
  return text.split("\n").every((raw) => {
    const l = raw.replace(/\r$/, "");
    if (/^\s*#(if|elif)\b/.test(l)) return !l.includes(";");
    if (/^\s*#(else|endif)\b/.test(l)) return /^\s*#(else|endif)\s*(\/\/.*)?$/.test(l);
    return true;
  });
}

const SELECTOR_DECL = 'MutationSelector: Codeunit "Mutation Selector";';

/** Line count with R-297's object-level selector insertion removed. That insertion adds lines by
 *  design (`\n        <decl>` appended to a var section, or `    var\n        <decl>\n\n` before
 *  the first member) and is not what these tests measure; the latch edits must add none. */
function linesWithoutSelector(text: string): number {
  return text
    .replace(`    var\n        ${SELECTOR_DECL}\n\n`, "")
    .replace(`\n        ${SELECTOR_DECL}`, "")
    .split("\n").length;
}

describe("R<next>: a member var section ending in #if gets its latch after the var keyword", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("writes the latch on the var line, never on the #endif line, and moves no line", () => {
    const root = wrapRoot(parseAL(INBODY_SRC));
    const at = (text: string): ALSyntaxNode => {
      const a = findAll(root, ALNodeKind.assignment_statement).find((n) => n.text === text);
      if (a === undefined) throw new Error(`fixture drift: no assignment ${text}`);
      return a;
    };
    const specs = [
      spec(at("Glob := X + 1"), "Glob := 0", "lethal.op"),
      spec(at("Glob := Glob + 2"), "Glob := 0", "lethal.op"),
    ];
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(INBODY_SRC, root, specs, ided);
    expect(out).toContain(`    var ${REACH_LATCH}: Boolean;\n#if not CLEAN27\n        K: Integer;`);
    expect(out).toContain(`    var ${REACH_LATCH}: Boolean; // note\n        A: Integer;`);
    expect(out).not.toMatch(/#endif\s*\S/);
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutSelector(out)).toBe(INBODY_SRC.split("\n").length);
    expect(countErrorNodes(out)).toBe(0);
  });
});
```

(`findAll`, `ALNodeKind`, `wrapRoot`, `parseAL`, `initParser` are already imported by the R303 describe in this file; add any that are not.)

- [ ] **Step 2: Run it, expect FAIL.** `bun test packages/schemata/tests/compile.test.ts -t "R<next>"`. Expected: FAIL on the first `toContain`; the output has `#endif ${REACH_LATCH}: Boolean;`.

- [ ] **Step 3: Implement.** In `injectReachLatches`, replace the body of `if (vars !== undefined && lastDecl !== undefined) { ... }` with:

```ts
      if (lastDecl.rawKind === "preproc_conditional_var") {
        // R<next>: the section ends in `#if` declarations, and after its last child is the
        // `#endif` line, where alc allows no code (AL0631). Right after the `var` keyword is
        // unconditional and on a line of its own; any comment after it stays after it.
        const keyword = vars.children.find((n) => n.rawKind === "var_keyword");
        if (keyword === undefined) {
          throw new Error(
            `compileSchemataForFile: cannot instrument ${filePath}: a var section ending in #if has no var keyword to anchor the latch \`${latch}\` after.`,
          );
        }
        rewrites.set(insertionNodeAt(keyword, keyword.endIndex), ` ${latch}: Boolean;`);
      } else {
        // After the last DECLARATION, before any trailing comment on its line.
        rewrites.set(insertionNodeAt(lastDecl, lastDecl.endIndex), ` ${latch}: Boolean;`);
      }
```

Only a `preproc_conditional_var` last child takes the new path, so every var section that ends in a plain declaration, including every fixture's, emits byte-for-byte as before.

- [ ] **Step 4: Run, expect PASS.** Same command. Then the whole package: `bun run typecheck && rm -rf packages/*/dist && bun test packages/schemata packages/runner`. Expected: all green.

- [ ] **Step 5: alc-proven.** `bun $S/alc-all.ts $S/repro/k1-inbody-only CLEAN27` and `bun $S/alc-all.ts $S/repro/k2-inbody-last CLEAN27`. Expected: PASS (both subsets, exit 0, `.app`), where Task 0 Step 6 recorded FAIL `AL0631`. Also `c1-plain`: PASS, and its emitted file byte-identical to `$S/head-emit-c1-plain.al` (`cmp`).

- [ ] **Step 6: Red-check.** Change `lastDecl.rawKind === "preproc_conditional_var"` to `false`. Run Step 2's command: expected FAIL (the `#endif` emission). Restore; expected PASS. Record both outputs.

- [ ] **Step 7: Commit.**

```bash
bunx biome check packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts
git add packages/schemata/src/compile.ts packages/schemata/tests/compile.test.ts
git commit -m "fix(schemata): a var section ending in #if gets its reach latch after the var keyword, not on the #endif line (R<next>)

alc-proven on hand-written repros under every symbol subset. No fixture has a preproc node,
so every fixture emission is byte-identical by construction; no live gate needed."
```

---

### Task 2: The hoist, and the narrowed refusal (R303)

**Files:**
- Modify: `packages/schemata/src/dispatch.ts` (new `splitVarHoistAnchor`; `reachLatchRefusedOwner`; doc comments)
- Modify: `packages/schemata/src/compile.ts` (`injectReachLatches`, new branch before `const vars = ...`; import)
- Modify: `packages/runner/src/orchestrator.ts:774-779` (warning text)
- Test: `packages/schemata/tests/compile.test.ts` (replace the R303 describe), `packages/runner/tests/preproc-instrumentation.test.ts` (the R303 describe)

**Interfaces:**
- Produces: `export function splitVarHoistAnchor(owner: ALSyntaxNode): ALSyntaxNode | null` in `dispatch.ts`: for a procedure-like or trigger node with a `preproc_conditional_var_block` child, the header token the latch `var` is written after, or `null`. It returns a token only when the block's preceding non-comment sibling IS the header's actual end (`headerEndOf`): the owner-level `)` that closes the parameter list, else the `return_type` field after it, else a `;` directly after either. Returns `null` for a member with no block (callers test for the block first).
- `reachLatchRefusedOwner(node)` keeps its signature; it now returns the owner only when the owner has a block AND `splitVarHoistAnchor(owner) === null`.

- [ ] **Step 1: Write the failing tests.** In `compile.test.ts`, replace the whole `describe("R303: a member whose var section is split by #if gets no reach latch", ...)` block, keeping `R303_SRC` as it is, with:

```ts
/** The member owning the first latch declaration named `latch`, re-parsed from emitted text. */
function latchShape(out: string, latch: string): { direct: number; nested: number; blocks: number } {
  const root = wrapRoot(parseAL(out));
  let direct = 0;
  let nested = 0;
  let blocks = 0;
  visit(root, (n) => {
    if (n.rawKind === "preproc_conditional_var_block") blocks++;
    if (n.rawKind !== "variable_declaration") return;
    if (n.childForFieldName("name")?.text !== latch) return;
    if (n.parent?.rawKind === "var_body") direct++;
    else nested++;
  });
  return { direct, nested, blocks };
}

const HOIST_CASES: { name: string; src: string; header: string }[] = [
  {
    name: "S1 procedure with a return type, #if arm only",
    header: "    procedure Pick(X: Integer): Integer",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S2 trigger, #if and #else arms",
    header: "    trigger OnRun()",
    src: `codeunit 50100 "Repro H"
{
    trigger OnRun()
#if not CLEAN27
    var
        L: Integer;
#else
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S3 header ending in ; and a // comment, nested #if in the arm",
    header: "    procedure Pick(X: Integer);",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer); // header note
#if not CLEAN27
    var
        K: Integer;
#if A
        N: Integer;
#endif
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S4 named return, empty #if arm, var only in #else",
    header: "    local procedure Named(X: Integer) R: Integer",
    src: `codeunit 50100 "Repro H"
{
    local procedure Named(X: Integer) R: Integer
#if CLEAN27
#else
    var
        K: Integer;
#endif
    begin
        R := X + 1;
    end;
}
`,
  },
  {
    name: "S5 #elif chain with an empty middle arm and an attribute",
    header: "    procedure E(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure E(X: Integer)
#if A
    var K: Integer;
#elif B
#else
    var
        [NonDebuggable]
        M: Text;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S8 a // comment on its own line between the header and #if",
    header: "    procedure C(X: Integer)",
    src: `codeunit 50100 "Repro H"
{
    procedure C(X: Integer)
    // own-line note
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S9 an attribute before the member",
    header: "    procedure Pick(X: Integer): Integer",
    src: `codeunit 50100 "Repro H"
{
    [Scope('OnPrem')]
    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
  {
    name: "S10 parameters spanning lines: the latch goes on the header's LAST line",
    header: "        Z: Text): Integer",
    src: `codeunit 50100 "Repro H"
{
    procedure Pick(X: Integer;
        Y: Integer;
        Z: Text): Integer
#if not CLEAN27
    var
        K: Integer;
#else
    var
        M: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`,
  },
];

describe("R303: a member whose var section is split by #if gets one unconditional latch", () => {
  beforeAll(async () => {
    await initParser();
  });

  const firstAssignment = (root: ALSyntaxNode): ALSyntaxNode => {
    const a = findAll(root, ALNodeKind.assignment_statement)[0];
    if (a === undefined) throw new Error("fixture drift: no assignment");
    return a;
  };
  const instrument = (src: string) => {
    const root = wrapRoot(parseAL(src));
    const specs = [spec(firstAssignment(root), "Glob := 0", "lethal.op")];
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const grains = buildComponents(ided).flatMap((c) => c.members.map((m) => reachGrainOf(m, c.root)));
    return { grains, out: compileSchemataForFile(src, root, specs, ided) };
  };

  for (const c of [...HOIST_CASES, { ...HOIST_CASES[0], name: "S1-crlf", src: HOIST_CASES[0]?.src.replace(/\n/g, "\r\n") ?? "" }]) {
    it(`${c.name}: statement grain, latch on the header line, every arm's var blanked, no line moved`, () => {
      const { grains, out } = instrument(c.src);
      expect(grains).toEqual(["statement"]);
      expect(out).toContain(`${c.header} var ${REACH_LATCH}: Boolean;`);
      expect(latchShape(out, REACH_LATCH)).toEqual({ direct: 1, nested: 0, blocks: 0 });
      expect(out.split("MutationSelector.Reached(").length - 1).toBe(1);
      expect(directiveLinesClean(out)).toBe(true);
      expect(linesWithoutSelector(out)).toBe(c.src.split("\n").length);
      expect(countErrorNodes(out)).toBe(0);
    });
  }

  it("S7: an arm that declares the default name pushes the latch to a free one", () => {
    const src = `codeunit 50100 "Repro H"
{
    procedure P(X: Integer)
#if A
    var
        ${REACH_LATCH}: Integer;
#endif
    begin
        Glob := X + 1;
    end;

    var
        Glob: Integer;
}
`;
    const { out } = instrument(src);
    expect(out).toContain(`    procedure P(X: Integer) var ${REACH_LATCH}2: Boolean;`);
    expect(latchShape(out, `${REACH_LATCH}2`)).toEqual({ direct: 1, nested: 0, blocks: 0 });
  });

  it("M1: R-297's selector anchor and both latch insertions in one emitted file", () => {
    const src = `codeunit 50100 "Repro M"
{
    var
        G: Integer;
#if not CLEAN27
        H: Integer;
#endif

    procedure Pick(X: Integer): Integer
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        G := X + 1;
    end;

    procedure Keep(X: Integer): Integer
    var
#if not CLEAN27
        L: Integer;
#endif
    begin
        G := X + 2;
    end;

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        G := X + 3;
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const specs = findAll(root, ALNodeKind.assignment_statement).map((n) => spec(n, "G := 0", "lethal.op"));
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(src, root, specs, ided);
    expect(out.split(SELECTOR_DECL).length - 1).toBe(1);
    // R-297's real behaviour: an #if block holding only declarations is declaration-only, so the
    // selector goes after its #endif, on a line of its own (as in a-ordinary-ifdecl's HEAD_EMIT).
    expect(out).toContain(`        G: Integer;\n#if not CLEAN27\n        H: Integer;\n#endif\n        ${SELECTOR_DECL}\n`);
    expect(out).toContain(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`    var ${REACH_LATCH}: Boolean;\n#if not CLEAN27\n        L: Integer;`);
    expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(3);
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutSelector(out)).toBe(src.split("\n").length);
    expect(countErrorNodes(out)).toBe(0);
  });

  it("R303_SRC: all three members get a latch; none is refused", () => {
    const root = wrapRoot(parseAL(R303_SRC));
    const specs = findAll(root, ALNodeKind.assignment_statement)
      .filter((n) => ["Glob := Glob + 1", "Glob := X + 1", "P := X + 2"].includes(n.text))
      .map((n) => spec(n, "Glob := 0", "lethal.op"));
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(R303_SRC, root, specs, ided);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(3);
    expect(out).toContain(`    trigger OnRun() var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    expect(latchShape(out, REACH_LATCH).blocks).toBe(0);
    expect(countErrorNodes(out)).toBe(0);
  });

  it("a pragma-only #if before the block, and a split header, stay refused", () => {
    const src = `codeunit 50100 "Repro R"
{
    procedure Prag(X: Integer)
#if not CLEAN27
#pragma warning disable AL0432
#endif
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 1;
    end;

#if A
    procedure S(X: Integer)
#else
    procedure S(X: Integer; Y: Integer)
#endif
#if not CLEAN27
    var
        K: Integer;
#endif
    begin
        Glob := X + 2;
    end;

    var
        Glob: Integer;
}
`;
    const root = wrapRoot(parseAL(src));
    const blocks: ALSyntaxNode[] = [];
    visit(root, (n) => {
      if (n.rawKind === "preproc_conditional_var_block") blocks.push(n);
    });
    expect(blocks.map((b) => b.parent?.rawKind)).toEqual(["procedure", "preproc_split_procedure"]);
    for (const b of blocks) {
      const owner = b.parent;
      if (owner === null) throw new Error("fixture drift: block without owner");
      expect(splitVarHoistAnchor(owner)).toBeNull();
      expect(reachLatchRefusedOwner(b)?.startIndex).toBe(owner.startIndex);
    }
    const specs = findAll(root, ALNodeKind.assignment_statement).map((n) => spec(n, "Glob := 0", "lethal.op"));
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const grains = buildComponents(ided).flatMap((c) => c.members.map((m) => reachGrainOf(m, c.root)));
    expect(grains).toEqual(["unplaced", "unplaced"]);
    const out = compileSchemataForFile(src, root, specs, ided);
    expect(out).not.toContain(REACH_LATCH);
  });
});
```

Add `splitVarHoistAnchor` and `reachLatchRefusedOwner` to the `../src/dispatch` import, and `visit` to the `@lethal/engine` import if missing. If the `S1-crlf` spread trips `exactOptionalPropertyTypes` or the `noNonNullAssertion` rule, destructure `HOIST_CASES[0]` into a const and check it for `undefined` first.

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/schemata/tests/compile.test.ts -t "R303"`. Expected: compile error on the missing `splitVarHoistAnchor` export; after a stub `export function splitVarHoistAnchor() { return null; }`, the S1 to S10 cases FAIL with grain `unplaced`, M1 FAILS on the `Pick` header line, and the refused-shapes test PASSES (that one must pass before and after, it is the control).

- [ ] **Step 3: Implement the predicate.** In `dispatch.ts`, above `reachLatchRefusedOwner`:

```ts
/**
 * R303. The last token of a procedure or trigger header: the owner-level `)` that closes the
 * parameter list, else the `return_type` after it (plain or named return), else a `;` directly
 * after either. Attributes before the member and parameters spanning lines do not change it: an
 * attribute's own parentheses sit inside `attribute_item`, and parameters inside `parameter_list`.
 * `null` when the owner has no owner-level `)` (a split header keeps its `)` inside each arm).
 */
function headerEndOf(owner: ALSyntaxNode): ALSyntaxNode | null {
  const kids = owner.children.filter((c) => c.rawKind !== "comment" && c.rawKind !== "multiline_comment");
  const close = kids.find((c) => c.rawKind === ")");
  if (close === undefined) return null;
  const ret = owner.childForFieldName("return_type");
  const end = ret !== null && ret.startIndex > close.startIndex ? ret : close;
  const next = kids.find((c) => c.startIndex >= end.endIndex);
  return next !== undefined && next.rawKind === ";" ? next : end;
}

/**
 * R303. For a procedure or trigger whose `var` section sits inside `#if`
 * (`preproc_conditional_var_block`), the header token to write ONE unconditional
 * `var <latch>: Boolean;` after. The writer then blanks each arm's own `var` keyword, so each
 * arm's declarations become conditional declarations in that one section, which is valid in every
 * build. `null` when the member has no such block, or when the token before the block (comments
 * skipped) is anything but the header's actual end: a pragma-only `#if` block, a split header's
 * `#endif`, or any kind not yet seen. Those members stay refused by name.
 */
export function splitVarHoistAnchor(owner: ALSyntaxNode): ALSyntaxNode | null {
  const kids = owner.children;
  const at = kids.findIndex((c) => c.rawKind === "preproc_conditional_var_block");
  if (at < 0) return null;
  const prev = kids
    .slice(0, at)
    .filter((c) => c.rawKind !== "comment" && c.rawKind !== "multiline_comment")
    .at(-1);
  const end = headerEndOf(owner);
  if (prev === undefined || end === null) return null;
  return prev.startIndex === end.startIndex && prev.endIndex === end.endIndex ? prev : null;
}
```

and change the last line of `reachLatchRefusedOwner` to:

```ts
  const split = owner.children.some((c) => c.rawKind === "preproc_conditional_var_block");
  return split && splitVarHoistAnchor(owner) === null ? owner : null;
```

Rewrite its doc comment: "R303: the procedure or trigger holding `node` when its `var` section sits inside `#if` in a shape `splitVarHoistAnchor` does not cover, else `null`. Such a member gets no latch and no marker: its mutants are `unplaced`, their reach is `not-decided`, never unreached. The member is still instrumented and scored." Update the one-line comment in `placeReach` the same way ("R303: a split var section in an unproven shape gets no latch, so no marker"). Export `splitVarHoistAnchor` from `packages/schemata/src/index.ts` next to `reachLatchRefusedOwner` only if Task 2 Step 6 needs it (it does not at plan time; do not add it otherwise).

- [ ] **Step 4: Implement the hoist.** In `compile.ts`, import `splitVarHoistAnchor` from `./dispatch`. In `injectReachLatches`, right after `latches.set(c, latch);` and before `const vars = ...`, add:

```ts
    // R303: the var section sits inside `#if`. One unconditional `var` on the header line, and
    // each arm's own `var` keyword blanked to spaces, so the arms' declarations join that one
    // section in every build. No newline, so no LINE moves (offsets and later columns do).
    const split = owner.children.find((n) => n.rawKind === "preproc_conditional_var_block");
    if (split !== undefined) {
      const anchor = splitVarHoistAnchor(owner);
      if (anchor === null) {
        // `placeReach` refuses these members, so no statement-grain marker can reach here.
        throw new Error(
          `compileSchemataForFile: cannot instrument ${filePath}: a reach marker sits in a member whose var section is split by #if in a shape with no latch placement (R303).`,
        );
      }
      rewrites.set(insertionNodeAt(anchor, anchor.endIndex), ` var ${latch}: Boolean;`);
      for (const arm of split.children.filter((n) => n.kind === ALNodeKind.var_section)) {
        const keyword = arm.children.find((n) => n.rawKind === "var_keyword");
        if (keyword !== undefined) rewrites.set(keyword, " ".repeat(keyword.endIndex - keyword.startIndex));
      }
      continue;
    }
```

- [ ] **Step 5: Run, expect PASS.** `bun test packages/schemata/tests/compile.test.ts`. Expected: all green, including Task 1's describe and the unchanged older tests.

- [ ] **Step 6: The runner test through the real pipeline.** In `preproc-instrumentation.test.ts`, rename the describe to `"R303: a member whose var section is split by #if gets a latch, or is refused by name"`. In its `SRC`, add after `Plain` (before the object `var`):

```al
    procedure Prag(X: Integer): Integer
#if not CLEAN27
#pragma warning disable AL0432
#endif
#if not CLEAN27
    var
        Q: Integer;
#endif
    begin
        if X > 3 then
            exit(X + 3);
        exit(0);
    end;
```

Also change the object's closing `var` section to `var` / `Glob: Integer;` / `#if not CLEAN27` / `Old: Integer;` / `#endif`, so R-297's selector anchor runs in the same file (review r1). Change the expectations to: `refused` messages split on `"'s var section"` equal `["[lethal] Repro.Codeunit.al: procedure Prag"]`, the message contains `R303` and `is not the end of its header`; grains `OnRun` and `Pick` each contain `"statement"`, `Prag` equals `["unplaced"]`, `Plain` contains `"statement"`; the emitted text contains `trigger OnRun() var LethALReachLatch: Boolean;`, `procedure Pick(X: Integer): Integer var LethALReachLatch: Boolean;` and `P: Integer; LethALReachLatch: Boolean;`; `text.split("LethALReachLatch: Boolean;").length - 1` is `3`; `text.split(SELECTOR).length - 1` is `1`, and the text contains `` `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR}` ``: R-297's real behaviour puts the selector after a declaration-only `#if` block's `#endif`, on its own line (compare `a-ordinary-ifdecl` in this file's `HEAD_EMIT`). Run `bun test packages/runner/tests/preproc-instrumentation.test.ts -t R303`: FAIL on the old message text until Step 7, then PASS.

- [ ] **Step 7: The warning text.** In `orchestrator.ts`, the `reach-latch-refused` message becomes:

```ts
        `[lethal] ${rel}: ${r.member}'s var section is split by #if (preproc_conditional_var_block), and the token before that #if is not the end of its header (the parameter list's ")", the return type, or a ";" after either), so no reach latch is declared there: its ${r.sites} site(s) carry no reach marker (reachGrain "unplaced", reach not-decided, never unreached). R303.`,
```

and the `reachLatchRefusals` doc comment says "in a shape `splitVarHoistAnchor` does not cover". Then `grep -rn "Placement rule pending\|placement rule not built\|per-arm placement" packages --include=*.ts | grep -v /dist/`: expected no hit.

- [ ] **Step 8: alc-proven, every admitted shape and both refused ones.**

```bash
S=<scratchpad>; cd /u/Git/LethAL
for r in s1-proc-if:CLEAN27 s1-crlf:CLEAN27 s2-trigger-ifelse:CLEAN27 s3-semicolon-comment:CLEAN27,A \
         s4-named-return-else:CLEAN27 s5-elif:A,B s6-empty-var-arm:A s7-name-taken:A s8-own-line-comment:CLEAN27 s9-attribute-before:CLEAN27 s10-multiline-params:CLEAN27 m1-mixed:CLEAN27 \
         k1-inbody-only:CLEAN27 k2-inbody-last:CLEAN27 r1-pragma-first:CLEAN27 r2-split-header:A,CLEAN27 c1-plain:; do
  bun "$S/alc-all.ts" "$S/repro/${r%%:*}" "${r#*:}" 2>&1 | grep -v '^\[lethal\]'
done
```

Expected: every line ends `PASS`. The refused ones pass because they carry no latch. Any `FAIL` on an admitted shape is a STOP: narrow `splitVarHoistAnchor` so that shape returns `null` and is refused, record the alc error, and carry it to Task 5's R303 text as an unproven shape.

- [ ] **Step 9: The negative control through the real pipeline.** Temporarily delete the blanking loop (`for (const arm of ...)`) in `compile.ts`. Run `bun $S/alc-all.ts $S/repro/s2-trigger-ifelse CLEAN27`. Expected: FAIL (a second `var` section, `AL0104` or a sibling error) under BOTH subsets. Run Step 5's test: expected FAIL on `latchShape(...)` (`blocks: 1` or a `var` line left). Restore; both PASS. Record all four outputs.

- [ ] **Step 10: Red-checks.** Each, one at a time, recorded red then restored green:
  1. `headerEndOf` without its `;` step (return `end`): the S3 case goes red (grain `unplaced`).
  1b. `splitVarHoistAnchor` returning `prev` whenever `prev.rawKind` is `)`, `type_specification` or `;`, without comparing it to `headerEndOf` (r1's allowlist): add a unit case where the token before the block is one of those kinds but NOT the header's end, and confirm it goes red. If the grammar admits no such parse, record that, and keep the stricter rule anyway.
  2. `reachLatchRefusedOwner` back to `return split ? owner : null;` (the R-297 refusal): S1 to S10 and M1 red.
  3. In the hoist branch, insert `` `var ${latch}: Boolean; ` `` before `begin` instead of after the anchor (HEAD's pre-refusal emission): the header `toContain` goes red, and `alc-all` on `s1-proc-if` FAILs with `AL0104` with CLEAN27 absent (R303's measured row).
  4. `splitVarHoistAnchor` without the comment filter: the S8 case (a `//` comment on its own line between the header and `#if`) goes red (grain `unplaced`, because the comment becomes `prev`). S3 does not catch this one, since its comment is also a sibling after `;`; S8 is the case that pins the filter.

- [ ] **Step 11: Whole suite and commit.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/orchestrator.ts packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/orchestrator.ts packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "fix(schemata,runner): a member whose var section is split by #if gets one unconditional reach latch on its header line (R303)

Each arm's own var keyword is blanked to spaces, so its declarations join that one section in
every build. alc-proven on hand-written repros under every symbol subset. A block whose
preceding token is not the header's end (pragma-only #if, split header, anything else) keeps
the named reach-latch-refused refusal. No backend claim yet: the al-runner probe is next.
No fixture has a preproc node, so fixture emission is byte-identical; no live gate needed."
```

---

### Task 3: Local al-runner probe of EVERY admitted repro (no container), BEFORE any backend-support claim

**Files:** scratch only (`$S/alrunner-probe.ts`, `$S/repro-tests-<name>/`). No product change in this task.

**Why:** `alc` passing says nothing about al-runner, which compiles AL with its own pipeline. No gate sees these shapes (no fixture has `#if`). So "the hoist works on the al-runner backend" is unmeasured until this task runs. Backend support is claimed ONLY for shapes measured green here, under every subset of that shape's symbols.

**Interfaces:**
- Consumes: `AlRunnerBackend` (`packages/runner/src/al-runner-backend.ts`, config fields `alRunnerPath`, `instrumentedDir`, `testDir`, `selectorObjectId`, `preprocessorSymbols`), `runSession` and `generateMutationSet` (`packages/runner/src/orchestrator.ts`), `ResultsStore` (`packages/runner/src/store.ts`). The shape is `scripts/probe-alrunner-tables.ts`, pointed at a scratch repro pair.
- Produces: a per-shape PASS/FAIL list with the al-runner version, carried to Task 5.

- [ ] **Step 1: One test app per repro.** `$S/repro-tests-<name>/` with `app.json` `{"id":"00000000-0000-0000-0000-000000000002","name":"repro-tests","publisher":"repro","version":"1.0.0.0","runtime":"16.0","idRanges":[{"from":50150,"to":50199}],"dependencies":[{"id":"00000000-0000-0000-0000-000000000001","name":"repro","publisher":"repro","version":"1.0.0.0"}]}` and one test codeunit `50150 "Repro Tests"` (`Subtype = Test;`) whose tests call each of that repro's members (a trigger through `Codeunit.Run`) with `X = 5` and `X = 0` and `Error(...)` on a wrong result, so the mutants have something to kill. One object per file: al-runner loses every object after the first in a file (upstream #3713).

- [ ] **Step 2: The probe script.** `$S/alrunner-probe.ts <repro-dir> <tests-dir> <SYM,SYM,...>`: a copy of `scripts/probe-alrunner-tables.ts` with `PROJECT_DIR` and `TEST_DIR` from argv and `SELECTOR_IDS = { selectorId: 50147, controlId: 50148, tableId: 50149 }`. Like `alc-all.ts`, it runs one session per SUBSET of the named symbols (`for (let mask = 0; mask < 1 << syms.length; mask++)`), each with a fresh `ResultsStore(":memory:")` and scratch dir and `preprocessorSymbols: on` passed to `new AlRunnerBackend({ ... })` (omitted for the empty subset). Per subset it prints `baselineGreen`, the counts, and per mutant `mutantCode verdict cause file:line operatorName reachGrain`, then `SUBSET PASS` when the baseline is green AND no mutant's verdict is `error` or carries a compile failure, else `SUBSET FAIL`. It ends with `<name> PASS` only if every subset passed.

- [ ] **Step 3: Run it on every admitted repro, each with ITS OWN symbols.**

```bash
S=<scratchpad>; cd /u/Git/LethAL
export LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
"$LETHAL_ALRUNNER_PATH" --version
for r in s1-proc-if:CLEAN27 s1-crlf:CLEAN27 s2-trigger-ifelse:CLEAN27 s3-semicolon-comment:CLEAN27,A \
         s4-named-return-else:CLEAN27 s5-elif:A,B s6-empty-var-arm:A s7-name-taken:A s8-own-line-comment:CLEAN27 \
         s9-attribute-before:CLEAN27 s10-multiline-params:CLEAN27 k1-inbody-only:CLEAN27 k2-inbody-last:CLEAN27 \
         m1-mixed:CLEAN27 c1-plain:; do
  n="${r%%:*}"; echo "== $n"
  bun "$S/alrunner-probe.ts" "$S/repro/$n" "$S/repro-tests-$n" "${r#*:}" 2>&1 | grep -v '^\[lethal\]' | tail -40
done
```

The list is every repro Task 2 Step 8 admitted (drop `s6-empty-var-arm` only if Task 0 Step 4 dropped it, and say so). That is 4 subsets for `s3` (`CLEAN27`, `A`), 4 for `s5` (`A`, `B`), 2 for each single-symbol repro, 1 for `c1-plain`. Record the al-runner version printed first. Expected: `<name> PASS` for every repro, and in the hoisted members every mutant's `reachGrain` is `statement` or `enclosing`, never `unplaced`. `c1-plain` is the control: if IT fails, the harness is wrong, not the shape; fix the harness and rerun everything.

- [ ] **Step 4: Any FAIL is a STOP.** If any repro (other than a harness failure caught by `c1-plain`) prints `FAIL` under any subset: do not design or apply a workaround here, do not commit a backend claim, and do not run Task 5 Steps 2 and 3 as written. Report to the coordinator: the al-runner version, each failing repro and subset, the failing probe lines, and that `alc` passes the same emission (Task 2 Step 8). The fix becomes its own designed task. Tasks 4 and 5 Step 1 (R<next>, the keyword anchor) and Step 4 (R297) may still proceed if the coordinator says so, since they do not depend on the hoist's al-runner support, except that R<next>'s text then states `k1`/`k2`'s al-runner result as measured.

If every repro passes, nothing is committed in this task. Carry the version and the pass list to Task 5.

---

### Task 4: Prove it: fixtures unchanged, corpora instrument, refusals fall, dc compiles or is filed

**Files:** scratch only, plus possibly `docs/roadmap/R<next+1>.md` (Step 6).

- [ ] **Step 1: Fixtures byte-identical and identity keys unchanged.**

```bash
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-after-$f.txt"; cmp "$S/hashes-before-$f.txt" "$S/hashes-after-$f.txt"
  rm -rf "$S/target-after-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-after-$f" > "$S/ids-after-$f.txt"
  diff <(grep -v maxRSS_KB "$S/ids-before-$f.txt") <(grep -v maxRSS_KB "$S/ids-after-$f.txt")
  diff -r --exclude=app.json "$S/target-before-$f" "$S/target-after-$f"
done
```

Expected: no output from any `cmp` or `diff`. Any difference is a STOP. This, not a newline count, is the proof that the change cannot move a fixture.

- [ ] **Step 2: Fingerprints.** `bun scripts/corpus-fingerprint.ts` per corpus into `$S/fp-after-$k.txt`; `cmp` with BEFORE. A mismatch voids that corpus's comparison (recapture BEFORE at HEAD in a worktree, `git worktree add $S/head a513df8`).

- [ ] **Step 3: dc, sysapp, bcf.** `locate.ts` and `identity-keys.ts` into `*-after-$k.txt` / `$S/target-after-$k`. Expected:
  - `locate.ts`: zero `FAIL` lines, as before.
  - `reach-latch-refused` count: 0, as before (no BLOCK member in these corpora).
  - Identity keys: identical except `maxRSS_KB`. The site set does not move; this is a writer-only change.
  - Emitted files: every file NOT in `$S/shape-files-<k>.txt` under `INBODY-LAST` is byte-identical (`diff -rq`). Every changed file is in that list, and its diff is ONLY the latch declaration moving from the `#endif` line to the `var` line: check mechanically by deleting ` LethALReachLatch\d*: Boolean;` from both sides and requiring equal text.
  - Oracle: `bun $S/r303-oracle.ts $S/target-after-$k`: `0 BAD` (Task 0 Step 8 recorded BAD lines before, for dc and sysapp).

- [ ] **Step 4: BaseApp, the scratch project (EXPLORATORY).** Same on `$S/baseapp-r303`. Expected: zero `FAIL`; `reach-latch-refused` falls from 12 to **0** (every BaseApp BLOCK member is `[if:V]` right after its header's end); identity keys identical in site set and `operatorName`, with `reachGrain` moving from `unplaced` to `statement` or `enclosing` ONLY for mutants in the 12 BLOCK members R303 named (list them by member from the BEFORE warnings and check each moved entry belongs to one); the oracle reports `0 BAD`. The emitted diffs of BLOCK files also carry new reach markers, so they are inspected by hand, one file at a time (10 files): each change must be the header `var`, a blanked `var`, a latch declaration moving, or a reach marker (with its `begin ... end` wrapper for a single-statement slot). Anything else is a STOP. This evidence is EXPLORATORY wherever it is quoted: it runs selected BaseApp files outside BaseApp's own project, as R303's refusal count did. It is not a whole-BaseApp run and not a whole-corpus alc pass (R311).

- [ ] **Step 5: Offline alc compile of dc's emitted target, attempted.** dc (`U:/Git/DC/Cloud`) declares about a dozen Continia dependencies (Continia System Application, Online Connector, Business Foundation, Approvals, Connector App, Core, Delivery Network, and more), and both `U:/Git/DC/.alpackages` and `U:/Git/DC/Cloud/.alpackages` were EMPTY at plan time. So:
  1. Look for the symbols: `find U:/Git -maxdepth 5 -iname "Continia*.app" 2>/dev/null` and the `.alpackages` of every fixture and scratch project on this machine. Record what was found.
  2. If EVERY dependency in dc's `app.json` resolves at a compatible version: stage them plus the Microsoft symbols (`extensions/lethal-control/.alpackages`) and `lethal-control.app` into `$S/target-after-dc/.alpackages`, write `injectControlDependency(dc's app.json)` as its `app.json`, and run `alc` with dc's own `preprocessorSymbols` (absent if dc declares none), then once more with each symbol the census files use (`CLEAN27`, and any other symbol named in an `INBODY-LAST` file's directives). Expected: exit 0 and an `.app` each time. Also run the same compile on `$S/target-before-dc` (HEAD's emission) and record its `AL0631` errors: that is the negative control at corpus scale.
  3. If ANY dependency cannot be staged: do not compile a partial set (missing symbols give hundreds of AL0185 errors that hide AL0631). Record "dc offline compile UNVERIFIED: <missing dependency names>" and file `docs/roadmap/R<next+1>.md` (`ls docs/roadmap/` first): "No offline alc compile of a real corpus's emitted target: dc's Continia dependencies are not staged on this machine, so R303 and R<next> are proven on hand-written repros and the text oracle only". Status `open, filed <date>`, section `product-gaps`. Commit it with a regenerated `ROADMAP.md`.

- [ ] **Step 6: Record.** Write the figures (per corpus: FAIL count, refused count before and after, oracle BAD before and after, changed-file count and that each is explained, the dc compile result or UNVERIFIED) into Task 5's roadmap text.

---

### Task 5: Roadmap

**Files:** `docs/roadmap/R303.md`, `docs/roadmap/R<next>.md`, `docs/roadmap/R310.md`, `docs/roadmap/R297.md`, `ROADMAP.md`.

- [ ] **Step 1: R<next>.** Status `done (<Task 1 commit>)`. Add: the rule (after the `var` keyword when the last child is a `preproc_conditional_var`), the alc rows, Task 4's dc/sysapp oracle figures (BAD before, 0 after), the dc compile result or a link to R<next+1>, and Task 3's al-runner result for `k1-inbody-only`.

- [ ] **Step 2: R303.** Only if every admitted shape passed Task 2 Step 8 AND every repro passed Task 3 under every subset (else Task 3 Step 4 has stopped the plan): status `done (<Task 2 commit>)`. Add a dated section: the hoist rule; why per-arm duplication was rejected (an arm with no `var_section` needs a new line); the anchor is the header's actual end, and why that holds with attributes and multi-line parameters; that only LINE numbers are preserved (offsets and later columns move); the shapes still refused by name, both with zero corpus members (a pragma-only `#if` block before the var block; a split-header procedure followed by one); the al-runner version and the measured-green list from Task 3 (backend support is stated for those shapes only); BaseApp's EXPLORATORY refused count 12 to 0. If any shape was narrowed out in Task 2 Step 8, status becomes `open, narrowed <date> (<Task 2 commit>)` instead, naming the remaining shape and its alc error.

- [ ] **Step 3: R310, closed as a ruling ONLY if Task 3 was fully green.** If any al-runner probe failed, R310 stays open, untouched by this plan, because a refusal on al-runner would restore the very gap it names. If Task 3 was fully green, status: `closed <date>, ruling: after R303's hoist, a member is refused only when the token before its #if var block is not its header's end, and no measured corpus contains one (dc, sysapp, bcf 0; BaseApp exploratory 0), so the gap R310 names covers zero measured mutants`. Use the exact `closed <date> <dash> <ruling>` form CLAUDE.md allows, with the same dash character R77 and R101 use (the only dash in this plan, required by that format), so "how many are open" counts it closed. Add a **Reopen trigger** paragraph: reopen when any run's `reach-latch-refused` warning fires on a real project (a non-zero count in a campaign or corpus run), or when any later task refuses a hoisted shape on any backend; then do what R310's "What would close it" already says.

- [ ] **Step 4: R297, a dated correction.** Append (do not rewrite the closed text), filling the bracketed figures from Tasks 0 and 4: "**Correction, <date> (R-303):** 'instruments' in this item means `compileSchemataForFile` completes without a throw. It never meant the emitted target compiles: R-297's corpus proof ran no alc over corpus emission. At HEAD `a513df8`, wherever a reach latch is WRITTEN into a member whose `var` section ends in an `#if` block of declarations, the latch lands on the `#endif` line and alc rejects it (AL0631), under every symbol set, measured on hand-written repros. How often that happens is two different numbers. The parse-shape census counts members with that SHAPE (dc 40, sysapp 1, BaseApp 11, parse-only); the AFFECTED emissions are the members where a latch was actually written, which needs a statement-grain site: [dc N, sysapp N, BaseApp exploratory N], from Task 0 Step 8's oracle on HEAD's emission. dc's emitted target: [compiled offline, AL0631 reproduced at HEAD and gone after R<next> | offline compile UNVERIFIED, dependencies not staged, see R<next+1>]. Fixed by R<next>."

- [ ] **Step 5: Regenerate and commit.** Leave `R310.md` out of the `git add` when Step 3 kept it open.

```bash
ls docs/roadmap/   # confirm no one else took the ids this touches
bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R303.md docs/roadmap/R<next>.md docs/roadmap/R310.md docs/roadmap/R297.md ROADMAP.md
git commit -m "roadmap: R303 and R<next> closed by the hoist and the keyword anchor; R310 closed as a ruling if Task 3 was fully green (zero measured gap, reopen trigger); R297 corrected (instruments is not compiles)"
```

---

## Self-review

- Spec point 1 (enumerate shapes): plan-time census table plus Task 0 Steps 2 and 4 (single arm, if/else, elif, `#if` around the `var` keyword vs inside `var_body`, variables in one arm only, empty arms, triggers and procedures, `;` and comment headers, an attribute before the member, parameters spanning lines, name collision, CRLF, all insertions in one file).
- Point 2 (a rule valid under every symbol combination, alc-proven, negative control): the hoist and the keyword anchor; `alc-all.ts` enumerates every subset; negatives are HEAD's AL0631 (Task 0 Step 6, and at corpus scale in Task 4 Step 5 if dc's symbols stage), R303's AL0104 (Task 2 Step 10.3) and the blanking removal (Task 2 Step 9). al-runner is measured separately (Task 3).
- Point 3 (lift only for proven shapes): `splitVarHoistAnchor` admits only a block right after the header's actual end; anything else keeps the named refusal; Task 2 Step 8 narrows it on an alc FAIL; an al-runner FAIL stops the plan (Task 3 Step 4).
- Point 4 (fixtures, identity keys, corpus proof): Task 4.
- Point 5 (TDD, red-checks, roadmap): every task; Task 5.
- Review r1 and rulings: al-runner probe (Task 3); header-end anchor with attribute and multi-line probes (Task 2 Steps 1, 3, 8, 10); selector plus latches in one file (Task 2 Steps 1, 6, 8); the columns claim withdrawn (plan-time section, Task 2 Step 4 comment); R310 ruling (conditional on Task 3), R297 correction (narrowed), dc compile (Tasks 4 and 5); review r2: every repro and subset on al-runner, STOP on failure, R-297's real selector position, `linesWithoutSelector`; BaseApp exploratory (Global Constraints, census, Task 4 Step 4); the warning states the real predicate (Task 2 Step 7).
- Types: `splitVarHoistAnchor(owner: ALSyntaxNode): ALSyntaxNode | null` is the only new export; `headerEndOf` is module-private in `dispatch.ts`.

## Open questions

1. **The AL0631 defect is filed as its own item (R<next>) and fixed here.** It is the same family (a member-level `#if` var section) and the same function, but a different mechanism and a much larger reach (dc 40 members vs R303's 0). Is a separate item right, or should it be folded into R303's text?
2. **The two still-refused shapes have zero corpus members,** so this plan keeps them refused and named (review r1 agrees). R310's reopen trigger (if Task 3 lets it close) covers the day one appears. Is that trigger enough, or should a census of those two shapes run as part of every future corpus campaign?
