# R-214: site enumeration honours the build's preprocessor symbols Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r1 (2026-09-29), draft for the orchestrator's review.** Written by `lethal-preproc` (coord-only lane) on `lethal/lane-preproc` at `a22626ec`. No product code was written or prototyped. Every fact below marked "measured" was measured at plan time with the throwaway tools in `H:/lethal-scratch/R-214/plan/` (`$P` below). Task 1 turns the plan-time predictions into the committed PRE-COMMITMENT, alone, before any product code.

**Goal:** A mutant is never generated in a `#if` / `#elif` / `#else` arm that the build's preprocessor symbols compile out, and a statement directly inside a statement-level `#if` arm is a mutation site like any other statement.

**Architecture:** One pure evaluator in `@lethal/engine` (`evaluateArms`) walks a file's directive nodes in document order and returns the byte ranges the build compiles out. `generateMutationSet` drops every spec whose node starts in such a range, before any other filter. The effective symbol set is the config's `preprocessorSymbols` plus `app.json`'s own, with each file's `#define` / `#undef` applied, which is what `alc` does (measured). Separately, `isStatementPosition` treats a direct child of a `preproc_conditional_statement` that itself sits in a statement list as a statement position; that one change gives the lost sites back and gives their mutants statement reach grain (R342), with no `placeReach` hunk. `IDENTITY_SCHEME` moves from 3 to 4, because both halves move identity keys for unchanged source (measured).

**Tech Stack:** Bun, TypeScript, tree-sitter-al 4.4.1 through the native parser addon, `bun:test`, `alc` 18.0.41 (offline compile), al-runner (the symbol legs), BC container Cronus28 under a coord lease (bcdev, tables, chunked gates).

**Spec:** `H:/lethal-coord/tasks/R-214/task.md` (binding) and `H:/lethal-coord/tasks/R-214/audit.md` (measured state). Items: `docs/roadmap/R214.md`, `R285.md`, `R306.md`, `R342.md`, `R325.md` (the identity scheme rule), `R343.md`. The frozen gate this changes: `docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`.

---

## What was measured at plan time (`a22626ec`, 2026-09-29)

### What alc does with symbols (alc 18.0.41.45789, probe `$P/sym/`)

A codeunit with `#if <cond>` / `exit(1)` / `#else` / `exit(ELSE_ARM_ACTIVE)` / `#endif` compiles only when the `#if` arm is the one built, so a compile result names the active arm. No package cache is needed for such a codeunit.

| probe | result | what it means |
| --- | --- | --- |
| `#if FOO`, `/define:FOO` | compiles | baseline |
| `#if FOO`, `/define:foo` and `/define:Foo` | `#else` built | **symbol names are case-SENSITIVE** |
| `#if NOT FOO`, `#if FOO AND BAR` | as expected | keywords `not`, `and`, `or` are case-insensitive |
| `#if FOO && BAR`, `#if FOO \|\| BAR` | `AL0631` | alc rejects `&&` and `\|\|` (the grammar accepts them) |
| `#if FOO or BAR and BAZ`, `/define:FOO` | `#if` built | `and` binds tighter than `or` |
| `#if not FOO and BAR`, `/define:FOO` | `#else` built | **`not` binds to the next operand only**: `(not FOO) and BAR` |
| `#if CLEANSCHEMA25`, `#if CLEANSCHEMA1`, `#if CLEAN25`, `#if BC28`, no define | `#else` built | alc predefines no symbol |
| `app.json` `"preprocessorSymbols": ["FOO"]`, `#if FOO` | `#if` built | alc reads `app.json`'s symbols |
| same `app.json`, `/define:BAR`, `#if FOO and BAR` | `#if` built | the two lists are UNIONED |
| `#define FOO` at the top of the file | `#if FOO` built | a file-level define counts |
| `#undef FOO` at the top, `/define:FOO`, `#if not FOO` | `#if` built | a file-level undef removes a configured symbol |
| `#define foo`, `#if FOO` | `#else` built | the file-level define is case-sensitive too |
| `#if BAR` / `#define FOO` / `#endif` at the top, BAR undefined | `#else` built | a define in an inactive leading arm is not applied |

### What tree-sitter-al 4.4.1 does with the same conditions (`$P/cond.ts`, `$P/cond2.ts`)

A condition is the `condition` field of `preproc_if` and `preproc_elif`. Its node kinds are `identifier`, `preproc_parenthesized_expression`, `preproc_not_expression`, `preproc_and_expression` and `preproc_or_expression` (grammar rule `_preproc_expression`). `&&` and `||` appear as anonymous children of the and/or node. `#define X` and `#undef X` are the extras `preproc_define` and `preproc_undef`, one node each, symbol inside the node text.

**The grammar scopes `not` wider than alc does.** `#if not FOO and BAR` parses as `(preproc_not_expression (preproc_and_expression FOO BAR))`, that is `not (FOO and BAR)`; alc builds `(not FOO) and BAR`. `FOO and not BAR or BAZ` parses as `FOO and not (BAR or BAZ)`. An evaluator that trusted the tree would pick the wrong arm here with no error. The shape occurs 0 times in all four corpora (below), so the product refuses it by name (Decision 2) and an upstream issue is drafted under "Notes".

**Container shapes.** Every visible grammar rule that holds a directive marker holds `preproc_if` and `preproc_endif` as DIRECT children, except two where one chain crosses a node boundary: `preproc_split_if_then_begin_else_shared` (an `#if` with no `#endif` inside it) and `preproc_fragmented_else_tail` (an `#endif` with no `#if`). Hidden rules (`_pspb_*`, `_preproc_*`) inline their markers into the visible parent. So the evaluator walks markers in document order over the whole file, never per container (Decision 2).

### The repros and what master does with them

Hand-written, invented names. `$P/repro/<name>/` holds `app.json` (runtime 16, no dependency), the AL, and `symbol-sets.json`. Every repro compiles un-instrumented under every set (`$P/alc-plain.sh`, 25 of 25 builds, 0 errors). `p-r214`, `p-r285`, `p-r306`, `p-r306b` are the audit's repros (`H:/lethal-scratch/R-214/a/`), unchanged apart from dropping the `platform` / `application` keys so no package cache is needed.

| repro | shape | sets | master deployed |
| --- | --- | --- | ---: |
| `p-r214` | R214's own: a whole procedure in `#if CLEAN25` / `#else`, and a statement-level `#if CLEAN25` / `Helper(A);` / `#else` / `Helper(A + 1);` | `[]`, `[CLEAN25]` | 7 |
| `p-r285` | R285's split case label (`preproc_split_case_extended`), `#if FASTPATH` | `[]`, `[FASTPATH]` | 7 |
| `p-r306` | R306 case 3: `#if not SYM` around one assignment | `[]`, `[SYM]` | 5 |
| `p-r306b` | the same with an `#else` arm | `[]`, `[SYM]` | 6 |
| `p5-elif-nested` | `#if A` (holding a nested `#if B` / `#else`) / `#elif B` / `#else` | `[]`, `[A]`, `[B]`, `[A,B]` | 7 |
| `p6-define` | `#define LOCALSYM` and `#undef DROPSYM` at the top of the file | `[]`, `[DROPSYM]` | 2 |
| `p7-appjson` | `app.json` declares `APPSYM`; `#if APPSYM` / `#else` | `[]` | 2 |
| `p8-slot` | a `#if` in an un-braced `then` slot (`if X > 0 then #if SLOTSYM Helper(X) #else Helper(X + 1) #endif;`) | `[]`, `[SLOTSYM]` | 5 |
| `p9-undecided` | `#if not UA and UB` (the misparsed shape) | `[]`, `[UA]`, `[UB]` | 2 |
| `p10-case` | `#if Foo`, config `FOO` or `Foo` | `[]`, `[FOO]`, `[Foo]` | 2 |
| `p11-tier2` | a table and a codeunit: `Commit();` then `#if T2SYM` / `Rec.SetRange(Code, C);` / `Codeunit.Run(50013);` / `#else` / `Rec.Amt := 5;` / `Rec.Modify(true);` | `[]`, `[T2SYM]` | 7 (raw 8) |
| `fixtures/sandbox-symbols` | the R321 fixture | `[]`, `[LETHALA]`, `[LETHALB]` | 13 |

### The predictor, run on every repro (plan-time; Task 1 re-runs and commits it)

