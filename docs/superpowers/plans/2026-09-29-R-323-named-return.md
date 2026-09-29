# R-323: a named return value is a local of its member, so it hides a same-named global and types by its own declaration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r1 (2026-09-29), draft for the orchestrator's review.** Written in two commits on purpose, as R-302's was. The first commit holds the measurements, the decisions and the PRE-COMMITMENT (every expected mutant change per repro, per corpus and per fixture, raw and deployed separately, with the exact moved identity keys). The second commit adds the prototype check and the tasks, so git history shows the pre-commitment existed before any prototype of the fix.

**Goal:** In AL a named return value (`procedure P() Result: Integer`) is a local variable of `P`. It hides an object global of the same name, compared as AL compares names (case-insensitively). Today type resolution and receiver resolution do not see it, so a reference to it falls through to a same-named global (R323's `AL0133`), or resolves to nothing when there is no such global (lost sites and a missing hang tag). After this change the named return resolves to its own declared type in a plain procedure and in a split member whose arms agree (R-302's every-arm rule), is ambiguous in a split member whose arms disagree, and is unknown in a trigger (R330's rule for trigger header names).

**Architecture:** One engine change of meaning, in `packages/engine/src/semantic/symbol-table.ts`: `parseProcedure` indexes the named return as a local of its procedure, `parseSplitProcedure` adds it to each arm's declarations so the every-arm rule decides it, and `triggerLocalNames` counts it as a trigger header name. `semantic/receiver.ts`'s `classifyDeclaredType` learns to read a named return's type, since its declaration node is not a `variable_declaration`. `IDENTITY_SCHEME` moves from 2 to 3, because the change moves identity keys for unchanged source (measured below). No emission code changes.

**Tech Stack:** Bun, TypeScript, tree-sitter-al through the native parser addon, `bun:test`, `alc` (offline compile). No container is used for planning.

**Spec:** `docs/roadmap/R323.md`, `H:/lethal-coord/tasks/R-323/task.md`. Model and rules: `docs/superpowers/plans/2026-09-28-R-302-split-semantics.md` (the every-arm rule, "unindexed means unknown", the checker, R325's identity scheme). Siblings: `docs/roadmap/R302.md`, `R322.md`, `R325.md`, `R330.md`, `R331.md`.

---

## What was measured at plan time (master `bd491fd0`, 2026-09-29)

Every repro is hand-written with invented names. No corpus source is quoted here; corpus files and members are named, lines are cited only as positions. `$S` is `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323`. Every tool imports from `U:/Git/LethAL-wt/r323`.

| tool | what it does |
| --- | --- |
| `sites.ts`, `check-sites.ts`, `alc-all.ts`, `alc-plain.ts`, `identity-keys.ts`, `ptree.ts` | R-302's, repointed. `sites.ts` prints one row per deployed mutant (file:line, operator, `procedureName`, `hangCapable`, identity key, span) and a `raw N deployed M` header. `check-sites.ts` is R-302's final checker: rows join on (file, span, operator); `+`/`-` rows are consumed exactly once; a `k` row pins an exact old and new key; an `a` row pins the key a NEW mutant must carry; a `= raw N deployed M` line pins both totals. `alc-plain.ts` now passes the Control app's `.alpackages` as the package cache, so a page repro finds `System.app`. |
| `dump.ts` | the full tree (anonymous nodes and fields too) of a line range. Hand-written repros only. |
| `named-census.ts <dir>` | every named return (a `return_value` field) on a procedure, a split member or a trigger: kind, per-arm name and type, arm agreement, the object's same-named global (casing and type), whether the member is `#if`-wrapped, and how many body identifiers read the name. Also counts ERROR nodes that hold a `procedure` keyword. |
| `named-twin.ts <src> <out>` | the RESOLVE ORACLE. Writes a twin project in which each named return of a plain procedure, and of a split member whose arms all agree on name and type, is moved into the member's local `var` section: the name is overwritten with spaces in the header (the `: <type>` stays, so the return type is unchanged), and `<name>: <type>;` is inserted after the member's `var` keyword, or as `var <name>: <type>;` just before `begin`, on the same line. Every line number is unchanged; each insert is logged (`EDIT`) with its original offset and length. Triggers and disagreeing split members are not rewritten; they are listed as `manual`. |
| `twin-diff.ts` | maps every twin span back to original offsets through the `EDIT` log, joins on (file, span, operator) exactly as `check-sites.ts` does, and writes the expectation (`+`, `-`, `k`, `a`, `=`) plus a back-mapped copy of the twin capture. It flags any difference outside a rewritten member (`OUTSIDE`) and any new mutant that carries an old mutant's key (`TAKES-OLD-KEY`). |
| `unknown-twin.ts` | the FAIL-SAFE ORACLE, for the decision only. In each member that has a named return AND a same-named global, every identifier spelling the name is overwritten with a same-length run of `Q`, so HEAD types those uses as nothing. Offsets are unchanged. |
| `span-diff.ts`, `counts.ts`, `summ.ts` | joins two same-offset captures; per-operator counts of an expectation (new, removed, hang-tag change, `k`, `a`); an expectation grouped by file and member. |

### What AL says a named return is (measured with `alc`)

- **It hides a same-named global, and `alc` types it by its own declaration.** Probe `$S/probe/tr`: a page trigger `OnFindRecord(Which: Text) Found: Boolean` beside a global `Found: Integer`, with the body line `Glob := Glob + Found;`. `alc` rejects it with `AL0175: Operator '+' cannot be applied to operands of type 'Integer' and 'Boolean'`: inside the trigger, `Found` is the `Boolean` named return, not the `Integer` global.
- **Triggers can have one.** The same probe: `alc` accepts the named return on a page trigger (the only error is the deliberate one above). The grammar parses it with the same `return_value` and `return_type` fields as a procedure.
- **Interfaces and events are not relevant.** An interface member has no body, so nothing inside it is resolved, and `interface` is not an object kind the symbol table indexes. An event publisher cannot return a value, and a subscriber must match its publisher, so neither has a named return. Not measured further.
- **A named return inside a `#if` in one header compiles, and the grammar cannot parse it.** Repro `n10-if-header`: `procedure Pick(X: Integer)` then `#if CLEAN27` / `Result: Text` / `#else` / `Result: Integer` / `#endif` on their own lines, then the body. `alc` passes under `[]` and `[CLEAN27]` (`alc-plain.ts`). tree-sitter-al makes the whole member an `ERROR` node, so master emits NO mutant anywhere in that file (0 raw, 0 deployed). This is not R323's bug and no fix here can reach it; it is drafted as an upstream grammar issue under "Notes". The census counts ERROR nodes holding a `procedure` keyword: 0 in every corpus and fixture.

### The grammar (measured with `dump.ts`)

A plain procedure's named return is a direct child `identifier` with field `return_value`, followed by `:` and a `type_specification` with field `return_type`. A trigger (`trigger_declaration`) has the same two fields. In a split member (`preproc_split_procedure`, `preproc_split_procedure_preamble`) each arm carries its own `return_value` and `return_type` among the arm's children, so `memberArms` already separates them. Master reads `return_type` (`parseProcedure`, `procedureLikeReturnType`, `return-value.ts`) and never reads `return_value`, except in `packages/runner/src/testpage-scan.ts`, which already scopes a named return as a variable of its procedure (the TestPage scan, not the mutation pipeline).

### The class: every place a name is resolved

R-302's lesson was that each review round found another path in the same bug class. So this is every place master turns an identifier into a declaration, and what each does with a named return today:

| # | place | reached by | today, named return with a same-named global | today, with no such global |
| --- | --- | --- | --- | --- |
| 1 | `resolveIdentifierType` (`semantic/types.ts`), plain procedure | `swap-additive`, `swap-call-arguments` (through `computeType`) | types by the GLOBAL (n1, n2): `alc`-failing swap | `null`: sites lost (n4) |
| 2 | the same, inside a split member (`parseSplitProcedure`) | same | types by the global (n5, n6, n7, n8) | `null` |
| 3 | the same, inside a trigger (`triggerLocalNames` guard) | same | types by the global (n9) | `null` (no change needed) |
| 4 | `memberType` and `callType` (`types.ts`) | `Result.Field + X`, `Result.Proc() + X` | through place 1 | `null`: sites lost (n13's `R.Amt + Glob`) |
| 5 | `lookupVar` (`semantic/receiver.ts`), procedure path | every Tier-2 claim (`claimsRecordMethod`, `resolveReceiverTable`), and every Tier-1 cession that asks whether Tier 2 claims (`flip-boolean-literal`'s `Modify(true)`, `void-method-call`'s precedence) | resolves to the GLOBAL (n12: `validate-to-assign` rewrites a codeunit call into `R.N := 5`, `AL0132`) | `null`: no claim, so `void-method-call` keeps the span (n13) |
| 6 | `lookupVar`, trigger path (`triggerScopeVar`, then `triggerLocalNames`) | same | resolves to the global | `null` (no change needed) |
| 7 | `resolveVarRef` (`semantic/resolve-var-ref.ts`, a thin wrapper over `lookupVar`) | the hang tag (`loop-hazard.ts`: `remove-assignment`, `shift-integer`, `swap-additive`, `flip-boolean-literal`) | the target and the loop condition both resolve to the global, so the tag appears by coincidence (n11b) | `null`: the classifier refuses, so a loop counter's `remove-assignment` has NO hang tag (n11) |
| 8 | `classifyDeclaredType` (`receiver.ts`) | place 5, after the declaration is found | reads `declaration.node.childForFieldName("type")`, which a named return's node does not have | the fix must teach it, or place 5 finds the declaration and still refuses (Decision 4) |
| 9 | a member the table does not index (`#if`-wrapped, or swallowed; R327, R330, R331) | places 1, 5 | `resolveProcedureAt` is `null`, so nothing resolves | already unknown; no change |
| 10 | the partial-header `#if` (n10) | none | the member is an ERROR node; no mutant in the file | same; out of reach (upstream) |

Not in the class, checked: `return-value.ts` reads `return_type` only (unchanged by a name); `callers.ts` names the enclosing member; `schemata/src/dispatch.ts` already handles "plain or named return" when it places emitted text; `swap-rec-xrec.ts` walks to a trigger for `Rec`/`xRec` only.

### Census (`named-census.ts`)

| corpus | files | named returns | plain | split (agree / partial) | trigger | `#if`-wrapped (unindexed) | same-named global: same type / other type | read in the body |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DC/Cloud (`U:/Git/DC/Cloud`) | 1135 | 516 | 516 | 0 | 0 | 3 | 4 / 0 | 418 |
| System Application | 1718 | 372 | 372 | 0 | 0 | 0 | 0 / 0 | 341 |
| BusinessFoundation | 104 | 34 | 34 | 0 | 0 | 0 | 0 / 0 | 33 |
| BaseApp scratch project (`$S/ba-split`, R-302's 4 files) | 4 | 9 | 4 | 4 / 1 | 0 | 1 | 0 / 0 | 9 |
| full BaseApp (`U:/Git/BC.History/BaseApp`) | 9620 | 3804 | 3753 | 4 / 1 | 46 | 19 | 15 / 0 | 3713 |
| `fixtures/sandbox-coverage-probe` | 3 | 5 | 5 | 0 | 0 | 0 | 0 / 0 | 5 |
| every other fixture, `sandbox-symbols` included | | 0 | | | | | | |

So R323's hazard shape (a same-named global of ANOTHER type) occurs 0 times in every corpus, as R323 guessed. The size of the change comes from the other side: 4,700 named returns with no such global, most of them read in their body, which master cannot type today. The 19 same-type globals (DC: `OptionCount` twice, `GetRandomCompanyCode`, `TestConnection`; BaseApp: 15 members, for example `SalesHeader.Table.al`'s `ConfirmKeepExistingDimensions`) type correctly on master by coincidence. The 46 BaseApp triggers and the one partial split member (`PageManagement.Codeunit.al`'s `GetSalesHeaderPageID`, a named return in arm 1 only) have no same-named global.

### The repros (`$S/repro/<name>/`) and what master does with them

Each has the R-303 repro `app.json` (runtime 16). Every repro compiles UN-instrumented under every symbol subset (`alc-plain.ts`, 16 of 16 projects). "master alc" is `alc-all.ts` on master's instrumented project, every subset (`$S/logs/alc-head-<name>.log`).

| repro | shape | master deployed | master alc |
| --- | --- | --- | --- |
| `n1-named-return-global` | R323's evidence: plain `Pick(X: Integer) Result: Text`, global `Result: Integer`, `Show(X, Result)` with overloads `(Integer; Integer)` and `(Integer; Text)` | 9, with a `swap-call-arguments` at L6 | FAIL `AL0133` |
| `n2-case-global` | `n1` with the global spelled `result` | 9, the same swap | FAIL `AL0133` |
| `n3-same-type-global` | named `Result: Integer`, global `Result: Integer` | 8, a swap at L6 that is RIGHT by coincidence | PASS |
| `n4-no-global` | named `Result: Integer`, no global; `Result := X + 1; Glob := Result + X; Show(X, Result);` | 9: no swap at L6 or L7 | PASS |
| `n5-split-both-arms` | `preproc_split_procedure`, both arms `Result: Text`, global `Result: Integer` | 9, the swap at L10 | FAIL `AL0133` under `[]` and `[CLEAN27]` |
| `n6-preamble-both-arms` | the preamble shape of `n5` (a `var` per arm) | 10, the swap at L15 | FAIL `AL0133` under both |
| `n7-split-one-arm` | arm 1 `Result: Text`, arm 2 unnamed `: Text` (`GetSalesHeaderPageID`'s shape), global `Result: Integer` | 7, the swap at L9 | FAIL `AL0133` under `[]` (arm 1); PASS under `[CLEAN27]` |
| `n8-split-arms-differ` | arm 1 `Result: Text`, arm 2 `Result: Integer`, global `Result: Integer` | 7, the swap at L9 | FAIL under `[]`; PASS under `[CLEAN27]` |
| `n9-trigger` | page trigger `OnFindRecord(Which: Text) Found: Boolean`, global `Found: Integer`, `Show(Glob, Found)` with overloads `(Integer; Integer)` and `(Integer; Boolean)` | 8, the swap at L9 | FAIL `AL0133` (`Boolean` to `Integer`) |
| `n10-if-header` | the partial-header `#if` above | 0 (ERROR node) | PASS (nothing to compile wrongly) |
| `n11-hang-no-global` | `Count() Result: Integer`, `while Result < 10 do Result := Result + 1;`, no global | 6: `remove-assignment` L7 with NO hang tag, no `swap-additive` at L7 | PASS |
| `n11b-hang-global` | `n11` plus a global `Result: Integer` | 7: L7's `remove-assignment` and `swap-additive` both tagged | PASS |
| `n12-receiver-codeunit` | `Make() R: Codeunit "Repro N12 Helper"` (which declares `Validate(F: Integer; V: Integer)`), global `R: Record "Repro N12 Tab"`, `R.Validate(N, 5)` | 8, with a `validate-to-assign` at L8 | FAIL `AL0132: 'Codeunit "Repro N12 Helper"' does not contain a definition for 'N'` |
| `n13-record-no-global` | `Load() R: Record "Repro N13 Tab"`, no global; `R.SetRange(Code, 'A'); Glob := R.Amt + Glob;` | 3: `void-method-call` at L5, nothing at L6 | PASS |
| `n14-overload-key-add` | `Pick(X) Result: Integer` with `Glob := Result + X`, then an overload `Pick(X; Y)` with a LOCAL `Result: Integer` and the same line | 5: the overload's `swap-additive` at L12 has ordinal 0 | PASS |
| `n15-overload-key-remove` | `n1`'s `Pick` then an overload `Pick(X; Y)` with a local `Result: Integer` and the same `Show(X, Result)` | 10: L5's wrong swap is ordinal 0, L12's right swap ordinal 1 | FAIL `AL0133` (L5's swap) |

### The corpora today, and the twin oracle

`$S/cap/head/` holds master's capture of every repro, DC/Cloud, System Application, BusinessFoundation, the BaseApp scratch project, full BaseApp and all six gate fixtures. Master's totals: DC/Cloud raw 102584, deployed 97126 (the numbers R-302's merge records); System Application 77291 / 75832; BusinessFoundation 3639 / 3573; BaseApp scratch 1568 / 1540; full BaseApp 1775366 / 1687730 (73 skipped files, 391 s, a 480 MB capture); `sandbox-app` 19 / 19; `sandbox-data` 407 / 387; `sandbox-hang` 40 / 40; `sandbox-harden` 22 / 21; `sandbox-coverage-probe` 86 / 80; `sandbox-symbols` 13 / 13.

The twin oracle runs master, unchanged, on a transformed copy in which each named return is an ordinary local. Master already resolves a local correctly (it hides the global, and types by its own declaration), so master's sites on the twin ARE the sites the "resolve" decision predicts. It runs no fix. Its self-check: `check-sites.ts` against master's capture and the back-mapped twin capture PASSES for every expectation below except the three rows added by hand (`n7`, `n8`, `n9`, which the twin does not model by design), and no difference falls outside a rewritten member except the two key renumberings that are the point (`$S/logs/selfcheck-all.txt`, `$S/logs/twin-diff-*.txt`).

### The fail-safe alternative, measured (`unknown-twin.ts`, `span-diff.ts`)

Treating a named return as unknown changes only members that have a same-named global (elsewhere master already answers `null`). On DC/Cloud (4 such members) it changes nothing: raw and deployed identical, no tag moved. On full BaseApp (15 such members) it REMOVES 4 correct `swap-call-arguments` mutants (`PurchaseHeader.Table.al` L4355, `SalesHeader.Table.al` L5144, L6799, L7565; each a same-type swap that compiles) and gains nothing. On the repros it would remove `n3`'s correct swap and `n11b`'s two hang tags, and it leaves `n4`, `n11` and `n13` as master has them.

---

## Decisions

### 1. Resolve the named return to its own declared type (not the fail-safe)

Evidence, in two lines: `alc` types a named return by its own declaration and hides the global with it (probe `tr`, `AL0175`), so resolving is what the compiler does; and on the corpora resolving ADDS 70 (DC), 7 (System Application) and 561 (full BaseApp) typed mutants and gives a hang tag back to 21, 6 and 55 existing mutants, while the fail-safe fixes the same zero corpus hazards and REMOVES 4 correct BaseApp mutants and every coincidental hang tag (`n11b`).

The fail-safe would also leave the 21 + 6 + 55 loop-counter mutants untagged (`n11`'s shape: a named return used as a loop counter, with no global, reads as not hang-capable today). A hang-capable mutant without its tag is the unsafe direction of R196. Resolving closes it; the fail-safe cannot, because it only ever answers `null`.

Resolving follows R-302's rules: every arm must agree (Decision 2), and a member the table does not index stays unknown (place 9 is unchanged: `resolveProcedureAt` answers `null` for it, so nothing inside it resolves at all).

### 2. Split members: the every-arm rule, unchanged

`parseSplitProcedure` already builds one declaration map per arm and resolves a name only when every arm declares it with the same type text; anything else is `ambiguous`, resolves to nothing and hides the global. The named return joins that per-arm map as one more declaration of the arm (not a parameter). So:

- both arms `Result: Text` (`n5`, `n6`, and BaseApp's four `OAuth20Setup` members): `Result` is a local of type `Text`;
- one arm names it and the other does not (`n7`, `GetSalesHeaderPageID`): ambiguous;
- arms name it with different types (`n8`): ambiguous.

The name comparison is the map's existing lowercase key, so `Result` in one arm and `RESULT` in another agree (AL compares names that way). Names that differ (`Result` and `Res`) are two names, each declared by one arm only, so both are ambiguous.

### 3. Triggers: a named return is a trigger header name, so it is unknown

R330 (run 002 and 003 fix rounds) made every name a trigger declares in its own header (its parameters, its `var` locals, a `#if` local) hide the globals: `resolveIdentifierType` types it as nothing and `lookupVar` resolves it to nothing, through `triggerLocalNames`. A named return is a header name of the trigger, so it joins that set, one condition in `triggerLocalNames`. Resolving it instead would make it the only trigger header name that types, and would need `triggerScopeVar` to learn a second node shape. On the corpora the choice changes nothing (46 BaseApp triggers, none with a same-named global); on `n9` it removes the `alc`-failing swap. Open question 2 asks whether trigger names should resolve one day.

### 4. The receiver needs the named return's type node

`classifyDeclaredType` reads `declaration.node.childForFieldName("type")`. For a parameter or a `variable_declaration` that is the type. A named return's declaration node is the `return_value` identifier, which has no `type` field. So the named return is indexed as a `VarSymbol` whose `node` is that identifier (unique by position, which `loop-hazard.ts`'s `sameDeclaration` relies on) and whose `typeText` is its `return_type` text; and `classifyDeclaredType` falls back to the `return_type` sibling that follows a `return_value` node in the same parent (for a split member, in the same arm). Without the fallback, place 5 would FIND the named return and then classify it `unresolved`: `n13` would lose its `remove-setrange` and `n12` would lose its wrong `validate-to-assign` for the wrong reason. The pre-commitment below expects `n13`'s `remove-setrange` and BaseApp's 8 new `remove-setrange` claims, so a fix without the fallback fails the checker.

### 5. Identity keys: bump `IDENTITY_SCHEME` from 2 to 3

R325's rule, in `IDENTITY_SCHEME`'s own doc comment: bump it with any engine change that can move an existing mutant's key for unchanged AL source. This change does, measured three ways:

- `n14`: the new `swap-additive` at L5 takes ordinal 0 of its tuple (same canonical `astHash`, object, procedure name `Pick`, operator), so the overload's existing L12 mutant moves from `...|Pick|lethal.swap-additive|1` to `...|1|1`, and the NEW mutant carries the key L12 held before;
- `n15`: the removed wrong swap at L5 held ordinal 0, so L12's correct swap moves from `...|1|1` to `...|1` and carries the key of the removed, `alc`-failing mutant;
- full BaseApp, `SalesTaxCalculate.Codeunit.al`, member `CalculateTax`: a new `swap-additive` at L107 takes the key L118's mutant held, L118 moves to L131's old key, and L131 to ordinal 2. `astHash` is canonical (it abstracts names), so every `x + y` in one procedure shares a tuple, and a new one early in a procedure renumbers every later one. DC/Cloud, System Application, BusinessFoundation, the BaseApp scratch project and every fixture move NO key.

Without the bump, history (`--skip-known-survivors`), `--resume` and equivalence marks made under scheme 2 would match those keys to different mutants. The bump reuses R325's machinery unchanged. What it ripples to, listed so none is missed: `fixtures/sandbox-harden/lethal.equivalent.json` (`"identityScheme": 2` becomes 3; sound because `sandbox-harden`'s keys are byte-identical under this change, see the pre-commitment), `CHANGELOG.md` (marks files need `"identityScheme": 3`), `docs/using-lethal-from-an-agent.md`'s example, every test that writes the literal `2` to mean "the current scheme" (`packages/runner/tests/equivalence-marks.test.ts`, `resume.test.ts`: they become `IDENTITY_SCHEME` or stay literal where they mean "an older scheme", reviewed one by one), and the `report-equality` snapshot's `"identityScheme": 2`. The schema field stays optional, so no committed sample report is regenerated.

### 6. Live gate: not needed, with a stated STOP

The change decides which specs exist and which hang tag they carry; it changes no emission code. Every new mutant is an existing operator at a site shape it already emits in a plain procedure, through the same wrapper, reach latch, markers and line maps. What each kind of evidence proves:

- `alc`, every repro, every symbol subset, through the prototype's and then the branch's pipeline: every emitted mutant compiles in every build, and the nine master failures (`n1`, `n2`, `n5` to `n9`, `n12`, `n15`) are gone;
- the checker with exact totals on every repro, DC/Cloud, System Application, BusinessFoundation, the BaseApp scratch project and full BaseApp: exactly the pre-committed sites, tags and keys;
- the six gate fixtures byte-identical (hashes, identity keys, emitted targets), so no frozen itest figure can move and no gate can observe the change.

The hang tag is the one runtime-visible effect (it decides how a mutant is scheduled and stopped). Its machinery is gated by `itest:hang`, whose fixture does not change. **STOP rule:** if the prototype or Task 4 finds any change in a gate fixture, or any mutant whose emitted guard branch differs from the same operator's in a plain procedure of the same shape, stop and ask the orchestrator for a Cronus28 gate before merging.

---

## PRE-COMMITMENT (written and committed before any prototype of the fix)

### How the expected sets were derived

1. **The oracle.** For every repro, corpus and fixture, the expected set is master's capture of the named-return TWIN (`named-twin.ts`), mapped back to original offsets and diffed against master's own capture (`twin-diff.ts`). This runs master unchanged, on a shape master already resolves; nothing of the fix exists yet.
2. **Then the rules the twin does not model, by hand.** Triggers (Decision 3) and split members whose arms disagree (Decision 2) are not rewritten by the twin. For each, the expected change is: a name that master typed by a same-named global is no longer typed. On the repros that removes the swap in `n7`, `n8` and `n9`. In the corpora no such member has a same-named global (46 triggers, 1 partial split member), so master's answer there (`null`) is already the rule's answer and nothing changes.
3. **Then an audit, by hand, of every repro row** against its operator's rule, below. For the corpora, the per-operator counts were read against the census (every new row lies in a member with a named return; `OUTSIDE` is empty except for the two `k` renumberings), and the removals were read one by one (all 13 in full BaseApp are Tier-2 takeovers, below).

The expectation files are `$S/expect/<name>.txt` in `check-sites.ts`'s format, with their SHA-256 pinned at the end of this section so they cannot drift after this commit. Lines are 1-based file lines.

### Repros

| repro | master raw / deployed | expected raw / deployed | rows |
| --- | --- | --- | --- |
| `n1-named-return-global` | 9 / 9 | **8 / 8** | `-` `swap-call-arguments` L6 (`Result` is `Text`, `X` is `Integer`: not same-typed) |
| `n2-case-global` | 9 / 9 | **8 / 8** | `-` `swap-call-arguments` L6 (the named return hides `result` too) |
| `n3-same-type-global` | 8 / 8 | **8 / 8** | none: the swap at L6 stays, now typed by the named return |
| `n4-no-global` | 9 / 9 | **11 / 11** | `+` `swap-additive` L6 (`Result + X`, both `Integer`); `+` `swap-call-arguments` L7 (`Show(Result, X)` is `Show(Integer; Integer)`) |
| `n5-split-both-arms` | 9 / 9 | **8 / 8** | `-` `swap-call-arguments` L10 (both arms `Text`) |
| `n6-preamble-both-arms` | 10 / 10 | **9 / 9** | `-` `swap-call-arguments` L15 |
| `n7-split-one-arm` | 7 / 7 | **6 / 6** | `-` `swap-call-arguments` L9 (ambiguous; by hand) |
| `n8-split-arms-differ` | 7 / 7 | **6 / 6** | `-` `swap-call-arguments` L9 (ambiguous; by hand) |
| `n9-trigger` | 8 / 8 | **7 / 7** | `-` `swap-call-arguments` L9 (unknown in a trigger; by hand) |
| `n10-if-header` | 0 / 0 | **0 / 0** | none: out of reach (ERROR node) |
| `n11-hang-no-global` | 6 / 6 | **7 / 7** | `remove-assignment` L7 gains `hangCapable: "loop-condition-target"` (a `-` and a `+` row, key unchanged); `+` `swap-additive` L7 with the same tag |
| `n11b-hang-global` | 7 / 7 | **7 / 7** | none: both tags stay, now for the right reason |
| `n12-receiver-codeunit` | 8 / 8 | **7 / 7** | `-` `validate-to-assign` L8 (the receiver is a `Codeunit`, not a record); its `void-method-call` stays |
| `n13-record-no-global` | 3 / 3 | **5 raw / 4 deployed** | L5 `-` `void-method-call`, `+` `remove-setrange` (Tier 2 claims a record receiver the project does not shadow, and takes the span by precedence; the `void-method-call` is still generated, so raw counts it); `+` `swap-additive` L6 (`R.Amt + Glob`, a field typed `Integer`, `memberType`) |
| `n14-overload-key-add` | 5 / 5 | **6 / 6** | `+` `swap-additive` L5; `k` L12 `swap-additive`, `78d263bd...|Repro N14|Pick|lethal.swap-additive|1` to `...|1|1`; `a` L5 carries `78d263bd...|Repro N14|Pick|lethal.swap-additive|1` |
| `n15-overload-key-remove` | 10 / 10 | **9 / 9** | `-` `swap-call-arguments` L5; `k` L12 `swap-call-arguments`, `2712cb75...|Repro N15|Pick|lethal.swap-call-arguments|1|1` to `...|1` |

(The full 64-hex `astHash` of every `k` and `a` row is in the expectation file; the files are pinned by hash below.)

### Corpora (raw and deployed separately)

| scope | master raw / deployed | expected raw / deployed | new | removed | hang tag gained | `k` | `a` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DC/Cloud | 102584 / 97126 | **102654 / 97196** | 70 (`swap-call-arguments` 61, `swap-additive` 9) | 0 | 21 (`remove-assignment` 17, `flip-boolean-literal` 4) | 0 | 0 |
| System Application | 77291 / 75832 | **77298 / 75839** | 7 (`swap-call-arguments`) | 0 | 6 (`remove-assignment`) | 0 | 0 |
| BusinessFoundation | 3639 / 3573 | **3639 / 3573** | 0 | 0 | 0 | 0 | 0 |
| BaseApp scratch project | 1568 / 1540 | **1569 / 1541** | 1 (`swap-call-arguments`, `OAuth20Setup.Table.al` `RefreshAccessToken` L315, a split member whose arms agree) | 0 | 0 | 0 | 0 |
| full BaseApp | 1775366 / 1687730 | **1775922 / 1688278** | 561 (`swap-call-arguments` 466, `swap-additive` 67, `swap-modify-flag` 11, `remove-setrange` 8, `swap-find-direction` 6, `validate-to-assign` 3) | 13 (`void-method-call` 8, `flip-boolean-literal` 5) | 55 (`remove-assignment` 43, `flip-boolean-literal` 7, `shift-integer` 5) | 2 | 1 |

Every other mutant keeps its identity key, `procedureName` and `hangCapable` (the checker's full id map). Raw moves by less than deployed-plus-removed in BaseApp because the 8 displaced `void-method-call` mutants are still generated and only dropped by precedence.

**DC/Cloud, by member** (`+` new, `~` hang tag gained; `*` the new mutant carries the tag):

- `.dependencies/DC/Codeunit/CDCCaptureManagement.Codeunit.al`: `CheckIsExpression` `~` `flip-boolean-literal` L2514, `~` `remove-assignment` L2514; `NoOfOccourance` `~` `remove-assignment` L2617, `+` `swap-additive` L2616, L2617*, L2620.
- `.dependencies/DC/Codeunit/CDCDocAICaptureMgt.Codeunit.al`: `CaptureFieldFromKeyValuePair` `~` `flip-boolean-literal` L134 twice, `~` `remove-assignment` L134.
- `.dependencies/DC/Codeunit/CDCPurchDocXMLIdentif.Codeunit.al`: `FindVendorWithCustom` `~` `remove-assignment` L318; `FindVendorWithGLN` `~` L235; `FindVendorWithVATNo` `~` L146, L162, L176.
- `.dependencies/DC/Codeunit/CDCSaleDocXMLIdentif.Codeunit.al`: `FindCustomerWithCustom` `~` `remove-assignment` L313; `FindCustomerWithGLN` `~` L230; `FindCustomerWithVATNo` `~` L143, L158, L171.
- `.dependencies/DC/Codeunit/CDCXmlLibrary.Codeunit.al` `GetXmlPathLastElement` `~` `remove-assignment` L418; `.dependencies/DC/Table/CDCTemplateFieldRule.Table.al` `CaptureExpression` `~` L148; `Al/Specialization/CDCSwissQRMgt.Codeunit.al` `IdentifyVendorFromQRCode` `~` `flip-boolean-literal` L112, `~` `remove-assignment` L112; `Modules/Purchase Contracts/Integration/src/Codeunits/CDCPCDAnalyzeInvoices.Codeunit.al` `AnalyzeVendors` `~` `remove-assignment` L170.
- `swap-additive` `+`: `CDCLineCapture20.Codeunit.al` `GetLineCaptions` L705; `CDCPurchDocManagement.Codeunit.al` `GetAllAmountsExclVAT` L244, `GetAmountInclVAT` L265; `CDCSalesManagement.Codeunit.al` `GetAllAmountsExclVAT` L136; `CDCScannerManagement.Codeunit.al` `DocumentListReceived` L76; `Modules/Storage/CDCFileServiceManagement.Codeunit.al` `GetDirectories` L273.
- `swap-call-arguments` `+` (61): `Modules/Storage/CDCDocumentFileInterface.Codeunit.al` 32 (one each in `Clear*`, `Get*`, `Has*` and `Set*` of `CleanXml`, `Email`, `Html`, `Misc`, `Pdf`, `Png`, `Tiff`, `Xml`), `Al/Overrides/Publishers/CDCCryptographyManagement.Codeunit.al` 4 (`DecryptText`, `DecryptTextBasic`, `EncryptText`, `EncryptTextBasic`), `CDCFileSystemManagement.Codeunit.al` 4 (`DeleteFile`, `ExportTempFileContent`, `GetTempFilename`, `ImportFileContentToTempFile`), `CDCClientFileSysMgt.Codeunit.al` 2, `CDCPDFManagement.Codeunit.al` 1, `CDCTIFFManagement.Codeunit.al` 1, `Al/Overrides/CDCItemReferenceMgt.Codeunit.al` 1, `.dependencies/DC/Codeunit/CDCPurchDocManagement.Codeunit.al` 5 (`GetIsInvoice` L90, `TranslateUOM` L5798, L5803, L5810, L5815), `CDCLineCapture20.Codeunit.al` 3 (`CaptureWithAI` L78, L128, `CaptureWithAreaLineRecognition` L250), `CDCCapturefromeDocumentMgt`, `CDCDocumentImporter`, `CDCDocumentModificationMgt`, `CDCPurchRegister`, `CDCPurchaseOrderRegister`, `CDCTempFile.Table.al` 1 each, `Modules/Approvals/Codeunits/CDCApprovalManagement.Codeunit.al` `PurchDocSubmittedForApproval` L1888, `CDCApprovalsBridge.Codeunit.al` `FilterPurchAppWorkflows` L842.

**System Application, by member:** `+` `swap-call-arguments` in `AzureDIImpl.Codeunit.al` (`AnalyzeInvoice` L59, `AnalyzeReceipt` L83), `AzureKeyVaultImpl.Codeunit.al` (`GetCertificateFromClient` L127, L131, `GetSecretFromClient` L104), `ConfirmManagementImpl.Codeunit.al` `IsGuiAllowed` L33, `LanguageImpl.Codeunit.al` `GetParentLanguageId` L305; `~` `remove-assignment` in `EditinExcelImpl.Codeunit.al` `ExternalizeODataObjectName` L236, L244, L259, `PasswordHandlerImpl.Codeunit.al` `GenerateSecretPassword` L33, `RetentionPolicySetupImpl.Codeunit.al` `CreateUniqueRetentionPeriodCode` L404, `WebServiceManagementImpl.Codeunit.al` `ExternalizeODataObjectName` L697.

**Full BaseApp.** 530 members change (`$S/logs/summ-baseapp.txt`). The 13 removals, each a Tier-2 takeover in a member whose named return is a record: `Inventory/Tracking/MatchedOrderLineMgmt.Codeunit.al` `InsertMatchedOrderLine` L1067, L1068, L1069 (`void-method-call` out, `remove-setrange` in at the same span); in `Test/Tests-ERM`, `ERMIntercompanyII.Codeunit.al` `FindPurchaseLine` L6888 to L6891 and `ERMFinancialReportSheetDef.Codeunit.al` `CreateDimPerspectiveLine` L595 (the same), and `AmountAutoFormatCurrency.Codeunit.al` L377, L386, `ERMAccountScheduleII.Codeunit.al` L3340, `ERMFinancialReportSchedules.Codeunit.al` L453, L488 (`flip-boolean-literal` on a `Modify(true)` argument ceded to the new `swap-modify-flag` there, the cession R-302's `d4` correction recorded). The two `k` rows and the `a` row, exactly:

- `k` `Source/Base Application/Finance/SalesTax/SalesTaxCalculate.Codeunit.al:118` `swap-additive`: `78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89|Sales Tax Calculate|CalculateTax|lethal.swap-additive|1` to `...|lethal.swap-additive|1|1`;
- `k` the same file, L131: `...|lethal.swap-additive|1|1` to `...|lethal.swap-additive|1|2`;
- `a` the same file, L107, a NEW `swap-additive`, carries `...|CalculateTax|lethal.swap-additive|1` (the key L118 held on master).

### Fixtures

`sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-harden`, `sandbox-coverage-probe` and `sandbox-symbols`: **no change**, raw and deployed as master (19/19, 407/387, 40/40, 22/21, 86/80, 13/13), every identity key and emitted target byte-identical. `sandbox-coverage-probe` is the one fixture with named returns (5, no same-named global, read in their bodies); the twin changes none of its sites, so the frozen coverage gates cannot move. Every other fixture has no named return. No frozen itest figure can move.

### Identity scheme

`IDENTITY_SCHEME` 2 to **3**, in the same commit series and BEFORE the engine change lands (Task 1), for the key moves pinned above: 1 in `n14`, 1 in `n15`, 2 in full BaseApp, 0 elsewhere.

### Expectation files, pinned (SHA-256 of `$S/expect/<name>.txt`)

```
19639a9772819fa88b3b8eb664ed4a839a82691f2fa1ad68fddbd88c21564c02  ba-split.txt
4748922c96b500b927f64967d51cda723514bfca380f14575206dbd1b956fae7  baseapp.txt
de5c90ed9fd6a0418aa45e02805a7c62be0bbc2c84d52ee3d614695c036efe58  bcf.txt
597fb7c918426713dcb03e757b7287ac91b92f754ab10d8e544fb77ea6170033  dc.txt
a366633b7d38363d244c0f3155b8bcd075daf73692d129b46c264fc2c14d976a  fixture-sandbox-app.txt
94c2d8fb69bcb5e5546f4d605a3ddd046921e4afc8403900b4ea180066bad4ff  fixture-sandbox-coverage-probe.txt
f432976ae9dfc0a9853e8d80f5e14933a32b26d92aec5679e2203d898fe34580  fixture-sandbox-data.txt
35cb52c292d27b662d50dc3165eae8959a06db259ec31bcc882fa289312d8062  fixture-sandbox-hang.txt
b9eb28349bb9f9f09b364c8d652054dab2de416239c3fced8fef26fa69e945ed  fixture-sandbox-harden.txt
796ff33faeca8ea08354dc54285b83fcd7000bf16c772cef9d7336959b4191b6  fixture-sandbox-symbols.txt
28c0507431a9b87439788ab1a7004dbf06159df3abe38d22010cab83b4c0417f  n1-named-return-global.txt
106309e07a38c77fecc0339c37401f1fb0d5d58b2729c50f828929c31f1a9ff4  n10-if-header.txt
103cb306316df2873c1e4cb5ddc3baa9d234cde288757bb959f17407be0c574e  n11-hang-no-global.txt
b7a0a6a5e573d0bb020e8e3fa6cc293a5c8c23135868143a1fa667c7953bed42  n11b-hang-global.txt
b021c71d5d74e65174acd35c1bde8b36ad5ae0bdf04d8f29428b1ba628fe4290  n12-receiver-codeunit.txt
c397d966c6bd435283792d443c2532525d09d7c46c932ab3268e332683036c95  n13-record-no-global.txt
f1ae496bc95f49ae414ebd90859e46586afb1dc3d4ce5df54684c63e8a4a828a  n14-overload-key-add.txt
713fe0dcddf0fc0c0a608834ea5ca532eef0c4bbdfc0043da311c27470d2753d  n15-overload-key-remove.txt
28c0507431a9b87439788ab1a7004dbf06159df3abe38d22010cab83b4c0417f  n2-case-global.txt
bd1661922f105db5ce746e8add88a3879cf48d02a7b12d09af13537c861183b7  n3-same-type-global.txt
788367aef3f96ef899baad716180683d08e20d19067de66ef11ad67ed1050c4e  n4-no-global.txt
029362afa9b4721965a5d566eefaf6c5bd558fac1de5ca22848bc83b5ce144ae  n5-split-both-arms.txt
7053031f71c5aa2b709917bd0eba8e4fb51238185e5c61c26ea6385db042d19a  n6-preamble-both-arms.txt
2ea56fbaf0f2c64da870c3b7aab33ff107f7ed0393d4a738b16518d2a94b7924  n7-split-one-arm.txt
2ea56fbaf0f2c64da870c3b7aab33ff107f7ed0393d4a738b16518d2a94b7924  n8-split-arms-differ.txt
c794b513650b949086aee73d92e6c1e894087c16e3adecd3ffe43afc478e8350  n9-trigger.txt
6503cdceafd6caaac8563ff96a58c89059546aa0f7b526bd64eb022e7947aba2  sysapp.txt
```

**Prototype check:** added by the second commit, after this one. Nothing above is edited to match it.
