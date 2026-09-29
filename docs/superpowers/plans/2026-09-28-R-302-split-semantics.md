# R-302: semantic resolution and the body walks see inside both split-header procedure shapes, so their sites are generated as in a plain procedure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r3 (2026-09-29), final.** Review r2 (`H:/lethal-coord/reviews/R-302-plan/review-r2.md`) closed C1, C2, I1 and I2 and found one new Critical: identity reuse across an engine change. There is no round 3; the orchestrator verifies this change. What changed: Task 1A (the identity-scheme version, R325, filed in `d3941580`); the checker pins the EXACT old and new keys of every renumbering; the gate checker requires a whole-body row to be reached by its covering tests; the earlier "no live gate" and "System Application unchanged" passages are marked SUPERSEDED, not deleted. See "Revision r3" at the end. Task count: 9 (Task 0, Task 1A, Tasks 1 to 7).

**Revision r1, second commit (2026-09-29).** Adds "Prototype check" (measured after the pre-commitment commit `d0e094ac`: 22 of 23 checks matched on the second round, DC/Cloud and BaseApp exactly; one pre-committed row was wrong, `d4`, and one place was missing, `findEnclosingStatement`), then Global Constraints, Review Focus, File structure, Tasks 0 to 6, Self-review, Notes and Open questions. Nothing above "Prototype check" was edited.

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

### 5. Live gate: not needed, with a stated STOP (SUPERSEDED by revision r2: Task 5 is a mandatory Cronus28 gate)

The change decides which specs exist; it changes no emission code (the wrapper, the reach latch, the markers, the line maps and the manifest walks are untouched, and R301 and R316 already made them see both shapes). What each kind of evidence proves here:

