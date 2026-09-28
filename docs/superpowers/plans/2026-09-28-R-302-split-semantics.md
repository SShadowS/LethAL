# R-302: semantic resolution and the body walks see inside both split-header procedure shapes, so their sites are generated as in a plain procedure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r1 (2026-09-29), draft for the orchestrator's review.** Written in two commits on purpose. The first commit holds the measurements, the decisions and the PRE-COMMITMENT (the expected mutants per repro and per corpus, by member, operator and line). The prototype check and the tasks are added by a second commit, so git history shows the pre-commitment was written before any prototype fix existed.

**Goal:** Inside a `preproc_split_procedure` (R301: one header per `#if` arm, one shared `var` section and body) and a `preproc_split_procedure_preamble` (R316: one header and one `var` section per arm, one shared body), every walk that today stops only at `procedure` treats the split member as a procedure. So locals, parameters and the return type resolve, the member is a member of its object in the symbol table, and every operator finds the same sites it finds in the member's de-preprocessed twin, except where the arms disagree about a name, which then resolves to nothing.

**Architecture:** One engine change of meaning: `findEnclosingProcedure` (`packages/engine/src/ast/tree-walks.ts`) returns the nearest procedure-like node (`isProcedureLike`), and `buildSymbolTable` (`packages/engine/src/semantic/symbol-table.ts`) indexes a split member with the per-arm agreement rule below. `semantic/types.ts` drops its private procedure walk for the engine's. Every operator-local walk listed in R302 is widened to the same predicate, but only to the member's BODY, never to its header region (see Decision 3). No emission code changes.

**Tech Stack:** Bun, TypeScript, tree-sitter-al through the native parser addon (RUST-03; emission is claimed byte-identical to the WASM path), `bun:test`, `alc` (offline compile), a local `al-runner` v2.11.0 (`C:/Users/SShadowS/.dotnet/tools/al-runner.exe`). No container is used for planning.

**Spec:** `docs/roadmap/R302.md` (widened by R316), `H:/lethal-coord/tasks/R-302/task.md`. Siblings: `docs/roadmap/R301.md`, `R316.md`, `R318.md`. Precedent plans: `docs/superpowers/plans/2026-09-28-R-316-preamble-member.md` and `2026-09-28-R-309-split-preamble.md` (their fail-fast scripts, checker rules, red-checks and serial probes are carried over).

---

## What was measured at plan time (HEAD `00e514c4`, 2026-09-28 and 29)

Every repro is hand-written with invented names. No corpus source is quoted in this plan; corpus members are named, and lines are cited only as positions. `$S` is `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r302`. Tools, all scratch, all importing from `U:/Git/LethAL-wt/r302`:

| tool | what it does |
| --- | --- |
| `sites.ts` | runs `generateMutationSet` and `writeInstrumentedProject` on a project and prints one row per deployed mutant: `file:line`, operator, `procedureName`, `hangCapable`, identity key, `startIndex-endIndex`. No source text. |
| `capture.sh <label> <sites.ts>` | serial, fail-fast: runs `sites.ts` on every repro, on DC/Cloud and on the BaseApp scratch project into `$S/cap/<label>/`. |
| `split-census.ts` | lists every split node with its per-arm name, modifier, parameter names and types, return type and var names. |
| `twin.ts <src> <out> <arm>` | writes a DE-PREPROCESSED TWIN: the split node's `#if`/`#elif`/`#else`/`#endif` markers and every arm except `<arm>` are overwritten with spaces, newlines kept. Every byte offset and line is unchanged, so a twin's mutants join the split file's by position. In-body `#if` blocks are untouched. |
| `check-sites.ts <before> <after> <expect>` | the checker (rules below). |
| `kids.ts`, `ptree.ts` | print a node's direct children, or the named-node tree of a line range, as kinds and fields only. |
| `alc-plain.ts`, `alc-all.ts`, `alrunner-probe.ts`, `check-probe.ts`, `identity-keys.ts`, `locate.ts`, `keys-diff.ts`, `verdict-diff.ts` | R-316's, copied and repointed to this worktree. |

The native parser changed the parse API (`parseAL` now returns a flat tree; wrap it with `wrapRoot`), so R-316's `preamble-census.ts` and `shape.ts` do not run as copied. `split-census.ts` replaces them.

### The checker

`check-sites.ts` joins the two captures on (file, `startIndex-endIndex`, operator). A duplicate join key in either capture is a FAIL. The expectation file has `+` rows (a new mutant, consumed exactly once), `-` rows (a mutant that disappears, exactly once), and `k` rows (an existing mutant whose identity key may change, exactly once). Every other BEFORE row must reappear with the same `procedureName`, `hangCapable` and identity key (the full id map), every AFTER row must be a BEFORE row or a consumed `+` row, and every expectation row must be consumed. A change of `hangCapable` is a `-` row plus a `+` row.

