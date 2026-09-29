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

---

## Prototype check (written AFTER the pre-commitment commit `f74b0c10`)

The prototype is a scratch worktree, `$S/proto`, detached at `f74b0c10`, with the native addon copied in and `$S/proto-patch.py` applied: Decisions 1 to 4 as four hunks (`plain`, `split`, `trigger`, `receiver`) in `symbol-table.ts` and `receiver.ts`, 22 lines added. Its diff is `$S/proto-r1.patch`; its tools are `$S/pt/` (the same tools, pointed at `$S/proto`). `IDENTITY_SCHEME` is not part of the site captures (the serialized key carries no scheme), so the site checks ran without the bump. The committed rows above are not edited.

### Every capture against the pre-commitment (`$S/logs/measure-proto.txt`)

**27 of 27 checks pass on the first round, with no disagreement.** The pre-commitment was checked as committed (`$S/expect-precommit/`, whose SHA-256 values equal the ones pinned above; checked before the run).

| scope | pre-committed | prototype |
| --- | --- | --- |
| 16 repros | the rows and totals above | the same rows, totals, `k` and `a` rows |
| DC/Cloud | 102654 raw, 97196 deployed; 70 new, 21 tags, no key moved | the same |
| System Application | 77298, 75839; 7 new, 6 tags | the same |
| BusinessFoundation | 3639, 3573; nothing | the same |
| BaseApp scratch project | 1569, 1541; 1 new | the same |
| full BaseApp | 1775922, 1688278; 561 new, 13 removed, 55 tags, 2 `k`, 1 `a` | the same |
| six gate fixtures | no change | no change |

Every `.err` file (the runner's warnings, including the dropped non-executable-site count) is byte-identical to master's for every repro, corpus and fixture.

### Controls: each hunk is load-bearing (`$S/controls.sh`, then the full patch restored and verified by `cmp`)

| hunk left out | repro checks that FAIL |
| --- | --- |
| `plain` | `n1`, `n2`, `n4`, `n11`, `n12`, `n13`, `n14`, `n15` |
| `split` | `n5`, `n6`, `n7`, `n8` |
| `trigger` | `n9` |
| `receiver` | `n13` |

Two passes to know about. `n3` and `n11b` pass without the `plain` hunk, because master's answer there is right by coincidence (the global has the named return's type); they pin that resolving does not REMOVE those sites, which is what separates Decision 1 from the fail-safe. `n12` passes without the `receiver` hunk, for the wrong reason: the procedure path finds the named return, `classifyDeclaredType` cannot read its type and answers `unresolved`, and an unresolved receiver is not claimed either. So `n12` pins the lookup, and `n13` (a record receiver that must be CLAIMED) is the only repro that pins the receiver hunk. Task 2's receiver test says so in its name.

### alc, every repro, every subset, through the prototype's pipeline (`$S/logs/alc-proto-*.log`)

**21 of 21 subsets pass** (16 projects; `n5` to `n8` and `n10` under `[]` and `[CLEAN27]`). On master 11 of those 21 subsets fail (`n1`, `n2`, `n9`, `n12`, `n15` once each, `n5` and `n6` twice each, `n7` and `n8` under `[]`).

### Fixtures, byte-identical on the prototype

`identity-keys.ts` (master) and `pt/identity-keys.ts` (prototype) on all six gate fixtures, `sandbox-symbols` included: the identity-key lists are identical and the emitted targets are identical (`diff -r --exclude=app.json`), for every fixture. The source hashes cannot move (no fixture AL changes).

### The whole suite on the prototype (`$S/logs/proto-bun-test.txt`)