- `alc`, every repro, every symbol subset: each new mutant's emitted AL compiles in every build, the false-site case included (`d1` would fail).
- al-runner, local, one-shot, coverage on and off, every subset, serially: each new mutant runs and gets a verdict, and each split member's verdicts equal its twin's (R-316's `verdict-diff.ts`).
- The manifest, offline: each new mutant in a split member has the same `reachGrain`, member lines and gap block as its twin's mutant at the same span (Task 4). The marker is placed by the same code for both.

**SUPERSEDED by revision r2** (Task 5 is a mandatory Cronus28 gate; kept for the record, not the decision). What a bcdev gate would add is live proof that a marker in a split member fires per test. R-316's Cronus28 gate proved that for the preamble's body statements, on both symbol configurations, with a negative control, and nothing here changes marker placement. So no live gate is planned. **STOP rule:** if Task 4 finds any new split-member mutant whose `reachGrain` differs from its twin's, or a mutant kind whose marker lands anywhere but inside the shared body, stop and ask the orchestrator for a Cronus28 gate before merging.

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

- **SUPERSEDED by revision r2 for System Application** (C2 adds 5 mutants there and renumbers one key; BusinessFoundation stays byte-identical). Original text: System Application and BusinessFoundation: no split node, so identity keys, manifests and emitted targets byte-identical to HEAD.
- Every fixture (`sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-harden`, `sandbox-coverage-probe`): no `#if` line and no split node, so hashes, identity keys, manifests and emitted targets byte-identical to HEAD. No frozen itest figure can move. If Task 0's census finds a split node in a fixture, that is a STOP: this plan's "fixtures stay byte-identical" premise is gone and the orchestrator decides.
- The three plain twins (`t5-*-twin`): unchanged.

**Prototype check:** added by the second commit, after this one. The rows above are not edited to match it.

---

## Prototype check (written AFTER the pre-commitment commit `d0e094ac`)

The prototype is a scratch worktree, `$S/proto`, detached at `d0e094ac`, with the native addon copied in and `$S/proto-patch.py` applied (the plan's design, places 1 to 11), then one more line (place 12, below). Its diff is `$S/proto-r2.patch`; its tools are `$S/pt/` (the same tools, pointed at `$S/proto`). It is compared with the pre-commitment by `check-all.sh`, which runs `check-sites.ts` for every expectation file against `$S/cap/head/`. The committed rows above are NOT edited. Where the prototype disagreed, the disagreement is recorded here, explained, and judged.

### Round 1: the design as committed (`$S/cap/proto-v1/`, `$S/logs/check-proto-v1.txt`)

**6 of 23 checks passed; 17 failed.** Every failure had the same shape: a pre-committed `empty-block` on a split member's body never appeared (every repro with a non-empty split body, DC's 4, BaseApp's 10), and BaseApp's `swap-call-arguments` at L279 and L288 and `k2`'s at L14 (all three inside an in-body `#if` in a split body) never appeared. The runner's warning said why: each was generated and then dropped as "not inside executable AL" (`isMutableSite`, `packages/schemata/src/enclosing.ts`), because `findEnclosingStatement` (`packages/engine/src/ast/tree-walks.ts`) treats a `code_block` as a statement only when its parent is in `BRANCH_PARENT_KINDS`, which lists `procedure` and not the split shapes. A plain procedure's body is its own statement; so is an in-body `#if`'s content, which climbs to the body. **That is a 12th place**, in neither R302's list nor this plan's table at `d0e094ac`. It is on the EMISSION path (`resolveSite` uses the same walk), so Decision 5's "no emission code changes" was wrong; see the corrections below.

The pre-commitment was right and the design was incomplete.

### Round 2: plus place 12 (`$S/cap/proto-v2/`, `$S/logs/check-proto-v2.txt`)

Place 12: `findEnclosingStatement`'s block case also admits a procedure-like parent. One line.

**22 of 23 checks pass.** Every repro but one matches its pre-committed rows exactly, and so do both corpora:

| scope | pre-committed | prototype |
| --- | --- | --- |
| DC/Cloud | 97144 deployed, 102603 raw; 19 `+`, 7 `-`, no other key moved | 97144, 102603; the same 19 and 7, no other key moved |
| BaseApp scratch | 1540 deployed, 1568 raw; 31 `+`, no other key moved | 1540, 1568; the same 31, no other key moved |
| every repro except `d4` | the rows above | the same rows |
| `d4-receiver-differs` | 4 deployed (`+` `empty-block` L12) | 5 deployed: also `flip-boolean-literal` L15 |

Every `.err` file (the runner's warnings, including the dropped non-executable-site count) is byte-identical to HEAD's on every repro and both corpora, so no generated site is now dropped.

**The one disagreement, `d4` L15, and the ruling: the pre-commitment was wrong.** The row is `flip-boolean-literal` on the `true` in `R.Modify(true)`. `flip-boolean-literal` cedes a `Modify(true)` argument to `swap-modify-flag` only when the receiver resolves to a record the project does not shadow (`claimsRecordMethod`). In `d4`, `R` is ambiguous by design, so `swap-modify-flag` does not claim and `flip-boolean-literal` keeps the site, exactly as it does for any unresolvable receiver in a plain procedure. The pre-commitment's reasoning for `d4` listed the Tier-2 claims that the ambiguous receiver loses and forgot this cession. The mutant (`R.Modify(false)`) compiles in both builds (alc below). So the implementation's expectation for `d4` is 5, and the correction is kept in a separate expectation set, `$S/expect-final/` (the committed rows plus this one row), which Task 4 checks against.

### Controls: each decision is load-bearing (measured on the prototype, then restored)

- **Decision 2's hiding off** (the `ambiguous` check removed from `resolveIdentifierType`): `d1` gains `swap-call-arguments` at L11, and the instrumented `d1` FAILS `alc` without `CLEAN27`: `AL0133: Argument 1: cannot convert from 'Text' to 'Integer'` (`$S/logs/n2-alc-d1.log`). That is the false site, through the real pipeline.
- **Decision 3 off** (`inMemberBody` answering yes for any procedure-like ancestor): `a1` gets 4 claimed sites (the four booleans in the two `[IntegrationEvent(...)]` attributes inside arms) that `isMutableSite` then drops as non-executable, so the runner's dropped-site warning and count move (`$S/cap/n1/`). BaseApp: 0. The plan's statement at `d0e094ac` that the 16 `Obsolete` strings in `OAuth20Setup` would be claimed was wrong: `toggle-blank-string` already refuses a string whose parent is not an expression it knows (`BEHAVIOURAL_PARENTS`), so attribute arguments never reach its body test. The hazard is `flip-boolean-literal` on a boolean attribute argument inside an arm, and its effect is a wrong dropped-site count, not a false mutant or a crash (the downstream guard holds). Decision 3 stays: a walk that means "executable body" should say so, not rely on a later filter.

### The whole suite on the prototype

`bun run typecheck` clean; `bun test` from the root: **4268 pass, 2 fail, 7 skip**. Both failures are tests that pin HEAD's blindness, and both are R302's to change:

- `packages/runner/tests/preproc-instrumentation.test.ts`, "c-split: the site set is unchanged by the manifest fixes (operator multiset)" (`SPLIT_SITES`, R301's snapshot of the blind site set);
- `packages/engine/tests/ast/tree-walks.test.ts`, "findEnclosingProcedure is deliberately unchanged: null inside a split procedure (R302)".

### alc, every repro, every subset, through the prototype's pipeline

**37 of 37 subsets PASS** (`$S/alc-proto.sh`, logs `$S/logs/alc-<name>.log`). Two harness gaps were found and fixed in scratch on the way: `alc-all.ts` now copies a repro file that has no mutant (a table), because `writeInstrumentedProject` writes only instrumented files; and `t5-lit-split` declares `Record Customer`, which cannot compile without BaseApp symbols, so alc runs a copy with a project table instead (`$S/repro-alc/t5-lit-split-local`), whose prototype sites are identical to `t5-lit-split`'s line for line.

### The manifest STOP rule (Decision 5), on the prototype

For every mutant inside a split member, `grain-vs-twin.ts` compared `reachGrain`, gap block, member end line and name with the twin's mutant at the same span: every compared mutant EQUAL in all 15 repros that have split-member mutants (128 mutants: 125 `statement`, 3 `enclosing`, the three in in-body `#if` blocks, as in the twin). The STOP rule did not fire.

### al-runner, local, serial (v2.11.0)

`$S/run-ar.sh proto $S/pt q1-twin-body q2-split-twin k1-dc-shape k2-baseapp-shape a1-attribute-in-arm d1-arg-type-differs`, one session at a time, coverage on then off, every subset (logs `$S/logs/ar-proto-<name>-cov<1|0>.log`, summary `$S/logs/ar-proto-summary.txt`): **12 sessions, 24 subsets, every one `SUBSET PASS`**, every baseline green, 0 `error` verdicts, no throw.

| repro | coverage on (killed / survived / no-coverage) | coverage off |
| --- | --- | --- |
| `q1-twin-body`, both subsets | 12 / 2 / 0 | 12 / 2 / 0 |
| `q2-split-twin`, both subsets | 12 / 2 / 0 | 12 / 2 / 0 |
| `k1-dc-shape`, `[]` | 6 / 5 / 6 | 6 / 11 / 0 |
| `k2-baseapp-shape`, 4 subsets | 6 / 1 / 9 each | 6 / 10 / 0 each |
| `a1-attribute-in-arm`, both subsets | 2 / 3 / 0 | 2 / 3 / 0 |
| `d1-arg-type-differs`, both subsets | 4 / 5 / 0 | 4 / 5 / 0 |

In `q1` and `q2`, each of `Pick`'s 7 mutants (the 3 new ones included) has the same verdict as `Twin`'s mutant of the same operator on the same relative line, with `exact` attribution to the one covering test, in both subsets and both coverage modes. The `no-coverage` rows in `k1` and `k2` are the members no test calls (`Guard`, `Mark`, `Calc`, all `local`); with coverage off they are scored, as expected.

### Corrections to the text at `d0e094ac` (the counts are not touched)

1. The places are 12, not 11: `findEnclosingStatement`'s block case (place 12). Tasks below include it.
2. **SUPERSEDED by revision r2** (Task 5 is a mandatory Cronus28 gate; kept for the record, not the decision). Decision 5: the change DOES touch the emission path, through place 12, which decides the statement a split member's body mutant is wrapped as. The decision stands, for the reasons measured above: the wrapped statement is the one a plain procedure's body gets (alc 37/37, grain and gap equal to the twin's), and nothing else on that path changes. Review may overrule this; if it does, a Cronus28 gate on `q2`-shaped and `k1`-shaped members is the natural scope.
3. Decision 3's example was overstated (see Controls).
4. `d4` expects 5, not 4 (see Round 2).
5. `t5-lit-split` (R-297's repro) does NOT compile un-instrumented offline: it declares `Record Customer`, which needs BaseApp symbols. The sentence at `d0e094ac` that every split repro compiles except `k1` missed it. Its site rows stand (the pipeline does not need symbols); alc runs its local-table copy, `$S/repro-alc/t5-lit-split-local`.

---

## Global Constraints

- Plain English, short sentences, no em dashes, in code comments, commits and roadmap text.
- No corpus source text in any committed file. File names, member names, operators, lines and counts are fine. Every repro is hand-written.
- No `!` non-null assertions; destructure and check `undefined`. Fail loudly on a contract violation.
- Fixtures stay byte-identical: hashes, identity keys, manifests and emitted targets, proven by diff in Task 5, not by argument. No frozen itest figure can move. A split node in a fixture is a STOP (Task 0).
- Identity keys move only as Decision 4 says. The checker's full id map enforces it on every repro, on DC/Cloud and on the BaseApp scratch project.
- The pre-committed rows above are not edited. Where the prototype showed a pre-commitment row wrong, the task's own expectation is the corrected row, and the correction is listed under "Prototype check" with its reason.
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>`.
- Every fix is red-checked: revert the specific line, confirm the specific test goes red, restore, report both outputs (or use the `mutation-red-checker` subagent).
- Every scratch shell block runs under `set -euo pipefail`, sources `$S/setup.sh`, never filters a command's output through `grep -v`, writes an "expect nothing" grep as `if grep ...; then exit 1; fi`, and keeps raw logs under `$S/logs/`.
- Probes run SERIALLY, one at a time, never beside another probe or a live gate. Any al-runner probe failure is a STOP (the R-303 rule): report it; the fix is its own designed task. A repeat of R-316's `exit 82` wire-contract throw on a serial run is filed as its own roadmap item.
- One container, one task: Task 5's gate, on Cronus28 ONLY (never Cronus281 to 283). The CONTROLLER holds `coord lease Cronus28 bugs` and heartbeats it; the implementer never takes or releases it. `lethal doctor` after every run; never restart the container or its server; an orphaned lease is recovered with `lethal force-reset-lease` (R201). Every other task is offline.
- Tests assert only what their task owns: Task 1's engine tests assert symbol-table and type answers, never operator sites; Task 2's operator tests assert sites, never identity keys; Task 3 owns the runner-level site sets, the ordinals and the hang tag.

## Review Focus

1. **No false site where arms disagree.** Expected: `d1`'s swap is absent (its first-arm version fails `alc`, measured), and no ambiguous name falls through to a global. Pinned by Task 1's symbol-table and type tests and Task 3's `d1`; red-checked by removing the hiding.
2. **No site from a split member's header region.** Expected: no site claimed from an attribute or pragma inside an arm, so no dropped-site warning either (`a1`'s four attribute booleans; see the Decision 3 control). Pinned by Task 2's `inMemberBody` test and Task 3's `a1`; red-checked by widening the walk to the whole split node.
3. **Every place a test.** R302's closing criterion. Each of the 12 places has a test that a site inside a split member is generated with the same operator and text as in its twin, red-checked by reverting that place alone.
4. **Refusal guards read any arm, resolution reads every arm.** `d5`, `d6` (any) and `d1` to `d4`, `d7` (every).
5. **A renamed member stays unnamed.** `c1`, `c2`: its new mutants carry `procedureName` `""`; no call by name resolves to it.
6. **Keys.** Only the rows in the pre-commitment (and the corrections) move; fixtures, System Application and BusinessFoundation 0.
7. **Emission.** Place 12 changes which node is the statement for a split member's body, so it is on the emission path. Every new mutant's emission compiles under every subset (Task 4), its emitted guard branch equals its twin's (`twin-parity.ts`, Task 4), and the Cronus28 gate (Task 5) shows a split body's marker firing in the test that enters it and not in the one that only covers it.
8. **C1 and C2 (review r1).** A call is typed only when its name is unique in its owner (`o1`, `o2`); variable names compare case-insensitively (`e1`, `e2`). Both are red-checked through `alc`.

## File structure

- Task 1A (R325): `packages/schemata/src/project.ts` (`IDENTITY_SCHEME`), `packages/runner/src/resume.ts` (`sessionFingerprint`), `packages/runner/src/store.ts` (runs column, `priorSurvivorKeys`, `getRun`), `packages/runner/src/orchestrator.ts` (the history and resume refusals, the report field), `packages/runner/src/equivalence-marks.ts` and `verify.ts`, and the `SessionReport` ripple chain (`events.ts`, `report-fold.ts`, `report.ts`, the generated schemas).
- Modify `packages/engine/src/ast/tree-walks.ts`: `findEnclosingProcedure`, `findEnclosingStatement`'s block case; new `memberArms`, `procedureLikeReturnType`, `inMemberBody` (Task 1).
- Modify `packages/engine/src/index.ts`: export the three new helpers (Task 1).
- Modify `packages/engine/src/semantic/symbol-table.ts`: `ProcedureSymbol.ambiguous`, `indexMembers`, a new `parseSplitProcedure`, `resolveProcedure`'s empty-name guard (Task 1).
- Modify `packages/engine/src/semantic/types.ts`: `resolveIdentifierType` and its private walk (Task 1).
- Modify `packages/engine/src/semantic/receiver.ts`: `lookupVar`, `declaresProcedure`, `nameOf` (Task 1).
- Modify `packages/engine/src/semantic/callers.ts`: `enclosingProcedureName` (Task 1).
- Modify `packages/builtin-tier1/src/`: `empty-block.ts`, `return-value.ts`, `flip-boolean-literal.ts`, `toggle-blank-string.ts`, `toggle-blank-temporal.ts`, `shift-integer.ts`, `loop-skip.ts`, `loop-truncate.ts`, `loop-hazard.ts` (Task 2).
- Modify `packages/builtin-tier2/src/write-txn-codeunit-run.ts` (Task 2).
- Tests: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/engine/tests/semantic/symbol-table.test.ts`, `types.test.ts`, `resolve-var-ref.test.ts`, `packages/builtin-tier2/tests/receiver.test.ts` (Task 1); `packages/builtin-tier1/tests/split-member.test.ts` (new) and `packages/builtin-tier2/tests/write-txn-codeunit-run.test.ts` (Task 2); `packages/runner/tests/preproc-instrumentation.test.ts` (Task 3).
- Roadmap: `docs/roadmap/R302.md` closed, one-line cross-links in `R301.md` and `R316.md`, regenerated `ROADMAP.md` (Task 6).
- Scratch, never committed: everything under `$S`.

---

### Task 0: Scratch setup, the census STOP, and BEFORE captures (no product change)

**Files:** scratch only.

- [ ] **Step 1: The setup file.** `$S/setup.sh` holds exactly:

```bash
# R-302 scratch setup. Sourced by every fail-fast block after `set -euo pipefail`. Never committed.
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r302
F="sandbox-app sandbox-data sandbox-hang sandbox-harden sandbox-coverage-probe"
corpus() { case "$1" in sysapp) echo "U:/Git/BC.History/System Application";; bcf) echo "U:/Git/BC.History/BusinessFoundation";; esac; }
export LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe"
cd /u/Git/LethAL-wt/r302
mkdir -p "$S/logs"
```

Confirm every tool imports from this worktree: `if grep -ln "LethAL-wt/r3[01][0-9]\|LethAL-wt/r297" "$S"/*.ts; then exit 1; fi`. The prototype's copies under `$S/pt/` point at `$S/proto` and are used by no task.

- [ ] **Step 2: Census and repros.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r302/setup.sh
for f in fixtures/*/; do
  n=$(basename "$f"); bun "$S/split-census.ts" "$f" > "$S/logs/census-fixture-$n.txt"
  test "$(tail -n 1 "$S/logs/census-fixture-$n.txt" | sed -n 's/.*nodes=\([0-9]*\)$/\1/p')" -eq 0
done
if grep -rlE "^\s*#(if|else|elif|endif)" fixtures --include=*.al; then echo "a fixture has #if: STOP"; exit 1; fi
bun "$S/split-census.ts" U:/Git/DC/Cloud > "$S/logs/census-dc.txt"
test "$(tail -n 1 "$S/logs/census-dc.txt")" = "files 1135/1135 nodes=11"
bun "$S/split-census.ts" U:/Git/BC.History/BaseApp > "$S/logs/census-baseapp.txt"
test "$(tail -n 1 "$S/logs/census-baseapp.txt")" = "files 9620/9620 nodes=11"
for k in sysapp bcf; do
  bun "$S/split-census.ts" "$(corpus "$k")" > "$S/logs/census-$k.txt"
  test "$(tail -n 1 "$S/logs/census-$k.txt" | sed -n 's/.*nodes=\([0-9]*\)$/\1/p')" -eq 0
done
for e in q1-twin-body:CLEAN27 q2-split-twin:CLEAN27 t5-loss-split:CLEAN27 t5-hang-split:CLEAN27 \
  k2-baseapp-shape:CLEAN27,CLEAN26 a1-attribute-in-arm:CLEAN27 c1-preamble-then-renamed-split:CLEAN27 \
  c2-renamed-split-then-preamble:CLEAN27 c3-preamble-then-overload:CLEAN27 d1-arg-type-differs:CLEAN27 \
  d2-return-differs:CLEAN27 d3-arm-only-local:CLEAN27 d4-receiver-differs:CLEAN27 \
  d5-split-shadows-setrange:CLEAN27 d6-renamed-shadows-setrange:CLEAN27 d7-caller-return:CLEAN27; do
  n=${e%%:*}
  bun "$S/alc-plain.ts" "$S/repro/$n" "${e#*:}" > "$S/logs/plain-$n.log" 2>&1
  test "$(tail -n 1 "$S/logs/plain-$n.log")" = "$n PASS"
done
bun "$S/alc-plain.ts" "$S/repro-alc/t5-lit-split-local" CLEAN27 > "$S/logs/plain-t5-lit-local.log" 2>&1
test "$(tail -n 1 "$S/logs/plain-t5-lit-local.log")" = "t5-lit-split-local PASS"
bun "$S/alc-plain.ts" "$S/repro/k1-dc-shape" "" > "$S/logs/plain-k1-dc-shape.log" 2>&1
test "$(tail -n 1 "$S/logs/plain-k1-dc-shape.log")" = "k1-dc-shape PASS"
bun "$S/alc-plain.ts" "$S/neg/neg-d1-swap-first-arm" CLEAN27 > "$S/logs/plain-neg-d1.log" 2>&1 || true
grep -q "sym=\[\] exit=1 app=false error AL0133" "$S/logs/plain-neg-d1.log"
grep -q "sym=\[CLEAN27\] exit=0 app=true" "$S/logs/plain-neg-d1.log"
echo "census and repros OK"
```

Expected: the last line. A fixture with a split node or an `#if` line is a STOP (the orchestrator decides). A changed corpus census is a STOP too: the pre-commitment is per member and would be stale.

- [ ] **Step 3: BEFORE captures.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r302/setup.sh
test -z "$(git status --porcelain -- packages)"
"$S/capture.sh" before "$S/sites.ts"
for f in $F; do
  bun scripts/probe-fixture-hashes.ts "fixtures/$f/src" > "$S/hashes-before-$f.txt"
  rm -rf "$S/target-before-$f"; bun "$S/identity-keys.ts" "fixtures/$f" "$S/target-before-$f" > "$S/ids-before-$f.txt"
done
for k in sysapp bcf; do
  rm -rf "$S/target-before-$k"; bun "$S/identity-keys.ts" "$(corpus "$k")" "$S/target-before-$k" > "$S/ids-before-$k.txt"
done
for n in $(ls "$S/cap/head"); do cmp "$S/cap/head/$n" "$S/cap/before/$n"; done
echo "BEFORE captured, identical to plan time"
```

Expected: the last line. `cmp` against `$S/cap/head/` (the plan-time capture) proves HEAD has not moved under the pre-commitment. A difference is a STOP: rebase decisions go to the orchestrator before any code.

---

### Task 1A: An identity-scheme version, so no verdict crosses a renumbering (R325; before Task 1)

**Why here.** Task 1 and Task 2 add mutants that can take an existing mutant's identity key (measured: System Application `SFTPClient` L42 takes L56's key; `o1` L8 takes L13's; `c3` L12 and L14 take the overload's keys). Every cross-session consumer must refuse to match keys made under a different scheme BEFORE that change lands, so this task commits first.

**Design.** `IDENTITY_SCHEME` (an integer, `packages/schemata/src/project.ts`, beside `assignIdentityOrdinals`, exported from `@lethal/schemata`) names the rules that turn source into identity keys. It is `2` from this commit; `1` means every key made before it, and anything recorded without a scheme is read as `1`. Its doc comment says when to bump it: any engine or operator change that can move an existing mutant's key for unchanged AL source. The serialized key itself does NOT change, so no mutant count and no key in any capture moves because of this task (nothing to pre-commit beyond that sentence). What changes is the fingerprint digest and one new field.

**Every cross-session consumer of identity keys, and what it does:**

| consumer | carries across sessions | change |
| --- | --- | --- |
| `priorSurvivorKeys` (`store.ts`) and `filterHistory` (`selection.ts`): the known-survivor skip | yes | runs table gains `identity_scheme` (a migration adds it nullable; `createRun` records the current one; NULL reads as 1). When the latest finished run's scheme differs, it returns no keys and the session emits warning `history-identity-scheme-changed` naming the run id and both schemes; nothing is skipped |
| `buildResumeIndex` via `--resume-run` / `--resume` (`orchestrator.ts`, `resume.ts`) | yes | before the fingerprint compare, a run whose scheme differs is refused with a named error (the run id, both schemes, R325). `sessionFingerprint` also gains an ALWAYS-present `identityScheme` key: unlike R127's conditional keys this is meant to change every digest, so a store from before this build can never be resumed by it. The automatic `--resume` search, which selects by fingerprint, names the old-scheme unfinished run when one exists instead of reporting "none found" |
| equivalence marks (`equivalence-marks.ts`, applied in `verify.ts` and the session) | yes (a human-kept file) | the marks file gains an optional `identityScheme`; absent reads as 1. On a mismatch every mark is reported `stale` with warning `equivalence-marks-identity-scheme`, and none is matched or contradicted. The module doc's "a mark can never drift onto a different mutant" is corrected: it could, across a renumbering |
| `SessionReport` (`report.ts`) | as a file | gains `identityScheme`, always written. Optional in the schema, so the committed sample reports still validate and are not regenerated; the ripple chain of CLAUDE.md's Conventions applies otherwise: `events.ts`, `report-fold.ts`'s accumulator, `report.ts`'s type, builder and banner, `bun scripts/generate-schemas.ts`, `tests/schemas.test.ts` (the root-required list stays as it is; the older-reports expectation gains the field as absent), `bun test <file> --update-snapshots` for report-equality |
| committed baselines: `assertMatchesBaseline` (`packages/runner/itest/baseline-guard.ts`), the itest baselines and `campaign freeze` / `compare` | compared, never carried | SAFE as is: they never carry a verdict into a run or a score. They compare verdicts per key as a multiset; a renumbering that matters shows as a loud per-key difference (a key present on one side, or a group whose size changed), and `campaign compare` already refuses an uncommitted baseline. Every fixture's keys are byte-identical under this change (measured), so no frozen baseline is invalidated |
| `report.ts`'s own keys, `scripts/c0204b-live-probe.ts`, the report-equality tests | no (one session, or one build) | SAFE: they compare keys made by the same build in the same process |

**Steps.**

- [ ] **Step 1: Failing tests.** (a) History: a store holding a finished run recorded with `identity_scheme` NULL whose survivor key equals a mutant's key in this session; with `--skip-known-survivors` the mutant is EXECUTED, not `known-survivor`, and the named warning is emitted. (b) Resume: `--resume-run` of that run throws the named scheme error. (c) Fingerprint: the digest for scheme 1 and scheme 2 inputs differs, and the key is present when every optional input is absent. (d) Marks: a marks file without `identityScheme` against a surviving mutant with that key: the mark is `stale`, the warning is named, the mutant is not marked equivalent. (e) The report carries `identityScheme: 2`.
- [ ] **Step 2: Implement** as the design says.
- [ ] **Step 3: Red-checks,** each reverted alone: remove the history scheme check (test (a) goes red: the mutant is skipped on the old verdict); remove the named resume check (test (b) goes red on the message; then also drop the key from the fingerprint and a test asserting "no verdict carried" goes red); remove the marks check (test (d) goes red: the mark matches). Record in `$S/logs/t1a-redcheck.txt`.
- [ ] **Step 4: Wiring.** Run the `wiring-completeness` subagent on `identityScheme` (every run-row construction, every report builder, every fingerprint input) and on `IDENTITY_SCHEME` (every cross-session reader in the table above); any site it names that the table does not cover is added to it or fixed.
- [ ] **Step 5: Green and commit.** Typecheck, `rm -rf packages/*/dist`, `bun test` from the root; `bunx biome check <touched files>`; `git commit -m "fix(R325): an identity-scheme version on runs, fingerprints, reports and marks; no verdict crosses a renumbering"`.

### Task 1: The engine resolves inside a split member, `return-value` reads the agreed return type, a call is typed only by a unique name, and names compare case-insensitively (places 1 to 4, 9 to 12; C1, C2)

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts`, `packages/engine/src/index.ts`, `packages/engine/src/semantic/symbol-table.ts`, `packages/engine/src/semantic/types.ts`, `packages/engine/src/semantic/receiver.ts`, `packages/engine/src/semantic/callers.ts`, `packages/builtin-tier1/src/return-value.ts`
- Test: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/engine/tests/semantic/symbol-table.test.ts`, `types.test.ts`, `resolve-var-ref.test.ts`, `callers.test.ts`, `packages/builtin-tier2/tests/receiver.test.ts`, `packages/builtin-tier1/tests/return-value.test.ts`

`return-value.ts` is in this task, not Task 2, on purpose: it reads `findEnclosingProcedure`, which this task widens. Left for Task 2, the Task 1 commit would give a split member a `return-value` typed by its FIRST arm's return type, which is `d2`'s wrong site.

- [ ] **Step 1: Write the failing tests, and flip the engine pin.** The test "findEnclosingProcedure is deliberately unchanged: null inside a split procedure (R302)" in `tree-walks.test.ts` pins HEAD's blindness and is R302's to change: it becomes "returns the split node". Then, each on hand-written inline AL, one per place, asserting only an engine answer (and, for `return-value`, its sites):
  - `tree-walks.test.ts`: `findEnclosingProcedure` from a body statement returns the split node for both shapes (place 3); `memberArms` gives one arm per `#if`/`#elif`/`#else` with the arm's own children; `procedureLikeReturnType` is the agreed text, `null` when arms disagree or one arm has none; `inMemberBody` is true for a body literal and FALSE for a string inside an `[Obsolete(...)]` attribute inside an arm; `findEnclosingStatement` of a split member's body block is that block (place 12).
  - `symbol-table.test.ts`: a split member is found by `resolveProcedureAt` at its own start (place 1); agreeing parameters and a shared var section's locals are listed; a parameter with different types per arm, and an arm-only local, are in `ambiguous` and in neither list; `returnType` agrees or is `null`; a renamed member has name `""` and `resolveProcedure(scope, "")` is `null`.
  - `types.test.ts`: an identifier that is an agreeing parameter types; an ambiguous one is `null` even when a global of the same name exists (place 2); a call to an agreeing split member types by its return type, a call to a disagreeing one is `null`; C1: a call to a name with two overloads (plain, and split-then-plain) is `null`, and a unique name called in other casing types; C2: a parameter `y: Text` referenced as `Y` beside a global `Y: Integer` types `Text`, in a plain procedure and in an agreeing split member.
  - `symbol-table.test.ts` also: `uniqueProcedure` is the one procedure of a name, `null` for two, and counts a renamed split member under each arm's name.
  - `resolve-var-ref.test.ts`: `resolveVarRef` finds an agreeing split-member local; an ambiguous name returns `null`, not the global (place 3).
  - `receiver.test.ts`: `claimsRecordMethod` refuses `R.SetRange(...)` on a table that declares `SetRange` as a split member, and on one where only ONE arm has that name (place 10); a receiver declared differently per arm is not claimed; a renamed member is not a name fallback (place 11).
  - `callers.test.ts`: a call inside an agreeing split member names it as the caller (place 9).
  - `return-value.test.ts`: `exit(<expr>)` in a split member whose arms agree on `Integer` is mutated as in its twin; nothing when the arms disagree (place 4).
- [ ] **Step 2: Run them, expect red.** `bun test packages/engine packages/builtin-tier2/tests/receiver.test.ts`: each new test fails at HEAD for the reason named, and nothing else fails.
- [ ] **Step 3: Implement.** The prototype's engine hunks are the reference (`$S/proto-r3.patch`, the `packages/engine` files; r2 added `uniqueProcedure` in `symbol-table.ts`, `callType` reading it, `sameName` in `types.ts`, and the private walk deleted): `findEnclosingProcedure` walks `isProcedureLike`; `memberArms`, `procedureLikeReturnType`, `inMemberBody` next to `isProcedureLike`, each with an R302 doc comment; `findEnclosingStatement`'s block case also admits a procedure-like parent; `parseSplitProcedure` with Decision 2's rule; `ProcedureSymbol.ambiguous` (lowercase names; absent on a plain procedure); `types.ts` deletes its private walk and imports the engine's; `lookupVar` and `resolveIdentifierType` return `null` for an ambiguous name before the global fall-through; `declaresProcedure` reads every `name`-field child; `nameOf` and `callers.ts` use `procedureLikeNameNode`. Update the doc comment on `isProcedureLike` (it no longer says the semantic walks skip it).
- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/engine packages/builtin-tier1/tests/return-value.test.ts packages/builtin-tier2`.
- [ ] **Step 5: Red-check each place.** Revert one hunk at a time, run only its test, confirm red, restore, confirm green. Record the eleven outputs (places 1 to 4, 9 to 12, the hiding, C1 and C2) in `$S/logs/t1-redcheck.txt`. C1 is reverted by putting `resolveProcedure` back in `callType`, C2 by putting `p.name === node.text` back; on the prototype each turned its repros' checker and `alc` red ("Revision r2 prototype check"). The hiding (place 2 and 3) is reverted by deleting the `ambiguous` check alone, so the red test is the one with the global.
- [ ] **Step 6: Commit.** `bunx biome check <touched files>`, then `git commit -m "fix(R302): the engine resolves locals, parameters and the return type inside a split member, by the every-arm rule"`.

### Task 2: The body walks find their sites inside a split member (places 5 to 8)

**Files:**
- Modify: `packages/builtin-tier1/src/empty-block.ts`, `flip-boolean-literal.ts`, `toggle-blank-string.ts`, `toggle-blank-temporal.ts`, `shift-integer.ts`, `loop-skip.ts`, `loop-truncate.ts`, `loop-hazard.ts`; `packages/builtin-tier2/src/write-txn-codeunit-run.ts`
- Test: `packages/builtin-tier1/tests/split-member.test.ts` (new), `packages/builtin-tier2/tests/write-txn-codeunit-run.test.ts`

- [ ] **Step 1: Write the failing tests.** One `describe` per operator. Each builds the semantic context for a split source and for its hand-written twin (the same text with the markers and the other arm replaced by blank lines, so lines match), runs the one operator over every node, and asserts the two `(startLine, before text, after text)` multisets are EQUAL. Both shapes (`preproc_split_procedure` and the preamble) for each operator. Plus the negative case of Decision 3: `flip-boolean-literal` finds NOTHING in an `[IntegrationEvent(false, false)]` attribute inside an arm, and `inMemberBody` is false there (measured: without it, 4 such sites in `a1` are claimed and then dropped as non-executable). For `loop-hazard`, the twin comparison includes `hangCapable`. `write-txn-codeunit-run`: a consumed `Codeunit.Run` inside a split member is claimed as in the twin.
- [ ] **Step 2: Red.** Every twin test fails at the Task 1 commit, except `swap-additive`'s and `swap-call-arguments`' (they need types only; Task 1 fixed them, and they stay as regression pins); the attribute case PASSES already (it is the guard the change must keep).
- [ ] **Step 3: Implement.** The prototype's operator hunks: `empty-block` admits a block whose parent `isProcedureLike`; the five executable-body tests and `flip-boolean-literal` call `inMemberBody`; `shift-integer`'s loop-condition walk and `loop-hazard`'s `SCOPE_KINDS` walks stop at a procedure-like node; `write-txn-codeunit-run`'s `enclosingBody` admits one. Update `BODY_ANCESTORS`' doc comment (it now names `inMemberBody`, and why the whole split node is not an allow-listed ancestor).
- [ ] **Step 4: Green, then red-check.** As Task 1, one operator at a time; for Decision 3, widen `inMemberBody` to "any procedure-like ancestor" and confirm the attribute cases go red. Record in `$S/logs/t2-redcheck.txt`.
- [ ] **Step 5: Flip the R301 pin.** `c-split: the site set is unchanged by the manifest fixes (operator multiset)` (`packages/runner/tests/preproc-instrumentation.test.ts`) pins HEAD's blindness (`SPLIT_SITES`, a literal list). This task's change is what turns it red (the split body gains its `empty-block`), and every commit must leave the suite green, so it is flipped HERE: it becomes "the split body's site set equals its twin's", with the twin computed from `C_SPLIT_OF` (the markers and the other arm replaced by blank lines), never a literal list. Run the whole suite: green.
- [ ] **Step 6: Commit.** `fix(R302): every body walk treats a split member's body as a procedure body, never its header region`.

### Task 3: Runner-level pins (the repros that matter, through the real pipeline)

**Files:** Test: `packages/runner/tests/preproc-instrumentation.test.ts`

- [ ] **Step 1: New tests,** each with inline AL copied from the named scratch repro (hand-written, invented names):
  - `q2`-shaped: the split member's `(line, operator)` multiset equals its plain twin's, and every one of its mutants names it;
  - `d1`: no `swap-call-arguments` at the `Show(X, Y)` line; `d3`: no `swap-additive` inside the in-body `#if`; `d7`: `swap-additive` on the agreeing call, not on the disagreeing one;
  - `d6`: `void-method-call`, not `remove-setrange`, at the plain caller;
  - `a1`: no mutant on an attribute line inside an arm, AND no dropped-site warning for the file (without Decision 3 the attribute booleans are claimed and then dropped as non-executable, which leaves the mutants right and the warning and its count wrong);
  - `t5-hang`-shaped: both `remove-assignment` mutants carry `hangCapable: "loop-condition-target"`;
  - `c3`-shaped: the overload's `empty-block` and `return-value` keys carry ordinal 1, the preamble's none; `c1`-shaped: the renamed member's new mutants have `procedureName` `""`;
  - `o1` and `o2`: no `swap-additive` at the overloaded call, and in `o1` the plain overload's `empty-block` key carries ordinal 1; `e1` and `e2`: no `swap-call-arguments` at `Show(X, Y)`; `o3` and `e3`: the added `swap-additive`.
- [ ] **Step 2: Red-check** the `d1`, `d6`, `a1`, `o1` and `e2` tests against the hunks they pin (hiding, any-arm guard, `inMemberBody`, `uniqueProcedure`, `sameName`).
- [ ] **Step 3: Commit.** `test(R302): runner-level pins for split-member sites, the per-arm rule, the hang tag and the ordinals`.

### Task 4: Offline proof: the checker, alc on every subset, the manifest STOP rule, and al-runner (serial)

**Files:** scratch only. On the r302 worktree with Tasks 1 to 3 committed.

- [ ] **Step 1: Every capture against the pre-commitment.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r302/setup.sh
"$S/capture.sh" after "$S/sites.ts"
EXPECT="$S/expect-r2-final" "$S/check-all.sh" after | tee "$S/logs/check-after.txt"
for n in $(ls "$S/cap/before" | grep '\.err$'); do cmp "$S/cap/before/$n" "$S/cap/after/$n"; done
echo "sites match the pre-commitment (with the listed corrections)"
```

`$S/expect-r2-final/` is the r2 pre-commitment (`$S/expect-r2/`) plus the corrections recorded under the two prototype checks (`d4` L15 in r1; the `o1` and System Application ordinals in r2), kept as a separate file set so the committed rows stay as they were. Expected: `checks: 33 pass, 0 fail` (every file's raw and deployed totals included), and every `.err` identical, which says no site was dropped as non-executable.

- [ ] **Step 2: alc, every repro, every subset:** `"$S/alc-proto.sh" "$S"` (the same script with the r302 tools instead of `$S/pt`). 25 projects (every repro except `n1`, which is R323's evidence and still fails by design; `t5-lit-split` as its local-table copy; the gate target with its selector ids widened in a scratch copy): 47 subsets. Expected: `alc: 47 of 47 subsets PASS`. Any FAIL is a STOP.
- [ ] **Step 3: Twin parity (Decision 5, review I1).** `bun "$S/twin-parity.ts" U:/Git/LethAL-wt/r302/packages <split> <twin> <count> [<allow>]` for every row of the r2 table "Twin parity, now mechanical": 18 repro runs, the gate target (version 2: 11), DC/Cloud, and BaseApp against both arm-twins, each with its pre-committed count and `d4`'s two allowed rows. Expected: every run ends `PASS`. A `NO-TWIN`, `DIFF`, `COUNT` or `ALLOWED-BUT-NOT-SEEN` line is a STOP.
- [ ] **Step 4: al-runner, local, serial.** `"$S/run-ar.sh" after "$S" q1-twin-body q2-split-twin k1-dc-shape k2-baseapp-shape a1-attribute-in-arm d1-arg-type-differs r302-gate` (7 projects, NOT every repro; each with its tests app, coverage on then off, every subset, one session at a time). Expected, as on the prototype: every session ends `<name> PASS`; in `q1` and `q2` each `Pick` mutant has the same verdict as the `Twin` mutant of the same operator on the same relative line; the gate target's verdicts equal the version 2 gate rows' verdicts. al-runner reports no reach, so this step proves compile, run and verdicts only. Any failure is a STOP.

### Task 5: Live gate on Cronus28: a split member's whole-body block reached by one test and not by another (review I1)

**Files:** scratch only (`$S/gate/`). Runs on the r302 worktree with Tasks 1 to 3 committed locally and Task 4 green. Nothing is merged, and R302 is not closed, unless it passes; the gate itself commits nothing.

- [ ] **Step 1: Offline, before asking for the lease.** The target and rows are VERSION 2 ("the gate, version 2"). `bash "$S/gate/build-pair.sh"` (both `.app` files, sha256 printed), `bun "$S/gate/redcheck-gate.ts"` (24 cases, expected `redcheck PASS`), and `bun "$S/gate/gate-config.ts"` for `cfg-none.json` (`""`) and `cfg-r302a.json` (`R302A`).
- [ ] **Step 2: Ask the controller.** The controller takes `coord lease Cronus28 bugs` and heartbeats it for the whole run; the implementer does not.
- [ ] **Step 3: One driver.** From the r302 worktree: `bash "$S/gate/run-gate.sh" fix`. It takes the full app inventory, runs the preflight (no scratch name or id may exist), requires doctor's lease check green, publishes the pair, runs `lethal run --backend bcdev` once per configuration with `lethal doctor` after each, and checks each report with `check-gate.ts` against `expect-gate.json` (the r2 pre-committed rows). Its EXIT trap removes the pair by app id AND publisher once doctor's lease check is green, then diffs the inventory. Expected: `gate [fix]: GATE PASS in both configurations`, and an empty inventory diff.
- [ ] **Step 4: On a FAIL,** stop: nothing is merged, the evidence goes to the controller, and the cause is designed as its own task. On a PASS, the controller releases the lease, and the evidence (reports, check logs, doctor logs, inventories and their diff, the removal log, `check-gate.ts`, `expect-gate.json`, the red-check outputs) is archived at `H:/lethal-coord/tasks/R-302/gate-evidence/`.

### Task 6: Prove nothing else moved

- [ ] **Step 1: Fixtures and BusinessFoundation.** The AFTER hashes, identity keys and emitted targets (Task 0 Step 3's loop into `*-after-*`) are byte-identical to BEFORE (`diff -r --exclude=app.json`, `maxRSS_KB` dropped). System Application is NOT byte-identical any more (C2 adds 5 mutants and renumbers one key); it is held by the checker in Task 4 Step 1 instead.
- [ ] **Step 2: DC/Cloud, BaseApp and System Application** already pass the checker in Task 4 Step 1 (DC 102603 raw, 97144 deployed, 19 `+`, 7 `-`; BaseApp 1568, 1540, 31 `+`; System Application 77291, 75832, 5 `+`, 1 `k`; every other key unchanged).
- [ ] **Step 3: Whole suite.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` from the root. Expected: green. `bun run compile:fixtures` is not needed (no fixture AL changes) and is not run.

### Task 7: Roadmap

- [ ] Mark `docs/roadmap/R325.md` done with Task 1A's commit and its red-checks. Mark `docs/roadmap/R302.md` `done (<first>..<last>)`, recording as POST-PROTOTYPE EXCEPTIONS (found by the r2 prototype, not predicted at `afe11fca`) the two exact key transitions pinned in "Revision r3" (`o1` L13 and System Application `SFTPClient` L56, each with the new site that takes its old key), with a closing section: the 12 places, the per-arm rule (and its strict reading), the pre-committed counts and the measured result for each repro, DC/Cloud (+12 deployed) and BaseApp scratch (+31), the prototypes' corrections, the hang tag back, and the Cronus28 gate's archived evidence. Mark `R322.md` and `R324.md` done with the Task 1 commit and their red-checks. `R323.md` stays open (named return values, out of R-302's scope). Add one line to `R301.md` and `R316.md` pointing at the closing. Re-check the next free id across every worktree before filing anything new (R-316's Task 0 Step 5 loop). Then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, and commit: `roadmap(R302): done`.

---

## Self-review

- **Spec coverage.** R302's places 1 to 4 (Task 1), its "other walks" (Task 2 for the operator walks, Task 1 for `callers.ts`), R316's per-arm rule (Decision 2, Task 1), the hang tag (Task 2, pinned in Task 3), the operator swap at one call (DC's 7, pinned by the checker), and the closing criterion "a test per place" (Tasks 1 and 2, one twin test per place, each red-checked). Two places beyond R302's list: the Tier-2 rule-3 guard (place 10, the unsafe direction) and `findEnclosingStatement` (place 12, found by the prototype).
- **Pre-commitment order.** `d0e094ac` holds the rows; this section and the tasks came after, and the rows were not edited. The one wrong row (`d4`) and the three wrong sentences are listed as corrections, with their evidence.
- **Assert only what you own.** Task 1: engine answers and `return-value`'s sites; Task 2: body-walk sites; Task 3: the runner-level repros, ordinals and the hang tag; the checker: every key.
- **No `!`, no em dashes, no corpus source text.** Checked by grep before each commit.

## Notes: upstream grammar observations

None found. Everything this plan relies on is the grammar as R301 and R316 measured it: a split node's arms (header tokens, a preamble's var sections, and any attribute or `#pragma` inside an arm) are its direct children, separated by the `preproc_*` markers, with the shared body a direct `code_block` child. An attribute inside an arm being a child of the split node, where a plain procedure's attribute is its sibling, follows from the shape (the attribute is part of the arm), so it is not filed. Nothing to draft.

## Open questions for the orchestrator

1. **The per-arm rule's reading.** This plan reads R316's "every arm that declares it agrees" strictly: a name some arms do not declare is ambiguous (`d3`). The looser reading would resolve `d3`'s site, which compiles because its only use is inside an in-body `#if` of the declaring arm. No corpus site differs between the two readings. Keep strict?
2. **No live gate.** Place 12 is on the emission path (it picks the statement a split member's body mutant is wrapped as), which this plan did not expect at `d0e094ac`. The evidence that it is safe is offline: alc 37 of 37 subsets, `reachGrain` and gap block equal to the twin's for all 128 split-member mutants, and al-runner verdicts equal to the plain twin's. Is that enough, or is a Cronus28 gate on a `q2`-shaped and a `k1`-shaped member wanted?
3. **Named return values** are not resolved in a plain procedure either (HEAD's `parseProcedure` ignores them), so a named return that shares its name with a global resolves to the global's type. This is HEAD's behaviour, unchanged here; the split rule copies it. File it as its own roadmap item, or leave it?
4. **The task text's "3 and 4 split procedures"** are file counts; the members are 11 and 11, and the pre-commitment covers all 22.

---

## Revision r2: review r1, and the PRE-COMMITMENT for C1 and C2

Review: `H:/lethal-coord/reviews/R-302-plan/review-r1.md` (2 Critical, 2 Important, 1 Minor). The orchestrator verified the r1 pre-commitment order. The rows committed at `d0e094ac` are not touched. This section is committed on its own, BEFORE any prototype of the C1 or C2 fix, so history shows the order again. The r2 prototype results come in a later commit.

The three roadmap items this round filed, each in its own commit before this one:

- **R322** (`1aec1f41`): C2 hits PLAIN procedures at HEAD. Measured below.
- **R323** (`49bc5b02`): a named return value is not a declaration to type resolution (the orchestrator's ruling on r1's open question 3). Measured on `n1-named-return-global`: HEAD emits a `swap-call-arguments` that fails `alc` with AL0133.
- **R324** (`d5f6177e`): C1 hits PLAIN procedures at HEAD too, so it is a pre-existing defect and got its own item. It was not in the orchestrator's list; CLAUDE.md says to file a defect the moment it is found. The ids follow the order the ruling set: C2's item first, the named-return item next, this one after.

The next free id was checked across every worktree under `U:/Git/LethAL-wt/` and every local branch (`git ls-tree`); the highest was R321.

### C1: a call typed by the first overload of its name

**Measured at HEAD `00e514c4`, plain procedures** (`o2-overload-plain`: `Foo(X: Integer): Integer` before `Foo(T: Text): Text`, caller `exit(Foo('x') + Foo('y'))`): HEAD emits `swap-additive` at the caller, and the instrumented project FAILS `alc`: `AL0175: Operator '-' cannot be applied to operands of type 'Text' and 'Text'`. So the defect predates R-302 (R324), and R-302 widens it: the r1 prototype makes `o1-overload-split-first` (the same, with the `Integer` overload as a split member) fail the same way, where HEAD refused.

**The choice: no type when the name is not unique.** `callType` gives a type only when the owner declares EXACTLY ONE procedure of that name, compared as AL compares names (case-insensitive, quotes ignored), with a split member counted under every arm's name. Overload-aware resolution was rejected: choosing an overload needs the argument types and AL's implicit conversions (`Integer` to `Decimal`, `Code` to `Text`, and `Decimal` to `Integer`, which r1 measured), which is inference about the platform in the direction R175 warns against, and a wrong pick is a whole-run compile failure. Refusing costs sites only where an overloaded name's call is an operand of `+` or `-`, and the census below finds 0 such calls in every fixture and corpus. The rule also makes the call-name match case-insensitive: a unique `Foo` called as `FOO` now types (`o3-call-case`).

### C2: a case-sensitive variable lookup

**Measured at HEAD, plain procedures** (`e1-case-plain`: `Pick(X: Integer; y: Text)`, global `Y: Integer`, body `Show(X, Y)` with overloads `Show(Integer; Integer)` and `Show(Integer; Text)`): HEAD emits `swap-call-arguments`, and the instrumented project FAILS `alc` with AL0133. It is the review's split case, in a plain procedure, so R322. `resolveIdentifierType` compares `v.name === node.text` for locals, parameters and globals alike; the fix compares case-insensitively at all three. `e2-case-split` is the review's split repro (the arms agree on `y: Text`); `e3-case-adds` is the silent side (no global; `Amount + rate` against `amount` and `Rate` gets no `swap-additive` today).

### How the corpus and fixture effects were pre-committed

A read-only census of HEAD, `$S/case-census.ts`, visits only the positions the two type-reading operators consult: identifier arguments of a call that has at least two (`swap-call-arguments`), and the typed path of each `+` or `-` operand (`swap-additive`: through parentheses, unary and non-comparison binary operands, down to an identifier, a member access's record, or a call's name or receiver). It reports each C2 trigger (a reference that matches a visible declaration only case-insensitively) and each C1 trigger (a call to a name with other than one declaration, or matching only case-insensitively).

| project | C1 triggers | C2 triggers |
| --- | --- | --- |
| every fixture (`sandbox-app`, `-data`, `-hang`, `-harden`, `-coverage-probe`) | 0 | 0 |
| BusinessFoundation, BaseApp scratch | 0 | 0 |
| DC/Cloud | 0 | 7 (6 local, 1 global; none takes a wrong global) |
| System Application | 0 | 19 (all local; 15 call arguments, 4 additive operands) |

For DC and System Application, a CASE TWIN (`$S/case-twin.ts`) rewrites each trigger to its declaration's spelling (same length, every offset kept), and HEAD, unchanged, runs on it: the source a case-insensitive resolver sees. It is an oracle, like r1's twin, and runs no fix. Its keys are not usable (the AST hash is case-sensitive, so rewritten source hashes differently); its site set is. Each resulting site was then audited by hand.

### The r2 expectation set

`$S/expect-r2/`: r1's `expect-final` (the `d0e094ac` rows plus the recorded `d4` correction), plus the rows below. Every file now also carries its pre-committed totals as `= raw N deployed M`, and `check-sites.ts` FAILS unless the capture's header equals them (I2). Red-checked on `q1`: a wrong total and a missing total line each FAIL.

New repros (hand-written; the un-instrumented source compiles under every subset):

| repro | HEAD (raw, deployed) | expected | rows |
| --- | --- | --- | --- |
| `e1-case-plain` | 10, 10 | 9, 9 | `-` `swap-call-arguments` L7 (`Y` is the `Text` parameter) |
| `e2-case-split` | 6, 6 | 9, 9 | `+` `empty-block` L10, `swap-additive` L12, `return-value` L13; NOT `swap-call-arguments` L11 |
| `e3-case-adds` | 4, 4 | 5, 5 | `+` `swap-additive` L8 (`Decimal` and `Decimal`) |
| `o1-overload-split-first` | 2, 2 | 4, 4 | `+` `empty-block` L8, `return-value` L9 (the split `Foo`); NOT `swap-additive` L19 |
| `o2-overload-plain` | 5, 5 | 4, 4 | `-` `swap-additive` L15 |
| `o3-call-case` | 4, 4 | 5, 5 | `+` `swap-additive` L10 (`FOO(1)`: one `Foo`, `Integer`) |
| `n1-named-return-global` | 9, 9 | 9, 9 | none: R323's evidence, out of R-302's scope. It stays a known `alc` FAIL and is excluded from the alc set |
| `r302-gate` (the gate target, offline) | 5, 5 | 10, 10 | `+` `empty-block` L8, `swap-additive` L9, `return-value` L11 (`Pick`); `+` `empty-block` L19, `swap-additive` L20 (`Note`) |

Totals now pre-committed for every r1 repro (raw, deployed): `q1` and `q2` 14, 14; `t5-loss-split` 30, 29; `t5-lit-split` 10, 10; `t5-hang-split` 8, 8; the three `t5-*-twin` unchanged (30, 29; 10, 10; 8, 8); `k1` 20, 17; `k2` 16, 16; `a1` 5, 5; `c1`, `c2`, `c3` 8, 8 each; `d1` 9, 9; `d2` 3, 3; `d3` 2, 2; `d4` 5, 5; `d5` and `d6` 2, 2 (the `remove-setrange` spec is no longer generated, so raw drops by one as well); `d7` 4, 4. Raw moves with deployed except where Tier 2 takes a span by precedence (`t5-loss-split`, `k1`): there the Tier-1 spec is still generated and then deduplicated.

Corpora, raw and deployed asserted separately (I2):

| corpus | HEAD raw | HEAD deployed | expected raw | expected deployed | rows |
| --- | --- | --- | --- | --- | --- |
| DC/Cloud | 102584 | 97132 | **102603** | **97144** | r1's 19 `+` and 7 `-`; C1 and C2 add NOTHING (the case twin changes no site: each of the 7 calls already had an earlier same-typed pair, or the corrected type makes no new pair) |
| BaseApp scratch | 1537 | 1509 | **1568** | **1540** | r1's 31 `+`; C1 and C2 add nothing (0 triggers) |
| System Application | 77286 | 75827 | **77291** | **75832** | 5 `+`, 0 `-`, 0 `k`, below |
| BusinessFoundation | 3639 | 3573 | 3639 | 3573 | none |
| every fixture | | | byte-identical | | none: 0 triggers of any kind, so hashes, identity keys, manifests and emitted targets stay byte-identical, and no frozen itest figure moves |

System Application's 5 rows, audited:

- `Source/System Application/Agent/Interaction/AgentMessage.Codeunit.al`, `ShowAttachment`: `+` `swap-call-arguments` L119. Two `BigInteger` parameters referenced with other casing; swapping two same-typed arguments.
- `Source/System Application/Agent/Troubleshooting/Internal/AgentTaskLogEntry.Codeunit.al`, `ExtractPageStack`: `+` `swap-additive` L43 twice (the inner and outer subtraction of one expression; an `Integer` local referenced with other casing) and L48 once (the same local plus a literal).
- `Source/System Application/SFTP Client/src/SFTPClient.Codeunit.al`, `Initialize`: `+` `swap-call-arguments` L42. A `Text` parameter referenced with other casing, beside another `Text` parameter.

No existing key changes on any corpus. The case twin's own keys DO change (9 on System Application, including an ordinal at `SFTPClient` L56, because the rewritten L42 call became byte-identical to an overload's call); that is an artifact of rewriting source, which a fix that changes no source cannot cause. The checker, run on the real fix, enforces "0 `k` rows".

### Twin parity, now mechanical (I1, I2)

`$S/twin-parity.ts` replaces `grain-vs-twin.ts`. For every mutant of the split project inside a split member it requires a twin mutant at the same span and operator (a missing twin FAILS unless it is in the pre-committed allow list), equal `reachGrain`, gap block, member end line and name (or `""` for a renamed member), and an EQUAL EMITTED GUARD BRANCH: the text between `Active('<id>') then begin` and the next `end else`, with the mutant id and the latch name normalised. That compares the mutated text and the marker placement. It FAILS unless the number compared equals the pre-committed count:

| project (twin) | compared | allowed with no twin |
| --- | --- | --- |
| `q1`, `q2` (a1) | 7, 7 | |
| `t5-loss-split`, `t5-lit-split`, `t5-hang-split` (a1) | 29, 10, 8 | |
| `k1`, `k2` (a1) | 15, 14 | |
| `a1` (a1) | 5 | |
| `c1`, `c2`, `c3` (a1) | 8, 8, 4 | |
| `d1`, `d2`, `d3` (a1) | 5, 3, 2 | |
| `d4` (a1) | 3 | `Repro.Codeunit.al:13:lethal.void-method-call` and `Repro.Codeunit.al:15:lethal.flip-boolean-literal` (the ambiguous receiver keeps Tier-1 sites where the twin claims Tier 2) |
| `e2`, `o1` (a1) | 5, 2 | |
| `r302-gate` (a1) | 8 | |
| DC/Cloud (`$S/dc-twin`) | 29 | |
| BaseApp scratch (a1, then a2) | 68, 68 | |

These counts come from the committed rows (the mutants HEAD has inside split members, plus `+`, minus `-`), not from a prototype.

### The live gate (review I1, ruling change)

A small serial bcdev gate on Cronus28, reusing R-316's scratch-pair harness: `$S/gate/` holds `pair.ps1`, `run-gate.sh`, `build-pair.sh` and `gate-config.ts` copied from `../r316/gate` and renamed, and a `check-gate.ts` rewritten to key rows by line and operator. Scratch pair `LethAL R302 Gate` / `LethAL R302 Gate Tests`, object ids 91700 to 91799 (proposed; R-316 used 91600 to 91699), two symbol configurations (`[]` and `[R302A]`). THE CONTROLLER HOLDS `coord lease Cronus28 bugs` and heartbeats it; the driver never takes or releases the lease. R-316's cleanup rules are unchanged: one driver with an EXIT trap; the preflight refuses an existing scratch name or id; removal is by app id AND publisher, only after doctor's lease check is green; the full app inventory must be unchanged. The gate commits nothing unless it passes.

The target is `codeunit 91700 "R302 Gate"`: `Pick(X: Integer): Integer`, a split member with identical arms, body `Glob := X + 1; Note(X); exit(Glob);`; `Note(X: Integer)`, a split member that is `local` in both arms, body `Seen := Seen + X;`; and a plain `Other(): Integer` returning 7. Tests: `PickEnters` (asserts `Pick(1) = 2`) and `OtherOnly` (asserts `Other() = 7`). `Note` is local, so its coverage widens to object grain (R63): BOTH tests cover it, and only `PickEnters` reaches it. That is the reached/not-reached control for a split member's whole-body block, the path place 12 admits.

Pre-committed rows, both configurations (`$S/gate/expect-gate.json`):

| member | line | operator | verdict | attribution | covering | reachedBy |
| --- | --- | --- | --- | --- | --- | --- |
| `Pick` | 8 | `empty-block` (the split BODY) | killed | exact | PickEnters | killer PickEnters |
| `Pick` | 9 | `remove-assignment` | killed | exact | PickEnters | killer PickEnters |
| `Pick` | 9 | `swap-additive` | killed | exact | PickEnters | killer PickEnters |
| `Pick` | 10 | `void-method-call` | survived | exact | PickEnters | exactly PickEnters |
| `Pick` | 11 | `return-value` | killed | exact | PickEnters | killer PickEnters |
| `Note` | 19 | `empty-block` (the split BODY) | survived | object | PickEnters, OtherOnly | exactly PickEnters (OtherOnly covers, does NOT reach) |
| `Note` | 20 | `remove-assignment` | survived | object | PickEnters, OtherOnly | exactly PickEnters |
| `Note` | 20 | `swap-additive` | survived | object | PickEnters, OtherOnly | exactly PickEnters |
| `Other` | 24 | `empty-block` | killed | exact | OtherOnly | killer OtherOnly |
| `Other` | 25 | `return-value` | killed | exact | OtherOnly | killer OtherOnly |

Every row also requires `reachGrain` `statement` and `guardReached` true; a report mutant without a row, or a row without a mutant, FAILS. The two arms are identical, so no arm witness can tell them apart; each configuration's `preprocessorSymbols` is checked in the report, and `alc` proves each build compiles.

### Minor

- al-runner covers 6 repros (`q1`, `q2`, `k1`, `k2`, `a1`, `d1`), not all of them; `alc` covers all of them except `n1`. al-runner's PASS condition is a green baseline and no `error` verdict; it proves nothing about marker reach (al-runner reports none). The gate is what proves reach.
- The duplicate procedure walk in `types.ts`: the r1 prototype widened the private walk instead of deleting it. The r2 prototype deletes it and imports the engine's `findEnclosingProcedure`, as Task 1 says.

### Revision r2: the gate, version 2 (PRE-COMMITMENT, committed before any run of it)

**Why the gate rows committed at `afe11fca` are wrong, and are superseded (not edited).** They pre-committed `Note`, a split member that is `local` in both arms, at attribution `object` with BOTH tests covering it, and used that as the reached/not-reached control. That rests on R63's object-grain widening for locals, which applies only on the HUB coverage path. The gate runs on bcdev's default FENCED path, where the line map names a local member exactly (R175, `packages/runner/src/selection.ts`, `localsAreUnnameable`, measured there on `fixtures/sandbox-app`'s local `LogAudit`). The r2 al-runner preview of the version 1 target showed the same thing: every `Note` mutant `exact`, one covering test. So version 1 would have failed on attribution and had no negative control at all. I found this while prototyping, after `afe11fca`; the version 1 files are kept as `$S/gate/expect-gate-v1.json` and `$S/gate/R302Gate-v1.al.txt`.

**The constraint that shapes version 2.** On fenced coverage, a test covers a member exactly when it executes some line of it, and a whole-body block's marker is the first thing its guard branch runs. So every test that covers a split member reaches that member's whole-body block: a covering-but-not-reaching test cannot exist for a whole-body `empty-block`. The not-reached control therefore sits on a block INSIDE a split member's body, and the whole-body blocks are proven reached by every covering test.

**Target, version 2** (`$S/gate/r302-gate/src/R302Gate.Codeunit.al`, hand-written, `alc` PASS under `[]` and `[R302A]`):

- `Pick(X: Integer): Integer`, a split member with identical arms (L3 to L14). Body: `if X > 1 then begin Seen := Seen + 1; end; Note(X); exit(X + 1);`
- `Note(X: Integer)`, a split member, `local` in both arms (L16 to L23). Body: `Seen := Seen + X;`
- `Other(): Integer`, plain, `exit(7)`.
- Global `Seen: Integer`, which no test reads.

Tests: `PickEnters` (`Pick(5)` must be 6), `PickSkips` (`Pick(1)` must be 2), `OtherOnly` (`Other()` must be 7). HEAD generates 8 mutants on this target; the fixed pipeline, 13 (`$S/expect-r2-final/r302-gate.txt`: `+` `empty-block` L8, `return-value` L13, `swap-additive` L13, `empty-block` L21, `swap-additive` L22; `= raw 13 deployed 13`). Twin parity for it: 11 compared (all but `Other`'s two).

**Rows, both configurations** (`$S/gate/expect-gate.json`, version 2; every row also `reachGrain` `statement`, attribution `exact`, `guardReached` true):

| member | line | operator | verdict | covering | reachedBy | why |
| --- | --- | --- | --- | --- | --- | --- |
| `Pick` | 8 | `empty-block`, the split member's WHOLE body | killed | PickEnters, PickSkips | killer (either test; both fail on 0) | place 12's path, reached |
| `Pick` | 9 | `conditional-boundary` | survived | PickEnters, PickSkips | exactly both | `X >= 1` changes only `Seen` |
| `Pick` | 9 | `empty-block`, the block INSIDE the split body | survived | PickEnters, PickSkips | exactly PickEnters | THE CONTROL: PickSkips covers `Pick` and does NOT reach this block |
| `Pick` | 10 | `remove-assignment` | survived | PickEnters, PickSkips | exactly PickEnters | inside the block |
| `Pick` | 10 | `swap-additive` | survived | PickEnters, PickSkips | exactly PickEnters | inside the block |
| `Pick` | 12 | `void-method-call` | survived | PickEnters, PickSkips | exactly both | `Seen` is not read |
| `Pick` | 13 | `return-value` | killed | PickEnters, PickSkips | killer (either) | returns 0 |
| `Pick` | 13 | `swap-additive` | killed | PickEnters, PickSkips | killer (either) | returns `X - 1` |
| `Note` | 21 | `empty-block`, a local split member's WHOLE body | survived | PickEnters, PickSkips | exactly both | every covering test reaches a whole body |
| `Note` | 22 | `remove-assignment` | survived | PickEnters, PickSkips | exactly both | `Seen` is not read |
| `Note` | 22 | `swap-additive` | survived | PickEnters, PickSkips | exactly both | `Seen` is not read |
| `Other` | 26 | `empty-block` | killed | OtherOnly | killer OtherOnly | plain control |
| `Other` | 27 | `return-value` | killed | OtherOnly | killer OtherOnly | plain control |

For a `killer` row without a named killer, `check-gate.ts` now requires the killing test to be a covering test and to be in `reachedBy` (either covering test may run first, R197). Red-checked offline (`$S/gate/redcheck-gate.ts`, `redcheck-v2.out`): 24 of 24 cases as wanted: the good report passes in both configurations, and eleven edits each fail in both (the control block also reached by PickSkips, not reached at all, killed; `Note`'s whole body reached by one test only; `Pick`'s whole body missing; an extra mutant; `unplaced`; attribution `object`; the wrong killer; a red baseline; the wrong symbols).

Everything else in the gate is as `afe11fca` states: Cronus28 only, the CONTROLLER holds `coord lease Cronus28 bugs` and heartbeats it, R-316's cleanup rules, ids 91700 to 91799, and it commits nothing unless it passes.

### Revision r2 prototype check (written AFTER the r2 pre-commitment commit `afe11fca`)

The prototype is `$S/proto` again: r1's code (`$S/proto-r2.patch`) plus `$S/proto-patch-r2.py`, which adds `uniqueProcedure` to the symbol table, makes `callType` read it (C1), compares variable names with a case-insensitive `sameName` (C2), and deletes `types.ts`'s private procedure walk in favour of the engine's `findEnclosingProcedure` (the Minor). The whole diff is `$S/proto-r3.patch`. The rows committed at `afe11fca` are not edited; the disagreements are recorded here.

**The checker: 31 of 33 pre-committed checks matched** (`$S/logs/check-p3.txt`), totals included: every repro, DC/Cloud (102603 raw, 97144 deployed, r1's 19 and 7 rows exactly), BaseApp scratch (1568, 1540, 31 rows), BusinessFoundation (unchanged), the gate target (version 2: 13, 13, its 5 rows; the version 1 target's 10, 10 matched too before it was replaced), and all C1 and C2 site rows, System Application's 5 included (77291, 75832). Every runner warning (`.err`) is byte-identical to HEAD's.

**The two disagreements, both an existing mutant's key moving by ordinal, and both my error:**

- `o1-overload-split-first`: the plain overload `Foo(T: Text)`'s `empty-block` (L13) gains ordinal 1. The split `Foo` before it now has an `empty-block` too, with the same procedure name and the same AST hash. The AST hash is identifier-blind (R166: a variable becomes a positional id), so `exit(X)` and `exit(T)` hash alike. It is Decision 4's third mechanism, exactly `c3`'s, and the pre-commitment should have listed it; `o1` is a same-named overload after a split member.
- System Application, `SFTPClient.Codeunit.al` L56: an existing `swap-call-arguments` in an overload of `Initialize` gains ordinal 1, because the new L42 site, in the other `Initialize`, has the same identifier-blind hash. The pre-commitment called the case twin's key move at L56 "an artifact of rewriting source, which a fix that changes no source cannot cause". That was wrong: the twin's other 8 key moves ARE artifacts (a case variant is a different positional id), but L56's comes from the new site itself, and the real fix causes it.

Both corrections go in `$S/expect-r2-final/` as `k` rows; with them, **33 of 33 checks PASS**. No other key moved on any project.

**Twin parity: every pre-committed count matched** (`$S/logs/tp-*.txt`): `q1` 7, `q2` 7, `t5-loss-split` 29, `t5-lit-split` 10, `t5-hang-split` 8, `k1` 15, `k2` 14, `a1` 5, `c1` 8, `c2` 8, `c3` 4, `d1` 5, `d2` 3, `d3` 2, `d4` 3 with its two allowed rows, `e2` 5, `o1` 2, the gate target 11 (version 2; version 1's 8 also matched), DC/Cloud 29, BaseApp 68 against each arm-twin. Every compared mutant has an equal emitted guard branch (mutated text and marker placement), equal grain, gap block, member end and name. Red-checked: a count of 8 where 7 is due FAILS (`COUNT`); `d4` without its allow list FAILS with 2 `NO-TWIN`; a twin whose body differs by one character FAILS with 5 `DIFF` (every branch that holds that line).

**alc, every repro, every subset: 47 of 47 PASS** (25 projects; `n1` excluded, as pre-committed). **Red-checks of C1 and C2**, one line reverted at a time in `types.ts`, then restored (the restored diff is byte-identical to `proto-r3.patch`):

| reverted | repro | checker | alc |
| --- | --- | --- | --- |
| C1 (`callType` back to `resolveProcedure`) | `o1-overload-split-first` | FAIL (a new `swap-additive` L19, totals 5, 5) | FAIL, AL0175 |
| C1 | `o2-overload-plain` | FAIL (the `-` row not seen, totals 5, 5) | FAIL, AL0175 |
| C2 (the parameter compare back to `===`) | `e1-case-plain` | FAIL (the `-` row not seen, totals 10, 10) | FAIL, AL0133 |
| C2 | `e2-case-split` | FAIL (a new `swap-call-arguments` L11, totals 10, 10) | FAIL, AL0133 |
| restored | all four | PASS | PASS |

**The gate checker, red-checked offline** (`$S/gate/redcheck-gate.ts`): for version 2, 24 of 24 cases as wanted (`redcheck-v2.out`).

**The whole suite on the prototype:** 4268 pass, 2 fail, 7 skip; the same two R302-owned pins as in r1, nothing new.

**al-runner, local, serial, 7 projects** (the six of r1 plus the gate target; NOT every repro), coverage on and off, every subset: every session PASS, every baseline green, 0 `error` verdicts; the six repros' counts are r1's exactly. The version 1 gate target's run is what exposed the attribution error (every `Note` mutant `exact`, one covering test); see "the gate, version 2". The version 2 target (`$S/logs/ar-p3g-r302-gate-cov<1|0>.log`), both subsets: 5 killed, 8 survived, 0 no-coverage, and all 13 verdicts equal the version 2 rows; with coverage on every `Pick` and `Note` mutant is `exact` with 2 covering tests and each `Other` mutant `exact` with 1, as pre-committed. al-runner reports no reach, so the `reachedBy` column (the control) is for the live gate alone. `alc` of the version 2 target: PASS under both configurations; the full alc run stays 47 of 47.

**Result against the r2 pre-commitment, in one line:** C1 and C2 matched every site and every total (DC 102603 raw and 97144 deployed, BaseApp 1568 and 1540, System Application 77291 and 75832, BusinessFoundation and the fixtures unchanged); two ordinal renumberings were missed (`o1`, System Application `SFTPClient` L56); the version 1 gate rows were wrong on attribution and were replaced by version 2 before it ran; every twin-parity count matched.

### Revision r2: open questions for the orchestrator

1. **The gate ids** 91700 to 91799 are proposed (R-316 used 91600 to 91699). Confirm.
2. **The version 2 control** sits on a block inside a split body, because a whole-body block cannot have a covering-but-not-reaching test on fenced coverage (see "the gate, version 2"). The whole-body blocks are proven reached by every covering test (`Pick` L8, `Note` L21). Is that the control you want, or do you want a HUB-path run as well, where R63's object grain would give a whole-body control?
3. **R324** was filed beyond the ruling's list (C1 is pre-existing in plain procedures). Keep it separate from R302, or fold it in? The plan closes R322 and R324 with Task 1's commit.
4. **R323 stays open.** The split rule copies the plain procedure's behaviour for named return values; `n1` is its evidence and is excluded from the alc set.

Task count: 8 (Task 0 to Task 7; the gate is Task 5).

---

## Revision r3: review r2

Review: `H:/lethal-coord/reviews/R-302-plan/review-r2.md`. It closed C1, C2, I1 and I2 (subject to the planned gates passing) and found one new Critical. The orchestrator's answers to r2's questions: the ids 91700 to 91799 are fine; the inner-block control is valid, and the whole-body rows must be reached by their covering tests; R322 and R324 stay separate and Task 1 closes them; the implementer removes the prototype worktree once building starts.

### Critical: identity reuse across an engine change (R325, Task 1A)

The renumberings are inherent in R193's source-order ordinals: a new same-tuple mutant earlier in an object takes ordinal 0 and moves the old one to 1. Measured on the r2 prototype, System Application: the NEW `swap-call-arguments` at `SFTPClient.Codeunit.al` L42 (span 1811-1882) carries exactly the key the OLD L56 site (span 2639-2712) held at HEAD. Since nothing in history, resume or marks records the scheme a key was made under, an old L56 verdict could be credited to L42 with the AL source unchanged. Filed as R325 (`d3941580`, next free id after R324, checked across every worktree under `U:/Git/LethAL-wt/` and every local branch), and closed by the new Task 1A, which lands before Task 1's engine change. It changes no mutant count and no key; only the fingerprint digest and one report field, so there is nothing further to pre-commit.

### Important: every key transition pinned exactly

`check-sites.ts` now reads `k <site>\t<op>\t<old key>\t<new key>` (the exact transition, not "some key changed") and `a <site>\t<op>\t<key>` (the key a new mutant must carry). `$S/expect-r2-final/` pins, and the r2 prototype capture passes (33 of 33):

| project | mutant | old key (HEAD) | new key | new mutant that takes the old key | status |
| --- | --- | --- | --- | --- | --- |
| System Application | `SFTPClient.Codeunit.al` L56, `swap-call-arguments`, `Initialize` (overload 2) | `373c5b11...8b83\|SFTP Client\|Initialize\|lethal.swap-call-arguments\|1` | the same plus `\|1` | L42, `Initialize` (overload 1) | POST-PROTOTYPE EXCEPTION (not predicted at `afe11fca`) |
| `o1-overload-split-first` | `Repro.Codeunit.al` L13, `empty-block`, plain `Foo` | `d36581a9...d79f\|Repro O1\|Foo\|lethal.empty-block\|1` | the same plus `\|1` | L8, the split `Foo`'s body | POST-PROTOTYPE EXCEPTION |
| `c3-preamble-then-overload` | L18 `empty-block` and L20 `return-value`, the plain overload `Pick` | `5ebb7c9c...35fe\|Repro P\|Pick\|lethal.empty-block\|1` and `40277aa1...57f5\|Repro P\|Pick\|lethal.return-value\|1` | each plus `\|1` | L12 and L14, the preamble `Pick` | pre-committed at `d0e094ac` as "some key changes"; now exact |

(Full 64-character hashes are in the expectation files; they are abbreviated here only.) Red-checked: a wrong new key (`|1|2`) and a wrong pinned after-key each FAIL on the real capture. Task 7's closing record lists the first two as post-prototype exceptions.

### Minor: the gate's whole-body rows must be reached

`expect-gate.json` marks `Pick` L8 and `Note` L21 `wholeBody`, and `check-gate.ts` requires such a row to be reached by its covering tests: survived, `reachedBy` equals the covering set exactly; killed, `reachedBy` non-empty and only covering tests. The offline red-check is 24 of 24 as wanted (`redcheck-v3.out`), and the rule is load-bearing on its own: with `Note` L21's expected `reachedBy` weakened to `PickEnters` alone, a report reached only by `PickEnters` still FAILS on the whole-body rule.

### Superseded, kept

Decision 5 ("Live gate: not needed") and its later restatement in r1's corrections, and the pre-commitment's "System Application and BusinessFoundation ... byte-identical" bullet, are labelled SUPERSEDED in place. Their text is kept; the committed rows are unchanged.

---

## ADDENDUM, run 002: the R330 fail-safe (PRE-COMMITMENT, committed before the branch code)

The final review found two regressions on this branch in rare shapes (R330, filed in `5e158e41`).
In each, `master` emits nothing, and the branch emits a `swap-additive` that fails `alc` with AL0175.

- **I1.** An overload of the same name, wrapped whole in `#if`, is not indexed. So `uniqueProcedure`
  calls a split member unique, and the call is typed by the split member's return type.
- **I2.** A plain procedure's local declared in a `#if` var block (R303's shape) is not indexed.
  So since R322's case-insensitive compare, the local fails to hide a global whose name differs
  only in case.

The rows committed above are not edited. This addendum only adds.

### The rule: one fail-safe, the same as R327's

A name declared in a `#if` region that the symbol table does not index is UNKNOWN. It gets no type,
and no typed operator can claim a site that depends on it. It has two uses:

- **Procedures (I1, and master's older plain form).** Every procedure-like declaration of an object
  counts under its names, wherever the grammar put it: a direct member, a member inside a
  `preproc_conditional`, or a member swallowed by the global `var` section (R327). The unindexed
  ones count as `null`. So `uniqueProcedure` answers only when exactly one INDEXED declaration
  carries the name and no other declaration does. This one walk replaces R327's special case.
- **Locals and parameters (I2).** A member's header can declare a name inside a `#if` region of
  its own: a `preproc_conditional_var_block`, or a conditional parameter. Such a name is in the
  member's `ambiguous` set. So `resolveIdentifierType` and `lookupVar` return `null` for it, before
  the locals and before the globals. For a split member, this also makes a `#if` block nested inside
  one arm's header unknown. That is review M6's case, until now read as unconditional for that arm,
  and it has 0 corpus hits.

Both uses read only where names are DECLARED, never the body.

### Scope decision: run 002 closes R330, plain form included

The guard is a small change: one walk in `buildSymbolTable` and one header walk per member, with no
`#if` indexing. It covers `master`'s older plain I1 form at no extra cost. So run 002 does both, and
R330 closes with it.

### Measured on a scratch prototype, then reasoned per row

I measured the effect on a scratch worktree: `$S/proto2`, detached at `c59d2b62` (this branch
merged with `master`), with the rule applied (`$S/run002-patch.py`). No branch code existed yet.
The sources are the same as `$S/cap/merged/`, which matched every row above.

| scope | before | with the guard | removals |
| --- | --- | --- | --- |
| DC/Cloud (the whole project) | 102603 raw, 97144 deployed | 102603, 97144 | **0**; the capture is byte-identical |
| BaseApp scratch project | 1568, 1540 | 1568, 1540 | **0** |
| System Application | 77291, 75832 | 77291, 75832 | **0** |
| BusinessFoundation | 3639, 3573 | 3639, 3573 | **0** |
| Every repro above, and the gate target (version 2) | as pre-committed | identical | **0** |
| All of `BC.History/BaseApp` (`Source` and `Test`, spec generation only) | 1775413 raw specs over 7106 files | the identical spec set | **0** |
| Every fixture: identity keys and emitted targets | byte-identical to BEFORE | byte-identical | **0** |

Every runner warning (`.err`) is byte-identical too.

**The review's 32 plain same-name pairs** (a direct procedure plus a `#if`-wrapped one of the same
name, in DC and BaseApp) lose no mutant. No typed-operator site in those corpora reads a call to one
of those names, so no pair-by-pair list exists to pin. The full-BaseApp row above is the
measurement that says so. It covers the qualified calls from other objects that the four-file
scratch project cannot see.

### The rows the guard does remove: three new hand-written repros

These are in `$S/repro/r330-*` and `$S/expect-r002/`. The branch totals are at `c59d2b62`.

| repro | shape | branch (raw, deployed) | expected (raw, deployed) | row |
| --- | --- | --- | --- | --- |
| `r330-i1` | a split `Foo(Integer): Integer`; inside `#if X`, a plain `Foo(Text): Text` and `Bar` calling `Foo('x') + Foo('y')` | 5, 5 | **4, 4** | `-` `swap-additive` in `Bar`, key `907a63da28a269ecb3f6fe80dfd511dc0590d35c4e22f0dc6072738bdfddc531\|Repro R330A\|Bar\|lethal.swap-additive\|1` |
| `r330-i2` | a global `AMT: Integer`; a plain `Bar` whose `#if not CLEAN27` var block declares `Amt: Text`; body `Amt + Amt` | 3, 3 | **2, 2** | `-` `swap-additive` in `Bar`, key `29cb74e25b27b013d70909c2b6d38f4ca2ad28040ac9566879e4f0e634dfa189\|Repro R330B\|Bar\|lethal.swap-additive\|1` |
| `r330-p1` | `master`'s older plain form: a direct `Foo(Integer): Integer`; inside `#if X`, `Foo(Text): Text` and `Bar` as in `r330-i1` | 5, 5 | **4, 4** | `-` `swap-additive` in `Bar`, key `907a63da28a269ecb3f6fe80dfd511dc0590d35c4e22f0dc6072738bdfddc531\|Repro R330P\|Bar\|lethal.swap-additive\|1` |

**Reasons, from the rule.**

- In `r330-i1` and `r330-p1`, `Foo` has two declarations, one of them unindexed, so no call to `Foo`
  is typed. `swap-additive` needs both operands typed as numeric.
- In `r330-i2`, `amt` is in `Bar`'s `ambiguous` set, so `Amt` is unknown and never reaches the
  global `AMT`.
- No other row moves: `empty-block`, `return-value` and `void-method-call` need no type.

**Every removal is AL0175, a mutant that does not compile.** Each instrumented project was compiled
with `alc`, under every subset of its symbols. The logs are `$S/logs/p002-alc-<tool>-<repro>.log`.

| emission | `r330-i1` | `r330-i2` | `r330-p1` |
| --- | --- | --- | --- |
| branch at `c59d2b62` | FAIL AL0175 under `[X]` and `[X,Y]`, PASS under `[]` and `[Y]` | FAIL AL0175 under `[]`, PASS under `[CLEAN27]` | FAIL AL0175 under `[X]`, PASS under `[]` |
| `master` at `9680dad9` | no swap; PASS all 4 | no swap; PASS both | **FAIL AL0175 under `[X]`** (the older plain form); PASS under `[]` |
| prototype with the guard | no swap; PASS all 4 | no swap; PASS both | no swap; PASS both |

**Checker.** `$S/expect-r002/` is `$S/expect-r2-final/` plus the three files above. Their BEFORE is
`$S/cap/head002/`, which is `$S/cap/head/` plus the branch captures of the three repros. On the
prototype, all three pass. The unedited files FAIL against the branch's own captures, each with the
`-` row not seen.

---

## ADDENDUM 2, run 002 fix round: trigger locals hide the globals (PRE-COMMITMENT, committed before the branch code)

The run 002 re-review found I3. Type resolution never reads a trigger's locals, so a name used in a
trigger falls through to the object's globals. Since R322, that includes a global whose name differs
only in case. Its repros emit `Amt - Amt`, which fails `alc` with AL0175, and `master` emits nothing
there. The same-case form is `master`'s older defect.

Neither the committed rows nor the first addendum is edited.

### The rule

Inside a trigger, any name the trigger declares in its own header is UNKNOWN. That covers a plain
`var` section and anything inside a `#if` region. Such a name gets no type in `resolveIdentifierType`
and never reaches a global.

`lookupVar` keeps resolving a plain trigger local to its declaration, as it has since R68, because
that is its real type. It now returns `null` for a name the trigger declares only inside a `#if`
region, instead of falling through to a global.

Trigger locals are NOT resolved to their own types in `types.ts`. That would add sites, which is
new scope.

### Measured on a scratch prototype, then reasoned per row

The prototype is `$S/proto3`, detached at `00980729`, with `$S/run002b-patch.py` applied. It is
compared with the branch at `00980729`.

| scope | branch | with the rule | removals |
| --- | --- | --- | --- |
| DC/Cloud | 102603, 97144 | 102603, 97144 | **0**; the capture is byte-identical |
| BaseApp scratch project | 1568, 1540 | 1568, 1540 | **0** |
| System Application | 77291, 75832 | 77291, 75832 | **0** |
| BusinessFoundation | 3639, 3573 | 3639, 3573 | **0** |
| Every committed repro and the gate target (version 2) | as pre-committed | identical | **0** |
| Every fixture: identity keys and emitted targets | byte-identical to BEFORE | byte-identical | **0** |
| All of `BC.History/BaseApp`, spec generation only | 1775413 raw specs | 1775409 | **4** (below) |

Every runner warning is byte-identical.

**The 4 full-BaseApp removals.** All four are in `Service/Document/ServiceHeader.Table.al`, in the
`OnValidate` trigger of one field, and all are `lethal.swap-additive`. Their identity keys were
measured on a scratch project holding that file and `ServiceLine.Table.al`, which is enough to type
the sites. The ordinals are the object's own, and no other key in that project moved:

- `ea7dc9fb05d7b12e86e3962b6dd8b43418865d40b84f10587ff974608eee0039|Service Header|OnValidate|lethal.swap-additive|1`
- the same with `|1|1`
- the same with `|1|2`
- the same with `|1|3`

**Reason:** each is an operand `1 + (<rec>."VAT %" / 100)`, where `<rec>` is a local of that
trigger. Before the rule it was typed through the table's GLOBAL of the same name. After the rule
the local is unknown, so the operand gets no type.

**These four are NOT compile failures.** The trigger local and the global are declared with the same
type (`Record "Service Line"`), so the old typing happened to be right, and the swapped expression
is a valid `Decimal` subtraction. The rule loses four valid mutants: under-generation, the safe
direction. They are outside the committed corpora, since the BaseApp scratch project does not
contain that file, so no committed total moves.

**The refinement not taken.** Keeping them would need the trigger local's own type, which the plan
keeps out of this run.

The review's census found 272 same-case trigger locals across the four corpora. Only these four
feed a typed site that the rule removes. The rest feed no typed site, or feed one that keeps its
type another way; that is an inference from identical output, not a per-local check.

### The rows the rule removes: four new hand-written repros

These are in `$S/repro/r330-t*` and `$S/expect-r002/`. Each loses exactly its `swap-additive`.

| repro | shape | branch (raw, deployed) | expected | key of the removed mutant |
| --- | --- | --- | --- | --- |
| `r330-t1c` | codeunit `OnRun`; its `#if not CLEAN27` var block declares `Amt: Text`; global `AMT: Integer`; body `Amt + Amt` | 3, 3 | **2, 2** | `29cb74e25b27b013d70909c2b6d38f4ca2ad28040ac9566879e4f0e634dfa189\|Repro R330T1\|OnRun\|lethal.swap-additive\|1` |
| `r330-t3` | the same with a PLAIN trigger `var` local | 3, 3 | **2, 2** | `...\|Repro R330T3\|OnRun\|lethal.swap-additive\|1` (same hash) |
| `r330-t3s` | `r330-t3` with the global spelled `Amt` (`master`'s older same-case form) | 3, 3 | **2, 2** | `...\|Repro R330T3S\|OnRun\|lethal.swap-additive\|1` (same hash) |
| `r330-t2` | the `#if` block form in a table field's `OnValidate` | 3, 3 | **2, 2** | `...\|Repro R330T2\|OnValidate\|lethal.swap-additive\|1` (same hash) |

**`alc` on every symbol subset.** The logs are `$S/logs/p003-alc-<tool>-<repro>.log`.

| emission | `r330-t1c` | `r330-t3` | `r330-t3s` | `r330-t2` |
| --- | --- | --- | --- | --- |
| branch at `00980729` | AL0175 under `[]` | AL0175 under both | AL0175 under both | AL0175 under `[]` |
| `master` at `9680dad9` | no swap, PASS | no swap, PASS | **AL0175 under both** (the older form) | no swap, PASS |
| prototype with the rule | no swap, PASS | no swap, PASS | no swap, PASS | no swap, PASS |

With these four files added, `$S/expect-r002/` passes on the prototype.

---

## ADDENDUM 3, run 003: unindexed plain members and the rule-3 guard (PRE-COMMITMENT, committed before the branch code)

Review R-302-002 r1 found two Critical defects. Both emit a mutant that does not compile.

- **C1.** A PLAIN procedure wrapped whole in `#if` is not indexed. Inside it, type resolution tried
  the name fallback (another procedure of the same name) and then the object's globals, and since
  R322 it also matched a global in other casing.
- **C2.** `validate-to-assign` relies on `declaresProcedure`, which did not see a `#if`-wrapped
  table procedure. So a custom `R.Validate(N, 5)` became `R.N := 5`, where no field `N` exists.

The committed rows and addenda 1 and 2 are not edited.

### The rule, and the sweep it came with

The run 003 rule is "unindexed means unknown", for every member shape and every name question.

1. **C1.** `resolveIdentifierType` and `lookupVar` resolve a member ONLY by its position in the
   index. A member the index does not hold, of ANY shape (plain, split, swallowed or wrapped), types
   nothing and resolves nothing. The name fallback is removed: it answered with a DIFFERENT
   procedure's declarations.
2. **C2.** `declaresProcedure` reads `allProcedureLikes`, which covers direct members, members
   inside `#if` and members swallowed by the var section.
3. **Sweep.** A table or `tableextension` wrapped whole in a `#if` object region (R298's
   `preproc_conditional_object`) is not in the index. Rule 3 now also reads those objects through a
   new `SymbolTable.unindexedObjects`. The same `R.Validate(N, 5)` shape against a wrapped table,
   and against a wrapped `tableextension`, failed `alc` on the branch and on master alike.

### Where the numbers come from

Everything below was measured on a scratch prototype: `$S/proto4`, detached at `f4d59ae4`, with
`$S/run003-patch.py` applied. It was compared with the branch at `f4d59ae4` (`$S/cap/r003`).

| scope | branch (raw, deployed) | with the rule | change |
| --- | --- | --- | --- |
| DC/Cloud | 102603, 97144 | **102584, 97126** | 19 removed, 1 added, 14 keys renumbered (rows below) |
| BaseApp scratch project | 1568, 1540 | 1568, 1540 | 0 |
| System Application | 77291, 75832 | 77291, 75832 | 0 |
| BusinessFoundation | 3639, 3573 | 3639, 3573 | 0 |
| Every earlier repro, and the gate target (version 2) | as pinned | identical | 0 |
| Every fixture: identity keys and emitted targets | byte-identical to BEFORE | byte-identical | 0 |
| All of `BC.History/BaseApp`, raw specs | 1775409 | **1775366** | 43 removed, 8 added, 4 keys renumbered (rows below) |

Every runner warning is byte-identical.

**The DC deployed total** falls by 18, not 19. One removed row was a Tier-2 claim (`remove-calcfields`
in `CreateTableRow`), and the Tier-1 `void-method-call` it had displaced comes back at the same span.

**Which rule caused each change.** A scratch walk over the removed rows (`$S/wrapped-of.ts`) puts
every one of them, 19 in DC and 43 in BaseApp, inside a procedure the index does not hold:

- 60 are inside a `preproc_conditional`: a plain overload wrapped whole in `#if not CLEAN27`, next
  to a direct procedure of the same name.
- 2 are inside a `preproc_conditional_var` region.

So every corpus change comes from C1. C2 and the wrapped-object sweep change no corpus count; they
matter only for the new repros.

**Every renumbered key is in a DIRECT member.** It loses the `|1` ordinal it had while the wrapped
twin's identical site existed.

**Every added row is a `void-method-call`** that returns where a Tier-2 claim (`remove-setrange` or
`remove-calcfields`) is no longer made. A receiver inside a wrapped member no longer resolves.

**Reason for the removals.** At `f4d59ae4`, a site inside a wrapped overload was typed through the
name fallback: by the declarations of the direct procedure with the same name, which is a different
member. In DC, for example, the direct overloads take a different XML Document codeunit or a Text
where the wrapped ones take a BigString codeunit. So those types were not the member's own.

Whether each removed swap compiles was not established: DC and BaseApp cannot be compiled offline
here. Removing them is the fail-safe direction. Some of them may have been valid mutants typed right
by accident.

### The new repros (`$S/repro/r331-*`, `$S/expect-r003/`)

| repro | shape | branch | expected | row |
| --- | --- | --- | --- | --- |
| `r331-c1` | `#if X` wraps a plain `Foo(V: Text): Text` returning `V + V`; global `v: Integer` | 2, 2 | **1, 1** | `-` `swap-additive` in `Foo` |
| `r331-c1s` | the same with the global spelled `V` (the older same-case form) | 2, 2 | **1, 1** | `-` `swap-additive` in `Foo` |
| `r331-c2` | a table declaring `Validate(A: Integer; B: Integer)` in both arms of `#if X ... #else ... #endif`; a codeunit calls `R.Validate(N, 5)` on it | 3, 3 | **2, 2** | `-` `validate-to-assign` in `Pick` |
| `r331-c2o` | the same, with the WHOLE table wrapped in `#if X ... #else ... #endif` (R298's object region) | 3, 3 | **2, 2** | `-` `validate-to-assign` in `Pick` |
| `r331-c2x` | a plain table, plus a `tableextension` declaring `Validate` wrapped whole in `#if`/`#else` | 3, 3 | **2, 2** | `-` `validate-to-assign` in `Pick` |

**`alc`, every subset of `[X]`.** The logs are `$S/logs/p004-alc-<tool>-<repro>.log`.

| emission | `r331-c1` | `r331-c1s` | `r331-c2` | `r331-c2o` | `r331-c2x` |
| --- | --- | --- | --- | --- | --- |
| branch at `f4d59ae4` | AL0175 under `[X]` | AL0175 under `[X]` | AL0132 under both | AL0132 under both | AL0132 under both |
| `master` at `9680dad9` | no swap, PASS | **AL0175 under `[X]`** | **AL0132 under both** | **AL0132 under both** | **AL0132 under both** |
| prototype with the rule | PASS both | PASS both | PASS both | PASS both | PASS both |

AL0132 is "Record ... does not contain a definition": the mutant assigns a field that does not exist.

**What exists on master:**

- C1 in its different-cased form (`r331-c1`) is a regression on this branch.
- C1's same-case form (`r331-c1s`), and all three C2 shapes, already emit the failing mutant on
  master.

**The checker.** Against `$S/expect-r003/` (every earlier row plus this addendum's), with BEFORE
at `$S/cap/head002/`: **45 of 45 pass** on the prototype.

### The rows

**DC/Cloud (a committed corpus).**

| row | file:line | operator | member | identity key |
| --- | --- | --- | --- | --- |
| `-` | `.dependencies\DC\Codeunit\CDCCaptureRTCLibrary.Codeunit.al:500` | `swap-call-arguments` | BuildStartScanningCommand | `c0b669bc93493eb324ce187e6da1c051e693cb8efe0d3c2a0fb8a4600684fb34\|CDC Capture RTC Library\|BuildStartScanningCommand\|lethal.swap-call-arguments\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCCaptureRTCLibrary.Codeunit.al:589` | `swap-call-arguments` | BuildSetSignParametersCommand | `1c058142c8f383328189a22c22b7eee06ac461797cc45331c64bd7f271aae706\|CDC Capture RTC Library\|BuildSetSignParametersCommand\|lethal.swap-call-arguments\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCCaptureRTCLibrary.Codeunit.al:625` | `swap-call-arguments` | BuildSetCertificateDataCommand | `8932fb09d565e1e400da8c03ea371cdf437e1edacc8bab1d4d0fa880ff2834e2\|CDC Capture RTC Library\|BuildSetCertificateDataCommand\|lethal.swap-call-arguments\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCCaptureRTCLibrary.Codeunit.al:661` | `swap-call-arguments` | BuildMatchInfoBarCommand | `769f8dd97415b7211e95e27ce413feac3bfdfb4c29844329b5db2d18684b2c81\|CDC Capture RTC Library\|BuildMatchInfoBarCommand\|lethal.swap-call-arguments\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCCaptureRTCLibrary.Codeunit.al:870` | `swap-call-arguments` | BuildDocHeaderFieldListCommand | `324fcd2caa612747a78347d50eb5c480d08749b74a6053f1421fdc52f9c25dd4\|CDC Capture RTC Library\|BuildDocHeaderFieldListCommand\|lethal.swap-call-arguments\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:515` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:516` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|1` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:517` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|2` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:518` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|3` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:519` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|4` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:520` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|5` |
| `-` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:521` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|6` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:154` | `swap-call-arguments` | CreateTableHeaderRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:155` | `swap-call-arguments` | CreateTableHeaderRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:205` | `swap-call-arguments` | CreateTableRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:206` | `swap-call-arguments` | CreateTableRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:208` | `swap-call-arguments` | CreateTableRow | `fe3c85f1d932041fb5dfb8b9ab888323a562b376a7c66b2827ac502e8adfa4f7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:209` | `swap-call-arguments` | CreateTableRow | `fe3c85f1d932041fb5dfb8b9ab888323a562b376a7c66b2827ac502e8adfa4f7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:212` | `remove-calcfields` | CreateTableRow | `a3dabdcf07058f5836ffbaad6affb0f01835df0490aa11ff646f0ac3009f0184\|CDC Review E-mail\|CreateTableRow\|lethal.remove-calcfields\|1` |
| `+` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:212` | `void-method-call` | CreateTableRow | `a3dabdcf07058f5836ffbaad6affb0f01835df0490aa11ff646f0ac3009f0184\|CDC Review E-mail\|CreateTableRow\|lethal.void-method-call\|1` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:547` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|7 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:548` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|8 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|1` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:549` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|9 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|2` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:550` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|10 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|3` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:551` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|11 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|4` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:552` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|12 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|5` |
| `k` | `.dependencies\DC\Codeunit\CDCPurchApprovalEMail.Codeunit.al:553` | `swap-call-arguments` | CreateTableHeaderRow | `ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|13 to ab77a65efb963feb79236f2ba9859a3040057c1b8fb22b6c44c186e199354448\|CDC Purch. Approval E-Mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|6` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:246` | `swap-call-arguments` | CreateTableRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|2 to 249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:247` | `swap-call-arguments` | CreateTableRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|3 to 249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|1` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:249` | `swap-call-arguments` | CreateTableRow | `fe3c85f1d932041fb5dfb8b9ab888323a562b376a7c66b2827ac502e8adfa4f7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|2 to fe3c85f1d932041fb5dfb8b9ab888323a562b376a7c66b2827ac502e8adfa4f7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:250` | `swap-call-arguments` | CreateTableRow | `fe3c85f1d932041fb5dfb8b9ab888323a562b376a7c66b2827ac502e8adfa4f7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|3 to fe3c85f1d932041fb5dfb8b9ab888323a562b376a7c66b2827ac502e8adfa4f7\|CDC Review E-mail\|CreateTableRow\|lethal.swap-call-arguments\|1\|1` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:253` | `remove-calcfields` | CreateTableRow | `a3dabdcf07058f5836ffbaad6affb0f01835df0490aa11ff646f0ac3009f0184\|CDC Review E-mail\|CreateTableRow\|lethal.remove-calcfields\|1\|1 to a3dabdcf07058f5836ffbaad6affb0f01835df0490aa11ff646f0ac3009f0184\|CDC Review E-mail\|CreateTableRow\|lethal.remove-calcfields\|1` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:178` | `swap-call-arguments` | CreateTableHeaderRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|2 to 249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1` |
| `k` | `Modules\Purchase Contracts\Base\src\Codeunits\CDCReviewEmail.Codeunit.al:179` | `swap-call-arguments` | CreateTableHeaderRow | `249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|3 to 249767cb6894295170b85e9f33fb51d8020603a3bcc71233d8c809cdb0330fa7\|CDC Review E-mail\|CreateTableHeaderRow\|lethal.swap-call-arguments\|1\|1` |

**All of `BC.History/BaseApp` (not a committed corpus). Keys were measured by generating the whole project, then instrumenting only the 18 affected files. Ordinals are per object, so each of those files keeps its full-run keys.**

| row | file:line | operator | member | identity key |
| --- | --- | --- | --- | --- |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:277` | `swap-call-arguments` | EmailFile | `db28ee3ff4c5abe44203b1acc9248a2664d341a3405ce78118c4d623f6a85c4b\|Document-Mailing\|EmailFile\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:362` | `swap-call-arguments` | EmailFileWithSubjectAndReportUsage | `9b5b677098dd61a8fb423f29a0866d06627c4e65259c7d38969e615b15b0dce6\|Document-Mailing\|EmailFileWithSubjectAndReportUsage\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:395` | `swap-call-arguments` | EmailFileWithSubjectAndReportUsage | `001e1bcb1747e223f16a3c199d2970ad907c277cafb38c07e0085273fb1c1346\|Document-Mailing\|EmailFileWithSubjectAndReportUsage\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:433` | `swap-call-arguments` | EmailFileWithSubjectAndReportUsage | `5b578dadb138b17a19f42a62829f78d8d8f0074da04ab24a4c20607374d1de66\|Document-Mailing\|EmailFileWithSubjectAndReportUsage\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:73` | `swap-call-arguments` | EmailFile | `4ddb7dd9c18373f0c813bebd71e3ca20093a12cdcdcd5384ef06ca15ea643f3c\|Document-Mailing\|EmailFile\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:107` | `swap-call-arguments` | EmailFile | `4c886b9ba5f0003a704412cebaf18b71e467e0a3b1a31b6a44b82229d7e50361\|Document-Mailing\|EmailFile\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:141` | `swap-call-arguments` | EmailFile | `4c886b9ba5f0003a704412cebaf18b71e467e0a3b1a31b6a44b82229d7e50361\|Document-Mailing\|EmailFile\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:178` | `swap-call-arguments` | EmailFile | `839d7935160550094d363031717e23adf51d1f995d8ab9d0657d3c78c93a7827\|Document-Mailing\|EmailFile\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\DocumentMailing.Codeunit.al:213` | `swap-call-arguments` | EmailFile | `90b02b8bd4d9149bd15fa312b1dd605955068588662411e5fd8de646880561fe\|Document-Mailing\|EmailFile\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Foundation\Reporting\ReportSelections.Table.al:830` | `swap-call-arguments` | GetEmailBodyTextForCust | `5c83eaca70fb74a28fb045744606a755358a802a15940394e85dc34e99d4b7f4\|Report Selections\|GetEmailBodyTextForCust\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Inventory\Item\Catalog\ItemReference.Table.al:285` | `swap-call-arguments` | FindItemDescription | `6a2dbb2325480effa9aac0945f108aa73fd6df828d661e5a16f74224a0b34404\|Item Reference\|FindItemDescription\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Inventory\Item\Substitution\ItemSubst.Codeunit.al:268` | `swap-call-arguments` | PrepareSubstList | `21d01233c86413a14f6b55e7336cf9fa7c4ea2f237601950be414e8991a3342a\|Item Subst.\|PrepareSubstList\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Inventory\Item\Substitution\ItemSubst.Codeunit.al:594` | `swap-call-arguments` | RunOnGetCompSubstOnAfterCheckPrepareSubstList | `3341c1652ebf920683226426d8dcbcaf850a4c8f60e2326e93d387f7c845deec\|Item Subst.\|RunOnGetCompSubstOnAfterCheckPrepareSubstList\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Inventory\Posting\ItemJnlPostLine.Codeunit.al:6976` | `swap-call-arguments` | RunOnPostOutputOnAfterInsertCostValueEntries | `a7a88132dabd5732a031998f39c73ffe03d86de48589752fd5a71cecd610d9dd\|Item Jnl.-Post Line\|RunOnPostOutputOnAfterInsertCostValueEntries\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Inventory\Tracking\InventoryProfileOffsetting.Codeunit.al:105` | `swap-call-arguments` | CalculatePlanFromWorksheet | `3e0f6a92afa0d3451fc51ea3d5a4c16c3955d21621af556e8dbc6bf19eef01d4\|Inventory Profile Offsetting\|CalculatePlanFromWorksheet\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Invoicing\O365HTMLTemplMgt.Codeunit.al:39` | `swap-call-arguments` | CreateEmailBodyFromReportSelections | `89a28e3a80b5dc6da7f1928f2b2e81b4604212c270f6cb8e5f46a4fcf23e02f9\|O365 HTML Templ. Mgt.\|CreateEmailBodyFromReportSelections\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Manufacturing\ProductionBOM\ProductionBOMCheck.Codeunit.al:124` | `swap-call-arguments` | CheckBOMStructure | `54bbc6d63bd3826d5f55b1b25ef91dc32ba0691cff03133c9d307c95e70b02d0\|Production BOM-Check\|CheckBOMStructure\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Purchases\Posting\PurchPostInvoiceEvents.Codeunit.al:411` | `swap-call-arguments` | RunOnPrepareLineOnAfterFillInvoicePostingBuffer | `498d44de1e896c9c1a16a049e1e38cc18edd93d65430e1fd134232b277ff99bb\|Purch. Post Invoice Events\|RunOnPrepareLineOnAfterFillInvoicePostingBuffer\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Source\Base Application\Sales\Pricing\SalesPriceCalcMgt.Codeunit.al:2027` | `swap-call-arguments` | RunOnBeforeFindSalesPrice | `b4d4b7e9f5a59ac4601ba0f9cc01d6f5bba28b4996825d3832890fdefe809d10\|Sales Price Calc. Mgt.\|RunOnBeforeFindSalesPrice\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Sales\Pricing\SalesPriceCalcMgt.Codeunit.al:1790` | `swap-call-arguments` | RunOnAfterFindSalesPrice | `1ee6f1cba6045169b98de6963669e98d43189ff85f1dcbb32261b8253a217546\|Sales Price Calc. Mgt.\|RunOnAfterFindSalesPrice\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Service\Posting\ServicePostInvoiceEvents.Codeunit.al:232` | `swap-call-arguments` | RunOnPostLedgerEntryOnBeforeGenJnlPostLine | `fa75cbb275bb28965006c6864ba824a7e490d7c0855a83dad4a76155efefd6d4\|Service Post Invoice Events\|RunOnPostLedgerEntryOnBeforeGenJnlPostLine\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Service\Posting\ServicePostInvoiceEvents.Codeunit.al:123` | `swap-call-arguments` | RunOnPrepareLineOnAfterFillInvoicePostingBuffer | `d48253772d4e8259f47dc0cc801af6f7dcd83add5765f06e127135e6fffb96d1\|Service Post Invoice Events\|RunOnPrepareLineOnAfterFillInvoicePostingBuffer\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:199` | `remove-setrange` | CreditMemoPEPPOL21_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL21_OnGetTotals\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:282` | `remove-setrange` | InvoicePEPPOL20_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL20_OnInitializeOnSetSourceDocument\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:304` | `remove-setrange` | InvoicePEPPOL20_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL20_OnGetTotals\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:328` | `remove-setrange` | InvoicePEPPOL21_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL21_OnInitializeOnSetSourceDocument\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:350` | `remove-setrange` | InvoicePEPPOL21_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL21_OnGetTotals\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:131` | `remove-setrange` | CreditMemoPEPPOL20_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL20_OnInitializeOnSetSourceDocument\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:153` | `remove-setrange` | CreditMemoPEPPOL20_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL20_OnGetTotals\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:177` | `remove-setrange` | CreditMemoPEPPOL21_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL21_OnInitializeOnSetSourceDocument\|lethal.remove-setrange\|1` |
| `-` | `Source\Base Application\Warehouse\Activity\CreateInventoryPutaway.Codeunit.al:631` | `swap-call-arguments` | SetFilterProdOrderLine | `005b2e5ac8b84c8922fb2615fba1edee0259b515b0fbe5b5c589cd9c3c5ac1ef\|Create Inventory Put-away\|SetFilterProdOrderLine\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Warehouse\Activity\CreatePutaway.Codeunit.al:1098` | `swap-call-arguments` | RunOnAfterSetValues | `38546c1aa5a3f6791fee05a4a74cb8dc2e1246db3ea7e0c65dcd030c28898686\|Create Put-away\|RunOnAfterSetValues\|lethal.swap-call-arguments\|1` |
| `-` | `Source\Base Application\Warehouse\Activity\CreatePutaway.Codeunit.al:1130` | `swap-call-arguments` | RunOnBeforeAssignQtyToPutAwayForBinMandatory | `4ffe08a503a871678a4504e2f6301b49f99cb38f2fb4c7d5ab14e7521a4cad75\|Create Put-away\|RunOnBeforeAssignQtyToPutAwayForBinMandatory\|lethal.swap-call-arguments\|1` |
| `-` | `Test\Tests-ERM\ERMInvDiscountbyCurrency.Codeunit.al:462` | `swap-additive` | VariousVATAmountsOnSalesOrderStatistics | `78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89\|ERM Inv Discount by Currency\|VariousVATAmountsOnSalesOrderStatistics\|lethal.swap-additive\|1` |
| `-` | `Test\Tests-ERM\ERMInvDiscountbyCurrency.Codeunit.al:464` | `swap-additive` | VariousVATAmountsOnSalesOrderStatistics | `78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89\|ERM Inv Discount by Currency\|VariousVATAmountsOnSalesOrderStatistics\|lethal.swap-additive\|1\|1` |
| `-` | `Test\Tests-Misc\ReportSelectionsTests.Codeunit.al:3049` | `validate-to-assign` | GetEmailItem | `af7438e4405a331160bef6203826947b43964b9d260aa2a9761362300f732f8c\|Report Selections Tests\|GetEmailItem\|lethal.validate-to-assign\|1` |
| `-` | `Test\Tests-Misc\ReportSelectionsTests.Codeunit.al:3050` | `validate-to-assign` | GetEmailItem | `5a4540cffd29b33069a439076f0c8b3abc6802722cec1210a6320b9dbbc3a05a\|Report Selections Tests\|GetEmailItem\|lethal.validate-to-assign\|1` |
| `-` | `Test\Tests-Misc\ReportSelectionsTests.Codeunit.al:3051` | `validate-to-assign` | GetEmailItem | `b6a63d0971c9bf988795d80ea0a69f1fd816f7c0180f93880397c197969baa1d\|Report Selections Tests\|GetEmailItem\|lethal.validate-to-assign\|1` |
| `-` | `Test\Tests-Prepayment\ERMPrepaymentIII.Codeunit.al:878` | `swap-additive` | PrepmtValuesOnSalesLine | `78d263bdf45458172865b270cf8c37ce220abae7feec90e4dd915b0eabc69b89\|ERM Prepayment III\|PrepmtValuesOnSalesLine\|lethal.swap-additive\|1` |
| `-` | `Test\Tests-SCM\SCMInventoryBatchJobs.Codeunit.al:2428` | `swap-call-arguments` | ServiceOrderStatisticsPageHandler | `7ade6c5ad83465038d84c1f3b9a18fb5b31a5fd63b8dd99e725e5711dd0c2161\|SCM Inventory Batch Jobs\|ServiceOrderStatisticsPageHandler\|lethal.swap-call-arguments\|1` |
| `-` | `Test\Tests-SCM\SCMInventoryBatchJobs.Codeunit.al:2431` | `swap-call-arguments` | ServiceOrderStatisticsPageHandler | `7ade6c5ad83465038d84c1f3b9a18fb5b31a5fd63b8dd99e725e5711dd0c2161\|SCM Inventory Batch Jobs\|ServiceOrderStatisticsPageHandler\|lethal.swap-call-arguments\|1\|1` |
| `-` | `Test\Tests-SCM\SCMInventoryBatchJobs.Codeunit.al:2444` | `swap-call-arguments` | PostedServiceInvoiceStatisticsPageHandler | `7ade6c5ad83465038d84c1f3b9a18fb5b31a5fd63b8dd99e725e5711dd0c2161\|SCM Inventory Batch Jobs\|PostedServiceInvoiceStatisticsPageHandler\|lethal.swap-call-arguments\|1` |
| `-` | `Test\Tests-SCM\SCMInventoryBatchJobs.Codeunit.al:2447` | `swap-call-arguments` | PostedServiceInvoiceStatisticsPageHandler | `7ade6c5ad83465038d84c1f3b9a18fb5b31a5fd63b8dd99e725e5711dd0c2161\|SCM Inventory Batch Jobs\|PostedServiceInvoiceStatisticsPageHandler\|lethal.swap-call-arguments\|1\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:199` | `void-method-call` | CreditMemoPEPPOL21_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL21_OnGetTotals\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:282` | `void-method-call` | InvoicePEPPOL20_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL20_OnInitializeOnSetSourceDocument\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:304` | `void-method-call` | InvoicePEPPOL20_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL20_OnGetTotals\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:328` | `void-method-call` | InvoicePEPPOL21_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL21_OnInitializeOnSetSourceDocument\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:350` | `void-method-call` | InvoicePEPPOL21_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|InvoicePEPPOL21_OnGetTotals\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:131` | `void-method-call` | CreditMemoPEPPOL20_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL20_OnInitializeOnSetSourceDocument\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:153` | `void-method-call` | CreditMemoPEPPOL20_OnGetTotals | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL20_OnGetTotals\|lethal.void-method-call\|1` |
| `+` | `Source\Base Application\Service\Sales\Peppol\ServPEPPOLManagement.Codeunit.al:177` | `void-method-call` | CreditMemoPEPPOL21_OnInitializeOnSetSourceDocument | `cb714f7d71d006fc4363968c98fd7c46ac07406da07d8821f9c91b8b41652ce3\|Serv. PEPPOL Management\|CreditMemoPEPPOL21_OnInitializeOnSetSourceDocument\|lethal.void-method-call\|1` |
| `k` | `Source\Base Application\Foundation\Reporting\ReportSelections.Table.al:915` | `swap-call-arguments` | GetEmailBodyTextForCust | `5c83eaca70fb74a28fb045744606a755358a802a15940394e85dc34e99d4b7f4\|Report Selections\|GetEmailBodyTextForCust\|lethal.swap-call-arguments\|1\|1 to 5c83eaca70fb74a28fb045744606a755358a802a15940394e85dc34e99d4b7f4\|Report Selections\|GetEmailBodyTextForCust\|lethal.swap-call-arguments\|1` |
| `k` | `Source\Base Application\Invoicing\O365HTMLTemplMgt.Codeunit.al:59` | `swap-call-arguments` | CreateEmailBodyFromReportSelections | `89a28e3a80b5dc6da7f1928f2b2e81b4604212c270f6cb8e5f46a4fcf23e02f9\|O365 HTML Templ. Mgt.\|CreateEmailBodyFromReportSelections\|lethal.swap-call-arguments\|1\|1 to 89a28e3a80b5dc6da7f1928f2b2e81b4604212c270f6cb8e5f46a4fcf23e02f9\|O365 HTML Templ. Mgt.\|CreateEmailBodyFromReportSelections\|lethal.swap-call-arguments\|1` |
| `k` | `Source\Base Application\Service\Posting\ServicePostInvoiceEvents.Codeunit.al:238` | `swap-call-arguments` | RunOnPostLedgerEntryOnBeforeGenJnlPostLine | `fa75cbb275bb28965006c6864ba824a7e490d7c0855a83dad4a76155efefd6d4\|Service Post Invoice Events\|RunOnPostLedgerEntryOnBeforeGenJnlPostLine\|lethal.swap-call-arguments\|1\|1 to fa75cbb275bb28965006c6864ba824a7e490d7c0855a83dad4a76155efefd6d4\|Service Post Invoice Events\|RunOnPostLedgerEntryOnBeforeGenJnlPostLine\|lethal.swap-call-arguments\|1` |
| `k` | `Test\Tests-Misc\ReportSelectionsTests.Codeunit.al:3057` | `validate-to-assign` | GetEmailItem | `5a4540cffd29b33069a439076f0c8b3abc6802722cec1210a6320b9dbbc3a05a\|Report Selections Tests\|GetEmailItem\|lethal.validate-to-assign\|1\|1 to 5a4540cffd29b33069a439076f0c8b3abc6802722cec1210a6320b9dbbc3a05a\|Report Selections Tests\|GetEmailItem\|lethal.validate-to-assign\|1` |
