# R-309: refuse a split-header procedure whose arms each have their own var section by name, instead of throwing the whole run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r2 (2026-09-28).** Revised per review r1 (`H:/lethal-coord/reviews/R-309-plan/review-r1.md`) and the orchestrator's rulings. What changed: master is merged in and R316 is the orchestrator's item (`75c36ae`), so Task 0 no longer files it and the plan cites it by id; Task 2 asserts only what R309 owns (grain, no latch, the warning), not R316's `procedureName ""` or absent scope; Task 5 no longer edits R316 (R309 only cross-links it); per-arm placement waits on R316 (ruling, kept); the trigger grammar defect is filed upstream as SShadowS/tree-sitter-al #32 and cited; the injector's throw stays as a guard for unexpected trees (the review found the predicate sound); Task 2 bounds EVERY member through its closing `end;` and asserts a non-empty unplaced set for each refused member and statement grain for every admitted one; Tasks 3 and 4 fail fast (`set -euo pipefail`, no `grep -v` masking, raw logs kept), and a checker script verifies every expected symbol subset and, per member, the counts, grains and verdicts; the plan states that the refusal's cause shows only in the warning and event, never in the manifest or `SessionReport` (consistent with R310); the uninstrumented alc subset count is 24. The revised Task 2 runner test was re-run against the prototype refusal (2 pass).

**Revision r1 (2026-09-28), draft for the orchestrator's review.**

**Goal:** A `preproc_split_procedure_preamble` (a procedure whose header AND var section are both split by `#if`, one pair per arm, with one shared body after `#endif`) no longer stops the whole run. The writer declares no reach latch there and names the member in a `reach-latch-refused` warning, exactly as it already does for R303's and R313's shapes. The rest of the file, and the rest of the run, is instrumented as before.

**Architecture:** One predicate change in `packages/schemata/src/dispatch.ts`: `reachLatchRefusedOwner` also stops at, and returns, a `preproc_split_procedure_preamble`. `placeReach` already consults it, so every mutant in such a member gets `reachGrain: "unplaced"` and no marker, and `injectReachLatches` in `packages/schemata/src/compile.ts` never sees a statement-grain marker there, so its throw is no longer reachable for this shape. `reachLatchRefusals` in `packages/runner/src/orchestrator.ts` then lists the member; its `unparsed: boolean` becomes a three-way `cause`, and the warning gets an R309 sentence. No emission changes for any file without this shape. Per-arm placement is NOT built (see "Decision" below).

**Tech Stack:** Bun, TypeScript, tree-sitter-al 4.4.1 (WASM, vendored in `packages/engine/vendor`), `bun:test`, `alc` (offline compile), a local `al-runner` v2.11.0 (`C:/Users/SShadowS/.dotnet/tools/al-runner.exe`, no container). No container, no live run.

**Spec:** `docs/roadmap/R309.md`, `H:/lethal-coord/tasks/R-309/task.md`. Sibling plan and precedent: `docs/superpowers/plans/2026-09-28-R-303-latch-placement-split-var.md` (its alc harness, its al-runner probe and its STOP rule are reused here).

---

## What was measured at plan time (2026-09-28)

Every repro is hand-written with invented names. No corpus source is quoted. The scratch tools are copies of R-303's (`alc-all.ts`, `alc-plain.ts`, `alrunner-probe.ts`, `identity-keys.ts`, `locate.ts`, `r303-census.ts`) repointed at this worktree, plus `shape.ts` (prints each member node's direct children) and `preamble-census.ts` (counts preamble nodes). A scratch worktree (`$S/proto`, detached at `656646b`, removed afterwards; its diff is kept as `$S/proto-refusal.patch`) held the refusal exactly as Tasks 1 and 2 write it, so the numbers below are the plan's own code, not a guess.

### The grammar (tree-sitter-al 4.4.1, the vendored build)

`preproc_split_procedure_preamble` is `preproc_if _procedure_preamble (preproc_elif _procedure_preamble)* [preproc_else _procedure_preamble] preproc_endif code_block [;]`, and `_procedure_preamble` is `_procedure_header [var_section | preproc_conditional_var_block]`. Both helper rules are hidden, so each arm's attributes, modifier, `procedure` keyword, `name` field, `(`, `parameter_list`, `)`, return type, and `var_section` (or nested `#if` var block) are DIRECT children of the preamble node. The body `code_block` is a direct child too. So:

- The owner walk in `injectReachLatches` climbs from a body statement to the preamble, finds it neither procedure-like (`isProcedureLike` is `procedure` or `preproc_split_procedure` only) nor a trigger, keeps climbing to the object and then the file root, and throws `a reach marker sits outside any procedure or trigger body`. That is R309.
- `procedureLikeNameNode` works on a preamble unchanged, because it reads the `name`-field children and those are the preamble's own: one name when every arm agrees, `null` when an arm renames the procedure (R301's rule).
- The rule exists for procedures ONLY. There is no trigger form, in 4.4.1 or at upstream HEAD `d4d38e4`.

### The repros and their parse shapes

`$S/repro/<name>/`, each with the R-303 repro `app.json` and one `Repro.Codeunit.al` holding `codeunit 50100 "Repro P"` and `var Glob: Integer;`. Unless stated, every arm is `procedure Pick(X: Integer): Integer`, and the shared body is `begin if X > 1 then Glob := X + 1; Glob := Glob + 2; exit(Glob); end;` (four mutation sites under the real operator set).