4507 pass, 7 skip, **1 fail**: `packages/runner/itest/gate-receipt.test.ts`, "a CHALLENGED skip exits non-zero" (it hits the 5 s test timeout). It fails the same way on the r323 worktree with no prototype (master's code, run alone), so it is not R-323's; it is listed under "Open questions". With `IDENTITY_SCHEME` also set to 3 on the prototype, 6 tests fail, every one because of the bump and none because of the engine change; "Task 1 inventory" at the end lists them with the change each needs. The `gate-receipt.test.ts` timeout did not recur on that run, so it is intermittent.

### What the prototype did not check, on purpose

- The emitted guard branch of each new mutant was not compared with a twin's. No emission code changed (the diff touches only `symbol-table.ts` and `receiver.ts`), and `alc` compiles every emitted mutant in every build.
- `al-runner` was not run. It would prove that the new mutants run and get verdicts; the new mutants are ordinary operator sites and emission is unchanged, so this plan does not ask for it (Decision 6).

---

## Task count and the live gate (added with the tasks)

Six tasks, Task 0 to Task 5, all OFFLINE. No task needs a container.

Cronus28 is OFF until further notice (coordinator, 2026-09-29), so nothing in this plan waits on it. Decision 6 already needs no live gate. If its STOP rule fires (a gate fixture changes in Task 4 Step 3, or `alc` fails in Step 2), the branch is not merged and a SEPARATE task, "Cronus28 gate for R-323", is filed and marked BLOCKED on Cronus28 returning; no other task depends on it or waits for it.

## Global Constraints

- Plain English, short sentences, no em dashes, in code comments, commits and roadmap text.
- No corpus source text in any committed file. File names, member names, operators, lines, keys and counts are fine. Every repro is hand-written.
- No `!` non-null assertions; destructure and check `undefined`. Fail loudly on a contract violation.
- The pre-committed rows above are not edited. If an implementation disagrees with one, stop and report it; a correction is written as its own addendum with its evidence, never as an edit.
- Fixtures stay byte-identical (source hashes, identity keys, emitted targets), proven by diff in Task 4, for all six gate fixtures including `sandbox-symbols`. The one fixture file that changes is `fixtures/sandbox-harden/lethal.equivalent.json` (its `identityScheme`), and only in Task 1.
- Identity keys move only as pre-committed (`n14`, `n15`, full BaseApp's two `k` and one `a`). The checker's full id map enforces it.
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>`.
- Every fix is red-checked: revert the specific hunk, confirm the specific test goes red, restore, report both outputs (or use the `mutation-red-checker` subagent).
- Every scratch shell block runs under `set -euo pipefail`, sources `$S/setup.sh`, never filters a command's output through `grep -v`, writes an "expect nothing" grep as `if grep ...; then exit 1; fi`, and keeps raw logs under `$S/logs/`.
- Probes run SERIALLY, one at a time. No container is used by any task.
- Tests assert only what their task owns: Task 1 the scheme value and its consumers; Task 2 symbol-table, type and receiver answers and the hang classifier's answer, never a mutant count; Task 3 the runner-level site sets, tags and keys of the repros.

## Review Focus

1. **No `alc`-failing site from a named return's name.** `n1`, `n2`, `n5` to `n9`, `n12`, `n15` compile in every build (Task 4), and the typed operators never read a same-named global where a named return is in scope. Pinned by Task 2's type and receiver tests and Task 3's pipeline pins; red-checked hunk by hunk.
2. **Resolve, not only hide.** `n3`, `n4`, `n11`, `n11b`, `n13`: the named return types by its own declaration, so sites are ADDED where master had none and KEPT where master was right by coincidence. This is what separates Decision 1 from the fail-safe.
3. **Every arm, and unknown where unindexed.** `n5`/`n6` resolve, `n7`/`n8` are ambiguous, a trigger's named return is unknown (`n9`), and an unindexed member (R327, R330, R331) still resolves nothing.
4. **The receiver reads the type.** `n13` is claimed as a record receiver, and `n12`'s codeunit receiver is not (Decision 4).
5. **The hang tag comes back.** 21 + 6 + 55 existing corpus mutants and `n11`'s gain `loop-condition-target`; `n11b`'s tags stay.
6. **Keys and the scheme.** Exactly the pre-committed key moves, and `IDENTITY_SCHEME` is 3 before the engine change lands, so no commit carries moved keys under scheme 2.
7. **Nothing else moved.** Fixtures byte-identical; BusinessFoundation unchanged; every `.err` identical.

## File structure

- Task 1: `packages/schemata/src/project.ts` (`IDENTITY_SCHEME` 3, doc comment: why), `fixtures/sandbox-harden/lethal.equivalent.json`, `CHANGELOG.md`, `docs/using-lethal-from-an-agent.md`, the tests that mean "this build's scheme" by a literal, `packages/runner/tests/__snapshots__/report-equality.test.ts.snap`.
- Task 2: `packages/engine/src/semantic/symbol-table.ts` (`parseProcedure`, `parseSplitProcedure`, `triggerLocalNames`), `packages/engine/src/semantic/receiver.ts` (`classifyDeclaredType`, a new `returnTypeAfter`). Tests: `packages/engine/tests/semantic/symbol-table.test.ts`, `types.test.ts`, `resolve-var-ref.test.ts`, `packages/builtin-tier2/tests/receiver.test.ts`, `packages/builtin-tier1/tests/loop-hazard.test.ts`.
- Task 3: `packages/runner/tests/named-return.test.ts` (new).
- Task 5: `docs/roadmap/R323.md` closed, a new roadmap item for the partial-header `#if` grammar gap, a one-line note in `R325.md`, regenerated `ROADMAP.md`.
- Scratch, never committed: everything under `$S`.

---

### Task 0: Scratch setup, the census STOP, and BEFORE captures (no product change)

**Files:** scratch only.

- [ ] **Step 1: The setup file.** `$S/setup.sh` holds exactly:

```bash
# R-323 scratch setup. Sourced by every fail-fast block after `set -euo pipefail`. Never committed.
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe sandbox-symbols"
corpus() { case "$1" in dc) echo "U:/Git/DC/Cloud";; sysapp) echo "U:/Git/BC.History/System Application";; bcf) echo "U:/Git/BC.History/BusinessFoundation";; baseapp) echo "U:/Git/BC.History/BaseApp";; ba-split) echo "$S/ba-split";; esac; }
export LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
cd /u/Git/LethAL-wt/r323
mkdir -p "$S/logs"
```

Confirm every tool imports from this worktree: `if grep -ln "LethAL-wt/r30[0-9]\|LethAL-wt/r29" "$S"/*.ts; then exit 1; fi`. The prototype's copies under `$S/pt/` point at `$S/proto` and are used by no task.

- [ ] **Step 2: Census and the expectation hashes.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323/setup.sh
for k in dc sysapp bcf ba-split baseapp; do bun "$S/named-census.ts" "$(corpus $k)" > "$S/logs/census2-$k.txt"; cmp "$S/logs/census-$k.txt" "$S/logs/census2-$k.txt"; done
for f in fixtures/*/; do n=$(basename "$f"); bun "$S/named-census.ts" "$f" > "$S/logs/census2-fixture-$n.txt"; cmp "$S/logs/census-fixture-$n.txt" "$S/logs/census2-fixture-$n.txt"; done
(cd "$S/expect-precommit" && sha256sum *.txt) | sed 's/ \*/  /' > "$S/logs/expect-hashes-now.txt"
grep -E '^[0-9a-f]{64}  ' docs/superpowers/plans/2026-09-29-R-323-named-return.md > "$S/logs/expect-hashes-plan.txt"
diff "$S/logs/expect-hashes-plan.txt" "$S/logs/expect-hashes-now.txt"
echo "census and expectations unchanged"
```

Expected: the last line. A changed census, a fixture with a named return other than `sandbox-coverage-probe`'s five, or a changed expectation hash is a STOP: the pre-commitment would be stale, and the orchestrator decides.

- [ ] **Step 3: BEFORE captures, identical to plan time.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323/setup.sh
test -z "$(git status --porcelain -- packages fixtures)"
R=$(pwd); O="$S/cap/before"; mkdir -p "$O"
for r in "$S"/repro/*/; do n=$(basename "$r"); bun "$S/sites.ts" "$r" > "$O/$n.txt" 2> "$O/$n.err"; done
for f in $F; do bun "$S/sites.ts" "$R/fixtures/$f" > "$O/fixture-$f.txt" 2> "$O/fixture-$f.err"; bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-before-$f.txt"; done
for k in dc sysapp bcf ba-split baseapp; do bun "$S/sites.ts" "$(corpus $k)" > "$O/$k.txt" 2> "$O/$k.err"; done
for n in $(ls "$S/cap/head"); do cmp "$S/cap/head/$n" "$O/$n"; done
echo "BEFORE captured, identical to plan time"
```

Expected: the last line (about 15 minutes; full BaseApp is 7). A difference is a STOP: master moved under the pre-commitment, and rebase decisions go to the orchestrator before any code.

### Task 1: `IDENTITY_SCHEME` 3, before the engine change (R325's rule)

**Why first.** Task 2 moves identity keys for unchanged source (pre-committed: `n14`, `n15`, full BaseApp's `CalculateTax`). Every cross-session consumer must already refuse scheme-2 keys when that lands, so no commit on this branch carries moved keys under scheme 2.

**Files:** `packages/schemata/src/project.ts`, `fixtures/sandbox-harden/lethal.equivalent.json`, `CHANGELOG.md`, `docs/using-lethal-from-an-agent.md`, `packages/runner/tests/__snapshots__/report-equality.test.ts.snap`, and any test the scheme-3 run names (Step 1).

- [ ] **Step 1: Know what the bump touches.** The prototype run with `IDENTITY_SCHEME = 3` (`$S/logs/proto-bun-test-scheme3.txt`) names every unit test that reads the literal 2 as "this build's scheme". Reproduce it on the branch: set the constant to 3, `bun run typecheck && rm -rf packages/*/dist && bun test`, and list the failures in `$S/logs/t1-scheme3.txt`. Expected: the six tests recorded under "Task 1 inventory" at the end of this plan, and nothing else (a seventh is a STOP: something else reads the scheme as a literal).
- [ ] **Step 2: Update each, by meaning.** A test that means "the current scheme" reads `IDENTITY_SCHEME`; a test that means "an older scheme" keeps its literal and says so in its name (the R325 tests already use 1 for that). `bun test <file> --update-snapshots` for `report-equality` only, and the diff must be the one line `"identityScheme": 2` to 3. `fixtures/sandbox-harden/lethal.equivalent.json`: `"identityScheme": 3`, justified in the commit message by Task 4's byte-identical `sandbox-harden` keys (its marks name the same mutants under both schemes). `CHANGELOG.md`: "Identity scheme 3 (R323): keys move for procedures with a named return value; existing marks files need `"identityScheme": 3` after re-checking each mark against a fresh report; history and resume from scheme-2 runs are refused by name (R325)". `docs/using-lethal-from-an-agent.md`: the example reads 3. The constant's doc comment gains one sentence: "3: R323, a named return value became a declaration (measured moves in the R-323 plan)".
- [ ] **Step 3: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test` (the pre-existing `gate-receipt.test.ts` timeout aside, which fails on master too). `bunx biome check <touched .ts files>`.
- [ ] **Step 4: Commit.** `git commit -m "fix(R323): identity scheme 3; a named return value becoming a declaration moves keys for unchanged source (R325's rule)"`.

### Task 2: A named return value is a declaration (engine)

**Files:**
- Modify: `packages/engine/src/semantic/symbol-table.ts`, `packages/engine/src/semantic/receiver.ts`
- Test: `packages/engine/tests/semantic/symbol-table.test.ts`, `types.test.ts`, `resolve-var-ref.test.ts`, `packages/builtin-tier2/tests/receiver.test.ts`, `packages/builtin-tier1/tests/loop-hazard.test.ts`

- [ ] **Step 1: Write the failing tests,** each on hand-written inline AL copied from the named repro, asserting only an engine answer:
  - `symbol-table.test.ts`, "a named return value is a local (R323)": a plain `Pick() Result: Text` lists `Result` in `locals` with type text `Text`; a split member whose arms both declare `Result: Text` lists it; a split member with a named return in one arm only (`n7`), or two types (`n8`), lists it in `ambiguous` and in no list.
  - `types.test.ts` (with the file's `typeAt`), "R323: a named return value": `n1`'s `Result` types `Text` with a global `Result: Integer`; `n2`'s with the global spelled `result`; `n3`'s types `Integer`; `n4`'s (no global) types `Integer`; `n5`/`n6` type `Text`; `n7`/`n8` are `null` with the global present; `n9`'s trigger `Found` is `null` with a global `Found: Integer`; `n13`'s `R.Amt` types `Integer` (`memberType` through the named return).
  - `resolve-var-ref.test.ts`, "R323": `resolveVarRef` on `n11`'s `Result` answers the named return's declaration (its node is the `return_value` identifier), and the same declaration for the loop condition's `Result`; on `n9`'s `Found` it answers `null`, not the global.
  - `loop-hazard.test.ts`, "R323": `classifyHangCapable` on `n11`'s `Result := Result + 1` answers `loop-condition-target`.
  - `receiver.test.ts`, "R323": `claimsRecordMethod` CLAIMS `n13`'s `R.SetRange(...)` (a named record return, no global): name it "the receiver hunk: a named record return is classified by its return_type"; and does NOT claim `n12`'s `R.Validate(N, 5)` (a named codeunit return beside a record global).
- [ ] **Step 2: Run them, expect red** for the reason named: `bun test packages/engine/tests/semantic packages/builtin-tier2/tests/receiver.test.ts packages/builtin-tier1/tests/loop-hazard.test.ts`. The `n3` type test and the `n12` receiver test PASS already (master is right there by coincidence, or refuses for another reason); they stay as regression pins, and the red-check below is what proves them.
- [ ] **Step 3: Implement** the four hunks of `$S/proto-r1.patch`, each with an R323 comment: `parseProcedure` pushes the named return onto `locals` (`name` quote-stripped, `typeText` the `return_type` text, `node` the `return_value` identifier); `parseSplitProcedure` adds an arm's named return to that arm's map as a non-parameter, with the `return_type` that follows it in the arm; `triggerLocalNames` adds a `return_value` child's name; `classifyDeclaredType` falls back to `returnTypeAfter(declaration.node)`. Update the doc comments that list what a procedure's scope holds (`ProcedureSymbol`, `lookupVar`'s resolution order, `triggerLocalNames`).
- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/engine packages/builtin-tier1 packages/builtin-tier2`.
- [ ] **Step 5: Red-check each hunk alone** (`python "$S/proto-patch.py"`'s `skip=` shows the four hunk boundaries): revert one, run only its tests, confirm red, restore, confirm green. Expected, as in the prototype's controls: `plain` turns the plain-procedure type, `resolveVarRef`, `loop-hazard` and `n13` receiver tests red; `split` the split tests; `trigger` the `n9` tests; `receiver` the `n13` claim test only. And Decision 1 itself: replace the `plain` hunk with the fail-safe (push the name onto the member's `ambiguous` list instead of `locals`) and confirm the `n3` and `n4` type tests and the `n11` classifier test go red while `n1`'s stays green; that is the difference between resolving and hiding. Record all outputs in `$S/logs/t2-redcheck.txt`.
- [ ] **Step 6: Commit.** `bunx biome check <touched files>`, then `git commit -m "fix(R323): a named return value is a local of its member; it hides a same-named global (every arm for a split member; unknown in a trigger)"`.

### Task 3: Runner-level pins (the repros, through the real pipeline)

**Files:** Test: `packages/runner/tests/named-return.test.ts` (new), built the way `preproc-instrumentation.test.ts` builds its projects (`generateMutationSet`, then `writeInstrumentedProject`, then the manifest).

- [ ] **Step 1: Tests,** each with inline AL copied from the named repro, asserting only what R-323 owns:
  - `n1`, `n2`, `n5`, `n6`, `n7`, `n8`, `n9`, `n15`: no `swap-call-arguments` at the pinned line;
  - `n4`: `swap-additive` at L6 and `swap-call-arguments` at L7; `n3`: `swap-call-arguments` at L6 stays;
  - `n11`: L7's `remove-assignment` and `swap-additive` carry `hangCapable: "loop-condition-target"`;
  - `n12`: no `validate-to-assign` at L8, and its `void-method-call` stays;
  - `n13`: `remove-setrange` at L5, no `void-method-call` there, `swap-additive` at L6;
  - `n14`: the L12 `swap-additive` key carries ordinal 1 and the new L5 one ordinal 0; `n15`: the L12 key carries ordinal 0.
- [ ] **Step 2: Red-check** `n1` (revert `plain`), `n7` (revert `split`), `n9` (revert `trigger`), `n13` (revert `receiver`) and `n14` (revert `plain`), one at a time, restore; record in `$S/logs/t3-redcheck.txt`.
- [ ] **Step 3: Commit.** `test(R323): runner-level pins for named return values: hiding, the every-arm rule, triggers, the receiver, the hang tag and the ordinals`.

### Task 4: Offline proof: the checker with exact totals, alc on every subset, fixtures byte-identical

**Files:** scratch only. On the r323 worktree with Tasks 1 to 3 committed.

- [ ] **Step 1: Every capture against the pre-commitment.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r323/setup.sh
R=$(pwd); O="$S/cap/after"; mkdir -p "$O"
for r in "$S"/repro/*/; do n=$(basename "$r"); bun "$S/sites.ts" "$r" > "$O/$n.txt" 2> "$O/$n.err"; done
for f in $F; do bun "$S/sites.ts" "$R/fixtures/$f" > "$O/fixture-$f.txt" 2> "$O/fixture-$f.err"; done
for k in dc sysapp bcf ba-split baseapp; do bun "$S/sites.ts" "$(corpus $k)" > "$O/$k.txt" 2> "$O/$k.err"; done
pass=0
for e in "$S"/expect-precommit/*.txt; do n=$(basename "$e" .txt); bun "$S/check-sites.ts" "$S/cap/before/$n.txt" "$O/$n.txt" "$e" | tee "$S/logs/check-after-$n.log"; pass=$((pass + 1)); done
test "$pass" -eq 27
for n in $(ls "$S/cap/before" | grep '\.err$'); do cmp "$S/cap/before/$n" "$O/$n"; done
echo "checks: 27 pass; every .err identical"
```

Each check pins the file's exact raw and deployed totals (`= raw N deployed M`), every `+`, `-`, `k` and `a` row, and every other mutant's key, `procedureName` and tag. Expected: the last line. Any FAIL is a STOP.

- [ ] **Step 2: alc, every repro, every subset.** For each repro, `bun "$S/alc-all.ts" "$S/repro/<name>" "<syms>"` (`CLEAN27` for `n5` to `n8` and `n10`, none otherwise). Expected: `21 of 21` subsets `exit=0 app=true`, every project `PASS`. Any FAIL is a STOP.
- [ ] **Step 3: Fixtures byte-identical.** For each of the six gate fixtures: `bun scripts/probe-fixture-hashes.ts "fixtures/$f/src"` equals `$S/hashes-before-$f.txt`; `bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-after-$f"` equals `$S/ids-before-$f.txt` (with `maxRSS_KB` dropped); and `diff -r --exclude=app.json "$S/target-before-$f" "$S/target-after-$f"` is empty. `bun run compile:fixtures` is not needed (no fixture AL changes) and is not run.
- [ ] **Step 4: Whole suite.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` from the root. Expected: green, except the pre-existing `gate-receipt.test.ts` timeout if it still fails on master (checked the same day).

### Task 5: Roadmap (no live gate: Decision 6; its STOP rule is checked by Task 4 Steps 2 and 3)

- [ ] Re-check the next free id across every worktree immediately before writing (`for w in U:/Git/LethAL-wt/*/; do ls "$w/docs/roadmap"; done | sort -u | tail`); at plan time another worktree holds R337, so the first free id was R338.
- [ ] File `docs/roadmap/R<next>.md`: "A `#if` inside one procedure header (around a named return or its type) makes the whole member an ERROR node, so no mutant is generated in that file" (repro `n10`, `alc` passes under both subsets, 0 in every corpus; the upstream draft is under "Notes").
- [ ] Mark `docs/roadmap/R323.md` `done (<Task 1 commit>..<Task 3 commit>)` with a closing section: the rule (resolve; every arm; unknown in a trigger; unindexed unknown), the pre-committed and measured counts per corpus (DC +70 deployed and 21 tags; System Application +7 and 6; BaseApp scratch +1; full BaseApp +548 deployed, 13 Tier-2 takeovers, 55 tags; fixtures 0), the scheme bump and its exact key moves, and the red-checks.
- [ ] One line in `docs/roadmap/R325.md`: "Scheme 3: R323 (named return values), measured key moves in the R-323 plan."
- [ ] `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, then commit `roadmap(R323): done; R<next> filed`.

---

## Self-review

- **Spec coverage.** R323's shape (plain, `n1`) and both split shapes (`n5`, `n6`) with the every-arm rule (`n7`, `n8`), as R323's text asks; the rest of the class found by the hunt: a trigger (`n9`), a differently-cased global (`n2`), the receiver path (`n12`, `n13`), the hang tag (`n11`, `n11b`), the member and call type paths (`n13`), identity keys (`n14`, `n15`), and the out-of-reach grammar shape (`n10`).
- **Pre-commitment order.** `f74b0c10` holds the rows and their hashes; this section and the tasks came after, and the rows were not edited. The prototype matched every row on its first round.
- **Assert only what you own.** Task 1: the scheme; Task 2: engine answers; Task 3: the runner-level repro sites, tags and keys; the checker: every corpus key.
- **No `!`, no em dashes, no corpus source text.** Checked by grep before each commit.

## Notes: upstream grammar observations (draft, not filed)

**Draft issue for SShadowS/tree-sitter-al: "`#if` inside a procedure header (around a named return) turns the whole procedure into ERROR".**

> A preprocessor block that covers only PART of a procedure header, here the named return value and its type, does not parse. `alc` accepts it under every symbol subset.
>
> ```al
> codeunit 50100 "Repro"
> {
>     procedure Pick(X: Integer)
> #if CLEAN27
>     Result: Text
> #else
>     Result: Integer
> #endif
>     begin
>         Glob := X;
>     end;
>
>     var
>         Glob: Integer;
> }
> ```
>
> Expected: a procedure node (or a split shape like `preproc_split_procedure`) whose `return_value` / `return_type` sit inside the arms. Actual: an `ERROR` node starting at `procedure`, with the `#if` parsed as a `var_section` fragment, so nothing after it in the member is structured. The same happens when only the type is conditional (`Result:` then `#if` / `Text` / `#else` / `Integer` / `#endif`). Not seen in DC/Cloud, System Application, BusinessFoundation or BaseApp (0 such ERROR nodes), so it is a completeness gap rather than an urgent one.

## Open questions for the orchestrator

1. **The scheme bump with zero moves in DC/Cloud and System Application.** Every user's history, resume and marks under scheme 2 will be refused once. The rule says bump (full BaseApp and two repros move keys for unchanged source). Confirm the bump, rather than a narrower rule such as "bump only when a measured corpus moves".
2. **Trigger names.** A trigger's named return is unknown, like every other trigger header name since R330. Resolving trigger header names (parameters, locals, the named return) would add sites in 46 BaseApp triggers at least. File it as its own roadmap item, or leave it?
3. **`gate-receipt.test.ts`.** "a CHALLENGED skip exits non-zero" times out at 5 s on master and on the prototype alike. File it (it is not R-323's), or is it already known?

## Task 1 inventory

With `IDENTITY_SCHEME = 3` on the prototype (`$S/logs/proto-bun-test-scheme3.txt`): 4502 pass, 7 skip, 6 fail, and each is the bump, not the engine change:

| test | why it fails | the change |
| --- | --- | --- |
| `packages/runner/itest/harden-fixture.test.ts:130`, "C02-03: the committed mark names exactly the planted equivalent" | `fixtures/sandbox-harden/lethal.equivalent.json` says scheme 2 | the marks file says 3 (its keys are byte-identical under R-323, Task 4 Step 3) |
| `packages/runner/tests/report-equality.test.ts` snapshot | `"identityScheme": 2` in the committed snapshot | `--update-snapshots`; the diff is that one line |
| `packages/runner/tests/resume.test.ts:450`, "a run with no exclusions adds nothing to the digest" | pins the base fingerprint's digest, which always includes the scheme: `9604b7d7987ab876007d8eb32d8d342afee7a63d40cf06e102d7b0818083b2d5` | the scheme-3 digest, `4a8c47ac5cc066d0bac1cdb266019d760a52e4debe2afcf465e76d803c8a288a`, with a comment naming R323 |
| `resume.test.ts:466`, "no preprocessor symbols, or an empty list, keeps the pre-symbol digest" | the same pinned digest | the same constant |
| `resume.test.ts:1779`, "the report carries the identity scheme it was keyed under" | expects the literal 2 | `IDENTITY_SCHEME` |
| `resume.test.ts:1832`, "--resume-run of an old-scheme run is refused by name" | its message regex names `scheme 2` | the regex is built from `IDENTITY_SCHEME` |

The two literal-2 marks in `equivalence-marks.test.ts` (L46, L101 to L102) and `resume.test.ts:1866` did NOT fail: they pass their own scheme explicitly, so they mean "some scheme" and stay. `gate-receipt.test.ts` passed on this run, so its timeout is intermittent.
