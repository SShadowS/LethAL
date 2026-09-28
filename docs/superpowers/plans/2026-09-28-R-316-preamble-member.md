# R-316: a split-header procedure whose arms each have their own var section becomes a member (name, scope, span, gap block, and one reach latch per arm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r3 (2026-09-28), final.** Round 2 was approved subject to three fixes from review r2 (`H:/lethal-coord/reviews/R-316-plan/review-r2.md`); there is no round 3. What changed, all in Task 4 and all measured offline: **C1**, the fallback no longer republishes the base pair over a higher instrumented version. The chosen fallback fully removes the pair first (the first driver's EXIT trap), then a fresh driver republishes it; the installed test app is not reused, and `pair.ps1 -Action Publish` refuses loudly unless neither scratch id nor name exists, so 1.0.0.0 can never replace a minted version. **I1**, cleanup is safe on a shared container: one driver (`run-gate.sh`) with an EXIT trap runs cleanup on every exit path; a preflight refuses any existing scratch name or app id before a publish; removal matches app id AND publisher and refuses if any other app depends on the pair; the before/after snapshot is the full app inventory (id, name, publisher, version, installed); and nothing is unpublished until doctor's `lease` check is green, meaning no live token and op kind `none`, i.e. no fenced operation in flight. **I2**, an arm witness: `Pick`'s `#else` arm declares a local `Glob` that shadows the object global, so only the `R316A` arm writes the global, and every test failure message reports it; `M0010`'s `killingTestFailure` must read `global Glob 0` in the `[]` run and nonzero in the `[R316A]` run (measured on al-runner: 0 and 5), and `check-gate.ts` refuses a same-arm report either way, red-checked. The pre-committed table gained the witness column and two `no-coverage` rows (`GlobSeen`). Rulings at r2: ids 91600 to 91699 and lane `bugs` confirmed; R319 does not block R-316 and is filed in Task 0.