| repro | arms | symbols | parse (`shape.ts`, ERROR count) |
| --- | --- | --- | --- |
| `p1-if-else` | `#if CLEAN27`: var `K`; `#else`: `[Obsolete]` attribute, var `K, M` | CLEAN27 | preamble, 0 |
| `p2-elif-else` | `#if A`: var `K`; `#elif B`: var `M`; `#else`: var `N: Text` | A,B | preamble, 0 |
| `p3-elif-noelse` | `#if A`: var `K`; `#elif not A`: `[Scope('OnPrem')]`, var `M` | A | preamble, 0 |
| `p4-one-arm-novar` | `#if CLEAN27`: var `K`; `#else`: header only, no var | CLEAN27 | preamble, 0 |
| `p5-trigger` (control) | `#if CLEAN27`: `trigger OnRun()` var `K`; `#else`: `trigger OnRun()` var `M` | CLEAN27 | NOT a preamble: `preproc_conditional` with an `ERROR`, 4 ERROR nodes |
| `p6-crlf` | `p1-if-else` saved with CRLF | CLEAN27 | preamble, 0 |
| `p7-mixed` | object var `Glob` then `#if not CLEAN27` / `Old` / `#endif` (R-297's selector anchor case), a plain `Plain`, `p1`'s preamble `Pick`, an R303 hoist member `Hoist` | CLEAN27 | procedure, preamble, procedure with `preproc_conditional_var_block`; 0 |
| `p8-nested-condvar` | `#if A`: header then `#if B` / var `K` / `#endif`; `#else`: var `M` | A,B | preamble whose first arm holds a `preproc_conditional_var_block`, 0 |
| `p9-all` | `p7-mixed` plus a renamed preamble (`#if CLEAN27` `Pick2` with var, `#else` `Choose` with no var, body `Glob := X + 7; exit(Glob);`) and an R301 split header `Split` (shared var `S`) | CLEAN27 | procedure, preamble, hoist procedure, preamble, `preproc_split_procedure`; 0 |
| `p10-renamed` | `#if CLEAN27`: `Pick` var `K`; `#else`: `Choose` var `M` | CLEAN27 | preamble, 0 |

Every repro, UN-instrumented, compiles under every subset of its symbols (`alc-plain.ts`: exit 0 and an `.app`, all 24 subsets: 22 for the preamble repros plus 2 for `p5-trigger`). So any later failure is LethAL's, not the repro's.

### HEAD behaviour (`656646b`, through the real pipeline, `alc-all.ts`)

- Every preamble repro THROWS in `writeInstrumentedProject`: `compileSchemataForFile: cannot instrument Repro.Codeunit.al: a reach marker sits outside any procedure or trigger body ... (R309)`. The whole run stops, including `p7-mixed`'s three healthy members.
- `p5-trigger` does NOT throw: tree-sitter-al leaves an ERROR inside the member, R313's `varSectionUnparsed` refuses it by name (`trigger OnRun's var section did not parse cleanly ... R313.`), and alc passes both subsets. So the trigger form needs no R309 work; it is a grammar defect (drafted in Notes).

### The refusal, prototyped (the exact code of Tasks 1 and 2)

| repro | warning(s) | alc, every subset (`alc-all.ts`) |
| --- | --- | --- |
| `p1-if-else` | `procedure Pick` R309 | PASS (2) |
| `p2-elif-else` | `procedure Pick` R309 | PASS (4) |
| `p3-elif-noelse` | `procedure Pick` R309 | PASS (2) |
| `p4-one-arm-novar` | `procedure Pick` R309 | PASS (2) |
| `p5-trigger` | `trigger OnRun` R313 (unchanged) | PASS (2) |
| `p6-crlf` | `procedure Pick` R309 | PASS (2) |
| `p7-mixed` | `procedure Pick` R309 | PASS (2) |
| `p8-nested-condvar` | `procedure Pick` R309 | PASS (4) |
| `p9-all` | `procedure Pick` and `procedure <unnamed>` R309 | PASS (2) |
| `p10-renamed` | `procedure <unnamed>` R309 | PASS (2) |

In `p7-mixed`'s emission, `Plain` and `Hoist` each get their latch (`P: Integer; LethALReachLatch: Boolean;` and `procedure Hoist(X: Integer): Integer var LethALReachLatch: Boolean;`), `Pick` gets none, and the selector goes after the object's `#endif` on a line of its own, as R-297 places it. Its manifest: `Plain` and `Hoist` mutants `reachGrain: "statement"`, all four `Pick` mutants `"unplaced"`.

The Task 1 and Task 2 tests, written into the prototype: 9 new schemata tests and 2 runner tests PASS, and the whole suite there is green (`bun test` from the root: 4117 pass, 7 skip, 0 fail). Red-checked there: dropping the preamble stop from the walk turns all 9 new schemata tests red (each throws the R309 message); making `cause` never `"preamble"` turns the runner warning test red (it prints R303's sentence).

### al-runner, local (v2.11.0), refusal prototype, every subset

`$S/alrunner-probe.ts` (R-303's probe plus `COV=1` for al-runner's own coverage), with the prototype's code, one session per subset of each repro's symbols, both coverage modes: 22 subsets per mode, 44 sessions. Each repro's test app calls each member with `X = 5` and `X = 0` and raises `Error(...)` on a wrong result.

| repro | subsets | coverage ON: preamble mutants | coverage ON: other members | coverage OFF: preamble mutants | result |
| --- | --- | --- | --- | --- | --- |
| `p1-if-else`, `p3-elif-noelse`, `p4-one-arm-novar`, `p6-crlf`, `p10-renamed` | 2 each | 4 `no-coverage` | none | 3 killed, 1 survived | PASS |
| `p2-elif-else`, `p8-nested-condvar` | 4 each | 4 `no-coverage` | none | 3 killed, 1 survived | PASS |
| `p7-mixed` | 2 | 4 `no-coverage` | 7 killed, 1 survived, all `exact` attribution | 3 killed, 1 survived | PASS |
| `p9-all` | 2 | 5 `no-coverage` | 8 killed, 1 survived, all `exact` (the R301 `Split` mutant included) | 4 killed, 1 survived | PASS |

Every session: `baselineGreen=true`, `errors=0`. Every preamble mutant `reachGrain=unplaced`; every other member's mutants `statement`. Verdicts are identical across every subset of a repro. The one survivor per preamble is `conditional-boundary` on `X > 1`, which the inputs 5 and 0 cannot tell from `X >= 1`: an honest survivor, the same in `Hoist`. So the refused member's file compiles and runs on al-runner, and the refusal changes no verdict of any other member. The coverage-ON column is the finding filed as R316 below: the tests DO execute the preamble (coverage OFF kills 3 of 4), yet with coverage on no test is attributed to it.

### What else touches this node (so the refusal does not just move the throw)

| stage | at HEAD, for a preamble member | after the refusal |
| --- | --- | --- |
| operator dispatch (spec generation) | runs; finds sites (4 in `p1`) | unchanged (spec generation is not touched) |
| `placeReach` / `reachGrainOf` | `statement` (no refusal applies) | `unplaced` |
| `injectReachLatches` | throws, whole run | no statement-grain marker reaches it; nothing written |
| R-297 selector anchor | fine: the preamble is a sibling of the object `var_section`, not inside it (`a-preamble, in isolation`) | unchanged |
| manifest (`procedureNameOf`, `procedureScopeOf`) | never reached (throw) | `procedureName ""`, `procedureScope` absent, no member span, `triggerName` absent |
| `gapBlockOf` | never reached | the body is not a procedure body, so the gap block climbs to the file root (`p7-mixed`: lines 1 to 46) |
| line map `spansOf` (bcdev fenced, al-runner coverage) | never reached | descends into the preamble and finds no procedure: no span, lines fall in no member |
| identity key | never reached | serializes, with an empty procedure part; unique within `p9-all` |
| coverage (`coverageFilter`) with al-runner coverage ON | never reached | every preamble mutant `no-coverage`, although the tests execute it (see the table above) |

The last four rows are one defect, and it is NOT R309's: this member has no procedure name, scope or span anywhere in the pipeline. With coverage on, its mutants read `no-coverage` while the tests run them: a false no-coverage, which drops live sites from the score (it never manufactures a kill or a survivor). There is also a SITE loss: the same body in a plain procedure gets 7 mutants, in a preamble 4 (`empty-block`, `return-value` and one `swap-additive` are missing, measured on a twin-body repro `q1-twin-body`), the same semantic blindness R302 names for `preproc_split_procedure`. Both are [[R316]], filed by the orchestrator on master (`75c36ae`). This plan does not fix them and does not pin them in a test.

### Per-arm placement, measured on hand-written text

The rule a per-arm placement would need is R303's hoist applied once per arm: after each arm's header end, ` var <latch>: Boolean;`, and each `var` keyword inside that arm blanked to spaces. Hand-written OUTPUT, compiled un-instrumented (`alc-plain.ts`, the latch set in the body by a hand-written marker):

| text | symbols, every subset | result |
| --- | --- | --- |
| `pa-p1` (per-arm hoist, 2 arms) | CLEAN27 | PASS (2) |
| `pa-p2` (3 arms) | A,B | PASS (4) |
| `pa-p4` (one arm with no var: the hoist gives it one) | CLEAN27 | PASS (2) |
| `pa-p8` (an arm whose var section is inside `#if`) | A,B | PASS (4) |
| `pa-p1-append` (latch appended after each arm's last declaration instead) | CLEAN27 | PASS (2) |
| `neg-first-arm-only` (latch in the first arm only, negative control) | CLEAN27 | FAIL with CLEAN27 absent, `AL0118` (the latch does not exist in the `#else` build) |

So per-arm placement is valid AL. It was not built into the prototype and not probed on al-runner.

### Census

`preamble-census.ts`: 0 `preproc_split_procedure_preamble` nodes in DC/Cloud (1135 files), System Application (1718), BusinessFoundation (104), and BaseApp in two halves (9620 files, parse-only). Every `fixtures/*` project has no `#if`, `#elif`, `#else` or `#endif` line at all (`grep -rlE '^\s*#(if|else|elif|endif)' --include=*.al fixtures` is empty). Fixture identity keys and emitted targets for `sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-harden` and `sandbox-coverage-probe`: HEAD and the prototype are identical (`diff` empty for both).

### Decision: the named refusal, not per-arm placement

1. **Per-arm placement would buy nothing measurable today.** A latch gives the member's mutants `reachGrain: "statement"`, and the reach reading is taken per covering test. But with coverage on, the member has no name and no span, so no test is ever attributed to its mutants (R316): they read `no-coverage` before any reach is read. With coverage off, al-runner runs every test anyway and scores the mutants (the table above) without a reach reading being needed.
2. **It is not cheap.** It is a second header-end anchor rule, per arm (the preamble's children interleave every arm's header, so `headerEndOf` cannot be reused as is), plus its own negative controls, red-checks and an al-runner probe of every repro, for a shape with 0 corpus sites.
3. **The refusal is small, proven and truthful.** One predicate, one warning sentence; alc PASS on every repro and subset; the member is still instrumented and scored, exactly like R303's and R313's refused members.

Per-arm placement waits on R316 (orchestrator ruling): it is the latch step to take AFTER R316 gives the member a name and a span, with the alc evidence above as its starting point.

**What the refusal makes visible, and what it does not.** The three-way `cause` distinguishes R309 from R303 and R313 in the `reach-latch-refused` WARNING and its event (console and the `--progress-out` NDJSON) only. The manifest and the `SessionReport` still show each refused mutant as a generic `reachGrain: "unplaced"`, with nothing naming the cause. That is the visibility R310's ruling accepts; this plan adds no report field.

---

## Global Constraints

- Plain English, short sentences, no em dashes, in code comments, commits and roadmap text.
- No corpus source text in any committed file. File names, member names and counts are fine. Every repro is hand-written.
- No emission change for any file without a `preproc_split_procedure_preamble`. Fixtures have no `#if` at all, so every fixture emission and identity key is byte-identical; Task 4 proves it by diff, not by argument. No live gate is needed for that reason; say so in the commit messages.
- A refused member is still instrumented and scored. Its file must still compile under every subset of its symbols (`alc-all.ts`), and its al-runner run must be green (Task 3).
- No container, no live run. Control app minimum stays `MIN_CONTROL_VERSION = "1.0.0.20"` (`packages/runner/src/harness.ts`).
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions; destructure and check `undefined`. Fail loudly on a contract violation: the injector's throw stays, as a guard no known shape reaches.
- Every fix is red-checked: revert the specific line, confirm the specific test goes red, restore, report both outputs.
- This plan files no new roadmap item. Every id it names (R301, R302, R303, R309, R310, R311, R312, R313, R316) was checked against `git ls-tree master docs/roadmap/` at r2. Regenerate with `bun scripts/roadmap-index.ts`; never hand-edit `ROADMAP.md`.
- Every scratch shell block runs under `set -euo pipefail`, never filters a command's output through `grep -v` (stderr goes to a file of its own instead), and keeps its raw logs under `$S/logs/`.
- `reachLatchRefusedOwner` and `reachLatchRefusals` keep their names. `reachLatchRefusals`'s `unparsed: boolean` becomes `cause: "preamble" | "unparsed" | "split-var"`; its only caller is `generateMutationSet` (grep at plan time, no test or script reads the field). The warning code stays `reach-latch-refused`, and every message keeps the `[lethal] <file>: <member>'s var section` prefix the runner tests split on.
- Any al-runner probe failure is a STOP (the R-303 rule): report to the coordinator, the fix becomes its own designed task.

## Review Focus

1. **The predicate stays truthful.** `reachLatchRefusedOwner`'s walk now stops at the FIRST of: a procedure-like node, a trigger, or a preamble. A preamble cannot sit inside a procedure or trigger, and nothing procedure-like sits inside a preamble's body, so the first one hit is the member. Expected: the doc comment names all three shapes (R303, R309, R313) and says the returned node for R309 is the preamble itself, which is not procedure-like. Pinned by Task 1's M1 test (one assignment per member kind, each mapped to its owner).
2. **The warning is true for every preamble.** An arm may have no var section (`p4`, and `Choose` in `p9-all`). Expected: the sentence says "its own var section, if any", and the member name is `procedure <unnamed>` when the arms rename the procedure (R301's naming rule). Pinned by Task 2's runner test.
3. **CRLF.** Expected: identical behaviour; no text is written into the member at all. Pinned by Task 1's `P6` case.
4. **The throw is not moved elsewhere.** Every later stage that sees the member (manifest, gap blocks, line map, identity keys, coverage) runs without throwing. Pinned by Task 2's runner test (manifest and identity keys) and Task 3 (the whole al-runner session, coverage on and off).
5. **R309 asserts only what R309 owns.** A preamble member's missing name, scope and coverage are [[R316]]'s. Expected: no test in this plan asserts `procedureName`, `procedureScope` or coverage for a preamble mutant, so R316's fix needs no change here. The refusal's cause is visible in the warning and event only, not in the manifest or `SessionReport` (R310's ruling).
6. **Every member is classified.** Expected: Task 2 bounds each member from its first line through its closing `end;`, asserts every mutant falls in exactly one member, and asserts per member a non-empty set with one grain (`unplaced` for `Pick` and `Pick2`, `statement` for `Plain` and `Hoist`). Task 3's checker does the same per member for the al-runner verdicts.
7. **Stale prose.** Every place that says R309 throws (code comments in `dispatch.ts`, `compile.ts`, `orchestrator.ts`, `tree-walks.ts`; roadmap items R301, R303, R310, R312, R313, R309 itself). Expected: none says "throws" for this shape after Task 5. Pinned by the grep in Task 5 Step 3.

---

## File structure

- Modify `packages/schemata/src/dispatch.ts`: `reachLatchRefusedOwner` (walk and doc comment), `splitVarHoistAnchor`'s doc comment, one comment in `placeReach`.
- Modify `packages/schemata/src/compile.ts`: the owner-null throw's message only.
- Modify `packages/engine/src/ast/tree-walks.ts`: `isProcedureLike`'s doc comment only.
- Modify `packages/runner/src/orchestrator.ts`: `reachLatchRefusals` (`cause`) and the `reach-latch-refused` message.
- Modify `packages/schemata/tests/compile.test.ts`: replace the `a-preamble ... still throws` test; add the R309 describe at the end.
- Modify `packages/runner/tests/preproc-instrumentation.test.ts`: add the R309 describe at the end.
- Roadmap: `docs/roadmap/R309.md`, `R301.md`, `R303.md`, `R310.md`, `R312.md`, `R313.md`, regenerated `ROADMAP.md`.
- Scratch, never committed (`$S` = `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r309`): the tools and repros listed above, already present at plan time.

---

### Task 0: Scratch tools, repros and BEFORE captures (no product change)

**Files:** scratch only. R316 is already on master (`75c36ae`); this task does not file it.

- [ ] **Step 1: Tools.** The plan-time tools are in `$S`. Confirm each imports from `U:/Git/LethAL-wt/r309` (not `r303`, not `$S/proto`): `grep -n "U:/Git" $S/*.ts`. `alrunner-probe.ts` carries two plan-time additions: `COV=1` in the environment passes `coverage: "al-runner"` to `AlRunnerBackend`, and each mutant line prints `attr=<coverageAttribution> cov=<covering test count>`. `extensions/lethal-control/lethal-control.app` must be 1.0.0.20 or newer (it is at plan time).

- [ ] **Step 2: Repros.** `$S/repro/p1-if-else` to `p10-renamed` and `q1-twin-body`, and the test apps `$S/repro-tests-<name>/` for every preamble repro except `p5-trigger` (one test codeunit 50150, `Subtype = Test`, calling each member with `X = 5` and `X = 0` and raising `Error(...)` on a wrong result; `p9-all` and `p10-renamed` call the renamed member under `#if CLEAN27` / `#else`). They exist at plan time. Re-run `bun $S/shape.ts $S/repro/*/Repro.Codeunit.al` and `bun $S/alc-plain.ts $S/repro/<name> <symbols>` for each: expected the parse table and the all-PASS result in "What was measured".

- [ ] **Step 3: HEAD's result, the negative control.** At the r2 merge commit (before any Task 1 change), `bun $S/alc-all.ts $S/repro/<name> <symbols>` for `p1-if-else`, `p7-mixed` and `p5-trigger`. Expected: `p1` and `p7` throw the R309 message; `p5` prints the R313 warning and PASSes.

- [ ] **Step 4: BEFORE captures.**

```bash
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r309
set -euo pipefail
cd /u/Git/LethAL-wt/r309
mkdir -p "$S/logs"
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-before-$f.txt"
  rm -rf "$S/target-before-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-before-$f" > "$S/ids-before-$f.txt"
done
declare -A C=([dc]="U:/Git/DC/Cloud" [sysapp]="U:/Git/BC.History/System Application" [bcf]="U:/Git/BC.History/BusinessFoundation")
for k in "${!C[@]}"; do
  bun scripts/corpus-fingerprint.ts "${C[$k]}" > "$S/fp-before-$k.txt"
  bun "$S/preamble-census.ts" "${C[$k]}" > "$S/census-$k.txt"
  bun "$S/locate.ts" "${C[$k]}" > "$S/locate-before-$k.txt" 2> "$S/logs/locate-before-$k.err"
  rm -rf "$S/target-before-$k"; bun "$S/identity-keys.ts" "${C[$k]}" "$S/target-before-$k" > "$S/ids-before-$k.txt"
done
for h in 0 1; do bun "$S/preamble-census.ts" U:/Git/BC.History/BaseApp $h/2 > "$S/census-baseapp-$h.txt"; done
```

Expected: every command exits 0 (the block stops at the first that does not), and every census line says `preamble=0`. A non-zero count is a STOP: record the files, since the "0 corpus sites" premise no longer holds and the orchestrator decides whether per-arm placement moves up.

---

### Task 1: The refusal (schemata)

**Files:**
- Modify: `packages/schemata/src/dispatch.ts` (`reachLatchRefusedOwner`, `splitVarHoistAnchor`'s doc comment, the refusal comment in `placeReach`)
- Modify: `packages/schemata/src/compile.ts` (the owner-null throw's message)
- Modify: `packages/engine/src/ast/tree-walks.ts` (`isProcedureLike`'s doc comment)
- Test: `packages/schemata/tests/compile.test.ts`

**Interfaces:**
- `reachLatchRefusedOwner(node)` keeps its signature. It now returns the `preproc_split_procedure_preamble` node for any node inside one.
- No new export.

- [ ] **Step 1: Write the failing tests.** In the `R297: the selector var is inserted after the leading declarations` describe, replace the whole `it("a-preamble: a spec inside the preamble procedure still throws (no latch owner; filed)", ...)` with:

```ts
  it("a-preamble: a spec inside the preamble procedure is refused by name, not thrown (R309)", () => {
    const root = wrapRoot(parseAL(PREAMBLE));
    const s = spec(assignment(root, "L := 1"), "L := 2", "lethal.op");
    expect(reachLatchRefusedOwner(s.before)?.rawKind).toBe("preproc_split_procedure_preamble");
    const out = compileSchemataForFile(PREAMBLE, root, [s]);
    expect(out).not.toContain(REACH_LATCH);
    expect(out).not.toContain("MutationSelector.Reached(");
    expect(selectorAt(out)).toBeLessThan(out.indexOf("#if"));
  });
```

Append at the end of the file:

```ts
/** R309: split-header procedures whose #if arms each hold their own header and var section. Hand-written. */
const PREAMBLE_BODY = `    begin
        Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;

const PREAMBLE_CASES: { name: string; src: string }[] = [
  {
    name: "P1 #if and #else arms, an attribute in the #else arm",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P2 #if, #elif and #else arms",
    src: `codeunit 50100 "Repro P"
{
#if A
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#elif B
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        N: Text;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P3 #if and #elif, no #else",
    src: `codeunit 50100 "Repro P"
{
#if A
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#elif not A
    [Scope('OnPrem')]
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P4 one arm with no var section",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P8 an arm whose own var section is itself inside #if",
    src: `codeunit 50100 "Repro P"
{
#if A
    procedure Pick(X: Integer): Integer
#if B
    var
        K: Integer;
#endif
#else
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
  {
    name: "P10 arms that rename the procedure",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Choose(X: Integer): Integer
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
];

describe("R309: a split-header procedure whose arms each have their own var section is refused by name", () => {
  beforeAll(async () => {
    await initParser();
  });

  const instrumentAll = (src: string) => {
    const root = wrapRoot(parseAL(src));
    const specs = findAll(root, ALNodeKind.assignment_statement).map((n) =>
      spec(n, "Glob := 0", "lethal.op"),
    );
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const grains = buildComponents(ided).flatMap((c) =>
      c.members.map((m) => reachGrainOf(m, c.root)),
    );
    return { specs, grains, out: compileSchemataForFile(src, root, specs, ided) };
  };

  const [first] = PREAMBLE_CASES;
  if (first === undefined) throw new Error("fixture drift: no preamble case");
  const cases = [
    ...PREAMBLE_CASES,
    { name: "P6 P1 saved with CRLF", src: first.src.replace(/\n/g, "\r\n") },
  ];
  for (const c of cases) {
    it(`${c.name}: a preamble owns every site, all unplaced, no latch, no marker, no line moved`, () => {
      const { specs, grains, out } = instrumentAll(c.src);
      expect(specs).toHaveLength(2);
      for (const s of specs)
        expect(reachLatchRefusedOwner(s.before)?.rawKind).toBe("preproc_split_procedure_preamble");
      expect(grains).toEqual(["unplaced", "unplaced"]);
      expect(out).not.toContain(REACH_LATCH);
      expect(out).not.toContain("MutationSelector.Reached(");
      expect(out.split(SELECTOR_DECL).length - 1).toBe(1);
      expect(directiveLinesClean(out)).toBe(true);
      const lf = (t: string): string => t.replace(/\r\n/g, "\n");
      expect(linesWithoutInstrumentation(lf(out))).toBe(lf(c.src).split("\n").length);
    });
  }

  it("M1: a plain member, a preamble, an R303 hoist, an R301 split header and R-297's selector anchor in one file", () => {
    const src = `codeunit 50100 "Repro P"
{
    var
        Glob: Integer;
#if not CLEAN27
        Old: Integer;
#endif

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        P := X + 3;
        exit(P);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
    begin
        Glob := X + 1;
        exit(Glob);
    end;

    procedure Hoist(X: Integer): Integer
#if not CLEAN27
    var
        H: Integer;
#endif
    begin
        Glob := X + 4;
        exit(Glob);
    end;

#if CLEAN27
    procedure Split(X: Integer): Integer
#else
    [Obsolete('Old', '27.0')]
    procedure Split(X: Integer): Integer
#endif
    var
        S: Integer;
    begin
        S := X + 5;
        exit(S);
    end;
}
`;
    const root = wrapRoot(parseAL(src));
    const assignments = findAll(root, ALNodeKind.assignment_statement);
    expect(
      assignments.map((n) => `${n.text} -> ${reachLatchRefusedOwner(n)?.rawKind ?? "latch"}`),
    ).toEqual([
      "P := X + 3 -> latch",
      "Glob := X + 1 -> preproc_split_procedure_preamble",
      "Glob := X + 4 -> latch",
      "S := X + 5 -> latch",
    ]);
    const specs = assignments.map((n) => spec(n, "Glob := 0", "lethal.op"));
    const ided = assignMutantIds(new Map([["f.al", specs]])).get("f.al") ?? [];
    const out = compileSchemataForFile(src, root, specs, ided);
    expect(out).toContain(`P: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`    procedure Hoist(X: Integer): Integer var ${REACH_LATCH}: Boolean;`);
    expect(out).toContain(`S: Integer; ${REACH_LATCH}: Boolean;`);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(3);
    expect(out.split("MutationSelector.Reached(").length - 1).toBe(3);
    // R-297: the selector goes after a declaration-only #if block's #endif, on a line of its own.
    expect(out).toContain(
      `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR_DECL}\n`,
    );
    expect(directiveLinesClean(out)).toBe(true);
    expect(linesWithoutInstrumentation(out)).toBe(src.split("\n").length);
  });
});
```

Every helper used here (`spec`, `directiveLinesClean`, `SELECTOR_DECL`, `linesWithoutInstrumentation`, `reachLatchRefusedOwner`, `reachGrainOf`, `buildComponents`, `assignMutantIds`, `findAll`) already exists in the file at `656646b`; `selectorAt` and `assignment` are the R297 describe's own. The bodies use no `if ... then` on purpose: a single-statement slot's `begin`/`end` wrap adds lines by design and `linesWithoutInstrumentation` does not fold it.

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/schemata/tests/compile.test.ts -t "R309|a-preamble"`. Expected: the new `a-preamble` test and all 8 new R309 tests FAIL, each throwing `a reach marker sits outside any procedure or trigger body`. The old `a-preamble, in isolation` test PASSes (it is a control, green before and after).

- [ ] **Step 3: Implement the predicate.** In `dispatch.ts`, replace `reachLatchRefusedOwner` and its doc comment with:

```ts
/**
 * The member holding `node` when the writer declares no reach latch there, else `null`. Three
 * shapes, each refused by name in the `reach-latch-refused` warning:
 * - R309: a `preproc_split_procedure_preamble`, a split-header procedure whose `#if` arms each
 *   hold their own header and their own `var` section (an arm may have none), with one shared body
 *   after `#endif`. One latch declaration cannot serve every arm's section, and a per-arm placement
 *   is not built (it would measure nothing until R316 gives the member a name and a span). The
 *   node returned is the preamble itself, which is not procedure-like.
 * - R313: a procedure or trigger whose var section did not parse cleanly (`varSectionUnparsed`).
 * - R303: a procedure or trigger whose var section sits inside `#if` in a shape
 *   `splitVarHoistAnchor` does not cover.
 * Such a member gets no latch and no marker: its mutants are `unplaced`, their reach is
 * `not-decided`, never unreached. The member is still instrumented and scored.
 */
export function reachLatchRefusedOwner(node: ALSyntaxNode): ALSyntaxNode | null {
  let owner: ALSyntaxNode | null = node;
  while (
    owner !== null &&
    !isProcedureLike(owner) &&
    owner.kind !== ALNodeKind.trigger &&
    owner.rawKind !== "preproc_split_procedure_preamble"
  )
    owner = owner.parent;
  if (owner === null) return null;
  if (owner.rawKind === "preproc_split_procedure_preamble") return owner;
  if (varSectionUnparsed(owner)) return owner;
  const split = owner.children.some((c) => c.rawKind === "preproc_conditional_var_block");
  return split && splitVarHoistAnchor(owner) === null ? owner : null;
}
```

In `splitVarHoistAnchor`'s doc comment, replace the last sentence ("Not every unproven shape reaches here: ... (R309, open).") with: "A `preproc_split_procedure_preamble` never reaches here: `reachLatchRefusedOwner` refuses it first (R309)." In `placeReach`, replace the two comment lines above `if (reachLatchRefusedOwner(root) !== null)` with `// R303, R309, R313: a member the writer declares no latch in gets no marker.`

- [ ] **Step 4: The injector's message.** In `compile.ts` (`injectReachLatches`, the `owner === null || begin === undefined` throw), keep the throw and its first sentence, and replace the R309 sentence, so the message reads:

```ts
        `compileSchemataForFile: cannot instrument ${filePath}: a reach marker sits outside any procedure or trigger body, so its latch \`${REACH_LATCH}\` has nowhere to be declared. No known shape reaches here: a split-header procedure whose #if arms each have their own var section (preproc_split_procedure_preamble) is refused by \`placeReach\` before any marker is placed (R309).`,
```

- [ ] **Step 5: The engine comment.** In `tree-walks.ts`, `isProcedureLike`'s doc comment, change the last sentence to: "A `preproc_split_procedure_preamble` is not procedure-like: each arm has its own `var` section, so one latch cannot serve every arm; the writer refuses it by name (R309), and its missing name and span are R316."

- [ ] **Step 6: Run, expect PASS.** `bun test packages/schemata/tests/compile.test.ts`. Expected: all green, including the R303, R312 and R-303 run 002 describes, unchanged. (Measured in the prototype: the 10 filtered tests pass.)

- [ ] **Step 7: Red-checks.** One at a time, recorded red then restored green:
  1. Delete the `owner.rawKind !== "preproc_split_procedure_preamble"` clause from the `while` condition. Expected: the new `a-preamble` test and all 8 R309 tests go red, each with the injector's throw (measured in the prototype: 9 red, the isolation control green).
  2. Keep the walk clause and delete `if (owner.rawKind === "preproc_split_procedure_preamble") return owner;`. Expected: red again (the preamble then falls through `varSectionUnparsed` and the split-var check, which do not refuse it, so a marker reaches the injector). Record which assertion fails.

- [ ] **Step 8: Commit.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test packages/schemata packages/engine
bunx biome check packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/engine/src/ast/tree-walks.ts packages/schemata/tests/compile.test.ts
git add packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/engine/src/ast/tree-walks.ts packages/schemata/tests/compile.test.ts
git commit -m "fix(schemata): a split-header procedure whose arms each have their own var section gets no reach latch and is refused by name, instead of throwing the whole run (R309)

reachLatchRefusedOwner also stops at a preproc_split_procedure_preamble, so placeReach marks
its mutants unplaced and the injector never sees a marker there. No fixture has a preproc
node, so every fixture emission is byte-identical; no live gate needed."
```

---

### Task 2: The named warning (runner)

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (`reachLatchRefusals`, the `reach-latch-refused` message in `generateMutationSet`)
- Test: `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- `reachLatchRefusals(specs)` returns `{ member; start; sites; cause: "preamble" | "unparsed" | "split-var" }[]` (was `unparsed: boolean`). Only `generateMutationSet` reads it.

- [ ] **Step 1: Write the failing test.** Append to `preproc-instrumentation.test.ts`:

```ts
describe("R309: a split-header procedure whose arms each have their own var section is refused by name", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SRC = `codeunit 50100 "Repro P"
{
    var
        Glob: Integer;
#if not CLEAN27
        Old: Integer;
#endif

    procedure Plain(X: Integer): Integer
    var
        P: Integer;
    begin
        P := X + 3;
        exit(P);
    end;

#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    [Obsolete('Old', '27.0')]
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
        M: Integer;
#endif
    begin
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob);
    end;

    procedure Hoist(X: Integer): Integer
#if not CLEAN27
    var
        H: Integer;
#endif
    begin
        if X > 4 then
            exit(X + 4);
        exit(0);
    end;

#if CLEAN27
    procedure Pick2(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Choose(X: Integer): Integer
#endif
    begin
        Glob := X + 7;
        exit(Glob);
    end;
}
`;
  const lines = SRC.split("\n");
  /** 1-based number of the first line at or after line `from` that starts with `prefix`. */
  const lineOf = (prefix: string, from = 1): number => {
    const i = lines.findIndex((l, k) => k + 1 >= from && l.startsWith(prefix));
    if (i < 0) throw new Error(`fixture drift: no line starting ${JSON.stringify(prefix)}`);
    return i + 1;
  };
  /** A member from its first line (the `#if` for a preamble) through its closing `end;`. */
  const member = (name: string, prefix: string, from: number, grain: "statement" | "unplaced") => {
    const first = lineOf(prefix, from);
    return { name, first, last: lineOf("    end;", first), grain };
  };
  const plain = member("Plain", "    procedure Plain(", 1, "statement");
  const pick = member("Pick", "#if CLEAN27", plain.last, "unplaced");
  const hoist = member("Hoist", "    procedure Hoist(", pick.last, "statement");
  const pick2 = member("Pick2", "#if CLEAN27", hoist.last, "unplaced");
  const members = [plain, pick, hoist, pick2];

  test("the run completes; both preamble members are named in a reach-latch-refused warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r309-"));
    try {
      await writeFile(join(dir, "app.json"), JSON.stringify(APP_JSON));
      await writeFile(join(dir, "Repro.Codeunit.al"), SRC);
      const warnings: { code: string; message: string }[] = [];
      await generateMutationSet(dir, {
        emit: (e) => {
          if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
        },
      });
      const refused = warnings.filter((w) => w.code === "reach-latch-refused");
      // Arms that rename the procedure name neither arm (R301's rule), hence <unnamed>.
      expect(refused.map((w) => w.message.split("'s var section")[0])).toEqual([
        "[lethal] Repro.Codeunit.al: procedure Pick",
        "[lethal] Repro.Codeunit.al: procedure <unnamed>",
      ]);
      for (const w of refused) {
        expect(w.message).toContain("R309");
        expect(w.message).toContain("preproc_split_procedure_preamble");
        expect(w.message).toContain("its own var section, if any");
        expect(w.message).not.toContain("R303");
        expect(w.message).not.toContain("R313");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("each refused member's sites are unplaced, each admitted member's are statement, and only admitted members get a latch", async () => {
    const { manifest, emitted } = await instrument({ "Repro.Codeunit.al": SRC });
    // Every mutant sits in exactly one member, each bounded through its closing `end;`.
    for (const m of manifest.mutants) {
      const owners = members.filter((x) => m.startLine >= x.first && m.startLine <= x.last);
      expect(owners).toHaveLength(1);
    }
    for (const x of members) {
      const grains = manifest.mutants
        .filter((m) => m.startLine >= x.first && m.startLine <= x.last)
        .map((m) => m.reachGrain);
      expect(grains.length).toBeGreaterThan(0);
      expect([...new Set(grains)]).toEqual([x.grain]);
    }
    // Identity keys still serialize, and no two mutants share one.
    const keys = manifest.mutants.map((m) => serializeKey(identityKeyOf(m)));
    expect(new Set(keys).size).toBe(keys.length);
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    expect(text).toContain("P: Integer; LethALReachLatch: Boolean;");
    expect(text).toContain("procedure Hoist(X: Integer): Integer var LethALReachLatch: Boolean;");
    expect(text.split("LethALReachLatch: Boolean;").length - 1).toBe(2);
    expect(text.split(SELECTOR).length - 1).toBe(1);
    expect(text).toContain(
      `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR}`,
    );
  });
});
```

This test asserts nothing about `procedureName`, `procedureScope` or coverage for a preamble mutant: those are [[R316]]'s. (`APP_JSON`, `instrument`, `SELECTOR`, `identityKeyOf`, `serializeKey`, `generateMutationSet`, `mkdtemp`, `tmpdir`, `writeFile`, `rm` are already imported or defined in the file at `656646b`.)

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/preproc-instrumentation.test.ts -t R309`. Expected with Task 1 landed: the warning test FAILs (the message is R303's sentence, since `unparsed` is false); the grain test PASSes already (Task 1 made the run complete).

- [ ] **Step 3: Implement.** In `orchestrator.ts`, replace `reachLatchRefusals`'s doc comment, return type and the `unparsed` field:

```ts
/**
 * The members of one file the writer declares no reach latch in (`reachLatchRefusedOwner`), each
 * with its site count and why, in source order. `cause` is `"preamble"` for a split-header
 * procedure whose arms each hold their own var section (R309), `"unparsed"` for a var section that
 * did not parse cleanly (R313, `varSectionUnparsed`), else `"split-var"` for a var section split by
 * `#if` in a shape `splitVarHoistAnchor` does not cover (R303). Named per member by
 * `generateMutationSet`'s `reach-latch-refused` warning, and counted by scripts.
 */
export function reachLatchRefusals(specs: readonly MutationSpec[]): {
  member: string;
  start: number;
  sites: number;
  cause: "preamble" | "unparsed" | "split-var";
}[] {
  const byStart = new Map<
    number,
    { member: string; start: number; sites: number; cause: "preamble" | "unparsed" | "split-var" }
  >();
```

and in the `byStart.set(...)` call, replace `unparsed: varSectionUnparsed(owner),` with:

```ts
      cause:
        owner.rawKind === "preproc_split_procedure_preamble"
          ? "preamble"
          : varSectionUnparsed(owner)
            ? "unparsed"
            : "split-var",
```

The member name needs no change: `procedureLikeNameNode(owner)` reads the preamble's own `name` children (see "The grammar"). In `generateMutationSet`, the `reach-latch-refused` message becomes a three-way choice, the two existing sentences unchanged:

```ts
        r.cause === "preamble"
          ? `[lethal] ${rel}: ${r.member}'s var section is split together with its header (preproc_split_procedure_preamble: each #if arm holds its own procedure header and its own var section, if any, and one body follows the #endif), so no reach latch is declared there: its ${r.sites} site(s) carry no reach marker (reachGrain "unplaced", reach not-decided, never unreached). R309.`
          : r.cause === "unparsed"
            ? `<the existing R313 sentence, unchanged>`
            : `<the existing R303 sentence, unchanged>`,
```

- [ ] **Step 4: Run, expect PASS.** `bun test packages/runner/tests/preproc-instrumentation.test.ts`. Expected: all green, the R303 describe's two refused names (`Prag` R303, `Twin` R313) unchanged.

- [ ] **Step 5: Red-check.** Replace the `owner.rawKind === "preproc_split_procedure_preamble"` test in `cause` with `false`. Expected: the warning test red, printing R303's sentence (measured in the prototype). Restore; green.

- [ ] **Step 6: Whole suite and commit.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "fix(runner): the reach-latch-refused warning names a preamble split procedure as R309, with its own sentence

reachLatchRefusals' unparsed flag becomes a three-way cause (preamble, unparsed, split-var).
Every member is bounded through its end; and classified by grain."
```

---

### Task 3: alc and a local al-runner probe of every repro (no container)

**Files:** scratch only.

**Why:** a refused member's file must still compile and run. `alc` says nothing about al-runner, which compiles AL its own way, and no gate has a `#if` (fixtures have none).

- [ ] **Step 1: alc, every repro, every subset.**

```bash
set -euo pipefail
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r309
cd /u/Git/LethAL-wt/r309
mkdir -p "$S/logs"
declare -A SUBSETS=([p1-if-else]=2 [p2-elif-else]=4 [p3-elif-noelse]=2 [p4-one-arm-novar]=2 [p5-trigger]=2 \
  [p6-crlf]=2 [p7-mixed]=2 [p8-nested-condvar]=4 [p9-all]=2 [p10-renamed]=2)
for r in p1-if-else:CLEAN27 p2-elif-else:A,B p3-elif-noelse:A p4-one-arm-novar:CLEAN27 p5-trigger:CLEAN27 \
         p6-crlf:CLEAN27 p7-mixed:CLEAN27 p8-nested-condvar:A,B p9-all:CLEAN27 p10-renamed:CLEAN27; do
  n="${r%%:*}"
  bun "$S/alc-all.ts" "$S/repro/$n" "${r#*:}" > "$S/logs/alc-$n.log" 2>&1
  test "$(grep -c "^$n sym=\[.*\] exit=0 app=true" "$S/logs/alc-$n.log")" -eq "${SUBSETS[$n]}"
  test "$(tail -n 1 "$S/logs/alc-$n.log")" = "$n PASS"
done
test "$(grep -c "LethALReachLatch: Boolean;" "$S/emit-p9-all/Repro.Codeunit.al")" -eq 3
echo "alc: every repro, every subset PASS"
```

Expected: the final line (24 subsets over 10 repros); a missing subset, a non-zero exit, a missing `.app` or a missing `PASS` line stops the block. In `$S/emit-p9-all/Repro.Codeunit.al`: exactly 3 `LethALReachLatch: Boolean;` (`Plain`, `Hoist`, `Split`); checked by hand, none between either preamble's `#if` and its `end;`.

- [ ] **Step 2: al-runner, every preamble repro, every subset, coverage ON and OFF, checked per member.** The checker `$S/check-probe.ts <raw-log> <expect.json> <cov>` (written at plan time) exits non-zero unless the log holds EXACTLY the expected subsets, each with `baselineGreen=true` and `errors=0`; every mutant falls in one expected member; each member's verdict counts and `reachGrain` match; each mutant's verdict is the same in every subset; and the `<name> PASS` line is present. The expectation files `$S/expect/<name>.json` hold, per member, its line range (through its closing `end;`), its grain and its verdict counts in each coverage mode, from the plan-time run:

| repro | member | lines | grain | coverage ON | coverage OFF |
| --- | --- | --- | --- | --- | --- |
| every single-preamble repro | `Pick` (or the renamed member) | the whole file | unplaced | 4 no-coverage | 3 killed, 1 survived |
| `p7-mixed`, `p9-all` | `Plain` | 9 to 15 | statement | 4 killed | 4 killed |
| `p7-mixed`, `p9-all` | `Pick` | 17 to 33 | unplaced | 4 no-coverage | 3 killed, 1 survived |
| `p7-mixed`, `p9-all` | `Hoist` | 35 to 44 | statement | 3 killed, 1 survived | 3 killed, 1 survived |
| `p9-all` | `Pick2` / `Choose` | 46 to 56 | unplaced | 1 no-coverage | 1 killed |
| `p9-all` | `Split` | 58 to 69 | statement | 1 killed | 1 killed |

At plan time the checker passed all 18 plan-time logs (kept in `$S/logs-plan/`), and it was red-checked: changing one `Pick` verdict in `p7-mixed`'s coverage-ON log makes it print `BAD` for both subsets and exit 1.

```bash
set -euo pipefail
export LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
"$LETHAL_ALRUNNER_PATH" --version > "$S/logs/alrunner-version.txt"
cat "$S/logs/alrunner-version.txt"
for cov in 1 0; do
  for r in p1-if-else:CLEAN27 p2-elif-else:A,B p3-elif-noelse:A p4-one-arm-novar:CLEAN27 p6-crlf:CLEAN27 \
           p7-mixed:CLEAN27 p8-nested-condvar:A,B p9-all:CLEAN27 p10-renamed:CLEAN27; do
    n="${r%%:*}"
    COV=$cov bun "$S/alrunner-probe.ts" "$S/repro/$n" "$S/repro-tests-$n" "${r#*:}" > "$S/logs/alrunner-$n-cov$cov.log" 2>&1
    bun "$S/check-probe.ts" "$S/logs/alrunner-$n-cov$cov.log" "$S/expect/$n.json" "$cov"
  done
done
echo "al-runner: every repro, every subset, both coverage modes CHECK PASS"
```

Expected: 18 `CHECK PASS` lines (9 repros, 2 modes, 44 sessions) and the final line. The raw logs stay in `$S/logs/`. The coverage-ON `no-coverage` of the preamble mutants is [[R316]]: expected here, not a failure of this task.

- [ ] **Step 3: Any FAIL is a STOP.** A non-zero exit from either block (a missing subset, a red baseline, an `error` verdict, a changed count, grain or verdict, a thrown session): report the al-runner version, the repro, the subset and the checker's `BAD` lines, with the raw log path, to the coordinator. Do not work around it here, and do not run Task 5.

---

### Task 4: Prove nothing else moved

**Files:** scratch only.

- [ ] **Step 1: Fixtures byte-identical, identity keys unchanged.**

```bash
set -euo pipefail
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-after-$f.txt"
  cmp "$S/hashes-before-$f.txt" "$S/hashes-after-$f.txt"
  rm -rf "$S/target-after-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-after-$f" > "$S/ids-after-$f.txt"
  diff <(sed '/^maxRSS_KB /d' "$S/ids-before-$f.txt") <(sed '/^maxRSS_KB /d' "$S/ids-after-$f.txt")
  diff -r --exclude=app.json "$S/target-before-$f" "$S/target-after-$f"
done
echo "fixtures: byte-identical, identity keys unchanged"
```

`cmp` and `diff` exit 1 on any difference, which stops the block; `sed` drops only the memory line, which varies per run. Expected: only the final line. (Measured at plan time between HEAD and the prototype: no output for all five.) Any difference is a STOP.

- [ ] **Step 2: Corpora**, under `set -euo pipefail`, each `cmp` and `diff` a command of its own (no `|| true`), stderr to `$S/logs/`. For dc, sysapp and bcf: `corpus-fingerprint.ts` into `fp-after-$k.txt` and `cmp` with BEFORE (a mismatch voids that corpus's comparison: recapture BEFORE in a scratch worktree at `656646b`); then `locate.ts` and `identity-keys.ts` into `*-after-$k.txt` / `$S/target-after-$k`. Expected: `locate` outputs identical; identity keys identical except `maxRSS_KB`; `diff -r --exclude=app.json` of the targets empty. The census said 0 preamble sites, so nothing may move. BaseApp is covered by the parse-only census (0 sites) and is not instrumented (R311).

- [ ] **Step 3: Record** the figures for Task 5 as MEASURED results, only after both blocks above finished: the al-runner version and the checker's pass list, the fixture and corpus results, the census.

---

### Task 5: Roadmap

**Files:** `docs/roadmap/R309.md`, `R301.md`, `R303.md`, `R310.md`, `R312.md`, `R313.md`, `ROADMAP.md`. R316 is not edited.

- [ ] **Step 1: R309.** Only if Task 3 was fully green. Status `done (<Task 1 commit>..<Task 2 commit>)`. Title unchanged. Append a dated section "**Closed <date> (R-309), a named refusal.**": the predicate (`reachLatchRefusedOwner` stops at a preamble); the warning's R309 sentence; the repro list with alc and al-runner results (version, subsets); why per-arm placement was not built (the "Decision" section, three points, short), with a cross-link to [[R316]] (per-arm placement waits on it) and a pointer to this plan for the per-arm alc evidence; that the refusal's cause is visible in the warning and event only, while the manifest and `SessionReport` show a generic `unplaced` (consistent with [[R310]]); that the trigger form does not parse as a preamble and is already refused as R313 (upstream: SShadowS/tree-sitter-al #32); 0 corpus sites; fixtures byte-identical. Also fix the item's own last paragraph, which says "Until then the injector still throws for this shape": make it past tense.

- [ ] **Step 2: The other items.** Each is a text correction, not a status change (except R310's status line):
  - **R301** (last paragraph): "which still throws because R301's fix has nowhere to anchor a per-arm latch, is filed as [[R309]]" becomes "is filed as [[R309]], which now refuses it by name instead of throwing (<date>); its missing name and span are [[R316]]". The status line's "remaining gaps moved to R302 and R309" stays true; leave it.
  - **R303** (the paragraph starting "**Not every unproven shape is refused by name.**"): rewrite to say that a `preproc_split_procedure_preamble` is now the third member shape refused by name (R309, `<date>`), with the R309 sentence in the warning, and drop "throws for the whole run" and "still open".
  - **R310**: the status line's tail "; R309's preamble shape is not refused but throws" becomes "; R309's preamble shape is now refused by name too, by its own predicate (a split-header procedure whose arms each hold their own var section), which no measured corpus has either (0 in dc, sysapp, bcf and BaseApp, parse-only)". In the body, the sentence starting "[[R309]]'s `preproc_split_procedure_preamble` is outside both predicates" becomes a statement that R309 is now a third refusal, also with zero measured members, so the ruling's premise (zero measured mutants) still holds. Keep the closed form and the reopen trigger unchanged.
  - **R312** (the run 002 paragraph): "and [[R309]]'s preamble shape still throws rather than being refused" becomes "and [[R309]]'s preamble shape is refused by name".
  - **R313** (the paragraph ending "the writer throws for the whole run"): the preamble "parses cleanly but has no procedure-like owner, so R313 does not catch it; [[R309]] refuses it by name with its own sentence". Add one line: the TRIGGER form of that shape (per-arm trigger header and var) does not parse as a preamble in 4.4.1, leaves an ERROR, and is caught by this item's refusal (measured on `p5-trigger` in the R-309 plan; filed upstream as SShadowS/tree-sitter-al #32).

- [ ] **Step 3: The prose grep.**

```bash
grep -rn --include=*.ts --exclude-dir=dist "R309" packages | grep -in "throw\|open)"
grep -rn "R309" docs/roadmap/*.md | grep -i "throw"
```

Expected: no line says the preamble throws. The injector's guard message says "No known shape reaches here", which is correct. R309.md's own history may say it USED to throw; that is fine if it is past tense.

- [ ] **Step 4: Regenerate and commit.**

```bash
git ls-tree --name-only master docs/roadmap/   # nothing to allocate; the items this commit edits still exist
bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R309.md docs/roadmap/R301.md docs/roadmap/R303.md docs/roadmap/R310.md docs/roadmap/R312.md docs/roadmap/R313.md ROADMAP.md
git commit -m "roadmap: R309 closed by a named refusal; R301, R303, R310, R312 and R313 no longer say the preamble shape throws"
```

---

## Self-review

- The task's points: the refusal and the R309 closure (Tasks 1, 2, 5); the predicate kept truthful (Task 1 Step 3's doc comment and the M1 owner map; Review Focus 1); the warning text keeps the `<file>: <member>'s var section` prefix (Task 2); tests through the real pipeline (schemata unit tests in Task 1, the runner test in Task 2); red-checks (Task 1 Step 7, Task 2 Step 5, both measured in the prototype); alc-all and a local al-runner probe of every repro, refused and admitted members together (Task 3, with `p7-mixed` and `p9-all` holding admitted members beside refused ones); fixtures byte-identical and corpora unchanged (Task 0 Step 4, Task 4); every R309 mention fixed (Task 5 Steps 2 and 3, and the code comments in Tasks 1 and 2); the upstream grammar defect, filed as SShadowS/tree-sitter-al #32 (Notes).
- The census: 0 preamble sites in every corpus; the repros are the evidence.
- The pipeline check: the table in "What else touches this node", which found R316 (filed by the orchestrator, `75c36ae`).
- Types: `reachLatchRefusals`'s `cause` is the only signature change; no new export.

## Notes: upstream grammar defect

The trigger form of this shape (each `#if` arm holding a `trigger OnRun()` header and its own var section, one shared body after `#endif`) is valid AL but does not parse in tree-sitter-al 4.4.1 or at upstream HEAD `d4d38e4`: it leaves a `preproc_conditional` with ERROR nodes (`p5-trigger`, 4 ERROR nodes). It is filed upstream as **SShadowS/tree-sitter-al #32**. LethAL is not blocked by it: R313 refuses the ERROR shape by name, and alc passes it in both builds. When a release parses it, check whether it becomes a preamble-like node that R309's predicate must also stop at.

## Rulings (r2)

1. R316 is the orchestrator's item (`75c36ae`); this plan cites it and neither files nor edits it.
2. Task 2 asserts only what R309 owns: grain, no latch, and the warning. No `procedureName` or scope assertion.
3. Per-arm placement waits on R316.
4. The injector's throw stays as a guard for unexpected trees.