The predictor runs NO code of the fix. It is `$P/pp.ts` (a textual preprocessor that reads directive LINES, with its own condition parser that binds `not` tight as alc does), `$P/sites.ts` (master's real pipeline, one row per deployed mutant), and `$P/predict.ts` (the join). Decision 5 specifies it. Plan-time output, `$P/out/expect/`:

| repro | set | master | predicted (raw / deployed) | what changes |
| --- | --- | ---: | ---: | --- |
| `p-r214` | `[]` | 7 | 6 / 6 | minus L5 `empty-block` and L6 `return-value` (the `#if CLEAN25` procedure); plus L20 `void-method-call` (`Helper(A + 1)`, lifted); L20 `swap-additive` grain `enclosing` to `statement` |
| `p-r214` | `[CLEAN25]` | 7 | 5 / 5 | minus L10, L11 (the `#else` procedure) and L20 `swap-additive`; plus L18 `void-method-call`; **L22 `void-method-call` key ordinal 0 to 1** |
| `p-r285` | `[]` | 7 | 3 / 3 | minus L8 `empty-block`, L9 `remove-not`, L10 and L12 `void-method-call` (R285's four); **L19 and L22 `void-method-call` ordinal 1 to 0** |
| `p-r285` | `[FASTPATH]` | 7 | 7 / 7 | none (the `#else` arm holds only case labels) |
| `p-r306` | `[]` | 5 | 6 / 6 | plus L9 `remove-assignment`; L9 `swap-additive` grain `unplaced` to `statement` |
| `p-r306` | `[SYM]` | 5 | 4 / 4 | minus L9 `swap-additive` |
| `p-r306b` | `[]` | 6 | 7 / 7 | plus L9 `void-method-call`, L10 `remove-assignment`; L10 `swap-additive` to `statement`; minus L12 `swap-additive` |
| `p-r306b` | `[SYM]` | 6 | 6 / 6 | minus L10 `swap-additive`; plus L12 `remove-assignment`; L12 `swap-additive` to `statement` |
| `p5-elif-nested` | `[]` | 7 | 6 / 6 | minus L11, L13, L16 `swap-additive`; plus L18 `void-method-call`, L19 `remove-assignment`; L18 `swap-additive` to `statement` |
| `p5-elif-nested` | `[A]` | 7 | 6 / 6 | minus L11, L16, L18; plus L9 `void-method-call`, L13 `remove-assignment`; L13 to `statement` |
| `p5-elif-nested` | `[B]` | 7 | 5 / 5 | minus L11, L13, L18; plus L16 `void-method-call`; L16 to `statement` |
| `p5-elif-nested` | `[A,B]` | 7 | 6 / 6 | minus L13, L16, L18; plus L9 `void-method-call`, L11 `remove-assignment`; L11 to `statement` |
| `p6-define` | `[]`, `[DROPSYM]` | 2 | 2 / 2 | plus L8 `void-method-call` (`LOCALSYM` from the file); minus L11 `swap-additive` (`DROPSYM` undefined by the file, even when configured) |
| `p7-appjson` | `[]` | 2 | 2 / 2 | plus L6 `void-method-call` (`APPSYM` from `app.json`); minus L8 `swap-additive` |
| `p8-slot` | `[]` | 5 | 5 / 5 | none (a slot-position `#if` is out of scope, Decision 1) |
| `p8-slot` | `[SLOTSYM]` | 5 | 4 / 4 | minus L9 `swap-additive` |
| `p9-undecided` | every set | 2 | 4 / 4 | undecided: EVERY arm kept; plus L5 and L8 `void-method-call`; L8 `swap-additive` to `statement`; one `preproc-arms-undecided` warning |
| `p10-case` | `[]`, `[FOO]` | 2 | 3 / 3 | `#if Foo` inactive (case-sensitive): plus L8 `void-method-call`; L8 `swap-additive` to `statement` |
| `p10-case` | `[Foo]` | 2 | 2 / 2 | plus L6 `void-method-call`; minus L8 `swap-additive` |
| `p11-tier2` | `[]` | 7 | 10 / 9 | plus L15 `remove-assignment`, L16 `void-method-call`; L15 `shift-integer` and L16 `swap-modify-flag` to `statement`; L10 `remove-commit` tag, ruled below |
| `p11-tier2` | `[T2SYM]` | 7 | 9 / 7 | minus L15, L16; plus L12 `remove-setrange` (Tier 2; its `void-method-call` twin is deduplicated away) and L13 `void-method-call`; L10 tag, ruled below |
| `sandbox-symbols` | `[]` | 13 | 9 / 9 | minus the L13 and L15 arms' four; L17 pair to `statement`; **L17 pair ordinal 2 to 0** |
| `sandbox-symbols` | `[LETHALA]` | 13 | 9 / 9 | minus L15, L17 pairs; L13 pair to `statement` |
| `sandbox-symbols` | `[LETHALB]` | 13 | 9 / 9 | minus L13, L17 pairs; L15 pair to `statement`; **L15 pair ordinal 1 to 0** |

`approxKeys` is 0 and `undecidedFiles` is 0 everywhere except `p9-undecided` (1, by design). One `ATTR` line (a kept mutant whose attribute the twin reads differently), in both `p11-tier2` sets: L10 `remove-commit`, master `plat=write-txn-codeunit-run`, twin `plat=-`. **Ruling:** `isConsumedCodeunitRun` (`write-txn-codeunit-run.ts:41`) treats a call as consumed when it is NOT in statement position. Master reads the bare `Codeunit.Run(50013);` inside the arm as consumed, which is the R214 under-claim again (a bare `Codeunit.Run` is measured NOT to abort, R72). After Task 4 it is a statement position in BOTH builds (that analysis reads the whole member, arms included), so the tag goes in both sets. The pre-commitment records `plat=-` for L10 in both.

**alc proof on the predictions** (`$P/poison.ts`, `$P/out/prove-*.txt`). For every repro and set, the source with every DROPPED mutant's span overwritten by the identifier `R214POISON` compiles (27 of 27 builds): each dropped span sat in code alc did not build. The control, one KEPT span poisoned, is rejected with `AL0118 ... 'R214POISON'` in 26 of 28 builds. The two that compile are `p9-undecided` under `[]` and `[UA]`, which is what "undecided keeps every arm" predicts: the kept span there is in the arm alc drops.

### Identity keys (`$P/keymoves.ts`)

The key is `astHash|object|procedure|operator|major` plus an ordinal among mutants sharing that tuple, in source order (`assignIdentityOrdinals`, `packages/schemata/src/project.ts:112`). With the source unchanged, the fix moves keys in both directions and from both halves:

- **Dropping arms renumbers.** `sandbox-symbols` `[LETHALB]`: L15 `return-value` goes from `...|Rate|lethal.return-value|1|1` to `...|Rate|lethal.return-value|1`, which is the exact key master gives L13's `return-value` in the `LETHALA` arm. The same for `swap-additive` (all three arms share one `astHash`, `78d263bd...`, because locals canonicalise to positional ids). `p-r285` `[]`: L19 and L22 move 1 to 0 and take the keys of the dropped L12 and L10.
- **Lifting statements renumbers.** `p-r214` `[CLEAN25]`: the new L18 `void-method-call` (`Helper(A)`) takes ordinal 0 and pushes L22's identical call to 1, so L22's old key now names L18.

### The corpora (not captured at plan time: corpus-sized)

| corpus | root (read-only; outputs go to `H:`) | `.al` files | files with `#if` | directive lines | `app.json` symbols | symbols the conditions name |
| --- | --- | ---: | ---: | ---: | --- | --- |
| DC | `U:/Git/DC/Cloud` | 1135 | 88 | 258 `#if`/`#elif` | `BC20` ... `BC27` | CLEAN27 (205), BC24 (27), BC25 (14), BC26 (4), BC22 (4), CLOUD (2), DC28UPGRADEFEATURE (1), CLEAN28 (1) |
| System Application | `U:/Git/BC.History/System Application` | 1718 | 54 | 109 | none | CLEAN28, CLEAN26, CLEAN27, CLEANSCHEMA31, 29, 27 |
| BusinessFoundation | `U:/Git/BC.History/BusinessFoundation` | 104 | 19 | 19 | none | CLEANSCHEMA27, CLEAN27, CLEAN28 |
| BaseApp | `U:/Git/BC.History/BaseApp` | 9620 | 666 | 2409 | none at the root | CLEAN26 to 29, CLEANSCHEMA25 to 31 |

No corpus has a compound condition (`and`, `or`, `&&`, `||`, parentheses): every condition is `SYM` or `not SYM`. No corpus has a `#define` or `#undef`. These are the same roots R-323 measured (`docs/superpowers/plans/2026-09-29-R-323-named-return.md`), where master's totals were DC 102584 / 97126, System Application 77291 / 75832, BusinessFoundation 3639 / 3573, full BaseApp 1775366 / 1687730 (raw / deployed, before R-323's own changes). Full BaseApp took 391 s and a 480 MB capture.

---

## Decisions

### 1. Scope: the two halves, and nothing else (confirmed, with one correction)

In scope: (a) no mutant in an arm the build compiles out, for every directive container the grammar has, because the evaluator walks MARKERS, not container kinds (so `preproc_conditional*`, `preproc_split_*` and `preproc_fragmented_*` are all covered by one rule, measured on `p-r285`'s `preproc_split_case_extended`); (b) a statement directly inside a `preproc_conditional_statement` that sits in a statement list is a statement position.

**Correction to the design:** `placeReach` (`packages/schemata/src/dispatch.ts:251`) needs NO new rule. Its P2 case (`dispatch.ts:280`) already places a statement-grain marker when `isStatementPosition(s)` holds, and `s` is the in-arm statement (`findEnclosingStatement`). The six `unplaced` mutants of R342 become `statement` from the `tree-walks.ts` hunk alone, predicted on `sandbox-symbols` and `p-r306`. Adding a `dispatch.ts` hunk would be a second implementation of one fact. R342 still closes: `fixtures/sandbox-symbols` joins `reach-grain-fixtures.test.ts`, which is the red-check of the `tree-walks.ts` hunk.

**Not in scope, listed so a reviewer can check nothing leaked in:** R304 (split `if ... then begin`), R287 C7, the `negate-guard` / `empty-block` split-`if` losses, R305 (`preproc_split_declaration`), R308, R339, R343 (typed operators in wrapped objects), R256 (baseline key), R293 (the harness's guard), R298 and R300 (line numbering). Also out, and filed by Task 8: a `#if` in a single-statement SLOT (`p8-slot`: its arm statements stay lost, as on master); member analyses that read inactive arms (the write-transaction and hang tags read the whole member); al-runner's predefined `CLEANSCHEMA1..25` (below); history across symbol sets (below); a `SessionReport` field for the compiled-out count (Decision 8).

### 2. The arm evaluator: markers in document order, alc's semantics, refuse the misparsed shape

`evaluateArms(root, symbols)` in a new `packages/engine/src/ast/preproc-arms.ts`:

- collects every `preproc_if`, `preproc_elif`, `preproc_else`, `preproc_endif`, `preproc_define` and `preproc_undef` node in document order, at any depth (the two cross-boundary rules above make a per-container walk wrong);
- keeps a stack of `{ outer, taken, active }` frames: `#if` pushes, `#elif` activates only when the outer region is active and no earlier arm was taken, `#else` likewise, `#endif` pops;
- evaluates a condition only when its outer region is active, so dead code can never refuse a file;
- applies `#define` / `#undef` only in an active region (measured: a define inside an inactive leading `#if` is not applied);
- compares symbols case-SENSITIVELY and reads keywords case-insensitively (measured; the question in the design was open, and alc answers it);
- returns the inactive byte ranges, from the end of the marker that closes the active region to the start of the marker that reopens it.

**An unrecognised shape fails SAFE, per file, and is named.** The evaluator returns `{ kind: "undecided", reason }` for: a `not` whose operand is an unparenthesised `and` / `or` (the tree scopes it wider than alc, measured); `&&` or `||` (alc rejects them, `AL0631`); any other condition node kind (`ERROR`, a missing identifier); an `#elif`, `#else` or `#endif` with no open `#if`, or an `#if` never closed; a `#define` / `#undef` that is not one bare symbol. Then `generateMutationSet` keeps EVERY arm of that file (master's behaviour) and warns `preproc-arms-undecided` naming the file, the reason and R214.

Why not fail loudly: the rule in CLAUDE.md is for caller-contract violations. An undecidable directive is a property of the user's source that alc may still compile (`not A and B` does), and a throw would stop a run that works today. Why not drop every arm: that silently loses active sites, the direction no filter downstream can recover (R214's own lesson). Keeping every arm is master's known over-claim, bounded to one named file, and it is R303's pattern: refuse the one thing, by name, keep the rest working. The corpora have 0 such files, and Task 1 pins that.

### 3. The symbols: config plus `app.json`, per file `#define` / `#undef`; absent means `[]`

**Correction to the design:** threading `cfg.preprocessorSymbols` alone is WRONG. alc unions `app.json`'s `preprocessorSymbols` with `/define` (measured), and DC's `app.json` declares `BC20` to `BC27`: DC's 48 `#if BC22/24/25/26` blocks are the arms its real build compiles. With the config list alone, the fix would DROP every one of them, the silent under-claim. So `generateMutationSet` reads `app.json` itself (from the source snapshot when it has one, else from `projectDir`; absent `app.json` means no `app.json` symbols, because several callers pass a `src` directory) and unions it with the option. A present but malformed `preprocessorSymbols` throws, naming the file.

**"Symbols not given" means `[]`.** `validatePreprocessorSymbols` (`cli.ts:2089`) already returns `[]` for an absent config key, and `ArtifactCompiler` then sends no `/define` (`artifact.ts:198`): the empty set IS the build LethAL compiles. A "keep every arm" default would re-open R214 for every caller that forgets the option. The cost is that existing tests which planted mutants in a `#if CLEAN27` arm under no symbols now see them dropped; Task 5 lists and rules each one.

Every caller, and what it passes:

| caller | passes | why |
| --- | --- | --- |
| `runSession` (`orchestrator.ts:4170`) | `cfg.preprocessorSymbols ?? []` | the same list the compile, the source hash (`:4152`) and the report receive |
| `lethal run --dry-run` (`printDryRun`, `cli.ts:3006`, called at `:5078`) | `validatePreprocessorSymbols(dryRunConfig?.preprocessorSymbols)` | a dry run must answer for the real run's scope (its own doc comment) |
| `scripts/campaign/compile-only.ts:54` | nothing (`[]`) | its alc step sends no `/define` either; making it read config symbols is a separate change (Task 8 files it) |
| `scripts/measure-gui-guarded.ts`, `measure-testpage-exclusive.ts`, `probe-alrunner-tables.ts` | nothing | fixture and measurement scripts with no directives; `[]` matches their compile |
| itests `bcdev`, `tables`, `envtool`, `growth`, `stale-publish`, `harden-fixture`, `al-runner` (sandbox-app count) | nothing | fixtures without directives, byte-identical (Task 6) |
| itest `al-runner` symbol legs | through `runSession` | `cfg.preprocessorSymbols` is the leg's set |
| unit tests | nothing, or the set a test names | see Task 5 |

`lethal campaign` and `lethal verify` reach generation only through `runSession`. `verify` never generates.

Not changed, and why: al-runner predefines `CLEANSCHEMA1` to `CLEANSCHEMA25` (R-319's decompile of 2.11.0, `docs/superpowers/plans/2026-09-28-R-319-server-symbols.md:39`); alc predefines nothing (measured). This plan follows alc, the authoritative backend. On al-runner a `#if not CLEANSCHEMA25` arm (35 in BaseApp) stays planted and compiled out, as on master. Task 8 files it; it needs its own measurement against the current al-runner.

### 4. `IDENTITY_SCHEME` 3 to 4 (R325's rule)

R325's rule: bump it with any change that can move an existing mutant's key for unchanged AL source. Measured above, three ways: `sandbox-symbols` `[LETHALB]` (L15's pair takes L13's keys), `p-r285` `[]` (L19 and L22 take the dropped L12 and L10's keys), `p-r214` `[CLEAN25]` (a lifted statement takes L22's key). So Task 2 bumps it first, with the CHANGELOG entry, the marks-file field, and R325's refusals (history, `--resume`, `--resume-run`, marks), exactly as R-323's Task 1 did.

**A consequence to record, not to fix here.** After the fix a key names a site WITHIN one build: `[LETHALA]`'s L13 `return-value` and `[LETHALB]`'s L15 `return-value` carry the same key text. `priorSurvivorKeys` (`store.ts:1183`) reads the latest finished run for the project with no symbol filter, so `--skip-known-survivors` after a run under another symbol set can skip a live mutant. This predates the fix (master already carried verdicts across builds, and a compiled-out `survived` could skip a live one), so it is filed (Task 8), not fixed.

### 5. The pre-commitment, and the predictor that produces it

Task 1 commits, alone, `docs/superpowers/specs/2026-09-29-r214-precommitment.md`, the lifted repros under `packages/runner/tests/fixtures/r214/`, and one expected capture per repro and set under `packages/runner/tests/fixtures/r214/expected/`. The expected captures are the predictor's output with the one hand ruling applied (L10, above). A difference later is a finding and a STOP, never an edit.

**The predictor, precisely.** Inputs: a project, one symbol set. It runs master's pipeline only (the fix is never built at Task 1).

1. `pp.ts <project> <set> <twin-dir> <regions.json>`: reads `app.json`'s `preprocessorSymbols` and unions the set. For each `.al` file holding `#if`, `#define` or `#undef`, walks LINES: a directive line is `^[ \t]*#[ \t]*(if|elif|else|endif|define|undef)\b`. Conditions are parsed from the line text by its own recursive-descent parser (`not` tightest, then `and`, then `or`; parentheses; symbols case-sensitive; keywords case-insensitive; a trailing `//` comment ignored). It refuses, as "undecided", exactly the shapes Decision 2 refuses (`&&`, `||`, `not <ident> and|or`, unbalanced markers); an undecided file is modelled as every arm active. It writes per file: `inactive` (byte ranges of non-directive lines in an inactive region), `lifted` (the byte ranges of the ACTIVE arms of every `preproc_conditional_statement` whose parent is `statement_block` or `code_block`, or a `preproc_conditional_statement` that is itself such, found with the unchanged parser), `blankedDirectives`, `undecided`, and a cross-check (`directiveLines` must equal the number of marker nodes, else exit 3: a directive inside a comment or string, or a mid-line directive). The twin is a copy of the project in which each `preproc_conditional_statement`'s directive lines and inactive-arm lines are overwritten with spaces, EOLs kept, so every offset is unchanged. There the active arm's statements sit directly in the `statement_block`, which master already handles: master on the twin IS the fixed engine's view of those arms.
2. `sites.ts <project> [--raw-out F --raw-files regions.json]` on the ORIGINAL (the BEFORE capture) and on each twin: master's `generateMutationSet`, then an offline `writeInstrumentedProject`, one row per DEPLOYED mutant: `file:line`, operator, `proc=`, `hang=`, the serialized identity key, `start-end`, `grain=`, `plat=`; header `raw N deployed M skippedFiles K`; raw (pre-dedup) rows for the directive files; the skipped list and `maxRSS_KB` on stderr.
3. `predict.ts <before> <twin> <regions> <before.raw> <twin.raw>`: per file, keep every BEFORE row whose start is in neither `inactive` nor `lifted`; add every TWIN row whose start is in `lifted`; renumber identity ordinals over the result per tuple in (file, start) order, as `assignIdentityOrdinals` does; raw = BEFORE raw, minus BEFORE raw rows in `inactive` or `lifted`, plus TWIN raw rows in `lifted`. It prints to stderr the counts `removed`, `added`, `approxKeys` (a lifted twin row whose span contains a blanked directive line: the twin's `astHash` is not the product's there; must be 0 or each one is ruled by hand) and `attrDiffs` (a kept row whose `proc`/`hang`/`grain`/`plat` differ from the twin's row at the same span: printed as `ATTR`, each ruled by hand in the spec, because the product's member analyses read inactive arms and the twin does not).
4. `keymoves.ts <before> <expected>`: every surviving row whose key moved.
5. Checking: an AFTER capture (`sites.ts --symbols <set>` on the branch) must equal the expected capture byte for byte, header included. The skipped list must be identical for files without a directive; for a directive file each skipped entry's site count may only fall.

The rule it encodes is the product rule stated independently: "a site starting in a compiled-out arm is gone; inside a statement-level active arm, a statement is a statement". It shares no code with `evaluateArms` (text lines against tree markers, its own condition parser against the tree's). What it cannot see, and says so: a slot-position `#if` (it follows the product's scope and does not lift those); member-wide analyses (the ATTR rulings).

**Corpora.** For each corpus, two sets, fixed now: `S0 = []` (the build LethAL compiles with no config; DC's effective set is its `app.json`'s `BC20` to `BC27`) and `S1` = every symbol the corpus's own conditions name that starts with `CLEAN` (DC: `CLEAN27, CLEAN28`; System Application: `CLEAN26, CLEAN27, CLEAN28, CLEANSCHEMA27, CLEANSCHEMA29, CLEANSCHEMA31`; BusinessFoundation: `CLEAN27, CLEAN28, CLEANSCHEMA27`; BaseApp: `CLEAN26, CLEAN27, CLEAN28, CLEAN29, CLEANSCHEMA25, CLEANSCHEMA26, CLEANSCHEMA27, CLEANSCHEMA28, CLEANSCHEMA29, CLEANSCHEMA30, CLEANSCHEMA31`). `S1` is the "next clean build" and flips every `#if CLEAN<n>` block. The spec pins per corpus and set: raw and deployed totals, the removed and added counts, the key-move count, the `ATTR` lines and their rulings, `undecidedFiles` (must be 0), `approxKeys` (must be 0), the SHA-256 of the expected capture, and the peak memory of each capture.

### 6. The R321 re-freeze: a new pre-commitment, then an owner-approved re-record

The frozen symbol legs contain compiled-out mutants scored `survived` (audit finding 3, and the old pre-commitment's own line 80). After the fix each build has 9 mutants, its own arm's two plus the seven outside the arms. The new tables (the verdicts of the surviving mutants do not move; the grain of the in-arm pair becomes `statement`, which scoring does not read for a killed mutant):

| line | operator | `[LETHALA]` | `[LETHALB]` | `[]` (`#else`, no gate leg) |
| ---: | --- | --- | --- | --- |
| 8 | `empty-block` | K | K | K |
| 9 | `remove-assignment` | K | S | S |
| 9 | `shift-integer` | K | S | S |
| 10 | `remove-assignment` | S | K | S |
| 10 | `shift-integer` | S | K | S |
| 11 | `remove-assignment` | S | S | K |
| 11 | `shift-integer` | S | S | K |
| 13 | `return-value` | K | (none) | (none) |
| 13 | `swap-additive` | K | (none) | (none) |
| 15 | `return-value` | (none) | K | (none) |
| 15 | `swap-additive` | (none) | K | (none) |
| 17 | `return-value` | (none) | (none) | K |
| 17 | `swap-additive` | (none) | (none) | K |
| | **killed / survived / no-coverage** | **5 / 4 / 0 over 9** | **5 / 4 / 0 over 9** | **5 / 4 / 0 over 9** |

`K` is killed by `Symbol Tests.RateSmall`, `S` is survived with no killing test. Codes are the dry run's order: M0001 to M0007 as before, then M0008 / M0009 are the build's own arm pair (L13 under `[LETHALA]`, L15 under `[LETHALB]`, L17 under `[]`). The builds now differ in WHICH mutants exist (two rows each) and, on the seven shared rows, pairwise on 4 verdicts.

**The red-checks, re-predicted.** (a) Dropping the daemon's `--define` (`AlRunnerServer.start`): LethAL still plants the configured arm (the enumeration reads the config), but the daemon compiles `#else`, where that arm is compiled out and `ForNone` is read. Both server legs print, under either set: L8 K, L9 S S, L10 S S, L11 K K, the arm pair S S: 3 killed / 6 survived. They fail the same four named equality assertions as before. (b) Dropping `buildAlRunnerArgv`'s `--define`: the one-shot leg prints the same 3 / 6 and fails `R321 one-shot [<set>]: per-mutant verdicts differ from the pre-committed table (...)`, the server legs fail equality, six failures in all. Both are now caught by the COUNT too (3 killed instead of 5), which the old tables could not do.

**Recording.** This moves a frozen figure (CLAUDE.md: killed 5 / survived 8 / no-coverage 0 over 13). The lane may not re-record on its own authority (lane runbook, "a moved frozen figure is reported, never re-recorded"). So Task 7 runs the gate in normal mode to show it fails only on the pre-committed rows, checkpoints for the owner, and only on an approving `coord answer` or `task.md` revision deletes the two baselines, records with `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1` (exit 3 by design), and re-runs to a pass. Never a hand edit. CLAUDE.md's figure moves to 5 / 4 / 0 over 9: the orchestrator edits CLAUDE.md, not the lane.

### 7. alc proof per build

For each lifted repro and `sandbox-symbols`, per set, on the branch after Task 5: (1) the instrumented project compiles (`$P/alc-emit.ts`: the real pipeline with the set, `writeInstrumentedProject`, `injectControlDependency`, the Control app's `.alpackages`, `alc /define:<set>`), which proves every kept mutant, marker and selector compiles in that build; (2) the poison proof on the AFTER capture: every mutant master had and the branch dropped, poisoned, compiles under that set (it sat in compiled-out code); (3) the control: one kept span poisoned is rejected with `AL0118` (it is built). `p9-undecided`'s control is expected to compile under `[]` and `[UA]`, the named over-claim. This mirrors `compile:fixtures --require-symbol-sets` (`scripts/compile-fixtures.ts:192`, one `alc` per declared set, `/define` omitted for the empty set).

### 8. Observability: two warnings, no report field

A dropped site must never be a silent shrink (the rule `generateMutationSet` states for declarative sites). So it warns `compiled-out-sites` once per run (total, file count, the symbols used, the first five files with counts) and `preproc-arms-undecided` once per undecided file. Warnings reach the console and the `--progress-out` stream, not the `SessionReport` JSON (R5's lesson). A report field ripples through `events.ts`, `report-fold.ts`, `report.ts`, the schemas and every committed sample report (CLAUDE.md), which is not the smallest fix. Task 8 files it; the orchestrator may rule it into this task instead (Open question 1).

### 9. Live gates

`itest:alrunner` (all legs; the symbol legs move as pre-committed, every other leg unchanged per mutant), then `itest:bcdev`, `itest:tables`, `itest:chunked` on Cronus28 under `coord lease Cronus28 preproc`, one at a time, heartbeat every 5 minutes, released right after. Their fixtures hold no directive and Task 6 proves them byte-identical offline, so any moved verdict there is a BLOCK. `itest:alrunner` needs no container.

---

## Global Constraints

- Plain English, short sentences, no em dashes anywhere (code comments included).
- Build loop, in this order: `LLVM_BIN="C:/Program Files/LLVM/bin" bun scripts/build-native-parser.ts` on a fresh worktree or after any change under `packages/engine/native/` (none planned); `bun run typecheck`; `rm -rf packages/*/dist` AFTER typecheck and BEFORE any `bun test`; `bun test` from the repo root (the preload hides the real home, R264). R335's known 5 s timeouts (`campaign-subcommands.test.ts`, `gate-receipt.test.ts`) must pass when run alone.
- `bunx biome check <touched files>` only; never `biome check .`.
- No `!` non-null assertions; `exactOptionalPropertyTypes` (`...(v !== undefined ? { k: v } : {})`); a typed error class extends `Error` directly; fail loudly on a caller-contract violation (a malformed `app.json` symbol list throws).
- `IDENTITY_SCHEME` is 4 from Task 2 on; nothing on this branch carries moved keys under 3.
- The pre-commitment (Task 1) is committed alone before any product code. A capture that differs from it is a STOP and a report, never an edit of the expectation.
- Corpus captures run on `H:` (outputs under `H:/lethal-scratch/R-214/`), one at a time, nothing else heavy running, peak memory recorded. Full BaseApp runs alone; no crash, then memory, then speed.
- Never hand-edit a baseline. `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1` only after the owner approves (Decision 6). A moved frozen figure goes to the owner; CLAUDE.md is edited by the orchestrator.
- Containers: Cronus28 only, under `coord lease Cronus28 preproc`, heartbeat every 5 minutes, release right after, one gate at a time.
- Coord-only lane: replies go in `coord checkpoint --note`, `coord submit`, `coord ask`; merge `master` before each task; re-check the next free roadmap id immediately before writing one.
- Red-check every product hunk (the `mutation-red-checker` subagent): revert that hunk alone, confirm its named test goes red, restore, confirm green. Record both outputs.

## Review Focus

1. **A project whose `app.json` declares symbols** (DC: `BC20` to `BC27`). Expected: those arms are the build and stay mutated. Pinned by `p7-appjson` in Task 5 and by DC's `S0` count in Task 6.
2. **A symbol that differs from the config only in case** (`#if Foo`, config `FOO`). Expected: the arm is compiled out, as alc does. Pinned by `p10-case` in Task 5 and by `evaluateArms`'s case test in Task 3.
3. **A file-level `#define` / `#undef`, and one inside an inactive leading `#if`.** Expected: applied only where active. Pinned by `p6-define` in Task 5 and by the leading-arm unit test in Task 3.
4. **`#if not A and B`**, which the grammar reads as `not (A and B)`. Expected: never evaluated wrongly; the file keeps every arm and says why. Pinned by `p9-undecided` in Task 5 and the refusal unit test in Task 3.
5. **A mutant whose node starts in active code but contains an inactive arm** (a whole-body `empty-block`). Expected: kept, in every build. Pinned by `p-r214`'s L16 `empty-block` in both sets (Task 5) and by `evaluateArms`'s range test (the container's own start is active, Task 3).

---

## File structure

- Create `packages/engine/src/ast/preproc-arms.ts`: `evaluateArms`, `startsInInactiveArm`. One responsibility: which bytes a build compiles out.
- Modify `packages/engine/src/ast/tree-walks.ts:33` (`isStatementPosition`) and `packages/engine/src/index.ts` (export).
- Modify `packages/runner/src/orchestrator.ts`: `MutationSetOptions.preprocessorSymbols`, `appJsonSymbols`, the filter in `generateMutationSet`'s spec loop, the two warnings, and `runSession`'s call.
- Modify `packages/runner/src/cli.ts`: `printDryRun`'s `paths.preprocessorSymbols` and its caller.
- Modify `packages/schemata/src/project.ts:105` (`IDENTITY_SCHEME`), `CHANGELOG.md`, `fixtures/sandbox-harden/lethal.equivalent.json`, `docs/using-lethal-from-an-agent.md`.
- Modify `packages/runner/itest/symbol-fixture.ts` (tables), `fixtures/README.md` (§ sandbox-symbols).
- Tests: create `packages/engine/tests/ast/preproc-arms.test.ts`, `packages/runner/tests/r214-compiled-out.test.ts`; modify `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/reach-grain-fixtures.test.ts`, `packages/runner/tests/cli.test.ts`, `packages/runner/tests/symbol-fixture.test.ts`, and the scheme and preproc tests Tasks 2 and 5 name.
- Test data: create `packages/runner/tests/fixtures/r214/<repro>/` (11 repros) and `packages/runner/tests/fixtures/r214/expected/<name>.<i>.txt`.

---

### Task 1: The pre-commitment, committed alone

**Files:**
- Create: `docs/superpowers/specs/2026-09-29-r214-precommitment.md`
- Create: `packages/runner/tests/fixtures/r214/{p-r214,p-r285,p-r306,p-r306b,p5-elif-nested,p6-define,p7-appjson,p8-slot,p9-undecided,p10-case,p11-tier2}/` (copied from `$P/repro/`, each with `app.json`, its `.al` files and `symbol-sets.json`)
- Create: `packages/runner/tests/fixtures/r214/expected/<name>.<i>.txt` (one per repro and set, 25 files, plus `fixture-sandbox-symbols.0.txt`, `.1.txt`, `.2.txt`)

**Interfaces:**
- Produces: the expected captures Task 5's test compares against, in `sites.ts`'s row format (forward-slash paths, header `raw N deployed M skippedFiles K`), named `<name>.<set index>.txt` (the index, not the symbols: `FOO` and `Foo` collide on a case-insensitive file system, measured).
- Produces: the new R321 tables (Decision 6) that Task 7 transcribes into `symbol-fixture.ts`.

- [ ] **Step 1: Merge master, set up.** `git merge master`. Re-read `ls docs/roadmap/ | tail -3` (nothing is filed in this task). `P=H:/lethal-scratch/R-214/plan`. Confirm the tools' SHA-256 prefixes match the plan-time ones (`sites.ts 6f95c8b1`, `pp.ts b012da98`, `predict.ts 8a56b31a`, `poison.ts ab3f70cf`, `keymoves.ts 92d3bdf4`, `run-predict.sh 174d89d2`, `before.sh 50dc5da1`, `prove.sh a1e78e2c`); a tool that moved is re-reviewed before use and its new hash goes in the spec.

- [ ] **Step 2: Lift the repros.** Copy each `$P/repro/<name>/` into `packages/runner/tests/fixtures/r214/<name>/` without `.alpackages` or build output. Re-run `bash $P/alc-plain.sh <dir>` on every lifted directory. Expected: 25 builds, `errors=0` each.

- [ ] **Step 3: Repros and `sandbox-symbols` through the predictor, from the lifted copies.**

```bash
set -euo pipefail
P=H:/lethal-scratch/R-214/plan; R=$(pwd); F="$R/packages/runner/tests/fixtures/r214"
for d in "$F"/p*/; do n=$(basename "$d"); bash "$P/before.sh" "$n" "${d%/}"; bash "$P/run-predict.sh" "$n" "${d%/}"; done
bash "$P/before.sh" fixture-sandbox-symbols "$R/fixtures/sandbox-symbols"
bash "$P/run-predict.sh" fixture-sandbox-symbols "$R/fixtures/sandbox-symbols"
for d in "$F"/p*/; do bash "$P/prove.sh" "$(basename "$d")" "${d%/}"; done > "$P/out/prove-t1.txt"
bash "$P/prove.sh" fixture-sandbox-symbols "$R/fixtures/sandbox-symbols" >> "$P/out/prove-t1.txt"
```

Expected: every total and change equals the plan's repro table; `approxKeys 0` everywhere; `undecidedFiles 1` only for `p9-undecided`; the one `ATTR` pair in `p11-tier2`; `prove-t1.txt` has 28 `dropped ... COMPILES` and every `control` REJECTED except `p9-undecided` under `[]` and `[UA]`. Any other result is a STOP: report it, do not tune a tool to it.

- [ ] **Step 4: Write the expected files.** For each `$P/out/expect/<name>.<i>[<set>].txt`, copy to `packages/runner/tests/fixtures/r214/expected/<name>.<i>.txt`. Apply the one ruling by hand: in both `p11-tier2` files, L10 `lethal.remove-commit`'s last column `plat=write-txn-codeunit-run` becomes `plat=-`. Record every file's SHA-256 (after the ruling).

- [ ] **Step 5: The six gate fixtures and the two examples, BEFORE captures.** For `sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe` under `fixtures/`, and `gift-card credit-limit` under `examples/`: `bun $P/sites.ts <dir> > $P/cap/gate/<name>.txt`, `bun scripts/probe-fixture-hashes.ts <dir>/src > $P/cap/gate/<name>.hashes`, and confirm `grep -rlE '^\s*#\s*(if|define|undef)' <dir>` is empty. Expected: empty for all seven, so the expected capture of each IS its BEFORE capture. Record the header line of each.

- [ ] **Step 6: The corpora, one at a time.** For each corpus `c` in `dc sysapp bcf baseapp` (roots in the plan's corpus table), with nothing else heavy running:

```bash
set -euo pipefail
P=H:/lethal-scratch/R-214/plan; O=H:/lethal-scratch/R-214/corpus; mkdir -p "$O"
# $root is the corpus root, $s1 its S1 set (comma-separated, from Decision 5)
bun "$P/pp.ts" "$root" "" "$O/twin-$c-0" "$O/regions-$c-0.json"
bun "$P/sites.ts" "$root" --raw-out "$O/before-$c.raw" --raw-files "$O/regions-$c-0.json" > "$O/before-$c.txt" 2> "$O/before-$c.err"
for i in 0 1; do s=$([ $i = 0 ] && echo "" || echo "$s1")
  [ $i = 1 ] && bun "$P/pp.ts" "$root" "$s" "$O/twin-$c-1" "$O/regions-$c-1.json"
  bun "$P/sites.ts" "$O/twin-$c-$i" --raw-out "$O/twin-$c-$i.raw" --raw-files "$O/regions-$c-$i.json" > "$O/twin-$c-$i.txt" 2> "$O/twin-$c-$i.err"
  bun "$P/predict.ts" "$O/before-$c.txt" "$O/twin-$c-$i.txt" "$O/regions-$c-$i.json" "$O/before-$c.raw" "$O/twin-$c-$i.raw" > "$O/expect-$c-$i.txt" 2> "$O/predict-$c-$i.log"
  bun "$P/keymoves.ts" "$O/before-$c.txt" "$O/expect-$c-$i.txt" > "$O/keymoves-$c-$i.txt"
done
```

Record per corpus and set: BEFORE's header, the expected header, `removed`, `added`, `approxKeys`, `attrDiffs`, `undecidedFiles`, the `moves` line, each capture's `maxRSS_KB`, and the SHA-256 of `expect-$c-$i.txt`. STOP conditions: `pp.ts` exits 3 (a directive the tree does not see); `undecidedFiles` above 0; `approxKeys` above 0 without a per-row ruling; `attrDiffs` above 20 in one corpus (ask before ruling that many). BEFORE's totals are compared with R-323's recorded master totals as a sanity check only (R-323's own change sits between them).

- [ ] **Step 7: Rule every `ATTR` line.** For each, read the product analysis that sets the attribute (`hangCapable`: `packages/builtin-tier1/src/loop-hazard.ts`; `platformKillMechanism`: the operator's own tag function) and decide whether the product after Task 4 reads it as master does or as the twin does. Write the ruling per row in the spec and apply it to the expected capture (the capture's SHA-256 is recorded after the rulings).

- [ ] **Step 8: Write the spec.** `docs/superpowers/specs/2026-09-29-r214-precommitment.md`, sections: "What is pre-committed" (the rule of Decision 5 in five lines); "Symbols" (alc's measured semantics, the table above); "Repros" (the repro table, each expected file and its SHA-256, the `p11-tier2` ruling); "Gate fixtures" (the seven headers, byte-identical, and `sandbox-symbols` per set); "R321, new tables" (Decision 6's table, codes, killing test, the re-predicted red-checks); "Corpora" (Step 6's numbers per corpus and set, the `ATTR` rulings, the SHA-256s, stating the captures live on `H:` because they are too large and hold corpus source); "Identity scheme" (4, and the measured key moves); "What would count as a finding" (any capture that is not byte-identical to its expected file; any verdict or killing test off Decision 6's table; any gate-fixture byte that moves; a red-check red anywhere else, or not red); "Tools" (paths and SHA-256 of each `$P` tool). No corpus source text in the spec: files and members only, lines as positions.

- [ ] **Step 9: Commit ALONE, and checkpoint.**

```bash
git add docs/superpowers/specs/2026-09-29-r214-precommitment.md packages/runner/tests/fixtures/r214
git commit -m "spec(R214): pre-commitment: per-mutant sites per build for 11 repros, the gate fixtures, the corpora, and the R321 re-freeze, before any product code"
```

Then `coord checkpoint --task R-214 --wait review --note "pre-commitment <sha>"`. No product code until it is reviewed.

---

### Task 2: `IDENTITY_SCHEME` 4, before the engine changes (R325's rule)

**Why first.** Tasks 4 and 5 move keys for unchanged source (Decision 4). Every cross-session consumer must already refuse scheme-3 keys when that lands.

**Files:**
- Modify: `packages/schemata/src/project.ts:100-105`, `CHANGELOG.md`, `fixtures/sandbox-harden/lethal.equivalent.json`, `docs/using-lethal-from-an-agent.md:485`
- Test: `packages/runner/tests/resume.test.ts`, `packages/runner/tests/named-return.test.ts`, `packages/runner/tests/__snapshots__/report-equality.test.ts.snap`, and any test Step 1 names

**Interfaces:**
- Produces: `IDENTITY_SCHEME === 4`, read by `store.ts`, `resume.ts`, `report.ts`, `equivalence-marks.ts` as today.

- [ ] **Step 1: Know what the bump touches.** Set the constant to 4, then `bun run typecheck && rm -rf packages/*/dist && bun test > $P/logs/t2-scheme4.txt 2>&1`. Expected failures, and nothing else: `resume.test.ts` (the `PINNED` fingerprint, and `expect(IDENTITY_SCHEME).toBe(3)` near line 1781); `named-return.test.ts` (the two guards `expect(IDENTITY_SCHEME).toBe(3)` near lines 561 and 663, and the controls that relabel a record to scheme 3 and expect it carried); `report-equality` (the snapshot's `"identityScheme": 3`); `harden-fixture.test.ts` only if run (it reads the marks file). A failure anywhere else is a STOP: something reads the scheme as a literal.

- [ ] **Step 2: Update each by meaning.** `project.ts`, the doc comment gains: `4: R214, a mutant in an #if arm the build compiles out is no longer generated, and a statement directly inside a statement-level #if became a statement position (measured moves in the R-214 plan).` `resume.test.ts`: the new `PINNED` value from the red output, with the comment extended `It moved again for R214 (scheme 4; it was 4a8c47ac...288a under scheme 3).`; the guard reads `expect(report.identityScheme).toBe(IDENTITY_SCHEME)` as R-323 did for the 2 to 3 step. `named-return.test.ts`: its own comment says a later bump must revisit, not re-aim; its n14 project holds no directive, so its key text is unchanged under 4 and the collision it exercises still holds. So each guard becomes `expect(IDENTITY_SCHEME).toBeGreaterThanOrEqual(3)` with the comment `R214: n14 holds no directive, so its keys are identical under scheme 4; the tests still mean "an older scheme's record never reaches a current-scheme mutant".`, each "relabelled to scheme 3" control relabels to `IDENTITY_SCHEME` (and its title says "the current scheme"), and the refusal side keeps its literal 2. `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`; the diff must be that one line. `lethal.equivalent.json`: `"identityScheme": 4` (sandbox-harden holds no directive; Task 6 proves its keys byte-identical). `docs/using-lethal-from-an-agent.md`: the example reads 4. `CHANGELOG.md`, under `[Unreleased]` / `### Changed`, above the scheme 3 entry:

```markdown
- **Identity scheme 4** (R214): keys can move in any object that holds a `#if`. A mutant in an arm
  the build's preprocessor symbols compile out is no longer generated, and a statement directly
  inside a statement-level `#if` is now a mutation site, so twin mutants renumber. Existing marks
  files need `"identityScheme": 4` after re-checking each mark against a fresh report. History and
  resume from scheme-3 runs are refused by name (R325).
```

- [ ] **Step 3: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test`. `bunx biome check packages/schemata/src/project.ts packages/runner/tests/resume.test.ts packages/runner/tests/named-return.test.ts`.

- [ ] **Step 4: Red-check.** Revert the constant to 3 alone: `resume.test.ts`'s `PINNED` test and the snapshot go red; restore: green. Record in `$P/logs/t2-redcheck.txt`. (The scheme transition on a SAME-TEXT key is pinned in Task 5 Step 5, where the moved keys exist.)

- [ ] **Step 5: Commit.** `git commit -m "fix(R214): identity scheme 4; dropping compiled-out arms and lifting in-arm statements move keys for unchanged source (R325's rule)"`.

---

### Task 3: The arm evaluator (engine)

**Files:**
- Create: `packages/engine/src/ast/preproc-arms.ts`
- Modify: `packages/engine/src/index.ts` (export next to the `tree-walks` block)
- Test: `packages/engine/tests/ast/preproc-arms.test.ts`

**Interfaces:**
- Produces, exactly (Task 5 imports these names from `@lethal/engine`):

```ts
export type ArmEvaluation =
  | { readonly kind: "decided"; readonly inactive: readonly (readonly [number, number])[] }
  | { readonly kind: "undecided"; readonly reason: string };
export function evaluateArms(root: ALSyntaxNode, symbols: readonly string[]): ArmEvaluation;
export function startsInInactiveArm(
  inactive: readonly (readonly [number, number])[],
  offset: number,
): boolean;
```

- [ ] **Step 1: Write the failing tests.** `packages/engine/tests/ast/preproc-arms.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { evaluateArms, initParser, parseAL, startsInInactiveArm, wrapRoot } from "../../src/index";

beforeAll(async () => {
  await initParser();
});

/** The code lines (directive lines skipped) of `src` whose first non-blank byte is inside an
 *  inactive range, 1-based. A directive line is skipped because a range between two inactive arms
 *  runs across the `#elif` / `#else` between them, and no mutation site starts on one. */
function inactiveLines(src: string, symbols: readonly string[]): number[] | string {
  const r = evaluateArms(wrapRoot(parseAL(src)), symbols);
  if (r.kind === "undecided") return `undecided: ${r.reason}`;
  const out: number[] = [];
  let start = 0;
  src.split("\n").forEach((line, i) => {
    const code = line.trim() !== "" && !line.trimStart().startsWith("#");
    if (code && startsInInactiveArm(r.inactive, start + line.search(/\S/))) out.push(i + 1);
    start += line.length + 1;
  });
  return out;
}

const body = (directives: string): string =>
  `codeunit 50001 "P"\n{\n    procedure A(X: Integer)\n    begin\n${directives}\n    end;\n}\n`;

describe("R214: evaluateArms", () => {
  const chain = body("#if A\n        X := 1;\n#elif B\n        X := 2;\n#else\n        X := 3;\n#endif");
  test("#if / #elif / #else: the first true arm is built, and only it", () => {
    expect(inactiveLines(chain, [])).toEqual([6, 8]);
    expect(inactiveLines(chain, ["A"])).toEqual([8, 10]);
    expect(inactiveLines(chain, ["B"])).toEqual([6, 10]);
    expect(inactiveLines(chain, ["A", "B"])).toEqual([8, 10]);
  });

  test("symbols are case-sensitive, keywords are not (alc 18.0.41, measured)", () => {
    const src = body("#if Foo\n        X := 1;\n#endif\n#IF NOT Foo\n        X := 2;\n#ENDIF");
    expect(inactiveLines(src, ["FOO"])).toEqual([6]);
    expect(inactiveLines(src, ["Foo"])).toEqual([9]);
  });

  test("an arm nested in a compiled-out arm is compiled out whatever its own condition", () => {
    const src = body("#if A\n#if B\n        X := 1;\n#endif\n#endif");
    expect(inactiveLines(src, ["B"])).toEqual([7]);
  });

  test("and binds tighter than or; parentheses; not over one operand", () => {
    const src = body("#if A or B and C\n        X := 1;\n#endif\n#if not (A or B)\n        X := 2;\n#endif\n#if A and not B\n        X := 3;\n#endif");
    expect(inactiveLines(src, ["A"])).toEqual([9]);
    expect(inactiveLines(src, ["B"])).toEqual([6, 9, 12]);
  });

  test("a file-level #define and #undef count, and a define in a compiled-out leading arm does not", () => {
    const src = `#define LOCAL\n#undef DROP\n#if OUTER\n#define LATE\n#endif\n${body("#if LOCAL\n        X := 1;\n#endif\n#if DROP\n        X := 2;\n#endif\n#if LATE\n        X := 3;\n#endif")}`;
    expect(inactiveLines(src, ["DROP"])).toEqual([14, 17]);
    expect(inactiveLines(src, ["DROP", "OUTER"])).toEqual([14]);
  });

  test("a node that STARTS in active code but contains a compiled-out arm is not in a range", () => {
    const src = body("#if A\n        X := 1;\n#endif");
    const r = evaluateArms(wrapRoot(parseAL(src)), []);
    if (r.kind !== "decided") throw new Error("decided expected");
    expect(startsInInactiveArm(r.inactive, src.indexOf("begin"))).toBe(false);
    expect(startsInInactiveArm(r.inactive, src.indexOf("#if"))).toBe(false);
    expect(startsInInactiveArm(r.inactive, src.indexOf("X := 1"))).toBe(true);
  });

  test("the refusals: not over an unparenthesised and/or, && and ||, each named", () => {
    expect(inactiveLines(body("#if not A and B\n        X := 1;\n#endif"), [])).toMatch(/^undecided: .*not/);
    expect(inactiveLines(body("#if A && B\n        X := 1;\n#endif"), [])).toMatch(/^undecided: .*AL0631/);
    expect(inactiveLines(body("#if A || B\n        X := 1;\n#endif"), [])).toMatch(/^undecided: .*AL0631/);
  });

  test("a refused condition inside a compiled-out arm refuses nothing (it is never evaluated)", () => {
    expect(inactiveLines(body("#if A\n#if not B and C\n        X := 1;\n#endif\n#endif"), [])).toEqual([7]);
  });
});
```

- [ ] **Step 2: Run, expect red.** `bun test packages/engine/tests/ast/preproc-arms.test.ts`. Expected: FAIL, `evaluateArms` is not exported.

- [ ] **Step 3: Implement.** `packages/engine/src/ast/preproc-arms.ts`:

```ts
import type { ALSyntaxNode } from "./syntax-node";

/**
 * R214: which bytes of one file a build compiles out, given that build's preprocessor symbols.
 *
 * alc's rules, measured with alc 18.0.41 (docs/superpowers/plans/2026-09-29-R-214-...md): symbol
 * names are case-sensitive and keywords are not; `not` binds to the next operand, `and` tighter
 * than `or`; `&&` and `||` are rejected (AL0631); a `#define` or `#undef` counts where it sits in an
 * active region. The walk is over every directive node in document order, never per container:
 * `preproc_split_if_then_begin_else_shared` holds an `#if` whose `#endif` is outside it, and
 * `preproc_fragmented_else_tail` the reverse.
 *
 * A shape it cannot evaluate as alc does is `undecided`, never guessed: the caller keeps every arm
 * and names the file. `not A and B` is one: tree-sitter-al 4.4.1 parses it as `not (A and B)`.
 */
export type ArmEvaluation =
  | { readonly kind: "decided"; readonly inactive: readonly (readonly [number, number])[] }
  | { readonly kind: "undecided"; readonly reason: string };

const DIRECTIVE_KINDS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
  "preproc_define",
  "preproc_undef",
]);
const SYMBOL_DIRECTIVE = /^#[ \t]*(define|undef)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\/\/.*)?$/i;

/** Internal: never leaves `evaluateArms`. */
class UndecidedArm extends Error {}

function directivesOf(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_KINDS.has(n.rawKind)) {
      out.push(n);
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function holds(node: ALSyntaxNode | null, defined: ReadonlySet<string>): boolean {
  if (node === null) throw new UndecidedArm("a directive with no condition");
  switch (node.rawKind) {
    case "identifier":
      return defined.has(node.text);
    case "preproc_parenthesized_expression":
      return holds(node.namedChildren[0] ?? null, defined);
    case "preproc_not_expression": {
      const operand = node.namedChildren[0] ?? null;
      if (
        operand?.rawKind === "preproc_and_expression" ||
        operand?.rawKind === "preproc_or_expression"
      )
        throw new UndecidedArm(
          `"${node.text}": tree-sitter-al reads not over the whole and/or, alc binds not to the next operand`,
        );
      return !holds(operand, defined);
    }
    case "preproc_and_expression":
    case "preproc_or_expression": {
      if (node.children.some((c) => c.rawKind === "&&" || c.rawKind === "||"))
        throw new UndecidedArm(`"${node.text}": alc rejects && and || in a directive (AL0631)`);
      const [left, right] = node.namedChildren;
      const a = holds(left ?? null, defined);
      const b = holds(right ?? null, defined);
      return node.rawKind === "preproc_and_expression" ? a && b : a || b;
    }
    default:
      throw new UndecidedArm(`"${node.text}": a condition of kind ${node.rawKind}`);
  }
}

export function evaluateArms(root: ALSyntaxNode, symbols: readonly string[]): ArmEvaluation {
  const defined = new Set(symbols);
  const frames: { outer: boolean; taken: boolean; active: boolean }[] = [];
  const inactive: [number, number][] = [];
  const active = (): boolean => frames.at(-1)?.active ?? true;
  let closedAt: number | null = null;
  try {
    for (const d of directivesOf(root)) {
      const before = active();
      if (d.rawKind === "preproc_define" || d.rawKind === "preproc_undef") {
        if (!before) continue;
        const m = SYMBOL_DIRECTIVE.exec(d.text.trim());
        if (m === null) throw new UndecidedArm(`"${d.text}": not a #define or #undef of one symbol`);
        const [, verb = "", name = ""] = m;
        if (verb.toLowerCase() === "define") defined.add(name);
        else defined.delete(name);
        continue;
      }
      if (d.rawKind === "preproc_if") {
        const v = before && holds(d.childForFieldName("condition"), defined);
        frames.push({ outer: before, taken: v, active: v });
      } else {
        const f = frames.at(-1);
        if (f === undefined) throw new UndecidedArm(`${d.rawKind} with no open #if`);
        if (d.rawKind === "preproc_elif") {
          const v = f.outer && !f.taken && holds(d.childForFieldName("condition"), defined);
          f.active = v;
          f.taken = f.taken || v;
        } else if (d.rawKind === "preproc_else") {
          f.active = f.outer && !f.taken;
          f.taken = true;
        } else {
          frames.pop();
        }
      }
      const after = active();
      if (before && !after) closedAt = d.endIndex;
      else if (!before && after && closedAt !== null) {
        inactive.push([closedAt, d.startIndex]);
        closedAt = null;
      }
    }
    if (frames.length > 0) throw new UndecidedArm("an #if with no #endif");
  } catch (err) {
    if (err instanceof UndecidedArm) return { kind: "undecided", reason: err.message };
    throw err;
  }
  return { kind: "decided", inactive };
}

/** Whether `offset` lies inside one of `evaluateArms`'s inactive ranges. ponytail: linear over a
 *  file's ranges (a few dozen at most in BaseApp); a binary search if a file ever holds thousands. */
export function startsInInactiveArm(
  inactive: readonly (readonly [number, number])[],
  offset: number,
): boolean {
  return inactive.some(([from, to]) => from <= offset && offset < to);
}
```

Export from `packages/engine/src/index.ts`: `export { evaluateArms, startsInInactiveArm } from "./ast/preproc-arms";` and `export type { ArmEvaluation } from "./ast/preproc-arms";`.

- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/engine`. `bunx biome check packages/engine/src/ast/preproc-arms.ts packages/engine/src/index.ts packages/engine/tests/ast/preproc-arms.test.ts`.

- [ ] **Step 5: Red-check each part alone** (`mutation-red-checker`), recording in `$P/logs/t3-redcheck.txt`: (a) the `not`-over-binary refusal removed: "the refusals" goes red; (b) `&&`/`||` refusal removed: the same test; (c) `before &&` removed from `preproc_if` (evaluate in dead code): "a refused condition inside a compiled-out arm" goes red; (d) the define branch's `if (!before) continue;` removed: the `#define` test goes red; (e) `f.taken = f.taken || v` replaced by `f.taken = v`: the `#elif` chain test goes red under `["A","B"]`; (f) `defined.has(node.text)` replaced by a lowercase comparison: the case test goes red.

- [ ] **Step 6: Commit.** `git commit -m "feat(R214): evaluateArms, which bytes a build compiles out, by alc's measured rules; refuses the shape tree-sitter-al scopes differently"`.

---

### Task 4: A statement directly inside a statement-level `#if` is a statement position (closes R342's cause)

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts:26-37`
- Test: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/runner/tests/reach-grain-fixtures.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `isStatementPosition(node)` true for a direct child of a `preproc_conditional_statement` that is itself in statement position; `isStatementSlot` follows (it calls it first).

- [ ] **Step 1: Write the failing tests.** In `tree-walks.test.ts`, a new describe:

```ts
describe("R214: a statement directly inside a statement-level #if", () => {
  const src = `codeunit 50001 "P"
{
    procedure A(X: Integer)
    begin
#if S
        Helper(X);
#if T
        X := 2;
#endif
#endif
        if X > 0 then
#if S
            Helper(X)
#endif
        ;
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;
  const callAt = (root: ALSyntaxNode, needle: string): ALSyntaxNode => {
    const at = src.indexOf(needle);
    const hit = findAll(root, ALNodeKind.procedure_call).find((n) => n.startIndex === at);
    if (hit === undefined) throw new Error(`no call at ${needle}`);
    return hit;
  };
  it("an arm of a #if in a statement list is a statement list, nested arms too", () => {
    const root = wrapRoot(parseAL(src));
    expect(isStatementPosition(callAt(root, "Helper(X);"))).toBe(true);
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    expect(isStatementPosition(assign)).toBe(true);
    expect(isStatementSlot(assign)).toBe(true);
  });
  it("an arm of a #if in a single-statement slot is not (out of R214's scope, unchanged)", () => {
    const root = wrapRoot(parseAL(src));
    const inSlot = callAt(root, "Helper(X)\n#endif");
    expect(isStatementPosition(inSlot)).toBe(false);
    expect(isStatementSlot(inSlot)).toBe(false);
  });
});
```

(The file already imports `findFirst`, `ALNodeKind`, `isStatementPosition` and `isStatementSlot`; add `findAll` from `../../src`. The file uses `it`, not `test`.)

In `reach-grain-fixtures.test.ts`, add `"fixtures/sandbox-symbols"` to `PROJECTS`. No other change here: until Task 5 the call passes no symbols and every arm is planted, which is the strongest check of this hunk (all 13 must have a grain). Task 5 Step 3b runs it per symbol set.

- [ ] **Step 2: Run, expect red.** `bun test packages/engine/tests/ast/tree-walks.test.ts packages/runner/tests/reach-grain-fixtures.test.ts`. Expected: the first new test FAILS (`false` for `Helper(X);`), the slot test passes (a pin), and the grain test FAILS listing six `sandbox-symbols` `unplaced` entries (`M0008` to `M0013`, lines 13, 15, 17).

- [ ] **Step 3: Implement.**

```ts
export function isStatementPosition(node: ALSyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.kind === ALNodeKind.statement_block || parent.kind === ALNodeKind.block) return true;
  // R214: an arm of a `#if` that sits in a statement list is itself a statement list. A `#if` in a
  // single-statement slot is not: only its first statement would fill the slot, so it stays out.
  return parent.rawKind === "preproc_conditional_statement" && isStatementPosition(parent);
}
```

Extend the doc comment above it by one paragraph saying the same, and naming the three consumers whose output this moves: `wrapIfSingleStatementSlot` (`compile.ts:676`, no `begin ... end` wrap for an in-arm statement, correct because the arm is a list), `placeReach`'s P2 (statement grain, R342), and `isConsumedCodeunitRun` (a bare in-arm `Codeunit.Run` is bare).

- [ ] **Step 4: Green where expected.** `bun test packages/engine packages/builtin-tier1 packages/builtin-tier2 packages/schemata`. The tree-walks tests pass. The grain test now passes for `sandbox-symbols` (the six are `statement`). List every OTHER red test in `$P/logs/t4-reds.txt`. Expected: only tests that pin emitted text or grain for a mutant inside a `preproc_conditional_statement` arm (candidates: `packages/schemata/tests/compile.test.ts`, `packages/builtin-tier2/tests/write-txn-codeunit-run.test.ts`). Rule each by meaning in the log: an emitted `begin ... end` around an in-arm statement that is no longer there, an `enclosing` grain that is now `statement`, or a write-transaction tag that is gone, is the pre-committed change and its expectation is updated with an `R214` comment; anything else is a STOP.

- [ ] **Step 5: Red-check.** Revert the hunk alone: the first tree-walks test and the grain test go red, restore, green. Record in `$P/logs/t4-redcheck.txt`.

- [ ] **Step 6: Commit.** `git commit -m "fix(R214, R342): a statement directly inside a statement-level #if is a statement position; the six unplaced sandbox-symbols mutants get statement grain"`.

---

### Task 5: `generateMutationSet` drops compiled-out sites; the symbols are threaded

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (`MutationSetOptions` near `:381`, `generateMutationSet` `:629-887`, `runSession` `:4170`)
- Modify: `packages/runner/src/cli.ts` (`printDryRun` `:2981-3012`, its caller `:5078`)
- Create: `packages/runner/tests/r214-compiled-out.test.ts`
- Modify: `packages/runner/tests/cli.test.ts` (the C02-06 describe at `:1983`), `packages/runner/tests/reach-grain-fixtures.test.ts` (per set), and the tests Step 6 names

**Interfaces:**
- Consumes: `evaluateArms`, `startsInInactiveArm` (Task 3).
- Produces: `MutationSetOptions.preprocessorSymbols?: readonly string[]`; warnings `compiled-out-sites` and `preproc-arms-undecided`; `printDryRun`'s `paths.preprocessorSymbols?: readonly string[]`.

- [ ] **Step 1: Write the failing runner test.** `packages/runner/tests/r214-compiled-out.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { type MutantManifest, writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * R214's pre-commitment (docs/superpowers/specs/2026-09-29-r214-precommitment.md), per repro and
 * per build: the deployed mutants, in the predictor's row format, must equal the committed file
 * byte for byte. A difference is a finding and a stop: never edit an expected file to match.
 */
const HERE = import.meta.dir;
const R214 = join(HERE, "fixtures", "r214");
const REPO = resolve(HERE, "../../..");

async function capture(projectDir: string, symbols: readonly string[]) {
  const warnings: { code: string; message: string }[] = [];
  const set = await generateMutationSet(projectDir, {
    preprocessorSymbols: symbols,
    emit: (e) => {
      if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
    },
  });
  const out = await mkdtemp(join(tmpdir(), "lethal-r214-"));
  try {
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "00000000-0000-0000-0000-000000000000",
      operatorTiers,
    });
    const m = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8")) as MutantManifest;
    const raw = set.files.reduce((n, f) => n + f.specs.length, 0);
    const rows = [...m.mutants]
      .sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.startLine - b.startLine ||
          a.operatorName.localeCompare(b.operatorName) ||
          a.startIndex - b.startIndex,
      )
      .map((e) =>
        [
          `${e.file.replaceAll("\\", "/")}:${e.startLine}`,
          e.operatorName,
          `proc=${e.procedureName === "" ? "<none>" : e.procedureName}`,
          `hang=${e.hangCapable ?? "-"}`,
          serializeKey(identityKeyOf(e)),
          `${e.startIndex}-${e.endIndex}`,
          `grain=${e.reachGrain ?? "-"}`,
          `plat=${e.platformKillMechanism ?? "-"}`,
        ].join("\t"),
      );
    const head = `raw ${raw} deployed ${m.mutants.length} skippedFiles ${set.skipped.length}`;
    return { text: `${[head, ...rows].join("\n")}\n`, warnings };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function setsOf(dir: string): Promise<string[][]> {
  return JSON.parse(await readFile(join(dir, "symbol-sets.json"), "utf8")) as string[][];
}

beforeAll(async () => {
  await initParser();
});

// Listed at module load (top-level await), so each repro is its own named test.
const CASES: [string, string][] = [
  ...(await readdir(R214))
    .filter((n) => n !== "expected")
    .map((n): [string, string] => [n, join(R214, n)]),
  ["fixture-sandbox-symbols", join(REPO, "fixtures", "sandbox-symbols")],
];

describe("R214: the pre-committed sites, per repro and per build", () => {
  test("every lifted repro is here (11) and has an expected file per set", async () => {
    expect(CASES).toHaveLength(12);
    for (const [name, dir] of CASES)
      for (const [i] of (await setsOf(dir)).entries())
        expect(await Bun.file(join(R214, "expected", `${name}.${i}.txt`)).exists()).toBe(true);
  });
  for (const [name, dir] of CASES) {
    test(`${name}: every build matches its expected capture`, async () => {
      const sets = await setsOf(dir);
      for (const [i, symbols] of sets.entries()) {
        const want = await readFile(join(R214, "expected", `${name}.${i}.txt`), "utf8");
        const got = await capture(dir, symbols);
        expect(`[${symbols.join(",")}]\n${got.text}`).toBe(`[${symbols.join(",")}]\n${want}`);
      }
    }, 60_000);
  }
});

describe("R214: every drop is named", () => {
  test("compiled-out sites are counted and the file is named", async () => {
    const { warnings } = await capture(join(R214, "p-r214"), []);
    const w = warnings.filter((x) => x.code === "compiled-out-sites");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("R214Probe.Codeunit.al (2)");
    expect(w[0]?.message).toContain("symbols: none");
  });

  test("an undecidable directive keeps every arm and says why, once per file", async () => {
    const { warnings } = await capture(join(R214, "p9-undecided"), ["UA"]);
    const w = warnings.filter((x) => x.code === "preproc-arms-undecided");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("Undecided.Codeunit.al");
    expect(w[0]?.message).toContain("R214");
    expect(warnings.some((x) => x.code === "compiled-out-sites")).toBe(false);
  });

  test("app.json's own preprocessorSymbols count, and a malformed list throws", async () => {
    const { text } = await capture(join(R214, "p7-appjson"), []);
    expect(text).toContain("AppSym.Codeunit.al:6\tlethal.void-method-call");
    expect(text).not.toContain("AppSym.Codeunit.al:8\tlethal.swap-additive");
  });
});
```

Add a fourth test in the second describe for the malformed list: write a temp project whose `app.json` has `"preprocessorSymbols": "APPSYM"` and one codeunit, and assert `generateMutationSet(dir)` rejects with `/app.json.*preprocessorSymbols/`. And in `cli.test.ts`'s C02-06 describe, a second test built exactly like the first (same `PassingBackend`, same `app.json`), whose `Logic.Codeunit.al` is:

```al
codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
#if X
        exit(Amount > Budget);
#else
        exit(Amount >= Budget);
#endif
    end;
}
```

with config `{ "preprocessorSymbols": ["X"] }`, asserting `report.mutants.some((m) => m.line === 6)` is true and `report.mutants.some((m) => m.line === 8)` is false. And a dry-run test in the same file: `printDryRun` over the same project with `paths.preprocessorSymbols: ["X"]`, capturing `console.log`, asserting the printed site count equals the count with `["X"]` from `generateMutationSet` and differs from the count with `[]`.

- [ ] **Step 2: Run, expect red.** `bun test packages/runner/tests/r214-compiled-out.test.ts packages/runner/tests/cli.test.ts`. Expected: every repro case FAILS with inactive-arm rows present; the warning tests FAIL; the `cli.test.ts` tests FAIL (line 8's mutants present).

- [ ] **Step 3: Implement in `orchestrator.ts`.** In `MutationSetOptions`:

```ts
  /**
   * R214: the build's preprocessor symbols as the config gives them (C02-06), the list the compile
   * step receives. `app.json`'s own `preprocessorSymbols` are added, because alc unions the two
   * (measured, alc 18.0.41), and each file's `#define` / `#undef` apply. A site in an arm that
   * build compiles out is not generated. Absent means `[]`: what alc builds with no `/define`, not
   * "keep every arm", which would re-open R214 for any caller that forgets it.
   */
  readonly preprocessorSymbols?: readonly string[];
```

Above `generateMutationSet`:

```ts
/** R214: `app.json`'s `preprocessorSymbols`. No `app.json` reads as none (callers pass a `src`
 *  directory); a malformed list throws, because alc would read something we did not. */
async function appJsonSymbols(
  projectDir: string,
  snapshot: ReadonlyMap<string, Buffer> | undefined,
): Promise<readonly string[]> {
  const path = join(projectDir, "app.json");
  const bytes = snapshot?.get("app.json");
  let text: string;
  if (bytes !== undefined) text = bytes.toString("utf8");
  else {
    try {
      await access(path);
    } catch {
      return [];
    }
    text = await readFile(path, "utf8");
  }
  const raw = (JSON.parse(text.replace(/^\uFEFF/, "")) as { preprocessorSymbols?: unknown })
    .preprocessorSymbols;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string" || s === "")) {
    throw new Error(
      `${path}: "preprocessorSymbols" must be an array of non-empty strings, got ${JSON.stringify(raw)}`,
    );
  }
  return raw as string[];
}
```

In `generateMutationSet`, after `ctx` is built: `const buildSymbols = [...new Set([...(await appJsonSymbols(projectDir, snapshot)), ...(options.preprocessorSymbols ?? [])])];` and `const compiledOut: { file: string; sites: number }[] = [];`. In the per-file loop, before `visit`:

```ts
    // R214: sites in an arm this build compiles out are not generated. An undecidable directive
    // keeps every arm of its file, named, rather than guessing which one alc builds.
    const arms = evaluateArms(root, buildSymbols);
    if (arms.kind === "undecided") {
      warn(
        "preproc-arms-undecided",
        `[lethal] ${rel}: a preprocessor directive could not be evaluated as alc does (${arms.reason}), so every #if arm in this file is kept, and a mutant in an arm this build compiles out can read survived. R214.`,
      );
    }
    const inactive = arms.kind === "decided" ? arms.inactive : [];
    let compiledOutHere = 0;
```

and as the first statement inside `for (const spec of op.generate(node, ctx)) {`:

```ts
            if (startsInInactiveArm(inactive, spec.before.startIndex)) {
              compiledOutHere++;
              continue;
            }
```

After `visit(...)`, before the R144 `declarativeInThisFile` block: `if (compiledOutHere > 0) compiledOut.push({ file: rel, sites: compiledOutHere });`. After the loop, before the `nonExecutableSites` warning:

```ts
  if (compiledOut.length > 0) {
    const total = compiledOut.reduce((n, f) => n + f.sites, 0);
    const listed = compiledOut.slice(0, 5).map((f) => `${f.file} (${f.sites})`);
    warn(
      "compiled-out-sites",
      `[lethal] ${total} site(s) in ${compiledOut.length} file(s) sit in #if arms this build compiles out (symbols: ${buildSymbols.length > 0 ? buildSymbols.join(", ") : "none"}), so no mutant was generated there (R214): ${listed.join(", ")}${compiledOut.length > 5 ? ", ..." : ""}.`,
    );
  }
```

Import `evaluateArms`, `startsInInactiveArm` from `@lethal/engine` and `access` is already imported. In `runSession`'s call (`:4170`), add `preprocessorSymbols: sourceSymbols,`.

- [ ] **Step 3b: The grain test per build.** In `reach-grain-fixtures.test.ts`, run each project once per set of its `symbol-sets.json` when it has one, else once with `[]`:

```ts
    for (const rel of PROJECTS) {
      const setsPath = join(REPO, rel, "symbol-sets.json");
      const sets: readonly (readonly string[])[] = existsSync(setsPath)
        ? (JSON.parse(await readFile(setsPath, "utf8")) as string[][])
        : [[]];
      for (const symbols of sets) {
        const set = await generateMutationSet(join(REPO, rel), { preprocessorSymbols: symbols });
        // ... the existing body, unchanged, with `[${symbols.join(",")}]` added to the
        // `[GH-24 grain]` log line and to each `unplaced` entry ...
      }
    }
```

Import `existsSync` from `node:fs`. Expected: `sandbox-symbols` logs 9 mutants and `{"statement":9,"enclosing":0,"unplaced":0}` under each of its three sets.

- [ ] **Step 4: Implement in `cli.ts`.** `printDryRun`'s `paths` gains `/** R214: the config's symbols, so a dry run answers for the build the real run compiles. */ readonly preprocessorSymbols?: readonly string[];`, passed as `...(paths.preprocessorSymbols !== undefined ? { preprocessorSymbols: paths.preprocessorSymbols } : {})`. The caller at `:5078` adds `...(dryRunConfig?.preprocessorSymbols !== undefined ? { preprocessorSymbols: validatePreprocessorSymbols(dryRunConfig.preprocessorSymbols) } : {})`.

- [ ] **Step 5: The scheme transition on a same-text key.** In `r214-compiled-out.test.ts`, a describe `"R214: a scheme-3 record never reaches a scheme-4 mutant with the same key text"`, built on `named-return.test.ts`'s `storedRun` pattern (relabel a stored run's `identity_scheme`, recompute its fingerprint with `identityScheme: 3`) over a temp copy of `fixtures/sandbox-symbols` with `preprocessorSymbols: ["LETHALB"]` and a backend on which every mutant survives. Each test first asserts the L15 `return-value` key is `c9159b46...|Symbol Logic|Rate|lethal.return-value|1` with no ordinal (the full hash from `expected/fixture-sandbox-symbols.2.txt`), the key master gave L13 in the `LETHALA` arm. Then: `--skip-known-survivors` after a record relabelled to scheme 3 executes it and warns `identity scheme 3`; control, relabelled to `IDENTITY_SCHEME`, it is skipped as a known survivor. `--resume-run <id>` relabelled to 3 is refused naming `identity scheme 3`, `scheme 4` and `R325`.

- [ ] **Step 6: Know what the filter touches.** `bun run typecheck && rm -rf packages/*/dist && bun test > $P/logs/t5-reds.txt 2>&1`. Expected reds: only tests that call `generateMutationSet` on AL holding a `#if` and assert a mutant in an arm the no-symbol build compiles out (candidates: `preproc-instrumentation.test.ts`, `line-map.test.ts`, `named-return.test.ts`). Rule each in the log, never deleting a test: if its point is instrumenting that arm's shape (R-297, R-302, R303, R316), it passes the symbols that make that arm the build (`preprocessorSymbols: ["CLEAN27"]`), so the shape stays covered; if it only counted mutants, its expectation drops the compiled-out ones with an `R214` comment. More than 15 reds, or a red outside those three files, is a STOP.

- [ ] **Step 7: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test`. `bunx biome check` on every touched file.

- [ ] **Step 8: Red-check each hunk alone**, in `$P/logs/t5-redcheck.txt`: (a) the `startsInInactiveArm` drop removed: every repro case goes red (inactive rows back); (b) `appJsonSymbols` returning `[]` always: `p7-appjson` and the `app.json` test go red; (c) `runSession`'s `preprocessorSymbols: sourceSymbols` removed: the new `cli.test.ts` session test goes red; (d) the dry-run threading removed: the dry-run test goes red; (e) the undecided warning removed: its test goes red; (f) the compiled-out warning removed: its test goes red; (g) `IDENTITY_SCHEME` set back to 3: the Step 5 history test goes red while its control stays green.

- [ ] **Step 9: Commit.** `git commit -m "fix(R214): generateMutationSet drops sites in #if arms the build compiles out (config plus app.json symbols, per-file #define/#undef); named warnings; symbols threaded through runSession and --dry-run"`.

---

### Task 6: Offline proof against the pre-commitment

**Files:** scratch only (`$P`, `H:/lethal-scratch/R-214/corpus/`). On the branch with Tasks 2 to 5 committed.

- [ ] **Step 1: Repros and `sandbox-symbols`.** `bun test packages/runner/tests/r214-compiled-out.test.ts` is green (it IS the per-mutant comparison). Also capture each with `bun $P/sites.ts <dir> --symbols <set>` into `$P/cap/after/` and `cmp` against the committed expected file. Expected: identical, all 28.

- [ ] **Step 2: alc per build.** Write `$P/alc-emit.ts` from R-323's `alc-all.ts` recipe (`C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323/alc-all.ts`), repointed to this worktree, taking one explicit set instead of every subset: `generateMutationSet(dir, { preprocessorSymbols })`, `writeInstrumentedProject`, copy the files with no mutant, `injectControlDependency`, the Control app and its `.alpackages` from `U:/Git/LethAL/extensions/lethal-control`, then `alc /define:<set>` (omitted for `[]`). Run it for every repro and set and for `sandbox-symbols`. Then `bash $P/prove.sh` with the AFTER captures in place of the predictions. Expected: every instrumented build `exit=0 app=true`; every `dropped` COMPILES; every `control` REJECTED except `p9-undecided` under `[]` and `[UA]`. Any other result is a STOP.

- [ ] **Step 3: Gate fixtures byte-identical.** For the seven of Task 1 Step 5: the AFTER capture equals the BEFORE capture (`cmp`), `probe-fixture-hashes.ts` equals, and `diff -r` of the instrumented targets (built with `sites.ts`'s settings into two directories) is empty apart from `app.json`. Expected: all identical.

- [ ] **Step 4: Corpora, one at a time.** For each corpus and set: `bun $P/sites.ts "$root" --symbols "$s" > $O/after-$c-$i.txt 2> $O/after-$c-$i.err`, then `cmp $O/expect-$c-$i.txt $O/after-$c-$i.txt`, and the skipped check (identical for files without a directive, per-file counts only falling for directive files). Record peak memory. Expected: every `cmp` silent. Full BaseApp alone.

- [ ] **Step 5: Whole suite.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` from the root. Green (R335's timeouts aside, each passing alone).

---

### Task 7: The R321 re-freeze and the live gates

**Files:**
- Modify: `packages/runner/itest/symbol-fixture.ts` (the three tables and the header comment), `packages/runner/tests/symbol-fixture.test.ts` (the non-vacuity test), `fixtures/README.md` (§ sandbox-symbols, lines 342 to 347)
- Delete then re-record (after owner approval only): `packages/runner/itest/al-runner.symbols-lethala.baseline.json`, `al-runner.symbols-lethalb.baseline.json`

- [ ] **Step 1: Transcribe the pre-committed tables.** In `symbol-fixture.ts`, replace `EXPECTED_BY_SET` and `EXPECTED_NO_DEFINE` with Decision 6's table, and the header's "All three builds score 5 killed / 8 survived and each pair differs on 8 of 13 mutants" with "Since R214 each build has 9 mutants, 5 killed / 4 survived: the seven outside the arms plus its own arm's two. Two builds share seven rows and differ on 4 of their verdicts, and each has two rows the others lack, so a transport that compiled the wrong build fails on the rows AND on the count.":

```ts
export const EXPECTED_BY_SET: Readonly<Record<string, readonly SymbolRow[]>> = {
  "[LETHALA]": [k(8, EB), k(9, RA), k(9, SI), s(10, RA), s(10, SI), s(11, RA), s(11, SI), k(13, RV), k(13, SA)],
  "[LETHALB]": [k(8, EB), s(9, RA), s(9, SI), k(10, RA), k(10, SI), s(11, RA), s(11, SI), k(15, RV), k(15, SA)],
};

export const EXPECTED_NO_DEFINE: readonly SymbolRow[] = [
  k(8, EB), s(9, RA), s(9, SI), s(10, RA), s(10, SI), k(11, RA), k(11, SI), k(17, RV), k(17, SA),
];
```

In `symbol-fixture.test.ts`, the non-vacuity test becomes "non-vacuity: three builds, 9 mutants each, 5/4 each; seven shared rows differ pairwise on 4 verdicts; two rows each of their own":

```ts
  test("non-vacuity: three builds, 9 mutants each, 5/4 each, seven shared rows differing pairwise on 4", () => {
    const tables = [rowsOf("[LETHALA]"), rowsOf("[LETHALB]"), EXPECTED_NO_DEFINE];
    const key = (r: SymbolRow) => `${r.line}|${r.operatorName}`;
    for (const t of tables) {
      expect(t).toHaveLength(9);
      expect(t.filter((r) => r.verdict === "killed")).toHaveLength(5);
    }
    const shared = (x: readonly SymbolRow[], y: readonly SymbolRow[]) =>
      x.filter((r) => y.some((o) => key(o) === key(r)));
    const differ = (x: readonly SymbolRow[], y: readonly SymbolRow[]) =>
      shared(x, y).filter((r) => y.find((o) => key(o) === key(r))?.verdict !== r.verdict).length;
    const [ta, tb, tn] = tables;
    if (ta === undefined || tb === undefined || tn === undefined) throw new Error("missing table");
    expect([shared(ta, tb).length, shared(ta, tn).length, shared(tb, tn).length]).toEqual([7, 7, 7]);
    expect([differ(ta, tb), differ(ta, tn), differ(tb, tn)]).toEqual([4, 4, 4]);
  });
```

`fixtures/README.md`: the paragraph says 5 / 4 / 0 over 9 per build since R214, and "compiles out four of them" becomes "LethAL no longer generates the other builds' arm mutants (R214)". `bun test packages/runner/tests/symbol-fixture.test.ts` green. Commit: `test(R214): the sandbox-symbols tables per the R214 pre-commitment (9 mutants per build)`.

- [ ] **Step 2: Run the al-runner gate in normal mode.** `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner > $P/logs/t7-alrunner-1.txt 2>&1`, foreground. Read its first line (the al-runner build). Expected: the sandbox-app legs PASS per mutant (3 / 12 / 4, unchanged); every symbol leg's printed table equals Decision 6's column; the run fails ONLY on the committed baselines' comparison for the two symbol sets (they hold 13 rows). Anything else is a STOP.

- [ ] **Step 3: Owner checkpoint.** `coord checkpoint --task R-214 --wait owner --note "R321 re-freeze ready: frozen 5/8/0 over 13 moves to 5/4/0 over 9 per set as pre-committed (<spec sha>); gate run shows only the baseline comparison failing; approve deleting and re-recording al-runner.symbols-lethala/-lethalb.baseline.json?"`. Nothing below runs until an approving `coord answer` or `task.md` revision.

- [ ] **Step 4: Re-record, then pass.** `git rm packages/runner/itest/al-runner.symbols-lethala.baseline.json packages/runner/itest/al-runner.symbols-lethalb.baseline.json`; `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=... bun run itest:alrunner` (exits 3 by design, a failed receipt, never a pass); review each new baseline's diff against Decision 6 row by row; re-run without the variable: PASS. Commit: `test(R214, R321): re-record the two symbol baselines per the R214 pre-commitment (owner-approved <ref>)`.

- [ ] **Step 5: The red-checks of R321, re-run** (Decision 6): (a) delete the daemon's `--define` line in `AlRunnerServer.start`, run the gate, expect the server legs to print 3 killed / 6 survived and fail the four equality assertions; restore. (b) delete `buildAlRunnerArgv`'s `--define` loop, run in normal mode, expect the one-shot legs to fail against the table with 3 / 6 and six failures in all; restore. Record both in `$P/logs/t7-r321-redcheck.txt`.

- [ ] **Step 6: The container gates, one at a time.** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`; `coord lease Cronus28 preproc`; heartbeat every 5 minutes. Then `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`, `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked`, each foreground, each log in `$P/logs/`. Expected: each PASS against its committed baseline, per mutant (bcdev 3 / 12 / 4 with its pins; tables and chunked as frozen). Release the lease right after. A moved verdict is a BLOCK, reported to the owner.

---

### Task 8: Roadmap, and hand-off

**Files:** `docs/roadmap/R214.md`, `R285.md`, `R306.md`, `R342.md`, `R325.md`, new items, `ROADMAP.md` (generated).

- [ ] **Step 1: Close and narrow.** Mark `R214` `done (<Task 3 commit>..<Task 5 commit>)` with a closing section: the rule (alc's measured semantics; config plus `app.json`; per-file defines; undecided keeps the file's arms and says so), both halves, the scheme bump and its measured key moves, the per-corpus counts from the pre-commitment, the alc proofs, the red-checks, and the gates. `R342` `done (<Task 4 commit>)` (the `tree-walks.ts` hunk, `sandbox-symbols` in the grain test). `R285` `done (<Task 5 commit>)`: its four inactive-arm mutants are gone (the block-body `empty-block` loss it also records stays, pointed at R304's family). `R306`: status narrowed; case 1 is closed by R214, case 3's prediction was wrong (unplaced, not statement) and is now right (statement, since the Task 4 hunk), case 2 remains R300's. One line in `R325`: "Scheme 4: R214 (compiled-out arms, in-arm statements), measured key moves in the R-214 plan."

- [ ] **Step 2: File the follow-ups.** Re-check the next free id across every worktree and branch immediately before writing (`for w in U:/Git/LethAL-wt/*/ H:/LethAL-wt/*/; do ls "$w/docs/roadmap"; done | sort -u | tail -3` and `git for-each-ref refs/heads --format='%(refname:short)' | while read b; do git ls-tree --name-only "$b" docs/roadmap/; done | sort -u | tail -3`). File, one per id:
  1. al-runner predefines `CLEANSCHEMA1..25` and alc does not, so on al-runner a `#if not CLEANSCHEMA<n>` arm (n up to 25; 35 in BaseApp) is still planted and compiled out; measure against the current al-runner first.
  2. `--skip-known-survivors` reads the latest finished run with no symbol filter; since R214 a key names a site within one build, so a survivor from another symbol set can skip a live mutant (it could before too).
  3. A `#if` in a single-statement slot (`p8-slot`): its arm statements are still no sites.
  4. Member-wide analyses read compiled-out arms: the write-transaction tag and the hang tag (a consumed `Codeunit.Run` or a loop-counter write in a dropped arm still counts).
  5. The compiled-out count is a warning, not a `SessionReport` field (unless the orchestrator ruled it into this task).
  6. `scripts/campaign/compile-only.ts` compiles and enumerates with no config symbols.
  7. Upstream: tree-sitter-al scopes `not` over a following `and`/`or` (the note below).
- [ ] **Step 3: Regenerate and commit.** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, commit `roadmap(R214): done; R285, R342 done; R306 narrowed; follow-ups filed`.
- [ ] **Step 4: Report to the orchestrator** in the submit note: CLAUDE.md's `itest:alrunner` paragraph moves from "killed 5 / survived 8 / no-coverage 0 over 13" to "5 / 4 / 0 over 9 per set, since R214", and its sentence "R214's fix will need a new pre-commitment and a re-freeze here" is now history; the prose sweep of `README.md`, `docs/measurements/README.md` and `.claude/skills/live-gate/SKILL.md` for the old figure (lines found by `grep -rn "5 / 8\|5/8\|over 13" README.md docs/measurements/README.md .claude/skills`) is listed for the orchestrator where the lane may not edit. Then `coord submit`.

---

## Self-review

- **Spec coverage.** task.md's requirements: pre-commitment committed alone (Task 1), repros, gate fixtures, corpora as exact counts (Task 1 Steps 3, 5, 6; Decision 5); IDENTITY_SCHEME (Decision 4, Task 2, and Task 5 Step 5's same-text transition); the R321 re-freeze with a new pre-commitment and the record variable, never a hand edit (Decision 6, Task 7); alc proof per build (Decision 7, Task 6 Step 2); red-checks per hunk (Tasks 2 to 5, each a step); no site lost in the active arm (Task 4); no mutant in an inactive arm, every container kind (Task 3's marker walk, Task 5's filter, `p-r285` for a split container).
- **Placeholder scan.** The only values left open are ones a run produces and the spec then pins (corpus counts, new fingerprint, SHA-256s); each has the exact command that produces it and a STOP rule for a surprise.
- **Type consistency.** `evaluateArms` / `startsInInactiveArm` / `ArmEvaluation` (Task 3) are the names Task 5 imports; `preprocessorSymbols` is the option name in `MutationSetOptions`, `printDryRun`'s `paths`, the tests and the scratch `sites.ts`; expected files are `<name>.<i>.txt` in Task 1 and in Task 5's test.
- **Review Focus.** Each of the five lines has its test in Task 3 or Task 5, named there.

## Notes: upstream grammar observation (draft, not filed)

tree-sitter-al 4.4.1: `preproc_not_expression` is `seq('not', _preproc_expression)` with no precedence, so `#if not A and B` parses as `not (A and B)` and `#if A and not B or C` as `A and not (B or C)`. alc 18.0.41 binds `not` to the next operand (measured: `#if not FOO and BAR` with `/define:FOO` builds the `#else` arm, which only `(not FOO) and BAR` explains). Suggested fix: `prec(3, seq('not', _preproc_expression))`, above `and` (2) and `or` (1). Zero occurrences in the four corpora measured here. LethAL refuses the shape by name until the grammar changes, and the refusal should stay as a guard afterwards.

## Open questions for the orchestrator

1. Decision 8: is a warning enough for the compiled-out count, or should this task add a `SessionReport` field now (with the ripple CLAUDE.md lists)?
2. Decision 3 corrects the design: symbols are config plus `app.json`, not config alone. Confirm.
3. Decision 1 corrects the design: no `placeReach` hunk, because the `isStatementPosition` change already gives statement grain. Confirm.
4. Decision 6: the lane cannot re-record a frozen baseline on its own authority; Task 7 Step 3 asks for the owner's approval at that point. Confirm that is the intended route, or approve it in the task revision up front.