Red-checked on `q1-twin-body` (`$S/rc/`): dropping a `+` row, duplicating one, adding an unused `k` row, a duplicated AFTER row, a changed key and a changed `hangCapable` each FAIL; the unedited expectation against HEAD itself (no fix) FAILs with the three missing rows; the unedited expectation against the twin PASSes.

### Census (`split-census.ts`)

| corpus | files | `preproc_split_procedure` nodes | preamble nodes | arms |
| --- | --- | --- | --- | --- |
| DC/Cloud (`U:/Git/DC/Cloud`, 1135 files) | 3 | 11 | 0 | every node has ONE arm: `#if not CLEAN27`, a `#pragma warning disable` line, the header, a `#pragma warning restore` line, `#endif` |
| BaseApp (`U:/Git/BC.History/BaseApp`, 9620 files) | 4 | 11 | 0 | every node has two arms (`#if not CLEAN27` or `#if not CLEAN26`, `#else`) |
| System Application (1718), BusinessFoundation (104) | 0 | 0 | 0 | |
| every `fixtures/*` project | 0 | 0 | 0 | no `#if`, `#else`, `#elif` or `#endif` line at all |

The task text says "DC/Cloud has 3 split procedures, BaseApp has 4". Those are FILE counts; there are 11 split members in each. The pre-commitment below is per member, all 22.

Where the BaseApp arms disagree (the only corpus disagreements):

- `OnBeforeUpdateColumnCaptions` (`AccScheduleOverview.Page.al`): one parameter's type differs between arms. Its body is empty.
- `CalcRoutingLineCosts` (`MfgCalculateBOMTree.Codeunit.al`): arm 1 has one extra `var` parameter of a codeunit type. The body uses it only as a call RECEIVER, and only inside in-body `#if not CLEAN27` blocks.
- `GetSalesHeaderPageID` (`PageManagement.Codeunit.al`): arm 1 has a named return value, arm 2 does not. The return type (`Integer`) agrees.

Two more facts the fix must respect, both measured with `ptree.ts`:

- In BaseApp's `OAuth20Setup.Table.al` and `AccScheduleOverview.Page.al`, arm 1 holds an `[Obsolete('<text>', '<version>')]` attribute INSIDE the arm, so the attribute and its two `string_literal`s are children of the split node. An attribute before a plain `procedure` is a sibling of the procedure node, not a child. So a body walk widened to "any procedure-like ancestor" would claim those literals. That is 16 string literals in `OAuth20Setup` alone, none inside executable code (the `Clustered = true` failure `flip-boolean-literal`'s doc comment records, one node kind over).
- In DC, every `#pragma` line of a split node is a child of the split node too.

### The places (R302's list, re-read at HEAD)

| # | place | today | the change |
| --- | --- | --- | --- |
| 1 | `buildSymbolTable`'s `indexMembers` (`semantic/symbol-table.ts`) | indexes direct `procedure` members only | also index a split member (Decision 2) |
| 2 | the private `findEnclosingProcedure` in `semantic/types.ts` (`resolveIdentifierType`) | stops at `procedure` | deleted; use the engine's |
| 3 | the engine's `findEnclosingProcedure` (`ast/tree-walks.ts`), read by `semantic/receiver.ts` (`lookupVar`) and `builtin-tier1/src/return-value.ts` | stops at `procedure` | nearest procedure-like node |
| 4 | `return-value.ts`'s `resolveReturnType` | reads `return_type` of the node, which is the FIRST arm's on a split node | reads the agreed return type (Decision 2) |
| 5 | `empty-block.ts`'s `BODY_PARENT_KINDS` | no split kind | a `code_block` whose parent is procedure-like |
| 6 | the executable-body tests: `flip-boolean-literal.ts` (`BODY_ANCESTORS`), `toggle-blank-string.ts`, `toggle-blank-temporal.ts`, `shift-integer.ts` (two walks), `loop-skip.ts`, `loop-truncate.ts` | allow-list of `procedure` and `trigger_declaration` | also the BODY of a procedure-like node (Decision 3) |
| 7 | `loop-hazard.ts`'s `SCOPE_KINDS` (three walks) | `procedure`, `trigger` | also procedure-like |
| 8 | `builtin-tier2/src/write-txn-codeunit-run.ts`'s `enclosingBody` | `procedure`, `trigger` | also procedure-like |
| 9 | `semantic/callers.ts`'s `enclosingProcedureName` | `procedure` | procedure-like, named by `procedureLikeNameNode` |
| 10 | `receiver.ts`'s `declaresProcedure` (Tier-2 rule 3: does the table declare a procedure of that name) | `procedure` members only | also a split member, matched by ANY arm's name (Decision 2) |
| 11 | `receiver.ts`'s `nameOf` fallback (used when the positional lookup misses) | `childForFieldName("name")`, the first arm's name | `procedureLikeNameNode`, so a renamed member has no name fallback |

