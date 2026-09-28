# R-302: semantic resolution and the body walks see inside both split-header procedure shapes, so their sites are generated as in a plain procedure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
2. Decision 5: the change DOES touch the emission path, through place 12, which decides the statement a split member's body mutant is wrapped as. The decision stands, for the reasons measured above: the wrapped statement is the one a plain procedure's body gets (alc 37/37, grain and gap equal to the twin's), and nothing else on that path changes. Review may overrule this; if it does, a Cronus28 gate on `q2`-shaped and `k1`-shaped members is the natural scope.
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
- No container is used. If Task 4's STOP rule fires (Decision 5), the orchestrator decides on a Cronus28 gate under `coord lease Cronus28 bugs`, never Cronus281 to 283.
- Tests assert only what their task owns: Task 1's engine tests assert symbol-table and type answers, never operator sites; Task 2's operator tests assert sites, never identity keys; Task 3 owns the runner-level site sets, the ordinals and the hang tag.

## Review Focus

1. **No false site where arms disagree.** Expected: `d1`'s swap is absent (its first-arm version fails `alc`, measured), and no ambiguous name falls through to a global. Pinned by Task 1's symbol-table and type tests and Task 3's `d1`; red-checked by removing the hiding.
2. **No site from a split member's header region.** Expected: no site claimed from an attribute or pragma inside an arm, so no dropped-site warning either (`a1`'s four attribute booleans; see the Decision 3 control). Pinned by Task 2's `inMemberBody` test and Task 3's `a1`; red-checked by widening the walk to the whole split node.
3. **Every place a test.** R302's closing criterion. Each of the 12 places has a test that a site inside a split member is generated with the same operator and text as in its twin, red-checked by reverting that place alone.
4. **Refusal guards read any arm, resolution reads every arm.** `d5`, `d6` (any) and `d1` to `d4`, `d7` (every).
5. **A renamed member stays unnamed.** `c1`, `c2`: its new mutants carry `procedureName` `""`; no call by name resolves to it.
6. **Keys.** Only the rows in the pre-commitment (and the corrections) move; fixtures, System Application and BusinessFoundation 0.
7. **Emission.** Place 12 changes which node is the statement for a split member's body, so it is on the emission path. Every new mutant's emission compiles under every subset (Task 4), and its `reachGrain`, member lines and gap block equal its twin's.

## File structure

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

### Task 1: The engine resolves inside a split member, and `return-value` reads the agreed return type (places 1 to 4, 9 to 12)

**Files:**
- Modify: `packages/engine/src/ast/tree-walks.ts`, `packages/engine/src/index.ts`, `packages/engine/src/semantic/symbol-table.ts`, `packages/engine/src/semantic/types.ts`, `packages/engine/src/semantic/receiver.ts`, `packages/engine/src/semantic/callers.ts`, `packages/builtin-tier1/src/return-value.ts`
- Test: `packages/engine/tests/ast/tree-walks.test.ts`, `packages/engine/tests/semantic/symbol-table.test.ts`, `types.test.ts`, `resolve-var-ref.test.ts`, `callers.test.ts`, `packages/builtin-tier2/tests/receiver.test.ts`, `packages/builtin-tier1/tests/return-value.test.ts`

`return-value.ts` is in this task, not Task 2, on purpose: it reads `findEnclosingProcedure`, which this task widens. Left for Task 2, the Task 1 commit would give a split member a `return-value` typed by its FIRST arm's return type, which is `d2`'s wrong site.

- [ ] **Step 1: Write the failing tests, and flip the engine pin.** The test "findEnclosingProcedure is deliberately unchanged: null inside a split procedure (R302)" in `tree-walks.test.ts` pins HEAD's blindness and is R302's to change: it becomes "returns the split node". Then, each on hand-written inline AL, one per place, asserting only an engine answer (and, for `return-value`, its sites):
  - `tree-walks.test.ts`: `findEnclosingProcedure` from a body statement returns the split node for both shapes (place 3); `memberArms` gives one arm per `#if`/`#elif`/`#else` with the arm's own children; `procedureLikeReturnType` is the agreed text, `null` when arms disagree or one arm has none; `inMemberBody` is true for a body literal and FALSE for a string inside an `[Obsolete(...)]` attribute inside an arm; `findEnclosingStatement` of a split member's body block is that block (place 12).
  - `symbol-table.test.ts`: a split member is found by `resolveProcedureAt` at its own start (place 1); agreeing parameters and a shared var section's locals are listed; a parameter with different types per arm, and an arm-only local, are in `ambiguous` and in neither list; `returnType` agrees or is `null`; a renamed member has name `""` and `resolveProcedure(scope, "")` is `null`.
  - `types.test.ts`: an identifier that is an agreeing parameter types; an ambiguous one is `null` even when a global of the same name exists (place 2); a call to an agreeing split member types by its return type, a call to a disagreeing one is `null`.
  - `resolve-var-ref.test.ts`: `resolveVarRef` finds an agreeing split-member local; an ambiguous name returns `null`, not the global (place 3).
  - `receiver.test.ts`: `claimsRecordMethod` refuses `R.SetRange(...)` on a table that declares `SetRange` as a split member, and on one where only ONE arm has that name (place 10); a receiver declared differently per arm is not claimed; a renamed member is not a name fallback (place 11).
  - `callers.test.ts`: a call inside an agreeing split member names it as the caller (place 9).
  - `return-value.test.ts`: `exit(<expr>)` in a split member whose arms agree on `Integer` is mutated as in its twin; nothing when the arms disagree (place 4).