**Revision r2 (2026-09-28).** Revised per review r1 (`H:/lethal-coord/reviews/R-316-plan/review-r1.md`) and the orchestrator's rulings (listed at the end, "Rulings (r2)"). What changed: Task 2's per-arm latch is built but NOT committed until a new live gate passes (Task 4: a serial bcdev run on Cronus28 under a coord lease, on a scratch app pair, each arm's symbol configuration, per-mutant reach, its negative control and fenced attribution pre-committed in `$S/gate/expect-gate.json`); if the gate cannot show it, Task 2 is dropped and R309's refusal stays (critical finding, ruling 1). Every "no live gate needed" claim is gone. I1: three collision repros (`c1` to `c3`) measured; an agreeing preamble renumbers an identical site AFTER it in the same object, both ways (a renamed R301 split procedure's ordinal drops, a same-named overload's rises), so the "0 keys change" promise is narrowed to exactly that and pinned by a test. I2: the R313 scan now covers a preamble's whole pre-body region, every arm's header included; three malformed-first-arm repros (`p15` to `p17`) were admitted by r1's code and are refused now, red-checked. I3: the fenced bcdev map is checked on the EMITTED source, al-runner's `--server` path (`st.scope`) was probed separately (and found to ignore preprocessor symbols, a pre-existing defect filed in Task 0), and `p12-mixed-scope` has per-subset expectations the checker enforces. Operator semantics go to R302 with a cross-link (ruling 2). The renamed-split-member gap and the server-symbols defect are filed in Task 0 (ruling 3). Probes run serially; a repeat throw is a STOP and the parallel flake gets filed if it recurs (ruling 4). The grammar notes are filed upstream (ruling 5). Task count: 7 (Task 0 to Task 6).

**Revision r1 (2026-09-28), draft for the orchestrator's review.**

**Goal:** A `preproc_split_procedure_preamble` (a procedure whose header AND var section are both split by `#if`, one pair per arm, with one shared body after `#endif`) is a member in every walk R301 extended for `preproc_split_procedure`: the manifest gives its mutants a procedure name, a scope, member lines and a gap block, and both line maps (bcdev's and al-runner's coverage index) give it a span. So with al-runner coverage on, its mutants are attributed to the tests that run them instead of reading `no-coverage`. Then (Task 2) it takes one reach latch per arm instead of R309's refusal, but only if a live Cronus28 gate (Task 4) shows the marker firing per test, with its negative control; otherwise R309's refusal stays.

**Architecture:** One predicate change in `packages/engine/src/ast/tree-walks.ts`: `isProcedureLike` also admits a `preproc_split_procedure_preamble`. Every walk R301 extended reads it (`gapBlockOf`, the manifest's `enclosingProcedureLike` for name, scope and member lines, the line map's `spansOf`, the latch owner walk and `latchNameFor`), so they all see the preamble as one procedure. `procedureScopeOf` (`packages/schemata/src/project.ts`) reads scope per arm for any split shape. The name rule is R301's, unchanged (`procedureLikeNameNode`). Task 2 adds `preambleArmHeaderEnds` (`packages/schemata/src/dispatch.ts`), which is R303's header-end rule applied once per arm, and a preamble branch in `injectReachLatches` (`packages/schemata/src/compile.ts`) that writes the latch after each arm's header and blanks each arm's `var` keyword, exactly as R303's hoist does for one header. Operator semantics are NOT changed: the missing operators are R302's (see Decision 4). For a preamble, R313's parse-error scan covers the whole region before the body, every arm's header included (review r1, I2).

**Tech Stack:** Bun, TypeScript, tree-sitter-al 4.4.1 (WASM, vendored in `packages/engine/vendor`), `bun:test`, `alc` (offline compile), a local `al-runner` v2.11.0 (`C:/Users/SShadowS/.dotnet/tools/al-runner.exe`), and one live bcdev gate on Cronus28 (Task 4) under a coord lease. Planning itself used no container.

**Spec:** `docs/roadmap/R316.md`, `H:/lethal-coord/tasks/R-316/task.md`. Sibling plan and precedent: `docs/superpowers/plans/2026-09-28-R-309-split-preamble.md` (its repros, alc harness, al-runner probe, checker and STOP rule are reused here), and `docs/superpowers/plans/2026-09-28-R-303-latch-placement-split-var.md` (the hoist rule Task 2 applies per arm).

---

## What was measured at plan time (2026-09-28)

Every repro is hand-written with invented names. No corpus source is quoted. `$S` is `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316`. The tools are R-309's (`alc-all.ts`, `alc-plain.ts`, `alrunner-probe.ts`, `check-probe.ts`, `identity-keys.ts`, `locate.ts`, `preamble-census.ts`, `shape.ts`), copied from `../r309` and repointed from `U:/Git/LethAL-wt/r309` to `U:/Git/LethAL-wt/r316`, plus the r2 additions `gate/` (the live gate's pair, `build-pair.sh`, `gate-config.ts`, `pair.ps1`, `run-gate.sh`, `check-gate.ts`, `expect-gate.json` and `mkredcheck.py`, Task 4) and `run-server.sh` (the `--server` probe), and five new ones: `members.ts` (per mutant: operator, procedure name, scope, member lines, gap block, grain, the line map's name for its line, identity key; per member: the operator list), `fields.ts` (a preamble's direct children with their field names), `keys-diff.ts` (compares two identity-key captures field by field: the procedure part may only go from `""` to an allowed name, an ordinal may only DROP and only in the `""` group, and it prints both counts; Task 5 Step 3), `verdict-diff.ts` (compares two al-runner probe logs mutant by mutant, grain ignored) and `mkexpect.py` (writes the checker's expectation files). Two scratch worktrees held the prototypes, both detached at `a295e52`: `$S/proto` (both variants behind a scratch environment switch, used for the al-runner runs; its tools are `$S/pt/`) and `$S/proto2` (the exact code and tests of Tasks 1 and 2, no switch; its tools are `$S/pt2/`, and its diff is `$S/proto2-full.patch`). Both are removed after the plan is accepted.

### The grammar (tree-sitter-al 4.4.1, the vendored build)

Every arm's header tokens are DIRECT children of the preamble, with their field names (`fields.ts` on `p1-if-else`, `p9-all`, `p11-named-return-local`): `procedure_modifier[modifier]`, `procedure_keyword`, `identifier[name]`, `(`, `parameter_list[parameters]`, `)`, `identifier[return_value]` for a named return, `type_specification[return_type]`, an optional `;`, then the arm's own `var_section` (or a nested `preproc_conditional_var_block`). The arms are separated by direct `preproc_if`, `preproc_elif`, `preproc_else` and `preproc_endif` children, and the shared `code_block` follows the `#endif` (with NO `body` field, unlike a `preproc_split_procedure`'s, which has one). So:

- `procedureLikeNameNode` already works on a preamble: one name when every arm agrees, `null` when an arm renames the procedure.
- `splitIsLocal` already works on a preamble: it counts `procedure_keyword` and `procedure_modifier` children.
- R303's `headerEndOf` finds only the FIRST arm's end (the first `)`, the first `return_type`), so a per-arm rule has to split the children at the arm markers first.

### The repros

`$S/repro/<name>/`, each with the R-303 repro `app.json` and one `Repro.Codeunit.al` holding `codeunit 50100 "Repro P"` and `var Glob: Integer;`. R-309's eleven (`p1-if-else` to `p10-renamed`, `q1-twin-body`) are unchanged. New at R-316:

| repro | shape | symbols |
| --- | --- | --- |
| `p11-named-return-local` | a public `CallPick` calling a preamble whose arms are both `local`, with a named return `R: Integer`; one arm has a `;` after its header, the other a `//` comment line between header and `var` | CLEAN27 |
| `p12-mixed-scope` | a preamble whose `#if` arm is `local` and whose `#else` arm is public | CLEAN27 |
| `p13-byref-name-taken` | a `var X: Integer` (by-reference) parameter in both arms, and a local named `LethALReachLatch` in one arm | CLEAN27 |
| `p14-arm-unparsed` | a preamble whose `#if CLEAN27` arm has two `#if A` / `#if not A` var blocks in a row (R313's shape inside an arm); tree-sitter-al leaves 3 ERROR nodes | CLEAN27, A |
| `q2-split-twin` | `q1-twin-body` with the preamble replaced by a `preproc_split_procedure` (one shared var section), the R302 control | CLEAN27 |

Test apps `$S/repro-tests-<name>/` (codeunit 50150, `Subtype = Test`, `Error(...)` on a wrong result) exist for every repro except `p5-trigger` and `q2-split-twin`. `q1-twin-body`'s calls `Twin` and `Pick` with 5 and 0; `p11` calls `CallPick`; `p12` calls `Pick` only under `#if not CLEAN27` (in the other build it is local and cannot be called); `p13` checks both the return value and the by-reference argument.

Every repro, UN-instrumented, compiles under every subset of its symbols (`alc-plain.ts`, exit 0 and an `.app`): the R-309 ones as recorded in its plan, and `p11`, `p12`, `p13`, `q2` (2 subsets each) and `p14` (4 subsets) at R-316. So a later failure is LethAL's, not the repro's.

### Today (HEAD `a295e52`), through the real pipeline

`members.ts` on every repro (logs `$S/mem/head-<name>.txt`): every preamble mutant has `procedureName ""`, no `procedureScope`, no member lines, a gap block of the WHOLE FILE (`q1-twin-body`: lines 1 to 32), grain `unplaced` (R309's refusal), and the line map names none of its lines. Its identity key has an empty procedure part (`<hash>|Repro P||<operator>|1`).

The site loss, `q1-twin-body` against `q2-split-twin`:

| member | mutants | operators |
| --- | --- | --- |
| `Twin` (plain procedure, same body) | 7 | conditional-boundary, empty-block, remove-assignment x2, return-value, swap-additive x2 |
| `Pick` as a preamble (`q1`) | 4 | conditional-boundary, remove-assignment x2, swap-additive |
| `Pick` as a `preproc_split_procedure` (`q2`) | 4 | the same 4 |

So the three missing operators (`empty-block`, `return-value`, and the `swap-additive` on `X + 1`, whose `X` is a parameter) are missing from the R301 shape too, which HEAD already treats as a member. They are R302's semantic walks, not a missing member walk (Decision 4).

al-runner v2.11.0, local, HEAD, every subset (`$S/logs/ar-head-<name>-cov<0|1>.log`, 24 sessions): with coverage ON every preamble mutant reads `no-coverage` (`q1-twin-body`: 4; `p1-if-else`, `p10-renamed`, `p12-mixed-scope`, `p13-byref-name-taken`: 4 each; `p11-named-return-local`: `Pick`'s 4, while `CallPick`'s 2 are killed with `exact` attribution). With coverage OFF the same mutants are scored: 3 killed and 1 survived in every repro (`p12`'s `CLEAN27` build, where no test can call the local arm, 4 survived). Every baseline green, 0 errors. That is R316's false `no-coverage`, reproduced.

### Every walk that reads `isProcedureLike`

| reader | file | effect for a preamble once `isProcedureLike` admits it |
| --- | --- | --- |
| `gapBlockOf` | `packages/engine/src/ast/tree-walks.ts` | the shared body is the gap block, not the file root |
| `enclosingProcedureLike` (`procedureNameOf`, `procedureScopeOf`, `enclosingMemberOf`) | `packages/schemata/src/project.ts` | name (R301's rule), scope (with the `procedureScopeOf` change), member lines from the `#if` line through `end;` |
| `spansOf` | `packages/runner/src/line-map.ts` | a named preamble gets a span; bcdev's fenced coverage and al-runner's coverage index both build their line maps here |
| the owner walk in `injectReachLatches` | `packages/schemata/src/compile.ts` | stops at the preamble; Task 1 guards it with a throw, Task 2 replaces the guard with the per-arm branch |
| `latchNameFor` | `packages/schemata/src/compile.ts` | a preamble's identifiers are no longer reserved against OTHER members' latch names (they are not in those members' scope), and a preamble's own latch name avoids every arm's identifiers (`p13`: `LethALReachLatch2`) |
| `reachLatchRefusedOwner` | `packages/schemata/src/dispatch.ts` | its extra `rawKind !== "preproc_split_procedure_preamble"` walk clause becomes redundant and is removed |

Not changed: the engine's `findEnclosingProcedure` and every semantic walk (R302), and `unnamedMemberLabel` (it reads `name` children, which it already did for a preamble).

### Task 1 prototyped (`$S/proto` with the switch off, then `$S/proto2`)

`members.ts` after the change (`$S/mem/refuse-<name>.txt`), R309's refusal still in place:

| repro | preamble `procedureName` | `procedureScope` | member lines | gap block | line map |
| --- | --- | --- | --- | --- | --- |
| `p1-if-else` (and `p2`, `p3`, `p4`, `p6`, `p8`, `p13`) | `Pick` | public | `#if` line to `end;` | the body, or a branch inside it | `Pick` on every line of the span |
| `p10-renamed` | `""` (arms rename it) | public | recorded | the body | no span |
| `p11-named-return-local` | `Pick` | local | recorded | the body | `Pick` |
| `p12-mixed-scope` | `Pick` | public (one arm is public) | recorded | the body | `Pick` |
| `p9-all` | `Pick` named, `Pick2`/`Choose` `""` | public | recorded for both | the body | `Pick` only |
| `p14-arm-unparsed` | `Pick` | public | recorded | the body | `Pick` |

The emitted AL is byte-identical to HEAD's on all 16 repros (the refusal still decides the latch). Identity keys (`$S/mem/*.txt`, HEAD against the change): a preamble whose arms agree gains its name in the procedure part (its 4 keys, in each of `p1`, `p2`, `p3`, `p4`, `p6`, `p7`, `p8`, `p9`, `p11`, `p12`, `p13`, `p14` and `q1`); a renamed preamble keeps the empty part (`p10`: 0 changed; `p9`'s `Pick2`/`Choose`: 0 changed); every other member's keys are unchanged (`Plain`, `Hoist`, `Split`, `Twin`, `CallPick`), and so are `q2-split-twin`'s (an R301 split procedure, 0 changed) and `p5-trigger`'s (0 changed).

Whole suite in `$S/proto2` with Task 1's code: before Task 1's tests, exactly ONE failure, the engine test that pins `isProcedureLike(preamble) === false` (Task 1 owns and flips it). With Task 1's tests: green.

### Per-arm latch prototyped (`$S/proto` with the switch on, then `$S/proto2`)

The rule is R303's hoist, once per arm: after each arm's header end (its `)`, else its return type, else a `;` directly after either), write ` var <latch>: Boolean;`, and blank every var-section `var` keyword before the body (inside a nested `#if` var block too) to the same number of spaces. Each build then declares the latch exactly once, and the arm's own declarations continue that one section. No newline is written, so no line moves. One latch name serves every arm (the body references one name); `latchNameFor` picks it against every arm's identifiers.

Emission, for example `p8-nested-condvar`: each arm's header line ends in ` var LethALReachLatch: Boolean;`, the `#if B` block's `var` and the `#else` arm's `var` are blanks, and each body statement's marker uses the same latch. `p13`: both headers take `LethALReachLatch2`, because one arm declares a local `LethALReachLatch`; the `var` of the by-reference parameter is untouched (only a `var_keyword` whose parent is a `var_section` is blanked). `p11`: the latch goes after the `;` in one arm and after `R: Integer` (before the comment line) in the other.

`p14-arm-unparsed` (R313's shape inside an arm) is refused by R313's predicate, which the prototype checks BEFORE the preamble rule: grain `unplaced`, the `reach-latch-refused` warning prints R313's sentence. (At HEAD it printed R309's sentence, because `reachLatchRefusals` read the preamble cause first; Task 2 reorders the cause the same way.) Measured as a negative control: with that check disabled, the per-arm rule also writes valid AL for `p14` (alc PASS, all 4 subsets), because blanking every `var` keyword in the arm covers two blocks as well as one. The refusal is kept anyway: an ERROR node means the tree may not be what the rule assumes, and refusing is the fail-safe direction (R313's own ruling).

The two negative controls that make the rule load-bearing, measured on hand-written output (`$S/perarm/`, `alc-plain.ts`):

| text | result |
| --- | --- |
| `neg-first-arm-only` (R-309: latch in the first arm only) | FAIL with CLEAN27 absent, `AL0118` (the latch does not exist in the `#else` build) |
| `neg-else-unblanked` (R-316: latch in both arms, the `#else` arm's `var` NOT blanked) | FAIL with CLEAN27 absent, `AL0104` (a second `var` section) |

The emitted AL AND manifest of `$S/proto2` (the final code) are byte-identical to `$S/proto` with the switch on, on all 16 repros (`diff -r`, `$S/em/p-*` against `$S/em/f-*`), so the al-runner results below, which ran on `$S/proto`, hold for the final code.

### alc, every repro, every subset (`alc-all.ts`)

| code | repros | subsets | result |
| --- | --- | --- | --- |
| `$S/proto`, refusal kept (Task 1 only) | 16 | 38 | all PASS |
| `$S/proto`, per-arm latch (Tasks 1 and 2) | 16 | 38 | all PASS |
| `$S/proto2`, the final code | 16 | 38 | all PASS |

(38 subsets: 2 for each of the 13 one-symbol repros, `p5-trigger` and `q2-split-twin` included, and 4 each for `p2-elif-else`, `p8-nested-condvar` and `p14-arm-unparsed`.)

### al-runner, local (v2.11.0), every subset, coverage ON and OFF

`$S/alrunner-probe.ts` (R-309's; `COV=1` passes `coverage: "al-runner"`, each mutant line prints `attr=<coverageAttribution> cov=<covering test count>`). One session per subset of each repro's symbols, both coverage modes. Checked by `$S/check-probe.ts` (below) against `$S/expect-fix/` and `$S/expect-perarm/`.

| run | code | repros | sessions | result |
| --- | --- | --- | --- | --- |
| today | HEAD (`$S/logs/ar-head-*`) | `q1`, `p1`, `p10`, `p11`, `p12`, `p13` | 24 | all green; every preamble mutant `no-coverage` with coverage ON (the "Today" section) |
| Task 1 only | `$S/proto`, switch off (`$S/logs/ar-fix-*`) | the 12 repros Task 3 checks, less `p14`, plus `p12` | 60 | 24 `CHECK PASS` against `$S/expect-fix/`: every agreeing preamble's mutants `exact` with coverage ON, the same verdicts as coverage OFF, grain `unplaced` |
| Tasks 1 and 2 | `$S/proto`, switch on (`$S/logs/ar-perarm-*`) | the 13 repros Task 3 checks, plus `p12` | 68 | 26 `CHECK PASS` against `$S/expect-perarm/`: the same, with grain `statement` (except `p14`, `unplaced`, refused by R313) |

Every session: `baselineGreen=true`, `errors=0`. Verdicts do not depend on the latch: `$S/verdict-diff.ts` compares two probe logs mutant by mutant (verdict and attribution per subset, grain ignored), and the Task 1 and Tasks 1 and 2 logs are the SAME for all 13 repros they share, in both coverage modes (26 comparisons). The per-arm run had three `wire contract UNMEASURABLE` throws before any mutant ran, each re-run alone and then green (Global Constraints). `p14-arm-unparsed` was run in the per-arm variant only: its emission is byte-identical in both variants (refused either way).

Coverage ON, per member, HEAD against the fix (the rows where the fix changes the verdict):

| repro | member | HEAD | after Task 1 (and Task 2) |
| --- | --- | --- | --- |
| `q1-twin-body`, `p1`, `p2`, `p3`, `p4`, `p6`, `p8`, `p13` | `Pick` | 4 `no-coverage` | 3 killed, 1 survived, `exact` |
| `p7-mixed`, `p9-all` | `Pick` | 4 `no-coverage` | 3 killed, 1 survived, `exact` |
| `p11-named-return-local` | `Pick` (every arm `local`) | 4 `no-coverage` | 3 killed, 1 survived, `exact` |
| `p10-renamed` | the renamed member | 4 `no-coverage` | 4 `no-coverage` (unchanged: no name, Decision 2) |
| `p9-all` | `Pick2` / `Choose` | 1 `no-coverage` | 1 `no-coverage` (unchanged, the same reason) |

`p12-mixed-scope` was reported, not checked, at r1: its two builds differ by design (in the `CLEAN27` build the preamble is local and no test calls it), so its per-mutant map differs across subsets. At r2 it is checked per subset ("Review r1 measurements", I3). Its results, identical in both variants (grain aside): coverage ON, subset `[]` 3 killed and 1 survived with `exact` attribution, subset `[CLEAN27]` 4 `no-coverage` (no test can call a local arm, and the scope rule reads the member as public because one arm is); coverage OFF, `[]` 3 killed and 1 survived, `[CLEAN27]` 4 survived.

**`check-probe.ts`, extended.** R-309's r3 rules (exactly the expected subsets; exactly one baseline summary and one `SUBSET PASS` line per subset; no mutant id twice in a subset; every mutant in one expected member with that member's grain; per-member verdict counts; the complete id map identical across subsets; the `<name> PASS` line) plus one R-316 rule: each member names its expected coverage attribution per mode (`attr1`, `attr0`: `exact` or `-`), every mutant line must carry it, and the attribution is part of the id map compared across subsets. Red-checked at plan time (`$S/redcheck/`), each exits 1: `attr.log` (one `Pick` mutant's `attr=exact` edited to `attr=-`: `M0008 (Pick) attr -, want exact`), `verdict.log` (one `Pick` kill edited to `no-coverage`: `Pick: want {"killed":3,"survived":1} got ...`), and R-309's five cases re-run against `expect-fix/p7-mixed.json` (`missing-id`, `dup-id-same-verdict`, `swap-verdicts-same-totals`, `dup-baseline`, `dup-subset-pass`), all still exit 1.

### Review r1 measurements (r2, offline, scratch)

All on `$S/proto2`, which now holds the exact r2 code of Tasks 1 and 2 (`$S/proto2-full.patch`), against HEAD `a295e52`.

**I1: identity-key ordinals.** A key carries an ordinal among its twins (same hash, object, member name, operator; `identityTupleOf`, `assignIdentityOrdinals`), numbered in source order. Three hand-written collision repros, each an agreeing preamble `Pick` beside another member holding the byte-identical site `Glob := Glob + 2;` (alc PASS, 2 subsets each, un-instrumented and instrumented by `$S/proto2`). `$S/keys-diff.ts` (below) compares HEAD's keys with `$S/proto2`'s:

| repro | shape | HEAD, the other member's keys | after, the other member's keys | changed keys (name / ordinal) |
| --- | --- | --- | --- | --- |
| `c1-preamble-then-renamed-split` | preamble, then a renamed R301 split procedure `AIf`/`AElse` | ordinal 1 (the preamble held ordinal 0 in the `""` group) | ordinal 0 | 2 / 2 |
| `c2-renamed-split-then-preamble` | the same two, split procedure first | ordinal 0 | ordinal 0 | 2 / 0 |
| `c3-preamble-then-overload` | preamble `Pick(X: Integer)`, then a plain overload `Pick(X: Text)` | ordinal 0 | ordinal 1 (the preamble joined the `Pick` group ahead of it) | 2 / 2 |

So an agreeing preamble does move EXISTING shapes' keys in one case: an identical site after it, in the same object, in a renamed split procedure (ordinal down) or a same-named overload (ordinal up). Both need a preamble in the object, and no fixture or measured corpus has one (Decision 2 says what this plan promises instead). Pinned by Task 1's `ordinals` test, which is red on HEAD's code (measured: HEAD reads `["#0", "#1"]` for `c1`'s shape).

**I2: a parse error before the first arm's header end.** r1's `varSectionUnparsed` started its scan at `headerEndOf(owner)`, the FIRST arm's header end, so an error earlier in the first arm's header was never seen, and `preambleArmHeaderEnds` (which counts one `)` and one `procedure` keyword per arm) still admitted the member. Three hand-written malformed first arms of `p1-if-else`, each still parsed as a preamble with one ERROR node:

| repro | first arm's header | where the ERROR sits | r1 code | r2 code |
| --- | --- | --- | --- | --- |
| `p15-param-error-nested` | `procedure Pick(X: Integer; @@ Y: Integer): Integer` | inside `parameter_list` | admitted, 4 `statement`, latch written | refused, 4 `unplaced`, R313's sentence |
| `p16-param-error-before-close` | `procedure Pick(X: Integer;): Integer` | a direct child before the arm's `)` | admitted | refused |
| `p17-param-error-after-open` | `procedure Pick(X: Integer Y: Integer): Integer` | a direct child after the arm's `(` | admitted | refused |

The r2 rule: for a preamble, `varSectionUnparsed` scans from the preamble's own start to its body. `p14-arm-unparsed` (the error in a later arm's var section) stays refused, and no admitted repro moves (`$S/mem/final-*.txt`). Pinned by Task 2's three P16 cases; red-checked (restoring the r1 start turns exactly those three red, 17 others stay green).

**I3: the coverage paths.** Fenced bcdev (`BcDevMcpBackend.indexArtifact`, `buildLineMap` over the INSTRUMENTED dir) and al-runner's Cobertura index both read the emitted source, so Task 1's line-map test now builds both maps from the emitted target and checks every dispatch line of every member (r1 built the bcdev map from the original source). al-runner's `--server` path does not use a line map: `alRunnerCoverageFromServer` takes each statement's `scope`, the procedure the server itself names. Probed separately (`SERVER=1` in `$S/alrunner-probe.ts`, which passes `serverMode: true`; `$S/run-server.sh`, one repro at a time, coverage ON):

| code | repros | result |
| --- | --- | --- |
| HEAD | `p1-if-else` | 4 `no-coverage` (the mutant's `procedureName` is `""`, so the server's `Pick` matches nothing) |
| `$S/proto2` | `p1`, `p7`, `p9`, `p10`, `p11`, `q1` | 6 `CHECK PASS` against `$S/expect-perarm/` (the same verdicts and `exact` attribution as the one-shot path; `p10` and `p9`'s renamed member still `no-coverage`) |
| `$S/proto2` | `p12-mixed-scope` | BOTH subsets 3 killed, 1 survived, `exact`: the `[CLEAN27]` subset did not compile the `CLEAN27` build |

The last row is a pre-existing defect, not R316's: `AlRunnerBackend.ensureServerSuite` sends `server.runTests` no preprocessor symbols at all (the one-shot path sends one `--define` per symbol), so the `--server` leg always measures the no-symbol build. It is filed in Task 0. For R316 it means the server probe proves `st.scope` attribution for the default build only.

`p12-mixed-scope` now has per-subset expectations (`$S/expect-*/p12-mixed-scope.json`, a `perSubset` field `check-probe.ts` now reads; the cross-subset map check is skipped for it, since its builds differ by design): subset `[]` 3 killed, 1 survived, `exact` with coverage ON and 3 killed, 1 survived with it OFF; subset `[CLEAN27]` 4 `no-coverage`, attribution `-`, with coverage ON (no test can call a local arm) and 4 survived with it OFF. Both variants' plan-time logs pass it; red-checked (`$S/redcheck/p12.log`, one kill edited to a survivor: `CHECK FAIL`).

**The live gate's scratch pair, offline** (as revised at r3). `$S/gate/r316-gate` (`codeunit 91600 "R316 Gate"`, id range 91600 to 91649) and `$S/gate/r316-gate-tests` (`codeunit 91650`, 91650 to 91699), fresh app ids, publisher `LethAL`, names `LethAL R316 Gate` and `LethAL R316 Gate Tests`. The target holds a plain `Twin` and a preamble `Pick` (arms `#if R316A` / `#else`; the `#else` arm's local `Glob` shadows the object global, the arm witness) with the SAME body, `Glob := X; if X > 1 then Note := X; exit(Glob + 1);`, a plain `Plain`, and `GlobSeen()`, which returns the object global. The tests: `TwinEnters` (`Twin(5)`), `TwinSkips` (`Twin(1)`), `PickEnters`, `PickSkips` (`Pick(1)`), `PlainOnly`; each failure message ends `; global Glob <GlobSeen()>`. `Note` is never asserted, so removing `Note := X` survives and only an Enters test reaches it: the per-test negative control. Un-instrumented alc PASS, both subsets; `$S/gate/build-pair.sh` builds both `.app` files. `$S/pt2/members.ts`: 14 mutants, `M0001` to `M0006` in `Twin`, `M0007` to `M0010` in `Pick` (the same four shapes as `M0002`, `M0003`, `M0004`, `M0006`), `M0011` and `M0012` in `Plain`, `M0013` and `M0014` in `GlobSeen`, all `statement` grain. Local al-runner (`$S/pt2/gate-probe.ts`, both subsets, coverage ON, `$S/logs/gate-alr-final-r3-cov1.log`): 8 killed, 4 survived, 2 `no-coverage` (`GlobSeen` runs only inside a failing test's message); every covered mutant `exact`; `Pick`'s covering tests exactly `PickEnters` and `PickSkips`, `Plain`'s exactly `PlainOnly`; verdicts identical in both subsets, and `M0010`'s failure text reads `global Glob 0` in `[]` and `global Glob 5` in `[R316A]`. At HEAD the four `Pick` mutants are `no-coverage`, `unplaced`. al-runner reports no reach (`reached=-`), which is why Task 4 exists.

### Fixtures and corpora

Every `fixtures/*` project has no `#if`, `#elif`, `#else` or `#endif` line (the grep is empty). Identity keys, manifests and emitted targets for `sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-harden` and `sandbox-coverage-probe`: HEAD, `$S/proto` (both variants) and `$S/proto2` are identical (`diff -r --exclude=app.json`, manifests included, `maxRSS_KB` dropped). DC/Cloud (1135 files, 102584 raw sites), System Application (1718, 77286) and BusinessFoundation (104, 3639): identity keys, manifests and emitted targets identical between HEAD and both `$S/proto` variants, and between HEAD and `$S/proto2` (`$S/logs/final-cap.log`). The census (`preamble-census.ts`): 0 `preproc_split_procedure_preamble` nodes in all three and in BaseApp (9620 files, parse-only, two halves, R-309's run); DC has 11 `preproc_split_procedure` nodes, which the change does not touch.

---

## Decisions

### 1. One predicate: widen `isProcedureLike`, not a sibling

R316 allows either. Widening is one clause, and it reaches every walk in the table above at once, which is the point: the walks must agree about what a member is, and a sibling predicate would need every reader edited and would leave a missed one silently disagreeing. The one reader that must NOT treat a preamble like the other shapes is the latch writer (its plain-var rule would write one latch into the first arm's section, which is `AL0118` in every other build). Task 1 guards it with a throw that no parse reaches (R309's refusal still decides first), and Task 2 replaces the guard with the per-arm branch.

### 2. The name rule: R301's, unchanged

A preamble is named exactly like a `preproc_split_procedure`: by `procedureLikeNameNode`, one name when every arm agrees (quotes stripped, case-insensitive, the first arm's spelling kept), and NO name (`""`) when an arm renames the procedure. Why no name for a rename: which arm is compiled depends on preprocessor symbols LethAL does not evaluate, so either arm's name may be the inactive one, and a guessed name attributes coverage to the wrong member. A joined name (`Pick|Choose`) was considered and rejected: `|` is the identity key's separator (`serializeKey`), the hub coverage path resolves the COMPILED name from `SymbolReference.json` and would never match it, and giving it to preambles only would name the same situation two ways, while giving it to R301's split procedures too would change their identity keys (an existing shape).

**Effect on identity keys** (measured, "Task 1 prototyped" and "Review r1 measurements"): a preamble whose arms agree gains its name in the key's procedure part; a renamed preamble keeps the empty part. Every other member's key is unchanged EXCEPT through the ordinal (review r1, I1): an identical site AFTER an agreeing preamble in the same object is renumbered, because the preamble left the `""` twin group and joined its name's group. That moves a renamed split procedure's ordinal down (`c1`) and a same-named overload's up (`c3`); a twin BEFORE the preamble keeps its ordinal (`c2`). Both cases need a preamble in the object. Fixtures and every measured corpus: 0 keys changed (Task 5).

**The promise, narrowed to what is measured:** a key changes only for a mutant inside an agreeing preamble (its procedure part), or for a mutant after an agreeing preamble's byte-identical site in the same object, under the same operator, whose twin group the preamble left or joined (its ordinal). Keeping those existing keys instead was considered and rejected: `c3` could be kept by numbering a preamble's mutants after every other twin in their group, but that is a second ordering rule beside R193's single "source order" one, and `c1` cannot be kept at all without leaving the named preamble counted in the `""` group, which is the defect R316 fixes. Task 1's `ordinals` test pins the new numbering, so any later change to it is a deliberate one.

**What stays open for a renamed member:** with coverage on, a public renamed member (either split shape) still reads `no-coverage` (`p10-renamed`, `p9-all`'s `Pick2`/`Choose`, measured). R301 noted this gap when it closed but moved it nowhere: R301's status line says its remaining gaps went to R302 and R309, and neither covers it. Task 0 files it as its own roadmap item, before any code (ruling 3).

### 3. Per-arm latch: build it, commit it only behind a live Cronus28 gate (ruling 1)

| | keep R309's refusal | per-arm latch (Task 2) |
| --- | --- | --- |
| alc, 16 repros, 38 subsets | PASS | PASS |
| al-runner, coverage ON and OFF, every subset | PASS, preamble grain `unplaced` | PASS, preamble grain `statement`, verdicts identical |
| reach on bcdev | `not-decided` for every preamble survivor | measured per test, as for every other member |
| code | none (Task 1's guard only) | `preambleArmHeaderEnds` (about 30 lines) and a 20-line branch in `injectReachLatches`, both reusing R303's rule |
| negative controls | n/a | latch in the first arm only: `AL0118`; one arm's `var` not blanked: `AL0104` |
| unit red-checks (measured in `$S/proto2`) | n/a | 6, each red then green (Task 2 Step 6) |
| live proof that the marker fires per test | n/a | Task 4, pre-committed, the commit condition |

R309's three reasons for not building it were: (1) it buys nothing measurable until R316 gives the member a name and a span; (2) it is not cheap, a second per-arm header-end rule for a shape with 0 corpus sites; (3) the refusal is small, proven and truthful. After Task 1, (1) no longer holds: a named, spanned member is attributed to its covering tests, and the latch is then what turns a survivor's reach from `not-decided` into a measured reading on bcdev, the same as for every other member. (2) shrank: the rule is R303's, applied per arm, and the prototype is about 50 lines with its tests written and red-checked. (3) still holds, which is why the ruling below makes the latch conditional on a live proof rather than on the offline evidence.

The limit of the offline evidence: al-runner never reports reach (the report calls a run on it unmeasured), so alc and al-runner prove that the output compiles and runs with identical verdicts, not that the marker fires or that `reachedBy` names the right test. Review r1 rated building on that alone Critical. Task 4 is the gate that makes that claim, on Cronus28, and Task 2 commits only after it.

**Ruling (r2):** Task 2 is built and red-checked but left UNCOMMITTED; Task 3 runs the offline probes on that tree; Task 4 runs a serial bcdev gate on Cronus28 under a coord lease, both arms' symbol configurations (each run proving by a runtime arm witness that it compiled its own arm), and asserts BY MUTANT that each preamble mutant's marker fires in exactly the tests that enter its statement (`guardReached`, `reachedBy`), that a covering test that calls `Pick` but skips the statement is NOT in `reachedBy` (the negative control), and that fenced coverage attributes each mutant `exact` to exactly the tests that call its member. The expected rows are pre-committed in `$S/gate/expect-gate.json` and in Task 4. Only a `GATE PASS` in both configurations commits Task 2. Otherwise Task 2's files are restored to Task 1's, Task 1's guard, R309's refusal and R309's warning sentence stay, and Task 4 re-runs once as `run-gate.sh refused` (on a freshly published pair, after the first driver removed it) so Task 1's attribution is still proven live.

### 4. Operator semantics: not in R-316; widen R302

R316 lists operator semantics among the walks. Measured, they are not a member walk: the same three operators are missing, with the same count, from the R301 shape that HEAD already treats as a member (`q2-split-twin`: 4 mutants against the twin's 7). The causes are R302's places: `empty-block`'s `BODY_PARENT_KINDS`, `return-value`'s use of the engine's `findEnclosingProcedure`, and `semantic/types.ts`'s own private `findEnclosingProcedure` for `swap-additive`. Fixing them for the preamble alone would leave the shape that corpora actually hold (DC 11 nodes, BaseApp 11) blind; fixing them for both is R302's whole closure, about fifteen walks with a twin test each. And the preamble adds one rule R302 does not have yet: its arms declare DIFFERENT locals (and may take different parameters or return types), so a name inside the body may only be resolved to a type when every arm that declares it agrees. Task 6 widens R302 to name the preamble and that rule, with a cross-link both ways (R316 to R302, R302 to R316); R-316 changes no operator (ruling 2).

---

## Global Constraints

- Plain English, short sentences, no em dashes, in code comments, commits and roadmap text.
- No corpus source text in any committed file. File names, member names and counts are fine. Every repro is hand-written.
- No emission change for any file without a `preproc_split_procedure_preamble`. Fixtures have no `#if` at all, so every fixture emission, manifest and identity key is byte-identical, and no frozen itest figure can move. Task 5 proves that by diff, not by argument. The preamble itself is proven live by Task 4's gate on a scratch app pair; no frozen gate is re-run or re-recorded for it.
- Identity keys: only a preamble's own keys change their procedure part, and only an identical site after an agreeing preamble in the same object changes its ordinal (Decision 2, measured on `c1` to `c3`). Nothing else moves; fixtures and corpora: 0 keys.
- A preamble member is still instrumented and scored. Its file must still compile under every subset of its symbols (`alc-all.ts`), and its al-runner run must be green (Task 3).
- One container, one live task: Task 4, on Cronus28 ONLY (never Cronus281, 282 or 283), under `coord lease Cronus28 bugs`, heartbeat every 5 minutes, one run at a time, released right after; `lethal doctor` after EVERY run, pass or fail; never restart the container or its server (if doctor does not recover within 10 minutes, stop and ask the owner); an orphaned lease after a killed run is recovered with `lethal force-reset-lease` (R201, R289's rerun recipe). Task 4 publishes only the scratch pair `LethAL R316 Gate` / `LethAL R316 Gate Tests` (object ids 91600 to 91699, confirmed), through ONE driver whose EXIT trap removes it on every exit path, by app id AND publisher, never while a fenced operation is in flight, and fails unless the full app inventory is unchanged; no gate fixture's published app is touched. Every other task is offline. Control app minimum stays `MIN_CONTROL_VERSION = "1.0.0.20"` (`packages/runner/src/harness.ts`).
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>`. At plan time the touched files hold three pre-existing `lint/style/useTemplate` findings (one in `compile.ts`, two in `orchestrator.ts`, at lines this plan does not touch; `a295e52`'s own files report them too). They are not this plan's; do not fix them here.
- No `!` non-null assertions; destructure and check `undefined`. Fail loudly on a contract violation: the injector's owner-null throw stays.
- Every fix is red-checked: revert the specific line, confirm the specific test goes red, restore, report both outputs.
- Every scratch shell block runs under `set -euo pipefail` and sources `$S/setup.sh` (Task 0 Step 1), never filters a command's output through `grep -v` (stderr goes to a file of its own), writes an "expect nothing" grep as `if grep ...; then exit 1; fi`, and keeps its raw logs under `$S/logs/`.
- `reachLatchRefusedOwner`, `reachLatchRefusals` and their `cause` values keep their names. The warning code stays `reach-latch-refused`, and every message keeps the `[lethal] <file>: <member>'s var section` prefix the runner tests split on.
- Any al-runner probe failure is a STOP (the R-303 rule): report to the coordinator; the fix becomes its own designed task. Probes run SERIALLY, one session at a time, never beside another probe or a live gate (ruling 4). At plan time a session threw `al-runner wire contract UNMEASURABLE` with `exit 82` before any mutant ran three times, each while three or four probe jobs ran in parallel (`p14-arm-unparsed`, coverage OFF, subset `[]`, and `p7-mixed`, coverage OFF, subset `[CLEAN27]`: the hang probe returned no message; `p2-elif-else`, coverage ON, subset `[A]`: no readable `--output-json` envelope), and each passed when re-run alone (logs `$S/logs/flake-*.log`). On a serial run that throw is a STOP like any other; if it recurs, file it as its own roadmap item (next free id, checked across every worktree) with the log paths, before anything else.
- This plan files two new roadmap items in Task 0 (ruling 3): the renamed-split-member coverage gap, and the `--server` path ignoring preprocessor symbols. Re-check the next free ids immediately before writing, in EVERY worktree's working directory and every local branch (`git worktree list`), not only master; at plan time the highest id anywhere is R317, so they are R318 and R319 or later. Regenerate with `bun scripts/roadmap-index.ts`; never hand-edit `ROADMAP.md`. The rest of the roadmap work (Task 6) is a few one-line corrections and never stands in for Task 4 or the collision checks.

## Review Focus

1. **Every walk agrees on what a member is.** Expected: the manifest's member lines, the gap block and both line maps all bound a preamble from its `#if` line through its closing `end;`. Pinned by Task 1's runner tests, which bound every member through `end;` and check each mutant's name, scope, member lines and gap block against its member, and both line maps on the EMITTED source line by line; live, by Task 4's `exact` attribution rows.
2. **A renamed preamble gets no name, anywhere.** Expected: `procedureName ""`, no line-map span in either map, the identity key's procedure part empty, and the key unchanged from HEAD. Pinned by Task 1 (the `Pick2`/`Choose` member) and by the identity-key comparison in Task 5.
3. **Scope is `local` only when every arm is.** A public arm read as local would widen coverage to object grain and could manufacture a vacuous `survived` (R63). Pinned by Task 1 (`LPick` local, `MPick` with one public arm public); red-checked.
4. **The latch writer never writes into one arm only.** Expected with Task 2: one latch per arm, every arm's var-section `var` blanked, and a by-reference parameter's `var` untouched. Pinned by Task 2's P-cases (one per arm shape, CRLF included) and red-checked by blanking only the first arm and by writing only the first arm's latch. Without Task 2: Task 1's guard throws rather than writing.
5. **An unparsed arm is still refused, by R313's sentence.** Expected: `varSectionUnparsed` runs before the preamble rule, and the warning's cause follows the same order. Pinned by Task 2's runner test (`Twin`) and red-checked both ways.
6. **Tests assert only what their task owns.** Task 1 asserts no grain and no latch; Task 2 asserts no name, scope or span; no test asserts an operator set for a preamble (R302's).
7. **The marker fires where the statement runs, and only there, in each arm** (review r1, Critical; review r2, I2). Expected on Cronus28, both symbol configurations: the in-branch survivor's `reachedBy` is exactly the Enters test, the test that calls `Pick` and skips the statement is covering but NOT in `reachedBy`, every `Pick` row equals its plain `Twin` row, and `M0010`'s arm witness reads 0 in `[]` and nonzero in `[R316A]`, so two passes cannot come from one arm. Pinned by Task 4's pre-committed rows; `check-gate.ts` red-checked on twelve synthesized failures, same-arm reports included.
10. **The shared container is left exactly as found** (review r2, C1 and I1). Expected: no publish while a scratch name or id exists, no 1.0.0.0 over a minted version, removal by id and publisher only, no removal while doctor's lease check is red, and an unchanged full inventory. Pinned by `pair.ps1`'s refusals and `run-gate.sh`'s EXIT trap and diff.
8. **A parse error anywhere in a preamble's headers refuses the latch** (review r1, I2). Pinned by Task 2's P16 cases (three positions in the first arm) and `p14`'s later-arm case.
9. **Keys move only as Decision 2 says** (review r1, I1). Pinned by Task 1's `ordinals` test and Task 5 Step 3's exact `keys-diff` outputs for `c1` to `c3`.

---

## File structure

- Modify `packages/engine/src/ast/tree-walks.ts`: `isProcedureLike` and its doc comment (Task 1).
- Modify `packages/schemata/src/project.ts`: `procedureScopeOf`, and the doc comments of `enclosingProcedureLike` and `splitIsLocal` (Task 1).
- Modify `packages/runner/src/line-map.ts`: the R301 comment in `spansOf` (Task 1).
- Modify `packages/schemata/src/dispatch.ts`: `reachLatchRefusedOwner`'s walk (Task 1); `preambleArmHeaderEnds`, `varSectionUnparsed`'s start for a preamble, `reachLatchRefusedOwner`'s order and doc comment, `splitVarHoistAnchor`'s doc comment, one comment in `placeReach` (Task 2).
- Modify `packages/schemata/src/compile.ts`: a guard in `injectReachLatches` (Task 1), replaced by the per-arm branch, plus the owner-null throw's message (Task 2).
- Modify `packages/runner/src/orchestrator.ts`: `reachLatchRefusals`'s cause order and doc comment, and the `"preamble"` warning sentence (Task 2).
- Tests: `packages/engine/tests/ast/tree-walks.test.ts` and `packages/runner/tests/preproc-instrumentation.test.ts` (Task 1); `packages/schemata/tests/compile.test.ts` and `packages/runner/tests/preproc-instrumentation.test.ts` (Task 2).
- Roadmap: two new items in Task 0 (R318 and R319 at plan time); one-line corrections in Task 6 to `docs/roadmap/R316.md`, `R302.md`, `R309.md`, `R301.md`, `R303.md`, `R310.md`, `R313.md`; regenerated `ROADMAP.md` in both.
- Live (Task 4): nothing committed; the scratch pair and its scripts (`pair.ps1`, `run-gate.sh`, `build-pair.sh`, `gate-config.ts`, `check-gate.ts`, `expect-gate.json`, `mkredcheck.py`) live in `$S/gate/`.
- Scratch, never committed: everything under `$S`, present at plan time.

---

### Task 0: Scratch tools, repros, BEFORE captures, and the two new roadmap items (no product change)

**Files:** scratch only.

- [ ] **Step 1: Tools and the shared setup file.** Every fail-fast block in this plan starts with `set -euo pipefail` and then sources `$S/setup.sh`, which exists at plan time with exactly this content:

```bash
# R-316 scratch setup. Sourced by every fail-fast block after `set -euo pipefail`, so no block
# depends on variables left over from an earlier shell. Scratch, never committed.
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
declare -A C=([dc]="U:/Git/DC/Cloud" [sysapp]="U:/Git/BC.History/System Application" [bcf]="U:/Git/BC.History/BusinessFoundation")
export LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
cd /u/Git/LethAL-wt/r316
mkdir -p "$S/logs"
```

Confirm every tool imports from this worktree, not R-309's and not a prototype: `if grep -n "LethAL-wt/r309\|/proto" "$S"/*.ts; then exit 1; fi` (the copies under `$S/pt/` and `$S/pt2/` are the prototypes' and are not used by any task). `alc-all.ts` stages the Control app from the main checkout, `U:/Git/LethAL/extensions/lethal-control` (`lethal-control.app` and its `.alpackages`; this worktree has no built `.app`); its `app.json` must say 1.0.0.20 or newer (it does at plan time).

- [ ] **Step 2: Repros.** Re-run `bun $S/shape.ts $S/repro/*/Repro.Codeunit.al` and, for each repro, `bun $S/alc-plain.ts $S/repro/<name> <symbols>`. Expected: every preamble repro parses as `preproc_split_procedure_preamble` with 0 ERROR nodes except `p14-arm-unparsed` (3), `p15`, `p16` and `p17` (1 each, malformed on purpose, so they are not alc-compiled) and `p5-trigger` (not a preamble, 4); every other un-instrumented repro, `c1` to `c3` included, PASSes every subset.

- [ ] **Step 3: HEAD's manifest, the negative control.** At `a295e52`, `bun $S/members.ts $S/repro/q1-twin-body > $S/logs/members-head-q1.txt`. Expected: every `Pick` line says `name=<none> scope=- span=- gap=1-32 grain=unplaced lm=<unmapped>`, and `MEMBER <none>@- n=4`.

- [ ] **Step 4: BEFORE captures.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-before-$f.txt"
  rm -rf "$S/target-before-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-before-$f" > "$S/ids-before-$f.txt"
done
for k in "${!C[@]}"; do
  bun scripts/corpus-fingerprint.ts "${C[$k]}" > "$S/fp-before-$k.txt"
  bun "$S/preamble-census.ts" "${C[$k]}" > "$S/census-$k.txt"
  bun "$S/locate.ts" "${C[$k]}" > "$S/locate-before-$k.txt" 2> "$S/logs/locate-before-$k.err"
  rm -rf "$S/target-before-$k"; bun "$S/identity-keys.ts" "${C[$k]}" "$S/target-before-$k" > "$S/ids-before-$k.txt"
done
for h in 0 1; do bun "$S/preamble-census.ts" U:/Git/BC.History/BaseApp $h/2 > "$S/census-baseapp-$h.txt"; done
for r in "$S"/repro/*/; do
  n=$(basename "$r"); rm -rf "$S/em/before-$n"
  bun "$S/identity-keys.ts" "$r" "$S/em/before-$n" > "$S/em/ids-before-$n.txt" 2> "$S/logs/ids-before-$n.err"
done
for c in "$S"/census-*.txt; do
  if ! grep -q "preamble=0 " "$c"; then echo "$c: a corpus holds a preamble"; exit 1; fi
done
echo "BEFORE captured"
```

Expected: the final line. A census with a non-zero preamble count is a STOP: the "0 corpus sites" premise no longer holds, and the orchestrator decides whether Task 2's per-arm latch needs a live measurement before it lands.

---

- [ ] **Step 5: File the two roadmap items (ruling 3), before any code.** Re-check the next free ids across every worktree and local branch:

```bash
set -euo pipefail
{ for w in $(git worktree list --porcelain | sed -n 's/^worktree //p'); do
    if [ -d "$w/docs/roadmap" ]; then ls "$w/docs/roadmap"; fi
  done
  for b in $(git branch --format='%(refname:short)'); do git ls-tree --name-only "$b" docs/roadmap/ | sed 's#.*/##'; done
} | sed -n 's/^R\([0-9]*\)\.md$/\1/p' | sort -n | tail -n 1
```

The next two ids after the printed one (R318 and R319 at plan time). Write each from `docs/roadmap/_template.md`:

1. **Renamed split member** (section `correctness-risks`, status `open, filed <date>`), title "A split-header procedure whose `#if` arms rename it has no procedure name, so under coverage attribution a public one's mutants read `no-coverage`". Body: both shapes (`preproc_split_procedure`, R301; `preproc_split_procedure_preamble`, R316); measured at R-316 plan time on al-runner v2.11.0 (`p10-renamed`: 4 `no-coverage` with coverage on, 3 killed and 1 survived with it off; `p9-all`'s `Pick2`/`Choose`: 1 and 1; the same on the `--server` leg); why no name is given (the compiled arm depends on symbols LethAL does not evaluate, and a guessed name attributes coverage to the wrong member); what would close it (pick the compiled arm's name from the run's own preprocessor symbols, which every session knows, or attribute by the name the coverage source reports, which `--server`'s `st.scope` already carries); 0 corpus sites seen (R301's note); R301 closed with this gap in its "Still open" list and moved it to neither R302 nor R309.
2. **`--server` ignores preprocessor symbols** (section `correctness-risks`), title "al-runner's `--server` path compiles the target without the session's preprocessor symbols, so a symbol-dependent build is measured as the no-symbol one". Body: `AlRunnerBackend.ensureServerSuite` sends `server.runTests` source paths, package paths, isolation and coverage flags but no symbols, where the one-shot path sends one `--define` per symbol; measured at R-316 plan time on `p12-mixed-scope` (a preamble local in its `CLEAN27` arm): the one-shot leg's `[CLEAN27]` subset reads 4 `no-coverage` (no test can call a local), the `--server` leg's reads 3 killed, 1 survived, the no-symbol build's result; the report still records the symbols as if they were used (R101(c)); no fixture defines a symbol, which is why `itest:alrunner`'s server leg matches. Close by passing the symbols in the server request (or refusing `serverMode` with symbols until al-runner's server accepts them), with a two-build test.

Then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, and commit the two files and `ROADMAP.md`: `roadmap: file R<a> (renamed split members get no name) and R<b> (--server ignores preprocessor symbols), found by R-316's plan`.

---

### Task 1: The preamble is a member (engine, schemata, runner)

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts` (`isProcedureLike`)
- Modify: `packages/schemata/src/project.ts` (`procedureScopeOf`; doc comments)
- Modify: `packages/schemata/src/dispatch.ts` (`reachLatchRefusedOwner`'s walk only)
- Modify: `packages/schemata/src/compile.ts` (a guard in `injectReachLatches`)
- Modify: `packages/runner/src/line-map.ts` (a comment in `spansOf`)
- Test: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- `isProcedureLike(n)` keeps its signature; it now returns `true` for a `preproc_split_procedure_preamble`.
- No new export.

- [ ] **Step 1: Write the failing tests.** In `tree-walks.test.ts`, in the `R301: split-header procedures` describe, rename the test `isProcedureLike: a procedure and a split procedure, never a trigger or a preamble` to `isProcedureLike: a procedure, a split procedure and a preamble (R316), never a trigger`, change its last assertion from `.toBe(false)` to `.toBe(true)`, and add after it:

```ts
  it("gapBlockOf: a top-level statement of a preamble's shared body belongs to the body (R316)", () => {
    const src = `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure A(X: Integer)
    var
        L: Integer;
#else
    procedure A(X: Integer)
    var
        M: Integer;
#endif
    begin
        G := X;
        Message('%1', G);
    end;

    var
        G: Integer;
}
`;
    const got = gapBlockOf(first(wrapRoot(parseAL(src)), "assignment_statement"));
    const begin = src.indexOf("begin\n        G := X");
    const end = src.indexOf("end;\n\n    var") + "end".length;
    expect([got.startIndex, got.endIndex]).toEqual([begin, end]);
    expect(got.parent?.rawKind).toBe("preproc_split_procedure_preamble");
  });
```

Append to `preproc-instrumentation.test.ts`:

```ts
describe("R316: a split-header procedure whose arms each have their own var section is a member", () => {
  beforeAll(async () => {
    await initParser();
  });
  const SRC = `codeunit 50100 "Repro M"
{
    procedure Plain(X: Integer): Integer
    begin
        Glob := Glob + 1;
        exit(Glob);
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

#if CLEAN27
    local procedure LPick(X: Integer): Integer
    var
        K: Integer;
#else
    local procedure LPick(X: Integer): Integer
#endif
    begin
        Glob := Glob + 3;
        exit(Glob);
    end;

#if CLEAN27
    local procedure MPick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure MPick(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 4;
        exit(Glob);
    end;

#if CLEAN27
    procedure Pick2(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Choose(X: Integer): Integer
#endif
    begin
        Glob := Glob + 5;
        exit(Glob);
    end;

    var
        Glob: Integer;
}
`;
  const lines = SRC.split("\n");
  /** 1-based number of the first line at or after line `from` that starts with `prefix`. */
  const lineOf = (prefix: string, from = 1): number => {
    const i = lines.findIndex((l, k) => k + 1 >= from && l.startsWith(prefix));
    if (i < 0) throw new Error(`fixture drift: no line starting ${JSON.stringify(prefix)}`);
    return i + 1;
  };
  /** A member from its first line (the `#if` for a split header) through its closing `end;`. */
  const member = (
    label: string,
    prefix: string,
    from: number,
    name: string,
    scope: "local" | "public",
  ) => {
    const first = lineOf(prefix, from);
    const begin = lineOf("    begin", first);
    return { label, name, scope, first, begin, last: lineOf("    end;", first) };
  };
  const plain = member("Plain", "    procedure Plain(", 1, "Plain", "public");
  const pick = member("Pick", "#if CLEAN27", plain.last, "Pick", "public");
  const lpick = member("LPick", "#if CLEAN27", pick.last, "LPick", "local");
  const mpick = member("MPick", "#if CLEAN27", lpick.last, "MPick", "public");
  // Arms that rename the procedure: which arm is compiled is not known here (R301's rule).
  const renamed = member("Pick2/Choose", "#if CLEAN27", mpick.last, "", "public");
  const members = [plain, pick, lpick, mpick, renamed];
  const ownerOf = (line: number) => {
    const owners = members.filter((x) => line >= x.first && line <= x.last);
    expect(owners).toHaveLength(1);
    const [owner] = owners;
    if (owner === undefined) throw new Error("unreachable");
    return owner;
  };

  test("name, scope, member lines and gap block for every member, each bounded through its end;", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": SRC });
    for (const x of members) {
      expect(manifest.mutants.filter((m) => ownerOf(m.startLine) === x).length).toBeGreaterThan(0);
    }
    for (const m of manifest.mutants) {
      const x = ownerOf(m.startLine);
      expect([x.label, m.procedureName]).toEqual([x.label, x.name]);
      expect([x.label, m.procedureScope]).toEqual([x.label, x.scope]);
      expect([x.label, m.procedureStartLine, m.procedureEndLine]).toEqual([x.label, x.first, x.last]);
      // The shared body or a branch inside it, never the file root.
      expect(m.blockStartLine ?? 0).toBeGreaterThanOrEqual(x.begin);
      expect(m.blockEndLine ?? 0).toBeLessThanOrEqual(x.last);
    }
  });

  test("identity keys carry the member's name, and no two mutants share one", async () => {
    const { manifest } = await instrument({ "Repro.Codeunit.al": SRC });
    const keys = manifest.mutants.map((m) => serializeKey(identityKeyOf(m)));
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of manifest.mutants) {
      expect(serializeKey(identityKeyOf(m)).split("|")[2]).toBe(ownerOf(m.startLine).name);
    }
  });

  // Review r1, I1: an identity key carries an ordinal among its twins (same hash, object, member
  // name, operator), numbered in SOURCE order. An agreeing preamble used to sit in the "" group
  // and now sits in its name's group, so an identical site AFTER it in the same object is
  // renumbered: a renamed R301 split procedure's ordinal drops, a same-named overload's rises.
  // Both need a preamble in the object, which no fixture or measured corpus has. Pinned so the
  // effect stays deliberate.
  test("ordinals: a preamble leaves the empty-name group and joins its name's group", async () => {
    const PRE = `#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        K: Integer;
#else
    procedure Pick(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := Glob + 2;
    end;
`;
    const RENAMED = `#if CLEAN27
    procedure AIf(X: Integer): Integer
#else
    procedure AElse(X: Integer): Integer
#endif
    var
        S: Integer;
    begin
        Glob := Glob + 2;
    end;
`;
    const OVERLOAD = `    procedure Pick(X: Text): Integer
    begin
        Glob := Glob + 2;
    end;
`;
    const file = (a: string, b: string): string =>
      `codeunit 50100 "Repro K"
{
${a}
${b}
    var
        Glob: Integer;
}
`;
    const ordinals = async (src: string) => {
      const { manifest } = await instrument({ "Repro.Codeunit.al": src });
      return manifest.mutants
        .filter((m) => m.operatorName === "lethal.remove-assignment")
        .sort((a, b) => a.startIndex - b.startIndex)
        .map((m) => `${m.procedureName}#${m.identityOrdinal ?? 0}`);
    };
    // Before R316 these read ["#0", "#1"] and ["#0", "Pick#0"].
    expect(await ordinals(file(PRE, RENAMED))).toEqual(["Pick#0", "#0"]);
    expect(await ordinals(file(PRE, OVERLOAD))).toEqual(["Pick#0", "Pick#1"]);
    // A renamed split procedure BEFORE the preamble keeps its ordinal.
    expect(await ordinals(file(RENAMED, PRE))).toEqual(["#0", "Pick#0"]);
  });

  test("both line maps, built from the EMITTED target, name every dispatch line of a named split member and none of a renamed one", async () => {
    // Fenced bcdev (`buildLineMap` over the instrumented dir) and al-runner's Cobertura index both
    // read the emitted source, whose lines differ from SRC. al-runner's --server path does not
    // use a line map at all (`st.scope`), so it needs a probe of its own.
    const { emitted } = await instrument({ "Repro.Codeunit.al": SRC });
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    const dir = await mkdtemp(join(tmpdir(), "lethal-r316-"));
    try {
      await writeFile(join(dir, "Repro.Codeunit.al"), text);
      const bcdev = await buildLineMap(dir, new Set(["codeunit:50100"]));
      const alr = await buildAlRunnerCoverageIndex(dir);
      expect(alr.refusedFiles).toEqual([]);
      const out = text.split("\n");
      const starts = out.flatMap((l, k) =>
        l.startsWith("#if CLEAN27") || l.startsWith("    procedure Plain(") ? [k + 1] : [],
      );
      expect(starts).toHaveLength(members.length);
      const ends = [...starts.slice(1), out.length + 1];
      let checked = 0;
      for (const [i, x] of members.entries()) {
        const from = starts[i] ?? 0;
        const to = (ends[i] ?? 0) - 1;
        for (let n = from; n <= to; n++) {
          if (!(out[n - 1] ?? "").includes("MutationSelector.Active(")) continue;
          expect([n, bcdev.lookup("Codeunit", 50100, n)]).toEqual([n, x.name || undefined]);
          expect([n, alr.lineMap.lookup("Codeunit", 50100, n)]).toEqual([n, x.name || undefined]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(members.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

This describe asserts nothing about reach grain or latches (Task 2's, and R309's until then), and nothing about which operators find sites (R302's). Every import it uses (`buildAlRunnerCoverageIndex`, `identityKeyOf`, `serializeKey`, `instrument`, `mkdtemp`, `tmpdir`, `writeFile`, `rm`, `join`) is already in the file at `a295e52`, except `buildLineMap`: change the file's line-map import to `import { buildLineMap, lineMapFromSources } from "../src/line-map";`. The line-map test builds BOTH maps from the emitted target, the way fenced bcdev (`buildLineMap` over the instrumented dir) and al-runner's Cobertura index do (review r1, I3); al-runner's `--server` path, which uses no line map, is Task 3's probe. The `ordinals` test pins Decision 2's measured renumbering (review r1, I1).

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/preproc-instrumentation.test.ts -t "R316|isProcedureLike"`. Expected: all six FAIL (measured: Task 1's tests on `a295e52`'s code in `$S/proto2`, 0 pass, 6 fail). At `a295e52`: the name test gets `""` for `Pick`, the key test gets an empty procedure part, the `ordinals` test gets `["#0", "#1"]`, the line-map test gets `undefined` for `Pick`'s lines, `isProcedureLike` returns `false`, and the gap block is the file root.

- [ ] **Step 3: Implement.** In `tree-walks.ts`, replace `isProcedureLike` and its doc comment with:

```ts
/**
 * R301, R316: a `procedure`, or one of the two split-header procedure shapes. A
 * `preproc_split_procedure` has one header per `#if` arm, then ONE shared `var` section and body
 * as direct children. A `preproc_split_procedure_preamble` has one header AND one optional `var`
 * section per arm, then one shared body; every arm's header and var section are direct children
 * too. The manifest, latch and line-map walks own both shapes through this.
 * `findEnclosingProcedure` and the semantic walks deliberately do NOT use it yet (R302).
 */
export function isProcedureLike(n: ALSyntaxNode): boolean {
  return (
    n.kind === ALNodeKind.procedure ||
    n.rawKind === "preproc_split_procedure" ||
    n.rawKind === "preproc_split_procedure_preamble"
  );
}
```

In `project.ts`, `procedureScopeOf`, replace `if (proc.rawKind === "preproc_split_procedure") return splitIsLocal(proc) ? "local" : "public";` with:

```ts
  // R301, R316: a split header's node text starts with `#if`, so its scope is read per arm.
  if (proc.kind !== ALNodeKind.procedure) return splitIsLocal(proc) ? "local" : "public";
```

and replace the doc comments of `enclosingProcedureLike` and `splitIsLocal` with:

```ts
/**
 * R301, R316: the narrowest procedure-like ancestor (a `procedure`, or either split-header shape),
 * or `null`. Project-local on purpose: the engine's `findEnclosingProcedure` also feeds semantic
 * resolution, which does not see inside a split procedure yet (R302), so it stays unchanged.
 */

/** R301, R316: a split procedure, either shape, is `local` only when EVERY arm is: `local` widens
 *  coverage to object grain (selection.ts, R63), so a public arm read as local could manufacture a
 *  vacuous `survived`. Each arm is one `procedure_keyword`, with its `local` in a
 *  `procedure_modifier` before it. */
```


In `dispatch.ts`, `reachLatchRefusedOwner`, the walk no longer needs its own preamble clause:

```ts
  while (owner !== null && !isProcedureLike(owner) && owner.kind !== ALNodeKind.trigger)
    owner = owner.parent;
```

(the line `if (owner.rawKind === "preproc_split_procedure_preamble") return owner;` below it stays in this task, so R309's refusal is unchanged). In its doc comment, the R309 bullet's last two sentences (`... a per-arm placement is not built (it would measure nothing until R316 gives the member a name and a span). The node returned is the preamble itself, which is not procedure-like.`) become: `... a per-arm placement is not built. The node returned is the preamble itself, procedure-like since R316.`

In `compile.ts`, `injectReachLatches`, right before `const known = byOwner.get(owner.startIndex);`:

```ts
    // R316: a preamble is procedure-like now, but each arm has its own var section, so the plain
    // rules below would declare the latch in ONE arm only (alc AL0118 in every other build).
    // `placeReach` refuses it (R309), so no statement-grain marker reaches here.
    if (owner.rawKind === "preproc_split_procedure_preamble") {
      throw new Error(
        `compileSchemataForFile: cannot instrument ${filePath}: a reach marker sits in a split-header procedure whose #if arms each have their own var section (preproc_split_procedure_preamble), which has no latch placement (R309).`,
      );
    }
```

No test reaches this guard (the refusal decides first), the same as the R303 guard beside it. Task 2 replaces it; if Task 2 is not built, it stays.

In `line-map.ts`, `spansOf`, replace the three-line `// R301: a split-header procedure is one procedure ...` comment with:

```ts
    // R301, R316: a split-header procedure, either shape, is one procedure (one shared body). Its
    // span starts at the `#if` line, which holds no code, so no covered line can land there. An arm
    // that renames the procedure gets no span: which name is compiled is not known here.
```

- [ ] **Step 4: Run, expect PASS.** The same command as Step 2: 6 pass (measured in `$S/proto2` on Task 1's code). Then `bun test packages/schemata packages/runner/tests/preproc-instrumentation.test.ts packages/runner/tests/line-map.test.ts`: all green, R309's describes included (the refusal is unchanged).

- [ ] **Step 5: Red-checks.** One at a time, each recorded red then restored green:
  1. Remove the `n.rawKind === "preproc_split_procedure_preamble"` clause from `isProcedureLike`. Expected (measured in `$S/proto2`): all 6 tests red; the manifest-based tests throw the injector's owner-null message (with the walk clause gone from `reachLatchRefusedOwner`, the refusal no longer sees the preamble, so a marker reaches the injector), the other two fail their assertions.
  2. Restore, then put back `proc.rawKind === "preproc_split_procedure"` in `procedureScopeOf`. Expected (measured): only the name/scope test red, `LPick`'s scope `"public"` where `"local"` is wanted.

- [ ] **Step 6: Commit.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/engine/src/ast/tree-walks.ts packages/schemata/src/project.ts packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/line-map.ts packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/preproc-instrumentation.test.ts
git add packages/engine/src/ast/tree-walks.ts packages/schemata/src/project.ts packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/line-map.ts packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "fix(engine,schemata,runner): a split-header procedure whose arms each have their own var section is a member: name, scope, member lines, gap block and line-map span (R316)

isProcedureLike admits preproc_split_procedure_preamble, so every walk R301 extended sees it,
and procedureScopeOf reads scope per arm for either split shape. The name rule is R301's:
none when an arm renames the procedure. An identical site after an agreeing preamble in the
same object is renumbered (pinned). The reach latch is still refused (R309); a guard in
injectReachLatches keeps the plain rules from writing into one arm. No fixture has a preproc
node, so fixture emissions and keys are byte-identical (Task 5); the live proof is Task 4."
```

Expected biome result: only the pre-existing `useTemplate` finding in `compile.ts` (Global Constraints).

---

### Task 2: One reach latch per arm (schemata, runner), built and red-checked, NOT committed until Task 4's live gate passes

**Files:**
- Modify: `packages/schemata/src/dispatch.ts` (`preambleArmHeaderEnds`, new export; `reachLatchRefusedOwner`; doc comments)
- Modify: `packages/schemata/src/compile.ts` (replace Task 1's guard with the per-arm branch; the owner-null message)
- Modify: `packages/runner/src/orchestrator.ts` (`reachLatchRefusals`'s cause order; the `"preamble"` sentence)
- Test: `packages/schemata/tests/compile.test.ts`, `packages/runner/tests/preproc-instrumentation.test.ts`

**Interfaces:**
- Consumes: Task 1's `isProcedureLike`.
- Produces: `preambleArmHeaderEnds(owner: ALSyntaxNode): ALSyntaxNode[] | null`, exported from `packages/schemata/src/dispatch.ts`, used by `reachLatchRefusedOwner` and `injectReachLatches`.
- `reachLatchRefusals`'s `cause` keeps its three values; `"unparsed"` is now decided first for every member kind.
- `varSectionUnparsed(owner)` keeps its signature; for a preamble it scans from the preamble's own start (review r1, I2).
- Produces an UNCOMMITTED working tree that Tasks 3 and 4 measure; Task 4 commits it or restores Task 1's files.

- [ ] **Step 1: Rewrite the R309 tests as R316 per-arm tests** (they pin the refusal this task removes). In `compile.test.ts`:
  1. In the `R297: the selector var is inserted after the leading declarations` describe, replace the whole `it("a-preamble: a spec inside the preamble procedure is refused by name, not thrown (R309)", ...)` with:

```ts
  it("a-preamble: a spec inside the preamble procedure takes a latch in each arm (R316)", () => {
    const root = wrapRoot(parseAL(PREAMBLE));
    const s = spec(assignment(root, "L := 1"), "L := 2", "lethal.op");
    expect(reachLatchRefusedOwner(s.before)).toBeNull();
    const out = compileSchemataForFile(PREAMBLE, root, [s]);
    expect(out.split(`    procedure A() var ${REACH_LATCH}: Boolean;`).length - 1).toBe(2);
    expect(out.split("MutationSelector.Reached(").length - 1).toBe(1);
    expect(selectorAt(out)).toBeLessThan(out.indexOf("#if"));
  });
```

  2. In `PREAMBLE_CASES`, insert before the `P10 arms that rename the procedure` entry:

```ts
  {
    name: "P11 a named return value, and a ; after one arm's header (R316)",
    src: `codeunit 50100 "Repro P"
{
#if CLEAN27
    procedure Pick(X: Integer) R: Integer;
    var
        K: Integer;
#else
    procedure Pick(X: Integer) R: Integer
    // a comment after the header
    var
        M: Integer;
#endif
${PREAMBLE_BODY}`,
  },
```

  and change the comment above `PREAMBLE_BODY` from `R309: ...` to `R309, R316: split-header procedures whose #if arms each hold their own header and var section. Hand-written.`

  3. Rename the describe `R309: a split-header procedure whose arms each have their own var section is refused by name` to `R316: a split-header procedure whose arms each have their own var section takes one reach latch per arm`, and replace its `for (const c of cases) { it(...) }` loop with:

```ts
  const lf = (t: string): string => t.replace(/\r\n/g, "\n");
  for (const c of cases) {
    it(`${c.name}: one latch per arm on its header line, every arm's var blanked, all statement, no line moved`, () => {
      const { specs, grains, out } = instrumentAll(c.src);
      expect(specs).toHaveLength(2);
      for (const s of specs) expect(reachLatchRefusedOwner(s.before)).toBeNull();
      expect(grains).toEqual(["statement", "statement"]);
      const text = lf(out);
      const headers = text.split("\n").filter((l) => l.startsWith("    procedure "));
      const arms = lf(c.src)
        .split("\n")
        .filter((l) => l.startsWith("    procedure ")).length;
      expect(headers).toHaveLength(arms);
      for (const h of headers) expect(h.endsWith(` var ${REACH_LATCH}: Boolean;`)).toBe(true);
      expect(text.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(arms);
      // Every arm's own `var` keyword is blanked: no line between the first #if and begin is `var`.
      const region = text.slice(text.indexOf("#if"), text.indexOf("    begin"));
      expect(region.split("\n").filter((l) => l.trim() === "var")).toEqual([]);
      expect(text.split("MutationSelector.Reached(").length - 1).toBe(2);
      expect(text.split(SELECTOR_DECL).length - 1).toBe(1);
      expect(directiveLinesClean(out)).toBe(true);
      expect(linesWithoutInstrumentation(text)).toBe(lf(c.src).split("\n").length);
    });
  }
```

  4. In its `M1` test, change `"Glob := X + 1 -> preproc_split_procedure_preamble",` to `"Glob := X + 1 -> latch",`, and replace these two count assertions:

```ts
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(3);
    expect(out.split("MutationSelector.Reached(").length - 1).toBe(3);
```

  with:

```ts
    // R316: the preamble's two arms each take the latch on their own header line.
    expect(
      out.split(`    procedure Pick(X: Integer): Integer var ${REACH_LATCH}: Boolean;`).length - 1,
    ).toBe(2);
    expect(out.split(`${REACH_LATCH}: Boolean;`).length - 1).toBe(5);
    expect(out.split("MutationSelector.Reached(").length - 1).toBe(4);
```

  5. In the same describe, before `M1`, add the malformed-first-arm cases (review r1, I2), and add `preambleArmHeaderEnds` to the file's `../src/dispatch` import:

```ts
  // R316 review r1, I2: a parse error in ANY arm's header, even before the first arm's `)`, where
  // R313's scan used to start, refuses the latch. tree-sitter-al keeps the preamble shape and one
  // `)` per arm here, so the arm-header rule alone would admit it.
  const P1_SRC = PREAMBLE_CASES.find((c) => c.name.startsWith("P1 "))?.src ?? "";
  const MALFORMED_FIRST_ARM: { name: string; header: string }[] = [
    {
      name: "an ERROR inside the parameter list",
      header: "procedure Pick(X: Integer; @@ Y: Integer): Integer",
    },
    { name: "an ERROR before the first arm's )", header: "procedure Pick(X: Integer;): Integer" },
    {
      name: "an ERROR right after the first arm's (",
      header: "procedure Pick(X: Integer Y: Integer): Integer",
    },
  ];
  for (const m of MALFORMED_FIRST_ARM) {
    it(`P16 ${m.name}: refused by R313's predicate, all unplaced, no latch`, () => {
      const src = P1_SRC.replace("procedure Pick(X: Integer): Integer", m.header);
      expect(src).not.toBe(P1_SRC);
      const { specs, grains, out } = instrumentAll(src);
      expect(specs).toHaveLength(2);
      for (const s of specs) {
        const owner = reachLatchRefusedOwner(s.before);
        expect(owner?.rawKind).toBe("preproc_split_procedure_preamble");
        if (owner === null) throw new Error("unreachable");
        expect(preambleArmHeaderEnds(owner)).not.toBeNull();
        expect(varSectionUnparsed(owner)).toBe(true);
      }
      expect(grains).toEqual(["unplaced", "unplaced"]);
      expect(out).not.toContain(REACH_LATCH);
      expect(out).not.toContain("MutationSelector.Reached(");
    });
  }
```

In `preproc-instrumentation.test.ts`, replace the whole `describe("R309: a split-header procedure whose arms each have their own var section is refused by name", ...)` with:

```ts
describe("R316: a split-header procedure whose arms each have their own var section takes one reach latch per arm", () => {
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

#if CLEAN27
    procedure Twin(X: Integer): Integer
#if A
    var
        K: Integer;
#endif
#if not A
    var
        N: Integer;
#endif
#else
    procedure Twin(X: Integer): Integer
    var
        M: Integer;
#endif
    begin
        Glob := X + 8;
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
  /** A member from its first line (the `#if` for a split header) through its closing `end;`. */
  const member = (name: string, prefix: string, from: number, grain: "statement" | "unplaced") => {
    const first = lineOf(prefix, from);
    return { name, first, last: lineOf("    end;", first), grain };
  };
  const plain = member("Plain", "    procedure Plain(", 1, "statement");
  const pick = member("Pick", "#if CLEAN27", plain.last, "statement");
  const hoist = member("Hoist", "    procedure Hoist(", pick.last, "statement");
  const pick2 = member("Pick2", "#if CLEAN27", hoist.last, "statement");
  // One arm's var section is two #if blocks in a row, which tree-sitter-al leaves as ERROR nodes
  // (R313): refused by R313's predicate, which runs before the preamble's own rule.
  const twin = member("Twin", "#if CLEAN27", pick2.last, "unplaced");
  const members = [plain, pick, hoist, pick2, twin];

  test("the only reach-latch-refused warning is the unparsed arm's, with R313's sentence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r316-"));
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
      expect(refused.map((w) => w.message.split("'s var section")[0])).toEqual([
        "[lethal] Repro.Codeunit.al: procedure Twin",
      ]);
      const [w] = refused;
      expect(w?.message).toContain("did not parse cleanly");
      expect(w?.message).toContain("R313");
      expect(w?.message).not.toContain("R316");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("each member's sites carry its grain, and each admitted preamble arm gets its own latch", async () => {
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
      expect([x.name, ...new Set(grains)]).toEqual([x.name, x.grain]);
    }
    const keys = manifest.mutants.map((m) => serializeKey(identityKeyOf(m)));
    expect(new Set(keys).size).toBe(keys.length);
    const text = emitted.get("Repro.Codeunit.al") ?? "";
    const latch = " var LethALReachLatch: Boolean;";
    expect(text).toContain("P: Integer; LethALReachLatch: Boolean;");
    expect(text).toContain(`procedure Hoist(X: Integer): Integer${latch}`);
    expect(text.split(`    procedure Pick(X: Integer): Integer${latch}`).length - 1).toBe(2);
    expect(text).toContain(`    procedure Pick2(X: Integer): Integer${latch}`);
    expect(text).toContain(`    procedure Choose(X: Integer): Integer${latch}`);
    expect(text).not.toContain(`procedure Twin(X: Integer): Integer${latch}`);
    // Plain, Hoist, both Pick arms, Pick2 and Choose; none for Twin.
    expect(text.split("LethALReachLatch: Boolean;").length - 1).toBe(6);
    expect(text.split(SELECTOR).length - 1).toBe(1);
    expect(text).toContain(
      `        Glob: Integer;\n#if not CLEAN27\n        Old: Integer;\n#endif\n        ${SELECTOR}`,
    );
  });
});
```

and in the `R309 review: a refused member's name label ...` describe (its hand-built preamble owners still reach the refusal, because they hold no arms), add before its first test:

```ts
  test("R316: a preamble whose arms give no header end to anchor on is refused, cause preamble", () => {
    const owner = fakeNode({ children: [fakeName("Pick")] });
    const spec: MutationSpec = {
      operatorName: "lethal.op",
      operatorVersion: "1.0.0",
      astNodeId: "0-0",
      before: owner,
      after: { ...owner, text: "" } as never,
      parentContext: "statement-position",
    };
    expect(reachLatchRefusals([spec]).map((r) => r.cause)).toEqual(["preamble"]);
  });
```

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts -t "R316|a-preamble"`. Expected with only Task 1 landed (measured in `$S/proto2` on Task 1's code): `compile.test.ts` does not load (`SyntaxError: Export named 'preambleArmHeaderEnds' not found`), so every test in it errors; in the runner file both R316 per-arm tests FAIL (the preamble is still refused: grain `unplaced`, no latch; the warning lists `Pick`, `Pick2/Choose` and `Twin`, all with R309's sentence, since the cause reads the preamble first) and 5 PASS (Task 1's four and the hand-built cause test).

- [ ] **Step 3: Implement the per-arm header ends.** In `dispatch.ts`, after `headerEndOf`, add:

```ts
/** The `#if` directives that open, switch and close a preamble's arms, as its direct children. */
const ARM_MARKERS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

/**
 * R316. For a `preproc_split_procedure_preamble`, the last header token of EACH `#if` arm, in
 * source order: the arm's `)`, else its return type after it (plain or named), else a `;` directly
 * after either. `headerEndOf`'s rule, applied per arm: every arm's header tokens are direct
 * children of the preamble. `null` unless every arm holds exactly one `procedure` keyword and one
 * `)`, and an `#endif` closes the arms before the body: any other split is refused, never guessed.
 */
export function preambleArmHeaderEnds(owner: ALSyntaxNode): ALSyntaxNode[] | null {
  const arms: ALSyntaxNode[][] = [];
  let arm: ALSyntaxNode[] | null = null;
  for (const c of owner.children) {
    if (c.kind === ALNodeKind.block) break;
    if (ARM_MARKERS.has(c.rawKind)) {
      if (arm !== null) arms.push(arm);
      arm = c.rawKind === "preproc_endif" ? null : [];
    } else if (arm !== null && c.rawKind !== "comment" && c.rawKind !== "multiline_comment") {
      arm.push(c);
    }
  }
  if (arm !== null || arms.length === 0) return null;
  const ends: ALSyntaxNode[] = [];
  for (const kids of arms) {
    const closes = kids.filter((c) => c.rawKind === ")");
    const [close] = closes;
    const keywords = kids.filter((c) => c.rawKind === "procedure_keyword").length;
    if (close === undefined || closes.length !== 1 || keywords !== 1) return null;
    const ret = kids.find((c) => c.fieldName === "return_type" && c.startIndex > close.startIndex);
    const end = ret ?? close;
    const next = kids.find((c) => c.startIndex >= end.endIndex);
    ends.push(next !== undefined && next.rawKind === ";" ? next : end);
  }
  return ends;
}
```

Replace the head of `varSectionUnparsed` (its doc comment's last lines and its first statement) so that a preamble's scan starts at the preamble itself (review r1, I2: each arm's header end anchors a latch, so an error in ANY arm's header must refuse it, and r1's start, `headerEndOf`, is the FIRST arm's end):

```ts
 * arm (alc AL0118) or beside a `var` that is already there (AL0104). Fail safe: refuse.
 * R316: for a `preproc_split_procedure_preamble` the region is the WHOLE preamble before its body,
 * every arm's header included: each arm's header end anchors a latch there, so a parse error in
 * any header, even before the first arm's `)`, must refuse it too.
 */
export function varSectionUnparsed(owner: ALSyntaxNode): boolean {
  const from =
    owner.rawKind === "preproc_split_procedure_preamble"
      ? owner.startIndex
      : (headerEndOf(owner)?.endIndex ?? owner.startIndex);
```

Nothing else in it changes, and no other member kind's scan moves.

In `reachLatchRefusedOwner`, replace

```ts
  if (owner.rawKind === "preproc_split_procedure_preamble") return owner;
  if (varSectionUnparsed(owner)) return owner;
```

with

```ts
  if (varSectionUnparsed(owner)) return owner;
  if (owner.rawKind === "preproc_split_procedure_preamble")
    return preambleArmHeaderEnds(owner) === null ? owner : null;
```

and replace the first part of its doc comment, through the R303 bullet, with:

```ts
/**
 * The member holding `node` when the writer declares no reach latch there, else `null`. Three
 * shapes, each refused by name in the `reach-latch-refused` warning, checked in this order:
 * - R313: a member whose var section did not parse cleanly (`varSectionUnparsed`), one arm's var
 *   section in a preamble included.
 * - R316: a `preproc_split_procedure_preamble` (each `#if` arm holds its own header and its own
 *   `var` section, if any, then one shared body after `#endif`) whose arm header ends
 *   `preambleArmHeaderEnds` cannot all find. No parse is known to reach this: a preamble it can
 *   anchor takes one latch per arm (`injectReachLatches`).
 * - R303: a procedure or trigger whose var section sits inside `#if` in a shape
 *   `splitVarHoistAnchor` does not cover.
```

(its last two lines, `Such a member gets no latch and no marker ...`, stay). In `splitVarHoistAnchor`'s doc comment, replace its last sentence, which says a preamble never reaches it because `reachLatchRefusedOwner` refuses it first (R309), with:

```ts
 * skipped) is anything but the header's actual end: a pragma-only `#if` block, a split header's
 * `#endif`, or any kind not yet seen. Those members stay refused by name. A
 * `preproc_split_procedure_preamble` never reaches here: `reachLatchRefusedOwner` decides it by
 * `preambleArmHeaderEnds` first (R316).
```

In `placeReach`, change the comment `// R303, R309, R313: a member the writer declares no latch in gets no marker.` to `// R303, R313, R316: a member the writer declares no latch in gets no marker.`

- [ ] **Step 4: Implement the per-arm latch.** In `compile.ts`, import `preambleArmHeaderEnds` from `./dispatch` beside `splitVarHoistAnchor`, delete Task 1's guard, and insert right after `latches.set(c, latch);`:

```ts
    // R316: a preamble, each `#if` arm with its own header and var section. R303's hoist, once per
    // arm: ` var <latch>: Boolean;` right after each arm's header end, and every var-section `var`
    // keyword before the body blanked to spaces, so each build declares the latch exactly once, in
    // the one section its arm's declarations then continue. No newline, so no LINE moves.
    if (owner.rawKind === "preproc_split_procedure_preamble") {
      const ends = preambleArmHeaderEnds(owner);
      if (ends === null) {
        // `placeReach` refuses these members, so no statement-grain marker can reach here.
        throw new Error(
          `compileSchemataForFile: cannot instrument ${filePath}: a reach marker sits in a split-header procedure whose #if arms each have their own var section, and not every arm's header end was found (R316).`,
        );
      }
      for (const end of ends)
        rewrites.set(insertionNodeAt(end, end.endIndex), ` var ${latch}: Boolean;`);
      const blank = (n: ALSyntaxNode): void => {
        if (n.kind === ALNodeKind.block) return;
        if (n.rawKind === "var_keyword" && n.parent?.kind === ALNodeKind.var_section) {
          rewrites.set(n, " ".repeat(n.endIndex - n.startIndex));
          return;
        }
        for (const k of n.children) blank(k);
      };
      for (const k of owner.children) blank(k);
      continue;
    }
```

The `n.parent?.kind === ALNodeKind.var_section` test is what leaves a by-reference parameter's `var` alone (`p13-byref-name-taken`). In the owner-null throw above it, keep the first sentence (the hand-built guard test matches it) and replace the R309 sentence after it, so the message reads:

```ts
        `compileSchemataForFile: cannot instrument ${filePath}: a reach marker sits outside any procedure or trigger body, so its latch \`${REACH_LATCH}\` has nowhere to be declared. No known shape reaches here: every procedure, both split-header procedure shapes and every trigger own their body (R301, R316).`,
```


- [ ] **Step 5: The warning's cause order and sentence.** In `orchestrator.ts`, `reachLatchRefusals`, replace the `cause:` expression with:

```ts
      cause: varSectionUnparsed(owner)
        ? "unparsed"
        : owner.rawKind === "preproc_split_procedure_preamble"
          ? "preamble"
          : "split-var",
```

replace its doc comment with:

```ts
/**
 * The members of one file the writer declares no reach latch in (`reachLatchRefusedOwner`), each
 * with its site count and why, in source order. `cause` is `"unparsed"` for a var section that
 * did not parse cleanly (R313, `varSectionUnparsed`, checked first for every member kind),
 * `"preamble"` for a split-header procedure whose arms each hold their own var section and whose
 * arm header ends `preambleArmHeaderEnds` could not all find (R316), else `"split-var"` for a var
 * section split by `#if` in a shape `splitVarHoistAnchor` does not cover (R303). Named per member
 * by `generateMutationSet`'s `reach-latch-refused` warning, and counted by scripts.
 */
```

and in `generateMutationSet` replace the `"preamble"` sentence with:

```ts
          ? `[lethal] ${rel}: ${r.member}'s var section is split together with its header (preproc_split_procedure_preamble: each #if arm holds its own procedure header and its own var section, if any, and one body follows the #endif), and not every arm's header end (its parameter list's ")", the return type, or a ";" after either) was found, so no reach latch is declared there: its ${r.sites} site(s) carry no reach marker (reachGrain "unplaced", reach not-decided, never unreached). R316.`
```

The R313 and R303 sentences are unchanged.

- [ ] **Step 6: Run, expect PASS, then red-check.** `bun test packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts -t "R316|a-preamble|P16"`: 20 pass (measured in `$S/proto2`). Then one at a time, each recorded red then restored green (all six measured in `$S/proto2`, 20 green after each restore):
  1. **Blank only the first arm** (in the branch, stop the `for (const k of owner.children)` loop at the first `preproc_else` or `preproc_elif`). Expected: 7 red, the P1, P2, P3, P8, P11, P10 and P6 cases (a `var` line is left); P4 stays green, correctly, since its `#else` arm has no var section.
  2. **Write only the first arm's latch** (`for (const end of ends.slice(0, 1))`). Expected: 11 red: all eight per-arm cases, `M1`, `a-preamble` and the runner grain-and-latch test.
  3. **No `;` after an arm's header** (`ends.push(end)` in `preambleArmHeaderEnds`). Expected: 1 red, P11.
  4. **The preamble rule before the unparsed check** (swap the two lines in `reachLatchRefusedOwner`). Expected: both runner tests red (`Twin` is admitted: no warning, grain `statement`).
  5. **The cause order reverted.** Expected: the runner warning test red (`Twin`'s warning prints the R316 sentence).
  6. **r1's scan start** (`varSectionUnparsed`'s `from` back to `headerEndOf(owner)?.endIndex ?? owner.startIndex` for a preamble too). Expected: exactly the three P16 cases red (each admitted: grain `statement`, a latch written), 17 green.

- [ ] **Step 7: Whole suite, then STOP before committing.**

```bash
bun run typecheck && rm -rf packages/*/dist && bun test
bunx biome check packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/orchestrator.ts packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts
git diff --stat > "$S/logs/task2-uncommitted.stat"
```

Measured in `$S/proto2` with Tasks 1 and 2 (r2 code): `bun run typecheck` clean, then `bun test` from the root, 4173 pass, 7 skip, 0 fail. With Task 1's code alone, only Task 2's own new tests are red. Leave the five files UNCOMMITTED: Task 3 measures this tree offline and Task 4 live, and Task 4 Step 6 either commits it with this message or restores Task 1's files:

```bash
git add packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/orchestrator.ts packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts
git commit -m "fix(schemata,runner): a split-header procedure whose arms each have their own var section takes one reach latch per arm (R316)

preambleArmHeaderEnds applies R303's header-end rule to each #if arm; injectReachLatches
writes the latch after each arm's header and blanks every arm's var keyword, so each build
declares it once. R313's scan covers every arm's header of a preamble, and an unparsed arm is
refused with R313's sentence. Live on Cronus28 (Task 4): per-test reach and its negative
control matched the pre-committed rows in both symbol configurations."
```

---

### Task 3: alc and local al-runner probes of every repro, one-shot and `--server` (no container)

**Files:** scratch only. Run on the r316 worktree with Task 1 committed and Task 2 UNCOMMITTED in the working tree. Every probe runs alone (Global Constraints). If Task 4 later drops Task 2, re-run Steps 1 and 2 on Task 1's tree against `$S/expect-fix/` (plan-time: all green there too).

- [ ] **Step 1: alc, every repro, every subset.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
declare -A SYM=([p1-if-else]=CLEAN27 [p2-elif-else]=A,B [p3-elif-noelse]=A [p4-one-arm-novar]=CLEAN27 \
  [p5-trigger]=CLEAN27 [p6-crlf]=CLEAN27 [p7-mixed]=CLEAN27 [p8-nested-condvar]=A,B [p9-all]=CLEAN27 \
  [p10-renamed]=CLEAN27 [p11-named-return-local]=CLEAN27 [p12-mixed-scope]=CLEAN27 \
  [p13-byref-name-taken]=CLEAN27 [p14-arm-unparsed]=CLEAN27,A [q1-twin-body]=CLEAN27 [q2-split-twin]=CLEAN27 \n  [c1-preamble-then-renamed-split]=CLEAN27 [c2-renamed-split-then-preamble]=CLEAN27 [c3-preamble-then-overload]=CLEAN27)
total=0
for n in "${!SYM[@]}"; do
  bun "$S/alc-all.ts" "$S/repro/$n" "${SYM[$n]}" > "$S/logs/alc-$n.log" 2>&1
  k=$(tr ',' '\n' <<< "${SYM[$n]}" | wc -l); want=$((1 << k))
  # `grep -c` prints 0 and exits 1 on no match; inside `$(...)` as an argument to `test`, that exit
  # status does not trip `set -e`, and `test` then fails on the count, which is the check wanted.
  test "$(grep -c "^$n sym=\[.*\] exit=0 app=true" "$S/logs/alc-$n.log")" -eq "$want"
  test "$(tail -n 1 "$S/logs/alc-$n.log")" = "$n PASS"
  total=$((total + want))
done
test "$total" -eq 44
test "$(grep -c "LethALReachLatch: Boolean;" "$S/emit-p9-all/Repro.Codeunit.al")" -eq 7
echo "alc: 19 repros, 44 subsets, PASS"
```

Expected: the final line (measured at plan time on `$S/proto2`: all 19 PASS; `p15` to `p17` are malformed on purpose and are not compiled). `p9-all`'s 7 latch declarations are `Plain`, `Hoist`, `Split`, and one per arm of `Pick` and of `Pick2`/`Choose` (with Task 1 only, 3). `alc-all.ts` writes its emission to `$S/emit-<name>/`, next to itself.

- [ ] **Step 2: al-runner, every checked repro, every subset, coverage ON and OFF, per member.** ONE probe at a time (Global Constraints).

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
"$LETHAL_ALRUNNER_PATH" --version > "$S/logs/alrunner-version.txt"
cat "$S/logs/alrunner-version.txt"
E="$S/expect-perarm"   # "$S/expect-fix" if Task 2 was skipped
for cov in 1 0; do
  for r in q1-twin-body:CLEAN27 p1-if-else:CLEAN27 p2-elif-else:A,B p3-elif-noelse:A p4-one-arm-novar:CLEAN27 \
           p6-crlf:CLEAN27 p7-mixed:CLEAN27 p8-nested-condvar:A,B p9-all:CLEAN27 p10-renamed:CLEAN27 \
           p11-named-return-local:CLEAN27 p12-mixed-scope:CLEAN27 p13-byref-name-taken:CLEAN27 p14-arm-unparsed:CLEAN27,A; do
    n="${r%%:*}"
    COV=$cov bun "$S/alrunner-probe.ts" "$S/repro/$n" "$S/repro-tests-$n" "${r#*:}" > "$S/logs/alrunner-$n-cov$cov.log" 2>&1
    bun "$S/check-probe.ts" "$S/logs/alrunner-$n-cov$cov.log" "$E/$n.json" "$cov"
  done
done
echo "al-runner: 14 repros, every subset, both coverage modes CHECK PASS"
```

Expected: 28 `CHECK PASS` lines and the final line. The expectation files (`$S/mkexpect.py` writes both sets) hold, per member, its lines (through its closing `end;`), its grain, its verdict counts and its attribution in each mode:

| repro | member | lines | grain (Task 2 / Task 1 only) | coverage ON | coverage OFF |
| --- | --- | --- | --- | --- | --- |
| `p1`, `p2`, `p3`, `p4`, `p6`, `p8`, `p13` | `Pick` | the whole file | statement / unplaced | 3 killed, 1 survived, `exact` | 3 killed, 1 survived |
| `p10-renamed` | the renamed member | the whole file | statement / unplaced | 4 no-coverage, `-` | 3 killed, 1 survived |
| `p7-mixed`, `p9-all` | `Plain` | 9 to 15 | statement | 4 killed, `exact` | 4 killed |
| `p7-mixed`, `p9-all` | `Pick` | 17 to 33 | statement / unplaced | 3 killed, 1 survived, `exact` | 3 killed, 1 survived |
| `p7-mixed`, `p9-all` | `Hoist` | 35 to 44 | statement | 3 killed, 1 survived, `exact` | 3 killed, 1 survived |
| `p9-all` | `Pick2` / `Choose` | 46 to 56 | statement / unplaced | 1 no-coverage, `-` | 1 killed |
| `p9-all` | `Split` | 58 to 69 | statement | 1 killed, `exact` | 1 killed |
| `q1-twin-body` | `Twin` | 3 to 11 | statement | 6 killed, 1 survived, `exact` | 6 killed, 1 survived |
| `q1-twin-body` | `Pick` | 13 to 27 | statement / unplaced | 3 killed, 1 survived, `exact` | 3 killed, 1 survived |
| `p11-named-return-local` | `CallPick` | 3 to 6 | statement | 2 killed, `exact` | 2 killed |
| `p11-named-return-local` | `Pick` (local) | 8 to 22 | statement / unplaced | 3 killed, 1 survived, `exact` | 3 killed, 1 survived |
| `p14-arm-unparsed` | `Pick` | the whole file | unplaced (R313) | 3 killed, 1 survived, `exact` | 3 killed, 1 survived |

Every attribution in coverage-OFF mode is `-`. The coverage-ON column is R316's fix: at HEAD every preamble cell there read `no-coverage`. The renamed rows still read `no-coverage`: that is the gap Task 0 files. The one survivor per `Pick` is `conditional-boundary` on `X > 1`, which the inputs 5 and 0 cannot tell from `X >= 1`: an honest survivor, the same in `Twin` and `Hoist`. `p12-mixed-scope` is checked per subset (`perSubset` in its expectation file, review r1, I3): subset `[]` 3 killed, 1 survived, `exact` (coverage OFF: 3 killed, 1 survived); subset `[CLEAN27]` 4 `no-coverage`, attribution `-` (coverage OFF: 4 survived), since no test can call a local arm and one public arm makes the member public.

- [ ] **Step 3: al-runner `--server`, coverage ON, and the gate pair.** The server path attributes by the statement's own `scope`, not by a line map (review r1, I3), so it is probed on its own. It ignores preprocessor symbols (filed in Task 0), so `p12-mixed-scope` is recorded, not checked.

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
for n in p1-if-else p7-mixed p9-all p10-renamed p11-named-return-local q1-twin-body; do
  SERVER=1 COV=1 bun "$S/alrunner-probe.ts" "$S/repro/$n" "$S/repro-tests-$n" CLEAN27 > "$S/logs/srv-$n-cov1.log" 2>&1
  bun "$S/check-probe.ts" "$S/logs/srv-$n-cov1.log" "$S/expect-perarm/$n.json" 1
done
SERVER=1 COV=1 bun "$S/alrunner-probe.ts" "$S/repro/p12-mixed-scope" "$S/repro-tests-p12-mixed-scope" CLEAN27 > "$S/logs/srv-p12-mixed-scope-cov1.log" 2>&1
COV=1 bun "$S/gate-probe.ts" "$S/gate/r316-gate" "$S/gate/r316-gate-tests" R316A > "$S/logs/gate-alr-cov1.log" 2>&1
bun "$S/check-probe.ts" "$S/logs/gate-alr-cov1.log" "$S/gate/expect-gate-alrunner.json" 1
echo "al-runner server and gate pair CHECK PASS"
```

Expected: 7 `CHECK PASS` lines and the final line (measured at plan time on `$S/proto2`: all 7). `$S/gate-probe.ts` is `alrunner-probe.ts` with the gate pair's selector ids (91647 to 91649) and each mutant line also printing its covering tests and reach fields; its expectation: `Twin` 4 killed, 2 survived, `Pick` 2 killed, 2 survived, `Plain` 2 killed, every covered mutant `statement` and `exact`, and `GlobSeen` 2 `no-coverage` (it runs only inside a failing test's message), in both subsets; measured at r3 on the revised pair (`$S/logs/gate-alr-final-r3-cov1.log`): `CHECK PASS`. For the record, `srv-p12-mixed-scope-cov1.log` is expected to show BOTH subsets 3 killed, 1 survived (the defect); if its `[CLEAN27]` subset reads 4 `no-coverage`, the server now honours symbols: tell the coordinator, since that closes the Task 0 item.

- [ ] **Step 3: Any FAIL is a STOP.** A non-zero exit from either block (a missing subset, a red baseline, an `error` verdict, a changed count, grain, verdict or attribution, a thrown session): report the al-runner version, the repro, the subset and the checker's `BAD` lines, with the raw log path, to the coordinator. Do not work around it here, and do not run Task 4. A `wire contract UNMEASURABLE` throw on these serial runs is a STOP too, and gets filed (Global Constraints).

---

### Task 4: Live gate on Cronus28: per-test reach, its negative control, fenced attribution and an arm witness, by mutant (commits Task 2 or drops it)

**Why:** review r1's Critical finding and ruling 1. alc and al-runner cannot show that `MutationSelector.Reached` fires, or that `reachedBy` names the right test: al-runner reports no reach, and fenced bcdev is the path that does. This task is the ONLY thing that may commit Task 2.

**Files:** scratch only, `$G` = `$S/gate` (present at plan time; object ids 91600 to 91699 and lease lane `bugs`, both confirmed by the orchestrator at r2):

- the pair `r316-gate` / `r316-gate-tests`: fresh app ids (`b065feef-3d15-4d53-8ea6-ff983e0dc332` and `b45ff3f5-8bbb-47e5-8ae1-6306bfd4430f`), publisher `LethAL`, names `LethAL R316 Gate` and `LethAL R316 Gate Tests`, outside every fixture's range and outside `LethAL Control`'s 91000 to 91099;
- `build-pair.sh`: alc, the base target into the tests project's `.alpackages`, then the tests app; prints both sha256;
- `gate-config.ts`: writes `cfg-none.json` / `cfg-r316a.json` from the main checkout's gitignored `fixtures/sandbox-app/lethal.config.local.json` (its `bcdev` section unchanged except `packageCachePath`, plus `selectorIds` 91647 to 91649 and the configuration's `preprocessorSymbols`); refuses a source config that does not point at `http://Cronus28`; never prints the config;
- `pair.ps1`, the ONLY script that touches apps on Cronus28 (review r2, I1): `-Action Inventory` writes the FULL app inventory (every app: `AppId`, `Name`, `Publisher`, `Version`, `IsInstalled`); `-Action Preflight` throws if any app has a scratch NAME or a scratch APP ID; `-Action Publish` repeats that refusal, then publishes the base pair through the dev endpoint (never Global: a Global target becomes an AppSource app its own tests depend on, and BC refuses LethAL's replace, `.claude/skills/control-app`); `-Action Remove` matches app id AND publisher (never a name alone), refuses if an app with a scratch name has another id or publisher, refuses if any app outside the pair lists a scratch id among its `Dependencies` (or reports no `Dependencies` property at all, so an unknown dependent is never guessed away), then unpublishes every version, tests first, runs `Sync-NAVApp -Mode Clean` for both, and throws if either id is still present. The scratch identity is read from the pair's own `app.json` files. `Dependencies` is there to read: BcContainerHelper 6.1.15's `Get-BcContainerAppInfo` re-reads every app with `Get-NAVAppInfo -id ... -version ...`, which carries it (read in the module source, not on a server). Parse-checked offline (`[Parser]::ParseFile`, no errors). The offline trap test with stub `pwsh` and `bun` on `PATH` was not run: this session's command guard blocks a PATH-shimmed execution, so the EXIT trap's every-path behaviour rests on bash's documented `trap ... EXIT` semantics and `bash -n`, and the first live run's `remove.log` and empty inventory diff are its proof;
- `run-gate.sh <latch|refused>`, the ONE driver (review r2, I1): full inventory BEFORE; `trap cleanup EXIT`; Preflight; doctor's lease check green; `published=1`, then Publish; per configuration `lethal run`, doctor, `check-gate.ts` (both configurations run even if the first check fails, so a drop decision sees both). The EXIT trap runs on every exit, success, a failed step under `set -e`, or an interrupt: if the pair was (or may have been) published, it waits up to 10 minutes for doctor's `lease` check to be green, which requires BOTH no live token AND op kind `none` (`checkLease` in `packages/runner/src/doctor.ts`: an op marker is exactly a fenced operation still in flight, R201), and only then runs `pair.ps1 -Action Remove`; a lease check that stays red means it does NOT unpublish, and it stops naming what is left; a doctor JSON with no `lease` check reads as red, the fail-safe direction. Then it takes the inventory AFTER and fails unless it equals BEFORE. `bash -n` clean;
- `check-gate.ts`, `expect-gate.json`, `mkredcheck.py` (the red-check reports).

A SIGKILL (the coding tool's memory reaper, R289's void run 4) cannot be trapped. After a killed driver: `lethal doctor`, `lethal force-reset-lease --server http://Cronus28 --instance BC --config <cfg>` only if doctor names an orphaned lease or op marker (R201), then `pwsh -NoProfile -File $G/pair.ps1 -Action Remove` by hand, then the inventory diff.

**The arm witness (review r2, I2).** The two runs must provably compile DIFFERENT arms of `Pick`. `Pick`'s `#else` arm declares a local `Glob` that shadows the object global; the `#if R316A` arm does not. The shared body `Glob := X; ...; exit(Glob + 1);` therefore writes the GLOBAL `Glob` only when the `R316A` arm was compiled, and every test's failure message ends `; global Glob <n>`, read back through `GlobSeen()`. So a killed `Pick` mutant's `killingTestFailure` records which arm ran: `M0010` (`Glob + 1` to `Glob - 1`) must read `global Glob 0` in the `[]` run and a nonzero digit in the `[R316A]` run. `Twin` (no shadow) is the control that the witness can read nonzero at all: its `M0006` reads nonzero in both. Measured offline at r3 on al-runner (`$S/logs/gate-alr-final-r3-cov1.log`): `M0010` `Pick(5) returned 4; global Glob 0` in subset `[]` and `... global Glob 5` in `[R316A]`, `M0006` `global Glob 5` in both. The shadowing changes no return value, so every verdict is the same in both arms. The skip tests now call with `X = 1` (the branch `X > 1` is still skipped), so that `PickSkips` also carries a nonzero witness in the `R316A` arm.

**How the test app is published per symbol configuration, and restored.** The tests app never references an arm-specific name, so ONE build (compiled against the base target, no symbols) serves both configurations: it is published once per driver run and never republished. The target is published by LethAL itself on every `lethal run`, instrumented with that run's `preprocessorSymbols`, at a version LethAL mints above the base's 1.0.0.0, so the second run is not a downgrade of the first. The base pair at 1.0.0.0 is published only by `pair.ps1 -Action Publish`, which refuses unless NEITHER scratch id nor name exists on the server, so it can never publish 1.0.0.0 over a higher instrumented version (review r2, C1). No gate fixture app is touched: removal matches the two scratch ids, and refuses if anything else depends on them.

**Pre-committed per-mutant results** (`$G/expect-gate.json`, both configurations; mutant codes as `$S/pt2/members.ts` measured them at r3; T = `R316 Gate Tests.`):

| mutant | member | line | operator | verdict | coveringTests (fenced, `exact`) | reachedBy | arm witness in killingTestFailure |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M0001 | Twin | 6 | empty-block | killed | T.TwinEnters, T.TwinSkips | non-empty subset, holds the killer | |
| M0002 | Twin | 7 | remove-assignment (`Glob := X`) | killed | T.TwinEnters, T.TwinSkips | holds the killer | |
| M0003 | Twin | 8 | conditional-boundary (`X > 1`) | survived | T.TwinEnters, T.TwinSkips | EXACTLY T.TwinEnters, T.TwinSkips | |
| M0004 | Twin | 9 | remove-assignment (`Note := X`) | survived | T.TwinEnters, T.TwinSkips | EXACTLY T.TwinEnters | |
| M0005 | Twin | 10 | return-value | killed | T.TwinEnters, T.TwinSkips | holds the killer | |
| M0006 | Twin | 10 | swap-additive | killed | T.TwinEnters, T.TwinSkips | holds the killer | nonzero in `[]` and `[R316A]` |
| M0007 | Pick | 23 | remove-assignment (`Glob := X`) | killed | T.PickEnters, T.PickSkips | holds the killer | |
| M0008 | Pick | 24 | conditional-boundary (`X > 1`) | survived | T.PickEnters, T.PickSkips | EXACTLY T.PickEnters, T.PickSkips | |
| **M0009** | **Pick** | **25** | **remove-assignment (`Note := X`)** | **survived** | **T.PickEnters, T.PickSkips** | **EXACTLY T.PickEnters (T.PickSkips calls `Pick(1)` and skips the statement: the negative control)** | |
| **M0010** | **Pick** | **26** | **swap-additive** | **killed** | T.PickEnters, T.PickSkips | holds the killer | **`0` in `[]`, nonzero in `[R316A]`** |
| M0011 | Plain | 30 | empty-block | killed by T.PlainOnly | T.PlainOnly | holds T.PlainOnly | |
| M0012 | Plain | 31 | return-value | killed by T.PlainOnly | T.PlainOnly | holds T.PlainOnly | |
| M0013 | GlobSeen | 35 | empty-block | no-coverage | none | none | |
| M0014 | GlobSeen | 36 | return-value | no-coverage | none | none | |

`GlobSeen` runs only inside a failing test's `Error(...)`, never in a green baseline, so its two mutants are `no-coverage`, with no attribution and no reach fields. Every other row also: `reachGrain` `statement`, `coverageAttribution` `exact`, `guardReached` true; the report's `baselineGreen` true and `preprocessorSymbols` exactly the configuration's. Each `Pick` row must EQUAL its plain `Twin` row (M0002 to M0007, M0003 to M0008, M0004 to M0009, M0006 to M0010: verdict, `guardReached`, `reachedBy`, `coveringTests` and killing test, test names mapped). A survivor runs every covering test, so its `reachedBy` is complete; a kill stops at the first failing test, so its `reachedBy` is only required to hold the killer. The local al-runner run of the same pair (`$S/logs/gate-alr-final-r3-cov1.log`, both subsets) matches every verdict, covering set, attribution and witness above; it cannot show reach.

**`check-gate.ts`, red-checked at r3** (`$G/redcheck/`, reports synthesized from `expect-gate.json` by `mkredcheck.py`): the two good reports `GATE PASS`; each of these exits 1 naming the row: **the same arm twice** (a `[]` report whose witness reads 5: `M0010 (Pick) arm witness 5, want zero for []`; a `[R316A]` report reading 0: `... want nonzero for [R316A]`; and the first again in `MODE=refused`), the negative control reached, a `Pick` grain `unplaced`, attribution `object`, an extra covering test, reach fields absent, a duplicated mutant, a `Twin` row differing from its `Pick` row, the witness missing from the failure text, and a `GlobSeen` row covered. `MODE=refused` (Task 1 alone) switches the four `Pick` rows to `unplaced` with NO reach fields and keeps every attribution, covering, verdict and witness assertion; its good reports pass and an attribution `object` fails.

- [ ] **Step 1: Offline preparation (no container).** On the r316 worktree with Task 2 uncommitted: `$G/build-pair.sh`; `bun $G/gate-config.ts $G/cfg-none.json ""` and `bun $G/gate-config.ts $G/cfg-r316a.json R316A`; `bash -n $G/run-gate.sh`. Confirm Task 3 passed. `$G/r316-gate/.alpackages` holds the Microsoft symbol apps and `lethal-control.app` copied from the main checkout's `fixtures/sandbox-app/.alpackages` (present at plan time).

- [ ] **Step 2: Container and lease.** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`: stopped means `coord ask`, never start it. Then `coord lease Cronus28 bugs`, heartbeat every 5 minutes from another shell until Step 5. Held by another lane: wait. Nothing else runs against Cronus28 from this session meanwhile, and no local probe runs beside it.

- [ ] **Step 3: The gate.** `$G/run-gate.sh latch > $S/logs/gate-latch.out 2>&1`. It writes `$S/logs/gate-latch/` (both inventories and their diff, both reports, both check logs, doctor logs, the removal log). A refusal from Preflight means a scratch name or id already exists on Cronus28: STOP and report, nothing was published. A publish refused for an object id (the 916xx range taken after all) is a STOP too; the fix is a new id range, which changes no mutant code or expectation.

- [ ] **Step 4: Decide.** Read `check-none.log` and `check-r316a.log`:
  1. **Both `GATE PASS`, and the driver exited 0** (the pair removed, the inventory unchanged): Task 2 is proven, in each arm. Go to Step 5, then Step 6's commit.
  2. **Any `Twin` row fails** (its own expectation, not only the comparison), or either witness fails: the server or the build did not behave, which says nothing about the preamble. STOP after Step 5, report the logs, commit nothing; at most one repeat (R289's stop rule: never more than 4 runs).
  3. **Only `Pick` rows fail, `Twin` rows and both witnesses pass:** the per-arm latch is not shown. Drop Task 2: `git restore packages/schemata/src/dispatch.ts packages/schemata/src/compile.ts packages/runner/src/orchestrator.ts packages/schemata/tests/compile.test.ts packages/runner/tests/preproc-instrumentation.test.ts` (Task 1's committed versions come back, with its guard and R309's refusal), re-run Task 3 Steps 1 and 2 against `$S/expect-fix/`, then run `$G/run-gate.sh refused`. **Chosen fallback (review r2, C1): the pair is fully removed first**, by the first driver's EXIT trap (checked: its `remove.log` is clean and its inventory diff empty), so the second driver's Preflight finds no scratch name or id and its publish of 1.0.0.0 cannot be a downgrade. The installed test app is NOT reused. Record which `Pick` rows failed, in R316's closing section.
  4. **A driver killed from outside** is VOID, not a result: the manual recovery in "Files" above, then one repeat.

- [ ] **Step 5: Confirm, release.** `$S/logs/gate-<label>/inventory.diff` is empty and `remove.log` names both scratch apps removed. Then `bun packages/runner/src/cli.ts doctor --config U:/Git/LethAL/fixtures/sandbox-app/lethal.config.local.json --project U:/Git/LethAL/fixtures/sandbox-app --tests U:/Git/LethAL/fixtures/sandbox-tests` is green, delete `$G/cfg-*.json` (they hold credentials), and release the coord lease. A non-empty diff, a refused removal or a red doctor is a STOP reported to the coordinator; do not repair an app by hand.

- [ ] **Step 6: Commit Task 2, or record the drop.** On Step 4.1: the commit block at the end of Task 2 Step 7. On Step 4.3: nothing to commit (the files are restored); Task 6 records the drop in R316 and keeps R309's closing text true.

---

### Task 5: Prove nothing else moved

**Files:** scratch only.

- [ ] **Step 1: Fixtures byte-identical, identity keys unchanged.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-after-$f.txt"
  cmp "$S/hashes-before-$f.txt" "$S/hashes-after-$f.txt"
  rm -rf "$S/target-after-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-after-$f" > "$S/ids-after-$f.txt"
  diff <(sed '/^maxRSS_KB /d' "$S/ids-before-$f.txt") <(sed '/^maxRSS_KB /d' "$S/ids-after-$f.txt")
  diff -r --exclude=app.json "$S/target-before-$f" "$S/target-after-$f"
done
echo "fixtures: byte-identical, manifests and identity keys unchanged"
```

`cmp` and `diff` exit 1 on any difference, which stops the block; `diff -r` includes each target's `mutant-manifest.json`; `sed` drops only the memory line. Expected: only the final line (measured at plan time between HEAD, `$S/proto` in both variants and `$S/proto2`: no difference for all five). Any difference is a STOP.

- [ ] **Step 2: Corpora**, in a block that starts `set -euo pipefail` and sources `$S/setup.sh` like the one above, each `cmp` and `diff` a command of its own (no `|| true`), stderr to `$S/logs/`. For dc, sysapp and bcf: `corpus-fingerprint.ts` into `fp-after-$k.txt` and `cmp` with BEFORE (a mismatch voids that corpus's comparison: recapture BEFORE in a scratch worktree at `a295e52`); then `locate.ts` and `identity-keys.ts` into `*-after-$k.txt` / `$S/target-after-$k`. Expected: `locate` outputs identical; identity keys identical except `maxRSS_KB`; `diff -r --exclude=app.json` of the targets empty (measured at plan time for all three). BaseApp is covered by the parse-only census (0 sites) and is not instrumented (R311).

- [ ] **Step 3: The repros' identity keys, collision repros included (review r1, I1).** `$S/keys-diff.ts <before> <after> <allowed name>...` (written at plan time) prints `named=<n> ordinal=<n>` and `KEYS OK` only when both files list the same mutants at the same sites in the same order, the hash, object, operator and major are equal, a changed procedure part goes from `""` to an allowed name, and a changed ordinal DROPS inside the `""` group; anything else is a `BAD` line and `KEYS FAIL`. The block compares each output, whole, with what was measured at plan time, so `c3`'s expected `KEYS FAIL` (the overload's ordinal rising, Decision 2) is checked line for line rather than excused.

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
declare -A WANT=([p1-if-else]=4 [p2-elif-else]=4 [p3-elif-noelse]=4 [p4-one-arm-novar]=4 [p5-trigger]=0 \
  [p6-crlf]=4 [p7-mixed]=4 [p8-nested-condvar]=4 [p9-all]=4 [p10-renamed]=0 [p11-named-return-local]=4 \
  [p12-mixed-scope]=4 [p13-byref-name-taken]=4 [p14-arm-unparsed]=4 [q1-twin-body]=4 [q2-split-twin]=0)
for n in "${!WANT[@]}" c1-preamble-then-renamed-split c2-renamed-split-then-preamble c3-preamble-then-overload; do
  rm -rf "$S/em/after-$n"
  bun "$S/identity-keys.ts" "$S/repro/$n" "$S/em/after-$n" > "$S/em/ids-after-$n.txt" 2> "$S/logs/ids-after-$n.err"
  # keys-diff exits 1 on c3 by design; its output, not its status, is what is checked.
  if bun "$S/keys-diff.ts" "$S/em/ids-before-$n.txt" "$S/em/ids-after-$n.txt" Pick > "$S/logs/keys-$n.log"; then :; fi
  if [ -f "$S/keys-expect/$n.txt" ]; then
    diff "$S/keys-expect/$n.txt" "$S/logs/keys-$n.log"
  else
    test "$(cat "$S/logs/keys-$n.log")" = "ids-after-$n.txt named=${WANT[$n]} ordinal=0 KEYS OK"
  fi
done
echo "repro identity keys: exactly the measured changes"
```

Expected: the final line (measured at plan time between HEAD and `$S/proto2`). The 4 named keys in `p7`, `p9`, `p11` and `q1` are `Pick`'s alone; `p9`'s renamed member, `p10`, the trigger control `p5` and the R301 control `q2` change nothing. `$S/keys-expect/` holds the three collision outputs: `c1` `named=2 ordinal=2 KEYS OK` (the renamed split procedure's two twins drop from ordinal 1 to 0), `c2` `named=2 ordinal=0 KEYS OK`, and `c3` two `BAD M000<n>: ordinal 0 -> 1 in "Pick"` lines (the overload's `remove-assignment` and `swap-additive`) and `named=2 ordinal=2 KEYS FAIL`. Red-checked at plan time: allowing only a wrong name (`Other`) on `p1` gives `BAD M0004: procedure "" -> "Pick"` and `KEYS FAIL`.

- [ ] **Step 4: Record** the figures for Task 6 as MEASURED results, only after the blocks above finished: the al-runner version and the checker's pass list, the fixture and corpus results, the census.

---

### Task 6: Roadmap (kept small, per the review's minor finding)

**Files:** `docs/roadmap/R316.md`, `R302.md`, `R309.md`, `R301.md`, `R303.md`, `R310.md`, `R313.md`, `ROADMAP.md`. The two new items were filed in Task 0. Each edit below is one short paragraph or one line; none stands in for Task 4 or Task 5.

- [ ] **Step 1: R316.** Only after Tasks 3, 4 and 5. Status `done (<Task 1 commit>..<Task 2 commit, or Task 1 alone if Task 2 was dropped>)`. One dated section "**Closed <date> (R-316).**": the predicate and the walks it reaches; the scope rule; the name rule (R301's) and the narrowed key promise (Decision 2, `c1` to `c3`); the per-arm latch with Task 4's live result per configuration, or its drop and which `Pick` rows failed; the whole-region R313 scan (`p15` to `p17`); the alc and al-runner totals (version, sessions); operator semantics moved to R302 (cross-link); the two items Task 0 filed (cross-links); 0 corpus sites; fixtures byte-identical.
- [ ] **Step 2: R302**, one paragraph and a cross-link to R316: every place it lists is blind inside a `preproc_split_procedure_preamble` too (measured: `q1-twin-body` against `q2-split-twin`, the same three operators missing from both), plus the preamble's own rule, that a name declared differently per arm may only be resolved when every arm agrees.
- [ ] **Step 3: One-line corrections**, each only where the text would otherwise be false after this plan:
  - **R309**: a dated line: R316 gave the preamble a name, a scope and a span, and the per-arm latch this item deferred landed there behind a live gate (or: was dropped, and this refusal stands); an unparsed arm now prints R313's sentence.
  - **R301**: the "Still open" renamed-arm bullet points at Task 0's renamed-member item.
  - **R303** ("**A third refused shape.**"), **R310** (status line and body) and **R313** (its sentence that a preamble has no procedure-like owner): only if Task 2 landed, the preamble is admitted with one latch per arm, and refused only on a parse error (R313's scan, every arm) or a missing arm header end.
- [ ] **Step 4: The prose grep.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r316/setup.sh
# Each grep is EXPECTED to find nothing. Under pipefail a grep that finds nothing exits 1, so the
# check is written as "fail if it finds something", never as a bare grep.
if grep -rn --include=*.ts --exclude-dir=dist "preamble" packages | grep -i "not procedure-like\|missing name and span\|until R316"; then
  echo "stale preamble prose in code"; exit 1
fi
if grep -n "preamble" docs/roadmap/R301.md docs/roadmap/R313.md | grep -i "no procedure-like owner\|has no procedure name"; then
  echo "stale preamble prose in the roadmap"; exit 1
fi
echo "no stale preamble prose"
```

Expected: only the final line. R309.md and R316.md are read by hand: their history may state the old behaviour in the past tense. If Task 2 was dropped, R313's "no procedure-like owner" sentence is still corrected (a preamble is procedure-like after Task 1 either way).

- [ ] **Step 5: Regenerate and commit.**

```bash
bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R316.md docs/roadmap/R302.md docs/roadmap/R309.md docs/roadmap/R301.md docs/roadmap/R303.md docs/roadmap/R310.md docs/roadmap/R313.md ROADMAP.md
git commit -m "roadmap: R316 closed (a preamble split procedure is a member; per-arm latch landed behind the Cronus28 gate, or dropped); R302 widened to the preamble"
```

Write the commit message's latch clause as what happened: "landed behind the Cronus28 gate" or "dropped, R309's refusal stands".

---

## Self-review

- The task's points and the r2 rulings: the preamble is a member in every walk R301 extended (Task 1); operator semantics routed to R302 with a cross-link (Decision 4, Task 6); the per-arm latch built but committed only behind the pre-committed Cronus28 gate, with its drop path (Decision 3, Tasks 2 and 4); a truthful name rule with its MEASURED key effect, collisions included (Decision 2, Task 1's `ordinals` test, Task 5 Step 3); R313's scan over every arm's header (Task 2, P16); coverage checks on the emitted source, the `--server` path probed separately, `p12` checked per subset (Tasks 1 and 3); fixtures' bytes and frozen gate figures unmoved (Task 5); serial probes and the flake rule (Global Constraints, Task 3); the two new items filed first (Task 0); red-checks for every fix, all measured (Task 1 Step 5, Task 2 Step 6, `check-gate.ts`, `check-probe.ts`, `keys-diff.ts`).
- Placeholders: none. Every figure is from a plan-time log under `$S/logs/`, `$S/mem/` or `$S/gate/`, named where it is quoted. The live gate's rows are pre-commitments, not measurements, and are labelled so.
- Types: `preambleArmHeaderEnds(owner: ALSyntaxNode): ALSyntaxNode[] | null` is the only new export; `reachLatchRefusals` and `varSectionUnparsed` keep their signatures.

## Notes: upstream grammar observations (filed)

1. **A preamble's body has no `body` field**, filed as **SShadowS/tree-sitter-al #33**. In tree-sitter-al 4.4.1 a `preproc_split_procedure`'s shared `code_block` carries the `body` field and a `preproc_split_procedure_preamble`'s does not (`fields.ts` on `p9-all`, which holds both). LethAL reads that field for neither shape, so nothing here depends on it.
2. **R313's two-block var section inside a preamble arm**, filed as a comment on **SShadowS/tree-sitter-al #31**. `p14-arm-unparsed` (valid AL, alc PASS in 4 subsets un-instrumented) leaves 3 ERROR nodes inside the preamble; R313's refusal catches it.

## Rulings (r2 and r3)

1. Task 2 is built ONLY behind a live gate: a serial bcdev probe on Cronus28 under a coord lease (Task 4), each arm's symbol configuration, a test that enters the mutated statement and one that calls the member but skips it, per-mutant reach, its negative control and fenced attribution pre-committed; if it cannot be shown, Task 2 is dropped and R309's refusal stays. No "no live gate needed" claim remains.
2. Operator semantics go to R302, with a cross-link (Task 6).
3. The renamed-split-member coverage gap is filed now, in Task 0, as its own item.
4. Probes run serially; a repeat throw is a STOP, and the parallel flake is filed if it recurs.
5. The grammar notes are filed: SShadowS/tree-sitter-al #33, and a comment on #31.
6. (r2) Object ids 91600 to 91699 and lease lane `bugs` are confirmed. R319 (`--server` ignores preprocessor symbols) does not block R-316; Task 0 files it.
7. (r3, final) Round 2 approved subject to review r2's C1, I1 and I2, folded into Task 4; no round 3. The fallback fully removes the pair first.