Place 10 is not in R302's text; it is the same blindness (a split member is not a member of its object), and it points the unsafe way: at HEAD, a table that declares `SetRange` as a split member does not stop Tier 2 from CLAIMING `R.SetRange(...)` (repro `d5`, and `d6` where only one arm has that name). The claim mislabels the site and, by precedence, deletes the Tier-1 `void-method-call` there.

Not changed: the schemata and runner walks (`enclosingProcedureLike`, `gapBlockOf`, the line maps, the latch writer), which R301 and R316 already widened; `swap-rec-xrec.ts` (it walks to a TRIGGER only); `cfg.ts` (it reads the body by kind and works on a split node as is; nothing calls it for one).

### The repros (`$S/repro/<name>/`)

Each has the R-303 repro `app.json`. Every repro that contains a split member compiles UN-instrumented (`alc-plain.ts`) under every symbol subset, except `k1-dc-shape`, which mirrors DC's one-arm shape and so compiles only with `CLEAN27` undefined (with it defined the header is compiled out; DC itself is built that way).

| repro | shape | what it pins | symbols |
| --- | --- | --- | --- |
| `q1-twin-body` | a preamble `Pick` beside a plain `Twin` with the same body (R-316's) | the headline: `Pick` 4 mutants where `Twin` has 7 | CLEAN27 |
| `q2-split-twin` | the same with a `preproc_split_procedure` (R-316's) | the same, R301 shape | CLEAN27 |
| `t5-loss-split` | a split member over a project table: record calls, strings, booleans, `+`, `exit` (R-297's) | every operator in R302's table except the loop ones | CLEAN27 |
| `t5-lit-split` | a split member with `I := 5`, `0D`, `Modify(true)`, `exit(I > 3)` (R-297's) | `shift-integer`, `toggle-blank-temporal`, receiver on a non-project table | CLEAN27 |
| `t5-hang-split` | a split member with `while I < 10 do I := I + 1;` and `repeat Done := true; until Done;` (R-297's) | the missing hang tag, `loop-skip`, `loop-truncate` | CLEAN27 |
| `t5-loss-twin`, `t5-lit-twin`, `t5-hang-twin` | R-297's plain twins | controls: no split member, so nothing may change | none |
| `k1-dc-shape` | DC's shape: one-arm `#if not CLEAN27` with `#pragma` lines, a `var` record parameter over a project table, `SetRange` twice, `SetFilter` with `'%1\|%2..'`, `<> ''`, `exit(<rec>.FindFirst())`; and a second one-arm member with a `true` argument | the corpus shape offline | CLEAN27 (only `[]` compiles) |
| `k2-baseapp-shape` | BaseApp's shape: two arms, arm 1 has an extra codeunit `var` parameter used only as a receiver in an in-body `#if`; shared `Decimal` locals; `false`/`true` arguments; a second member with a named return in one arm only | the corpus shape offline | CLEAN27, CLEAN26 |
| `a1-attribute-in-arm` | an `[Obsolete('...', '...')]` attribute inside arm 1, and `[IntegrationEvent(false, false)]` / `[IntegrationEvent(true, false)]` inside each arm of a second member | no site may come from an attribute inside an arm | CLEAN27 |
| `c1-preamble-then-renamed-split`, `c2-renamed-split-then-preamble`, `c3-preamble-then-overload` | R-316's collision repros | identity keys; a renamed member stays unnamed | CLEAN27 |
| `d1-arg-type-differs` | a split `Pick(X: Integer; Y: Integer)` / `Pick(X: Integer; Y: Text)`, body `Show(X, Y)` with overloads `Show(Integer; Integer)` and `Show(Integer; Text)`; object global `Y: Integer` | a disagreeing parameter resolves to nothing, and does NOT fall through to the global | CLEAN27 |
| `d2-return-differs` | a split `Pick(...): Decimal` / `Pick(...): Integer`, body `K := X + 1; exit(K);` | a disagreeing return type resolves to nothing | CLEAN27 |
| `d3-arm-only-local` | a preamble whose arm 1 declares `N: Integer` and arm 2 declares nothing; `N` is used only inside an in-body `#if CLEAN27`; object global `N: Text` | a name declared in some arms only resolves to nothing | CLEAN27 |
| `d4-receiver-differs` | a preamble whose arms declare `R` as `Record "Repro Tab A"` and `Record "Repro Tab B"` | a disagreeing receiver gets no Tier-2 claim | CLEAN27 |
| `d5-split-shadows-setrange` | a table declaring `SetRange` as a split member (both arms), and a plain procedure elsewhere calling `R.SetRange(Code, C)` on it | place 10 | CLEAN27 |
| `d6-renamed-shadows-setrange` | `d5` with arm 2 renamed to `SetRangeOld` | place 10 reads ANY arm | CLEAN27 |
| `d7-caller-return` | two split members `Same(): Integer` (both arms) and `Differs(): Decimal` / `Differs(): Integer`, called as `Glob := Same(1) + 1; Glob := Differs(1) + 1;` in a plain procedure | the one effect OUTSIDE a split member: a call's return type | CLEAN27 |

Negative control, measured (`$S/neg/`, `alc-plain.ts`): `d1` with the call swapped the way a first-arm-wins rule would swap it (`Show(Y, X)`) compiles with `CLEAN27` and FAILS without it, `AL0133: Argument 1: cannot convert from 'Text' to 'Integer'`. So a fix that took arm 1's parameter types, or that fell through to the global `Y: Integer` after dropping the conflicting parameter, emits a mutant that breaks the build. For `d2` the equivalent (`exit(0.0)` in the `Integer` build) COMPILES: AL converts `Decimal` to `Integer` implicitly. So `d2` pins the rule, not a compile hazard; this plan says so rather than claiming a false site there.

### Today (HEAD `00e514c4`), deployed mutants (`$S/cap/head/`)

| repro | deployed | | repro | deployed |
| --- | --- | --- | --- | --- |
| `q1-twin-body` | 11 (`Pick` 4, `Twin` 7) | | `d1-arg-type-differs` | 6 |
| `q2-split-twin` | 11 (`Pick` 4, `Twin` 7) | | `d2-return-differs` | 1 |
| `t5-loss-split` | 15 | | `d3-arm-only-local` | 0 |
| `t5-lit-split` | 5 | | `d4-receiver-differs` | 3 |
| `t5-hang-split` | 3, no hang tag | | `d5-split-shadows-setrange` | 2 (a `remove-setrange` claim) |
| `t5-loss-twin`, `t5-lit-twin`, `t5-hang-twin` | 29, 10, 8 | | `d6-renamed-shadows-setrange` | 2 (a `remove-setrange` claim) |
| `k1-dc-shape` | 10 | | `d7-caller-return` | 3 |
| `k2-baseapp-shape` | 6 | | `a1-attribute-in-arm` | 2 |
| `c1`, `c2`, `c3` | 4, 4, 6 | | | |
| DC/Cloud | 97132 deployed, 102584 raw | | BaseApp scratch (the 4 files) | 1509 deployed, 1537 raw |

The BaseApp scratch project is `$S/ba-split`: the 4 affected files at their BaseApp paths and the R-303 repro `app.json`. It is exploratory, as R-303's was: without the rest of BaseApp, a name that resolves to a BaseApp table or codeunit elsewhere does not resolve here, so its numbers describe this project, not BaseApp.

---

## Decisions

### 1. Close R302 whole, not only the three operators

The orchestrator names `empty-block`, `return-value` and one `swap-additive`, which is what `q1`/`q2` show. R302's closing criterion is wider ("those walks treat a split procedure as a procedure, with a test per place"), and the corpora need the wider fix: BaseApp's `CalcRoutingLineCosts` gains 4 `flip-boolean-literal` sites, DC's `FilterAppvlSharingToUserComp` a `toggle-blank-string` site, and DC's three `Filter...` members 7 Tier-2 claims, none of which the three-operator fix would find. Each place is a one-predicate change, so the cost is the tests.

### 2. The per-arm rule

R316 states it as "a name inside the shared body may be resolved to a type only when every arm that declares it agrees". This plan reads it STRICTLY, and flags the reading as an open question:

- **Parameters and arm locals.** A name resolves when EVERY arm declares it (as a parameter, or in the arm's own `var` section for a preamble) with the same type text (whitespace-normalised, the text `extractType` compares). A shared `var` section's locals (the R301 shape) belong to every arm and always resolve.
- **Ambiguous names.** A name that some arms declare and others do not, or that arms declare with different types, is AMBIGUOUS: it resolves to nothing, and it also HIDES the object's global of the same name. Without the hiding, `d1` resolves `Y` to the global `Integer` and emits the swap that fails `alc` (AL0133, measured above).
- **Return type.** The agreed return-type text across arms, else none. A named return value is not resolved, which is what HEAD does for a plain procedure too (parity, not a new rule).
- **Why strict.** The looser reading ("only the arms that declare it") would resolve `d3`'s `N` and `CalcRoutingLineCosts`'s extra parameter. That is safe in those two cases because every use sits in an in-body `#if` compiled only with that arm, but the rule cannot see that; outside such a block the looser reading types a name by one arm while another build compiles the same text against a global. Strict refuses sites (under-generation, the safe direction) and never types a name by the wrong build. On the corpora the two readings give the same sites (the extra parameter is only ever a call receiver of a codeunit type, which no operator claims).
- **Refusal guards read ANY arm.** Place 10 asks "could this table's `SetRange` be a project procedure?"; a split member answers yes if any arm has that name (`d6`). A refusal that reads "every arm" would re-open the wrong claim in the build where the arm exists.
- **A renamed member** (arms disagree on the name, R301's and R318's case) is indexed by POSITION only (`resolveProcedureAt`), never by name. So the body of a renamed member resolves (the positional lookup does not need a name), but a call by either name does not resolve to it, and its `procedureName` stays `""` (R318 is unchanged).

### 3. The body walks widen to the member's BODY only

Place 6's walks are allow-lists ("is this inside executable code"). For a plain `procedure`, "under a `procedure` node" is the same as "in its body or its header", and the header holds no literal. For a split node it is not: an attribute inside an arm is a child of the split node (BaseApp `OAuth20Setup`, `AccScheduleOverview`; repro `a1`). So each widened walk admits a split node only when the literal is inside the split node's `code_block` (its body), and one engine helper states that once, next to `isProcedureLike`, for every walk to call. The twin oracle below agrees: a twin's attribute is a sibling of its procedure, and no twin claims an attribute literal.

### 4. Identity keys

A new mutant in a named split member gets that member's name, as every existing mutant there already does (R301, R316). Existing mutants change in exactly three ways, all pre-committed below:

- A `void-method-call` that a Tier-2 claim now takes over by precedence DISAPPEARS, and a Tier-2 mutant appears at the same span (DC: 7; `t5-loss-split`: 1; `k1-dc-shape`: 3). This is R302's "operator swap at one call".
- A mutant gains `hangCapable: "loop-condition-target"` (`t5-hang-split`: 2). The tag is not part of the identity key.
- An identical site in a same-named overload AFTER an agreeing split member, under the same operator, is renumbered, because the split member now contributes the same site to that name's twin group (`c3`: the overload's `empty-block` and `return-value` gain ordinal 1). The same mechanism R316 measured for the procedure part.

And the one reverse change: `d5` and `d6` lose a wrong `remove-setrange` claim and get the `void-method-call` HEAD should have given.

### 5. Live gate: not needed, with a stated STOP

The change decides which specs exist; it changes no emission code (the wrapper, the reach latch, the markers, the line maps and the manifest walks are untouched, and R301 and R316 already made them see both shapes). What each kind of evidence proves here:

- `alc`, every repro, every symbol subset: each new mutant's emitted AL compiles in every build, the false-site case included (`d1` would fail).
- al-runner, local, one-shot, coverage on and off, every subset, serially: each new mutant runs and gets a verdict, and each split member's verdicts equal its twin's (R-316's `verdict-diff.ts`).
- The manifest, offline: each new mutant in a split member has the same `reachGrain`, member lines and gap block as its twin's mutant at the same span (Task 4). The marker is placed by the same code for both.

What a bcdev gate would add is live proof that a marker in a split member fires per test. R-316's Cronus28 gate proved that for the preamble's body statements, on both symbol configurations, with a negative control, and nothing here changes marker placement. So no live gate is planned. **STOP rule:** if Task 4 finds any new split-member mutant whose `reachGrain` differs from its twin's, or a mutant kind whose marker lands anywhere but inside the shared body, stop and ask the orchestrator for a Cronus28 gate before merging.

---

## PRE-COMMITMENT (written and committed before any prototype fix)

### How the expected sets were derived

1. **The definition.** R302 closes when a site inside a split member "is generated with the same operator and text as in its de-preprocessed twin". So the expected set for a member whose arms agree is what HEAD, unchanged, generates for its twin: `twin.ts` blanks the markers and the other arms, keeps every offset, and HEAD's `sites.ts` runs on the result (`$S/twin/`, `$S/dc-twin`, `$S/ba-a1`, `$S/ba-a2`). This runs no fix: it runs HEAD on a plain procedure, the shape HEAD already handles.
2. **Every arm.** Each two-arm repro and BaseApp was twinned twice (arm 1 kept, arm 2 kept). For every repro whose arms agree, and for all of BaseApp, the two twins' captures are IDENTICAL (`diff` empty).
3. **Then the rule, by hand.** Where arms disagree, the expected set is the twins' sites minus every site whose operator reads an ambiguous name or a disagreeing return type (Decision 2), and a renamed member keeps `procedureName` `""` where the twin names it. Each such adjustment is listed with its reason. For DC (one arm) the rule changes nothing. For BaseApp, the three disagreeing members were read site by site: `OnBeforeUpdateColumnCaptions` has an empty body; every `CalcRoutingLineCosts` site reads only parameters and shared locals both arms declare identically (the extra parameter is only a call receiver of a codeunit type, which no operator types); `GetSalesHeaderPageID`'s return type agrees and no site reads the named return value.
4. **Then an audit, by hand.** Every `+` and `-` row was checked against its operator's rule: `empty-block` for each non-empty body; `return-value` for `exit(<expr>)` in a `Boolean` or numeric member, never `exit(0)`; `swap-additive` for `+` on two numeric operands; `swap-call-arguments` for the first pair of distinct same-typed identifier arguments; `flip-boolean-literal`, `toggle-blank-string`, `toggle-blank-temporal` and `shift-integer` for literals in the body; `remove-setrange`, `swap-modify-flag`, `swap-find-direction`, `validate-to-assign` and `flip-filter-literal` for calls on a record receiver whose table the project does not shadow, with `remove-setrange` taking the span from `void-method-call` by precedence; the loop operators and the hang tag for `while`/`repeat`.

The expectation files are `$S/expect/<name>.txt`, in the checker's format; the rows below are the same content. Lines are 1-based file lines, as the manifest's `startLine`.

### Repros

| repro | HEAD | expected | `+` | `-` | `k` |
| --- | --- | --- | --- | --- | --- |
| `q1-twin-body` | 11 | 14 (`Pick` 4 to 7) | 3 | 0 | 0 |
| `q2-split-twin` | 11 | 14 (`Pick` 4 to 7) | 3 | 0 | 0 |
| `t5-loss-split` | 15 | 29 | 15 | 1 | 0 |
| `t5-lit-split` | 5 | 10 | 5 | 0 | 0 |
| `t5-hang-split` | 3 | 8 | 7 | 2 | 0 |
| `t5-loss-twin`, `t5-lit-twin`, `t5-hang-twin` | 29, 10, 8 | unchanged | 0 | 0 | 0 |
| `k1-dc-shape` | 10 | 17 | 10 | 3 | 0 |
| `k2-baseapp-shape` | 6 | 16 | 10 | 0 | 0 |
| `a1-attribute-in-arm` | 2 | 5 | 3 | 0 | 0 |
| `c1-preamble-then-renamed-split` | 4 | 8 | 4 | 0 | 0 |
| `c2-renamed-split-then-preamble` | 4 | 8 | 4 | 0 | 0 |
| `c3-preamble-then-overload` | 6 | 8 | 2 | 0 | 2 |
| `d1-arg-type-differs` | 6 | 9 | 3 | 0 | 0 |
| `d2-return-differs` | 1 | 3 | 2 | 0 | 0 |
| `d3-arm-only-local` | 0 | 2 | 2 | 0 | 0 |
| `d4-receiver-differs` | 3 | 4 | 1 | 0 | 0 |
| `d5-split-shadows-setrange` | 2 | 2 | 1 | 1 | 0 |
| `d6-renamed-shadows-setrange` | 2 | 2 | 1 | 1 | 0 |
| `d7-caller-return` | 3 | 4 | 1 | 0 | 0 |

The rows, by member, operator and line:

- `q1-twin-body`, `Pick` (preamble): `+` `empty-block` L22 (the shared body); `+` `swap-additive` L24 (`X` is a parameter both arms declare `Integer`); `+` `return-value` L26 (both arms return `Integer`). `Twin` unchanged, and no key of `Twin` changes (different procedure part).
- `q2-split-twin`, `Pick`: `+` `empty-block` L20, `swap-additive` L22, `return-value` L24. Same reasons.
- `t5-loss-split`, `A`: `+` `empty-block` L13; L15 `-` `void-method-call`, `+` `remove-setrange` (the receiver resolves to the project table, which does not shadow `SetRange`) and `+` `flip-boolean-literal`; `+` `swap-find-direction` L16; `+` `validate-to-assign` L17; `+` `swap-modify-flag` L18 and L20; `+` `flip-boolean-literal` L19 and L26; `+` `toggle-blank-string` L21, L22, L23; `+` `swap-additive` L24 (`D + 1`, `Decimal` local) and L28 (`X + 1`); `+` `return-value` L28. The `void-method-call` mutants at L14, L17, L18, L19 and L20 stay: precedence removes a `void-method-call` only where a Tier-2 mutant has the same span, which here is `remove-setrange` alone.
- `t5-lit-split`, `A`: `+` `empty-block` L12, `shift-integer` L13, `toggle-blank-temporal` L14, `swap-modify-flag` L15 (a table the project does not declare, so nothing shadows `Modify`), `return-value` L17 (`Boolean`, both arms).
- `t5-hang-split`, `A`: `+` `empty-block` L11, `loop-skip` L12, `swap-additive` L13 with hang tag, `flip-boolean-literal` L15 with hang tag, `loop-truncate` L16; and `remove-assignment` L13 and L15 each change from no tag to `hangCapable: "loop-condition-target"` (a `-` and a `+` row each). Keys unchanged.
- `k1-dc-shape`, `Filter`: `+` `empty-block` L8; L10, L11 and L14 each `-` `void-method-call`, `+` `remove-setrange`; `+` `flip-filter-literal` L12 (the `void-method-call` there stays); `+` `toggle-blank-string` L13 (`<> ''`); `+` `return-value` L15; `+` `swap-find-direction` L15 (`FindFirst()` with parentheses; DC spells it without them, and DC's twin has no such row). `Guard`: `+` `empty-block` L23, `flip-boolean-literal` L26.
- `k2-baseapp-shape`, `Calc`: `+` `empty-block` L11; `+` `swap-call-arguments` L12, L14 (inside the in-body `#if`, arguments are both-arm parameters) and L17 (shared locals); `+` `flip-boolean-literal` L16 twice. `PageId`: `+` `empty-block` L25, `shift-integer` L26 (the `1` in `Kind = 1`), `return-value` L27 and L28 (`Integer` in both arms; the named return in arm 1 is not read).
- `a1-attribute-in-arm`, `Pick`: `+` `empty-block` L11, `toggle-blank-string` L12, `return-value` L13. NO row on L4 (the attribute's two strings) or on L16 and L19 (the attributes' booleans). `OnPick` (empty body): nothing.
- `c1-preamble-then-renamed-split`: `Pick` `+` `empty-block` L12, `return-value` L14; the renamed member `+` `empty-block` L24, `return-value` L26, both with `procedureName` `""` (its twin would name it `AIf`; Decision 2 keeps it unnamed). No existing key changes: the renamed member's new mutants join the `""` group and nothing there shares their hash and operator.
- `c2-renamed-split-then-preamble`: renamed member `+` `empty-block` L10, `return-value` L12 (`""`); `Pick` `+` `empty-block` L24, `return-value` L26. No existing key changes.
- `c3-preamble-then-overload`: `Pick` (preamble) `+` `empty-block` L12, `return-value` L14; `k` the overload's `empty-block` L18 and `return-value` L20 (same body hash, same name `Pick`, same operator, after the preamble: each gains ordinal 1).
- `d1-arg-type-differs`, `Pick`: `+` `empty-block` L10, `swap-additive` L12 (`X`, both arms `Integer`), `return-value` L13. NOT `swap-call-arguments` L11: `Y` is ambiguous (arm 1 `Integer`, arm 2 `Text`) and hides the global `Y: Integer`. Both twins disagree here (arm 1 has the swap, arm 2 does not), which is the case the rule exists for.
- `d2-return-differs`, `Pick`: `+` `empty-block` L10, `swap-additive` L11. NOT `return-value` L12 (return type `Decimal` against `Integer`). Both twins have a `return-value` there, with different mutated text (`0.0` and `0`); the rule refuses it.
- `d3-arm-only-local`, `Pick`: `+` `empty-block` L10, `return-value` L15 (`exit(Glob)`, `Integer` in both arms). NOT `swap-additive` L13 (`N` is declared by arm 1 only; the arm-1 twin has it, the arm-2 twin does not). Strict reading, open question 1.
- `d4-receiver-differs`, `Pick`: `+` `empty-block` L12. NOT `remove-setrange` L13, `swap-find-direction` L14 or `swap-modify-flag` L15, which both twins have: `R` is ambiguous. The `void-method-call` and `negate-guard` mutants HEAD has there stay.
- `d5-split-shadows-setrange` and `d6-renamed-shadows-setrange`, `Pick` (a PLAIN procedure): L7 `-` `remove-setrange`, `+` `void-method-call`. In `d6` the arm-2 twin has no `SetRange` member and would claim; place 10 reads any arm.
- `d7-caller-return`, `Caller` (a plain procedure): `+` `swap-additive` L21 (`Same(1)` now types as `Integer`). NOT L22 (`Differs` has no agreed return type).

### DC/Cloud (whole project, `U:/Git/DC/Cloud`)

Expected: deployed 97132 to **97144** (+12), raw 102584 to **102603** (+19): 19 `+` rows, 7 `-` rows, 0 `k` rows, and every other mutant's identity key unchanged.

| file | member | HEAD | expected | rows |
| --- | --- | --- | --- | --- |
| `Modules/Approvals/Codeunits/CDCApprovalForwardSubscr.Codeunit.al` | `OnBeforeInsert` | 2 | 4 | `+` `empty-block` L19; `+` `flip-boolean-literal` L23 |
| `Modules/Approvals/Codeunits/CDCApprovalManagement.Codeunit.al` | `FilterApprovalSharingToUser` | 4 | 7 | `+` `empty-block` L657; L660, L661 `-` `void-method-call`, `+` `remove-setrange`; `+` `flip-filter-literal` L662; `+` `return-value` L663 |
| same | `FilterApprovalSharingFromUser` | 4 | 7 | `+` `empty-block` L671; L674, L675 `-` `void-method-call`, `+` `remove-setrange`; `+` `flip-filter-literal` L676; `+` `return-value` L677 |
| same | `FilterAppvlSharingToUserComp` | 7 | 11 | `+` `empty-block` L685; L689, L690, L693 `-` `void-method-call`, `+` `remove-setrange`; `+` `flip-filter-literal` L691; `+` `toggle-blank-string` L692; `+` `return-value` L694 |
| same | `OnGetOutOfOfficeOnAfterSetFilter`, `OnBeforeInsertSharedApprovalEntryInTemp`, `OnSetOutOfOfficeOnBeforeInsertApprovalSharing`, `OnAfterSetOutOfOffice` | 0 each | 0 each | none: empty bodies |
| `.dependencies/DC/Codeunit/CDCPurchApprovalEMail.Codeunit.al` | `OnBeforeSetSharedReminderHTMLBody2`, `OnAfterFilterSharedApprEntry`, `OnBeforeIncludeApprovalEntryInEmail` | 0 each | 0 each | none: empty bodies |

Reasons: every node has one arm, so every name agrees and the rule is the twin. The receiver is a `var` parameter of a project table, so `SetRange` is claimed by Tier 2 (`remove-setrange`) and the `void-method-call` there goes by precedence; `SetFilter` keeps its `void-method-call` and gains `flip-filter-literal`; the parenthesis-free `FINDFIRST` gets no `swap-find-direction`, as in the twin; the `SETRANGE` with a date range (`0D, TODAY`) is a `remove-setrange` like the others; `0D` inside a call's arguments gets no `toggle-blank-temporal` in the twin either.

### BaseApp scratch project (`$S/ba-split`, exploratory)

Expected: deployed 1509 to **1540** (+31), raw 1537 to **1568** (+31): 31 `+` rows, 0 `-`, 0 `k`, every other key unchanged. Both arm-twins give the same 31.

| file | member | HEAD | expected | rows |
| --- | --- | --- | --- | --- |
| `Finance/FinancialReports/AccScheduleOverview.Page.al` | `OnBeforeUpdateColumnCaptions` | 0 | 0 | none: empty body (its arms disagree on one parameter type; nothing reads it) |
| `Manufacturing/Inventory/BOM/MfgCalculateBOMTree.Codeunit.al` | `CalcRoutingLineCosts` | 7 | 18 | `+` `empty-block` L276; `+` `swap-call-arguments` L277, L279, L283, L284, L286, L288; `+` `flip-boolean-literal` L282 four times |
| `System/OAuth/OAuth20Setup.Table.al` | `SetToken` | 5 | 6 | `+` `empty-block` L194 |
| same | `GetTokenAsSecretText` | 2 | 3 | `+` `empty-block` L213 |
| same | `DeleteToken` | 2 | 3 | `+` `empty-block` L229 |
| same | `HasToken` | 2 | 4 | `+` `empty-block` L245; `+` `return-value` L246 |
| same | `RequestAuthorizationCode` | 4 | 5 | `+` `empty-block` L274 |
| same | `RequestAccessToken` | 4 | 7 | `+` `empty-block` L295; `+` `swap-call-arguments` L296, L298 |
| same | `RefreshAccessToken` | 3 | 4 | `+` `empty-block` L314 |
| same | `InvokeRequest` | 3 | 6 | `+` `empty-block` L331; `+` `swap-call-arguments` L332, L334 |
| `Utilities/PageManagement.Codeunit.al` | `GetSalesHeaderPageID` | 5 | 12 | `+` `empty-block` L297; `+` `return-value` L307, L309, L311, L313, L315, L317 |

(Paths are under `Source/Base Application/`.) Reasons: `CalcRoutingLineCosts`'s swaps all read two same-typed `Decimal` parameters or shared locals (two sit inside in-body `#if not CLEAN27` blocks, where the receiver is the arm-1-only parameter, which the swap does not read); its four booleans are literal call arguments. `OAuth20Setup`'s swaps read two `Text` parameters both arms declare. `GetSalesHeaderPageID`'s six `exit(<page id>)` get `return-value` (`Integer` in both arms); its `exit(0)` does not. And NO row in any `[Obsolete(...)]` attribute inside an arm (`OAuth20Setup` L188, L207, L223, L239, L266, L287, L306, L323; `AccScheduleOverview`'s), which a walk widened to the whole split node would admit (Decision 3).

### Everything else

- System Application and BusinessFoundation: no split node, so identity keys, manifests and emitted targets byte-identical to HEAD.
- Every fixture (`sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-harden`, `sandbox-coverage-probe`): no `#if` line and no split node, so hashes, identity keys, manifests and emitted targets byte-identical to HEAD. No frozen itest figure can move. If Task 0's census finds a split node in a fixture, that is a STOP: this plan's "fixtures stay byte-identical" premise is gone and the orchestrator decides.
- The three plain twins (`t5-*-twin`): unchanged.

**Prototype check:** added by the second commit, after this one. The rows above are not edited to match it.