- [ ] **Step 2: Run them, expect red.** `bun test packages/engine packages/builtin-tier2/tests/receiver.test.ts`: each new test fails at HEAD for the reason named, and nothing else fails.
- [ ] **Step 3: Implement.** The prototype's engine hunks are the reference (`$S/proto-r2.patch`, the `packages/engine` files): `findEnclosingProcedure` walks `isProcedureLike`; `memberArms`, `procedureLikeReturnType`, `inMemberBody` next to `isProcedureLike`, each with an R302 doc comment; `findEnclosingStatement`'s block case also admits a procedure-like parent; `parseSplitProcedure` with Decision 2's rule; `ProcedureSymbol.ambiguous` (lowercase names; absent on a plain procedure); `types.ts` deletes its private walk and imports the engine's; `lookupVar` and `resolveIdentifierType` return `null` for an ambiguous name before the global fall-through; `declaresProcedure` reads every `name`-field child; `nameOf` and `callers.ts` use `procedureLikeNameNode`. Update the doc comment on `isProcedureLike` (it no longer says the semantic walks skip it).
- [ ] **Step 4: Green.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/engine packages/builtin-tier1/tests/return-value.test.ts packages/builtin-tier2`.
- [ ] **Step 5: Red-check each place.** Revert one hunk at a time, run only its test, confirm red, restore, confirm green. Record the nine outputs (places 1 to 4, 9 to 12, and the hiding) in `$S/logs/t1-redcheck.txt`. The hiding (place 2 and 3) is reverted by deleting the `ambiguous` check alone, so the red test is the one with the global.
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
  - `c3`-shaped: the overload's `empty-block` and `return-value` keys carry ordinal 1, the preamble's none; `c1`-shaped: the renamed member's new mutants have `procedureName` `""`.
- [ ] **Step 2: Red-check** the `d1`, `d6` and `a1` tests against the Task 1 and 2 hunks they pin (hiding, any-arm guard, `inMemberBody`).
- [ ] **Step 3: Commit.** `test(R302): runner-level pins for split-member sites, the per-arm rule, the hang tag and the ordinals`.

### Task 4: Offline proof: the checker, alc on every subset, the manifest STOP rule, and al-runner (serial)

**Files:** scratch only. On the r302 worktree with Tasks 1 to 3 committed.

- [ ] **Step 1: Every capture against the pre-commitment.**

```bash
set -euo pipefail
source C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r302/setup.sh
"$S/capture.sh" after "$S/sites.ts"
EXPECT="$S/expect-final" "$S/check-all.sh" after | tee "$S/logs/check-after.txt"
for n in $(ls "$S/cap/before" | grep '\.err$'); do cmp "$S/cap/before/$n" "$S/cap/after/$n"; done
echo "sites match the pre-commitment (with the listed corrections)"
```

Run it as `EXPECT=$S/expect-final "$S/check-all.sh" after`: the pre-commitment plus the one correction under "Prototype check" (`d4` L15), kept as a separate file set so the committed rows stay as they were. Expected: `checks: 23 pass, 0 fail`, and every `.err` identical, which says no site was dropped as non-executable.

- [ ] **Step 2: alc, every repro, every subset:** `"$S/alc-proto.sh" "$S"` (the same script with the r302 tools instead of `$S/pt`). 18 repros, `t5-lit-split` as its local-table copy: 37 subsets. Expected: `alc: 37 of 37 subsets PASS`. Any FAIL is a STOP.
- [ ] **Step 3: The manifest STOP rule (Decision 5).** `bun "$S/pt/grain-vs-twin.ts" U:/Git/LethAL-wt/r302/packages "$S/repro/<name>" "$S/twin/<name>-a1"` for the 15 repros with split-member mutants (all but `d5`, `d6`, `d7`, whose split members have empty bodies). Expected: every line `same`, each run ending `PASS`, 128 mutants in all. Any `DIFF` is a STOP.
- [ ] **Step 4: al-runner, local, serial.** `"$S/run-ar.sh" after "$S" q1-twin-body q2-split-twin k1-dc-shape k2-baseapp-shape a1-attribute-in-arm d1-arg-type-differs` (each with its `$S/repro-tests-<name>` app, coverage on then off, every subset, one session at a time). Expected, as on the prototype ("Prototype check"): every session ends `<name> PASS`, and in `q1` and `q2` each `Pick` mutant has the same verdict as the `Twin` mutant of the same operator on the same relative line. Any failure is a STOP.

### Task 5: Prove nothing else moved

- [ ] **Step 1: Fixtures, System Application, BusinessFoundation.** The AFTER hashes, identity keys and emitted targets (Task 0 Step 3's loop into `*-after-*`) are byte-identical to BEFORE (`diff -r --exclude=app.json`, `maxRSS_KB` dropped).
- [ ] **Step 2: DC/Cloud and BaseApp** already pass the checker in Task 4 Step 1 (19 `+`, 7 `-` on DC; 31 `+` on BaseApp; every other key unchanged).
- [ ] **Step 3: Whole suite.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` from the root. Expected: green. `bun run compile:fixtures` is not needed (no fixture AL changes) and is not run.

### Task 6: Roadmap

- [ ] Mark `docs/roadmap/R302.md` `done (<first>..<last>)`, with a closing section: the 12 places, the per-arm rule (and its strict reading), the pre-committed counts and the measured result for each repro, DC/Cloud (+12 deployed) and BaseApp scratch (+31), the prototype's corrections, and that the hang tag is back. Add one line to `R301.md` and `R316.md` pointing at the closing. Re-check the next free id across every worktree before filing anything new (R-316's Task 0 Step 5 loop). Then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, and commit: `roadmap(R302): done`.

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
