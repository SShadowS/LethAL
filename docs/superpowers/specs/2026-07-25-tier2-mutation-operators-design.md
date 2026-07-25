# Layer 6 — Tier-2 AL-specific mutation operators (Design)

Status: approved for planning, 2026-07-25.
Supersedes nothing. Builds on `design.md` §4 (operator tiers, operator interface, conformance gate).

## 1. Goal

Ship the Tier-2 operator set: mutations that exploit AL/Business Central semantics to expose tests that
look thorough but assert nothing meaningful. Tier 1 catches sloppy boolean logic, which any language has.
Tier 2 targets the specific way BC test suites go wrong — a test that inserts a record, calls the right
procedure, and never checks that validation actually fired.

## 2. What changed after adversarial review (and why)

This design was reviewed twice by three independent models (Anthropic Fable 5, Google Gemini 3.1 Pro, OpenAI
GPT-5.5), each reading the codebase in isolation, and every accepted finding was then **verified directly
against the source** by the author. Round 1 reshaped the design; round 2 reviewed the committed spec and
forced three further changes (§3.2 dedup ordering, §3.2 precedence, §4 predicates). The five changes below
came out of round 1:

| First draft | This design | Verified evidence |
|---|---|---|
| 8 operators, all built | 6 built, `EmptyTrigger` dropped, `SwapRecXRec` gated on an experiment | `ALNodeKind.trigger` is in `BODY_PARENT_KINDS` (`packages/builtin-tier1/src/empty-block.ts:12`), so Tier-1 `empty-block` empties trigger bodies wherever they are instrumented. It does not double-count *today* only because §3.1's defect means table files never get usable guards — the moment that is fixed, `EmptyTrigger` would duplicate every trigger site. |
| Five deletion operators as new, parallel operators | Deletion operators are **narrowings** of `void-method-call`, with a dedup rule | `procedure_call` maps to `call_expression`, and the grammar has no distinct method-call node (`packages/engine/src/ast/node-kinds.ts:60-66`). `Rec.CalcFields(x);` in statement position is therefore matched by `void-method-call` (`void-method-call.ts:19-22`) **today**. Parallel operators would emit byte-identical duplicate mutants under different names. |
| "Spike: does wrap-lift-duplicate emit valid AL in a table?" | **Phase 0 deliverable**, not a spike | `injectMutationSelectorVar` returns early when the file has no codeunit (`packages/schemata/src/compile.ts:67-68`) while `project.ts` accepts `table` object headers. Guards would emit `MutationSelector.Active(...)` into a table with no variable in scope. This is a known defect with a known fix. |
| Tier-1 operators and baselines out of scope | Tier-1 **dedup interaction** in scope; Tier-1 baselines still untouched | Follows from the duplicate-mutant finding above. |
| `RemoveCommit` tagged likely-equivalent and excluded from the score | `RemoveCommit` is a **fully scored** mutant | `WriteA; Commit(); Error(...)` rolls back `WriteA` when the `Commit` is removed — genuinely observable, and a real transaction-boundary test gap would otherwise be hidden in an excluded bucket. |

Two further verified findings shaped Phase 0's scope:

- `procedureNameOf` returns `""` for any node not inside a procedure (`packages/schemata/src/project.ts:84-89`),
  and the mutant manifest carries `codeunitId`/`codeunitName`/`procedureName`. With the bcdev backend's
  procedure-level coverage, trigger mutants risk being classed `no-coverage` **silently** — no compile error,
  no failing test, just a gutted value proposition.
- The semantic layer is source-derived only, with no access to BC's post-compile symbol graph
  (`design.md` §4). It cannot prove that a `CalcFields` argument is a FlowField, that a receiver is a base-app
  `Record`, or that a given table has a non-trivial `OnModify`. Every operator predicate below is written to
  be correct **without** that knowledge, and each operator's limits are documented rather than wished away.

## 3. Phase 0 — make the compiler table-safe

No operators are written in this phase. Three deliverables:

### 3.1 Selector injection into table objects

Extend `injectMutationSelectorVar` to handle `table` objects. **The member ordering this depends on is no
longer an unknown — it was measured against real `alc` on 2026-07-25, before implementation:**

| emitted shape | `alc` result |
|---|---|
| `var` before `fields` | **AL0107 / AL0104 / AL0198 — hard syntax error**, the parse does not recover |
| `var` after `fields`/`keys`/`fieldgroups`, before `trigger` | compiles clean |
| `var` as the LAST member, table has only a field-level `OnValidate` | compiles clean |

So the codeunit strategy — "insert before the first member" — is **invalid for tables** and would break every
instrumented table object. The rule is:

- Read members with `declarationMembers(tableNode)`. v3 wraps a table's members in `declaration_body` exactly
  as it does a codeunit's; measured order inside it is `property`, `fields_section`, `keys_section`,
  `fieldgroups_section`, `var_section`, `trigger_declaration`… That helper already exists, is exported, and is
  used by `symbol-table.ts` and the codeunit path — do not hand-roll a sixth shape check.
- If an object-level `var_section` exists, append the selector to it (identical to the codeunit path).
- Otherwise insert a fresh `var` section **after the last section-like member** — equivalently, immediately
  before the first object-level `trigger_declaration`, and at the end of the members when the table has none.
- The "no object-level trigger" case is not hypothetical: a field-level `OnValidate` lives inside
  `fields_section`, not as an object-level member, so a table can carry mutable trigger bodies with no
  object-level trigger to anchor against. The third row above confirms a trailing `var` is legal and that a
  field trigger may reference a variable declared after it.

`CODEUNIT_HEADER_KINDS` in `compile.ts` needs a table analogue (`table_keyword`, `integer`,
`quoted_identifier`) for the member scan.

Still verify the finished emission with a real `alc` compile — these three shapes are the ones reasoned about,
not a proof that every table in the wild is covered.

### 3.2 Mutant identity and dedup

A single rule: a mutant's identity is `(file, startIndex, endIndex, after-form)`. When two operators produce
the same identity, the **more specific operator wins** — Tier 2 over Tier 1 — and the losing mutant is not
emitted.

**Where it runs is part of the requirement, not an implementation detail.** Dedup MUST happen before mutant
IDs are assigned and before compilation. Today `writeInstrumentedProject` passes raw `f.specs` to
`assignMutantIds` and then to `compileSchemataForFile(f.source, f.root, f.specs, ided)`
(`packages/schemata/src/project.ts:95-100`). Dropping a mutant only from the manifest would leave it compiled
into the emitted dispatch chain holding an assigned ID — an unreported mutation that still exists in the
artifact, which is worse than no dedup. Required order inside `writeInstrumentedProject`: dedup specs per
file → assign IDs to the deduped set → compile from the deduped set → emit the manifest from the same set.

**Precedence must never demote a scored mutant into an excluded bucket.** Tier 2 wins over Tier 1 ONLY when
the winning mutant is not tagged `likely-equivalent`. Otherwise an overbroad Tier-2 predicate — say
`RemoveSetLoadFields` wrongly claiming a user-defined `Loader.SetLoadFields(x)` — would suppress the fully
scored Tier-1 deletion and replace it with a mutant excluded from the score, hiding both the real mutant and
the predicate bug. A `likely-equivalent` Tier-2 mutant colliding with a scored Tier-1 mutant loses.

**Span discipline.** Tier-2 deletion operators MUST target the identical `call_expression` node that
`void-method-call` targets — not the enclosing statement, not the `member_expression`. A differently-bounded
span produces a different identity, dedup silently never fires, and two near-identical mutants ship under two
names. The §7.4 regression test would pass in exactly that failure mode, so the discipline is stated here as
a requirement rather than left to the test to catch.

**Precedence ordering is defined only over builtin tiers.** `MutationOperator.tier` also admits `"custom"`
(`packages/engine/src/operator/interface.ts`), which has no position in a specificity ordering. A collision
involving a custom operator fails loudly, exactly like a same-tier collision — a third-party operator must
not silently suppress a builtin mutant, nor be silently suppressed by one.

**This is a byte-duplicate rule, not a semantic-duplicate rule, and that is accepted.** Tier-1 `empty-block`
emptying a one-statement trigger body and Tier-2 `RemoveTestField` deleting that same statement produce
different spans and different after-forms, so both are kept even though the resulting behaviour is identical.
The same overlap already exists within Tier 1 (a procedure body containing a single void call). Detecting
semantic duplicates needs equivalence analysis this project does not have; the cost is a small number of
redundant mutants, which is preferable to a rule that guesses.

Two operators **of the same tier** producing one identity is a caller-contract violation, not something to
resolve by precedence: it means two operators claim the same mutation and the result would depend on
registration order. Fail loudly with both operator names, per this project's "never a plausible default"
convention. No such collision exists in the set below (each deletion operator matches a distinct method
name), so the check should never fire — which is exactly why it must be loud if it does.

Rationale for manifest-level dedup over narrowing `void-method-call` directly: one rule in one place, one
test, and no coordination burden on any future operator. Narrowing the generic operator would require every
new specific operator to also edit the generic one, which is exactly the kind of coupling that rots.

Existing baselines are unaffected: `fixtures/sandbox-app` contains no record calls for a Tier-2 operator to
claim, so no existing mutant changes operator or verdict. This must be asserted, not assumed — see §6.

### 3.3 Trigger attribution in the manifest

Record the enclosing trigger's identity for mutants inside trigger bodies, and establish how the bcdev
backend maps a trigger site to covering tests. If trigger mutants cannot be attributed to a covering test,
Tier 2's trigger-based value is unreachable and we need to know that in Phase 0, not Phase 2.

### 3.4 Phase 0 exit criteria

A single successful trigger mutant is not sufficient — it exercises §3.1 and §3.3 while proving nothing about
§3.2, and it can pass on a trivially-shaped table. All of the following must hold:

1. A table carrying `fields`, `keys`, an **existing** `var` section and **multiple** triggers instruments and
   compiles under real `alc`. The existing-`var` case matters: injection must extend a present section, not
   assume it is absent.
2. Both a **table-level** trigger (`OnInsert`) and a **field-level** trigger (`OnValidate` on a field
   declaration) are proven — they are structurally different insertion contexts, and one can work while the
   other is broken.
3. A trigger mutant carries explicit trigger attribution in the manifest — not an empty `procedureName`.
4. A dedup fixture proves a Tier-2 mutant replaces the colliding Tier-1 mutant **before ID assignment**: the
   suppressed mutant must be absent from the emitted artifact, not merely from the manifest.
5. Live, on trigger sites: **both a kill and a survive**. A kill alone can come from a runtime error unrelated
   to any assertion, which would satisfy a weaker criterion while proving nothing about attribution.
6. The existing Tier-1 per-mutant baselines (bcdev 3/10/3, al-runner 3/13/0) are re-run and unchanged.
7. al-runner's behaviour on table triggers is established — executed, or documented as unsupported. §8 lists
   this as unproven; Phase 0 is where it stops being unproven, not Phase 2.

## 4. Phase 1 — the four operators that survive scrutiny

The three **deletion** operators are statement-position only and claim their site from `void-method-call`
via §3.2. Deletion requires statement position: removing a call that is an `if`'s then-branch would leave
`if Cond then ;` and change control flow rather than delete a statement.

`SwapModifyFlag` is **not** statement-position restricted, and must not be. It rewrites an argument
(`Modify(true)` → `Modify(false)`) rather than deleting, so it is safe in any position. Restricting it to
statement position would miss `if Rec.FindSet() then Rec.Modify(true);` — a routine BC idiom where the call
is the then-branch, not a direct child of a `code_block`. **Measured, not assumed:** the grammar probe
(`scripts/probe-grammar-table.ts`) found exactly this — every other targeted call reached statement position
while `Modify` did not, precisely because the fixture writes it as a then-branch.

For the same reason `SwapModifyFlag` does not claim its site from `void-method-call`: its after-form differs
from the deletion's empty one, dedup correctly does not fire, and both mutants coexist at that site. That is
not duplication — they are two distinct mutations, exactly as `conditional-boundary` and `negate-conditional`
already coexist on one expression.

### 4.1 Receiver resolution — the rule every predicate below depends on

The semantic layer is source-derived and cannot prove a receiver is a base-app `Record` (§2). Name-only
matching is therefore unsafe in both directions, and every predicate must satisfy this rule:

- **Match the implicit-receiver form.** Inside a table or field trigger body, `TestField("No.")`,
  `SetRange(F, V)`, `CalcFields(X)` and `Modify(true)` are legal with no receiver — `Rec` is implicit. These
  are precisely the trigger-body sites Tier 2 exists to mutate, so a predicate requiring `<rec>.` would miss
  its own reason for existing.
- **Reject a receiver that resolves to a non-record in source.** Where the symbol table can see the
  declaration (`Loader: Codeunit "My Loader"`), a call on it is not the AL record method and must not be
  claimed.
- **Reject a name that resolves to a procedure declared in the project.** A local `procedure Commit()` or a
  user-defined `TestField` shadows the builtin for matching purposes.
- **Where the receiver cannot be resolved at all, do not claim the site.** The Tier-1 `void-method-call`
  mutant still covers it. Missing a Tier-2 site costs one operator's signal; claiming a wrong one emits a
  mislabelled mutation and, under §3.2 precedence, can suppress a correct Tier-1 mutant.
- **Matching is case-insensitive.** AL is case-insensitive, so `Modify(TRUE)`, `MODIFY(True)` and
  `Rec.SETRANGE(...)` are the same sites. A text-sensitive lowercase-only predicate silently misses real code.
- **Note the parenthesis-less call form.** AL permits `Commit;` without parentheses, which may not parse as a
  `call_expression` at all. Phase 2 must establish how the grammar represents it and either handle or
  explicitly document it as unsupported. (Tier-1 `void-method-call` has the same gap today.)

| Operator | Predicate | Documented limits |
|---|---|---|
| `RemoveTestField` | Delete `<rec>.TestField(...)`; both the one-argument and two-argument forms | Only observable on a failing path. Without an `asserterror` negative test it survives trivially — which is the intended signal, but the fixture must contain one or the baseline teaches nothing. |
| `RemoveSetRange` | Delete `<rec>.SetRange(F, ...)`. **Skip the no-value form**: `SetRange(F)` *clears* a filter, so deleting it *preserves* one — the inverse of the intended effect. | Highly data-dependent. With only in-range rows present, the mutant is equivalent with respect to that data. The fixture must seed out-of-filter decoy rows. |
| `RemoveCalcFields` | Delete `<rec>.CalcFields(...)` where the Boolean return is unused | No signal when the FlowField is never read afterwards, when `SetAutoCalcFields` or a second `CalcFields` makes it redundant, or when the call retrieves a BLOB (where "FlowField stays 0" is the wrong model). |
| `SwapModifyFlag` | Rewrite `Modify(true)` → `Modify(false)`, **literal `true` only** — never `Modify(SomeBoolean)` | Only observable when the table's `OnModify` does something the test asserts. The semantic layer cannot see base-app triggers, so equivalent mutants on base-app records cannot be hinted away. |

## 5. Phase 2 — conditional

- **`RemoveCommit`** — delete `Commit()`. A fully scored mutant, not likely-equivalent. The report must
  distinguish a genuine kill from the platform artifact where removing a `Commit` before a subsequent
  `Codeunit.Run(...)` produces "cannot run codeunit in a write transaction" — an error-kill that says
  nothing about assertion quality.
- **`RemoveSetLoadFields`** — delete `SetLoadFields(...)`, tagged `equivalenceHint: "likely-equivalent"`,
  reported in a bucket separate from `survived` and excluded from the headline mutation score. **Skips the
  no-argument form**, which resets loading to default (deleting it preserves a prior partial-load state).
- **`SwapRecXRec`** — **built only if an experiment justifies it.** When `Modify(true)` is driven from AL
  code rather than a page, `xRec` may carry the same values as `Rec`; LethAL drives every test headlessly.
  If `xRec` does not differ in that path, the operator is near-worthless in this execution model.

  The experiment runs at the start of Phase 2, before any operator code: a table whose `OnModify` writes both
  `Rec.<field>` and `xRec.<field>` to an observable location, exercised by a headless test that reads a row,
  changes that field, and calls `Modify(true)`. **Go criterion:** the two recorded values differ. If they are
  equal, the operator is not built, and this spec's §5 entry is replaced by a recorded finding explaining why
  — a documented "we measured it and it does not work here" is a better outcome than an operator that emits
  survivors meaning nothing.

## 6. Fixture

New `fixtures/sandbox-data`, deliberately built so that a **broken operator fails** rather than merely
exercising the happy path. Existing `fixtures/sandbox-app` is untouched, so the frozen Tier-1 baselines
(bcdev 3 killed / 10 survived / 3 no-coverage; al-runner 3/13/0) keep protecting Tier 1 throughout.

Required shapes:

- Out-of-filter **decoy rows**, or `RemoveSetRange` survives on data starvation.
- Seeded **related-table rows**, or the FlowField computes to 0 either way and `RemoveCalcFields` is equivalent.
- **`asserterror` negative tests**, or `RemoveTestField` survives trivially and the baseline's "real kills"
  claim is false.
- A **`Validate()`-driven path**, so `OnValidate` actually fires from test code.
- **Negative targets** that a sloppy predicate would wrongly claim: a user-defined procedure named `Commit`
  *plus a call to it*, an `Insert(false)`, a `SetRange` with no value, a `SetLoadFields()` with no arguments,
  a `Modify(SomeBoolean)`.
- **User-defined methods sharing a builtin name, taking arguments, with observable side effects** —
  `Loader.SetLoadFields(FieldNo)`, `Validator.TestField(X)`, `Builder.SetRange('A', 'Z')`. The no-argument
  negatives above do not catch a predicate that matches any same-named call with arguments, and under §3.2
  precedence such a bug also suppresses a correct Tier-1 mutant.
- **Implicit-receiver positive targets** inside trigger bodies — an unqualified `TestField(...)` and
  `Modify(true)` — or a predicate that only handles `<rec>.` forms passes the whole fixture while missing the
  sites Tier 2 exists for.
- **Case variants**: `Modify(TRUE)`, `Rec.SETRANGE(...)`.
- **Both `TestField` overloads**: a one-argument-only implementation must fail.
- A **weak positive test** that calls `TestField` without asserting, so a genuine survivor is represented
  alongside the `asserterror` negatives.
- Both **strong and weak tests**, so the expected baseline contains real kills *and* real survivors.

## 7. Verification

1. Unit tests plus each operator's `conformanceTests` golden cases (the SDK's load-time gate).
2. Offline `alc` compile of the instrumented fixture — the only thing that settles AL member ordering and
   emitted-AL validity.
3. A new env-gated live integration suite with its own committed per-mutant baseline.
4. **A dedup regression test** asserting no two operators ever emit the same `(site, after-form)`.
5. **A Tier-1 no-drift assertion**: the existing bcdev and al-runner baselines must be re-run and match
   per-mutant after Phase 0's manifest change.

Per-mutant equality is the gate throughout. Aggregate counts matching for the wrong mutants is a failure.

## 8. Risks

- ~~**The grammar's table-object coverage is unmapped.**~~ **RESOLVED — measured 2026-07-25** by
  `scripts/probe-grammar-table.ts` against the vendored wasm. A table carrying fields, a FlowField, keys,
  fieldgroups, an existing `var` section, table-level triggers and a field-level `OnValidate` parses with
  **zero** ERROR/MISSING nodes, and every member Phase 0 must locate is addressable:
  `table_declaration`, `field_declaration`, `keys_section`, `fieldgroups_section`, `var_section`,
  `trigger_declaration`. Trigger bodies are reachable as `code_block` whose parent is `trigger_declaration`
  (3 found), which also confirms Tier-1 `empty-block` will fire on them once §3.1 lands. `ALNodeKind` does
  not *declare* constants for the table members, but the grammar emits them and `node.kind` matches on the
  raw strings — Phase 0 should add the constants rather than hard-code strings.
- ~~**Vendored grammar is behind the grammar repo.**~~ **RESOLVED — the upgrade landed as its own layer
  (Layer 6A, `docs/superpowers/plans/2026-07-25-grammar-v3-upgrade.md`), exactly as this bullet asked.** LethAL
  now vendors a locally-built **v3.0.1** wasm. Two consequences bind Tier 2's predicates:
  - **Write predicates against the v3 shape.** v3 renames nothing but inserts container nodes:
    `statement_block` between a `code_block` and its statements, `var_body` inside `var_section`,
    `declaration_body` inside an object declaration. Use `isStatementPosition`, `blockStatements`,
    `varDeclarations` and `declarationMembers` from `packages/engine/src/ast/tree-walks.ts` — never a
    hand-rolled parent-kind check. Two probe scripts and **five** production call sites each hand-rolled one
    and silently matched nothing after the bump — the layer's own sweep found and fixed four of the five;
    the fifth (`packages/schemata/src/compile.ts`'s `injectMutationSelectorVar`, reading a codeunit's
    `var_section` straight off `namedChildren` instead of through `declarationMembers`) was missed by that
    sweep and caught only by the subsequent whole-branch review. Treat the sweep's own count as a lower
    bound, not a completeness guarantee.
  - **The measurements in §8 above still hold**, and improved: the same 2,876-file corpus parses 100% clean
    under v3 (99.9% under v2.5.0), with 710,950 statement-position calls (703,239 before) and every other site
    count identical. The table-member addressability finding is unchanged.
  The upgrade also confirmed this bullet's own warning was well-founded: the bump silently zeroed
  `void-method-call` until it was fixed, and moved the identity hash of all six `empty-block` mutants in both
  frozen live baselines — with every verdict and killing test held constant.
- ~~**AL member ordering in tables** (§3.1) is unverified against the real compiler.~~ **RESOLVED — measured
  against `alc` 18.0.38.8509 on 2026-07-25**, before implementation rather than during it. `var` before
  `fields` is a hard syntax error; `var` after the sections (before triggers, or trailing when there are none)
  compiles clean. The anchor rule is written into §3.1. No correction cycle should be needed for these shapes.
- **Equivalent-mutant dilution on real projects.** The fixture is engineered so Tier-2 mutants are killable.
  Real BC code is data-dependent in ways a fixture is not, so a production run will surface survivors that
  reflect data shape rather than test quality, and only `SetLoadFields` gets an excluded bucket. The headline
  mutation score will absorb the rest.
- **Trigger coverage attribution** (§3.3) may prove unworkable, which would strand the trigger-based value
  of Tier 2. Phase 0 exists to surface that early.
- **Hand-computed baselines**: `fixtures/README.md` records that the verdict table is hand-derived. Trigger
  and transaction semantics are materially harder to derive by hand than pure logic, so budget a live
  correction cycle for the new suite's first baseline.
- **al-runner backend**: whether it executes table triggers at all is unproven — the Tier-1 fixture is
  codeunit-only.

## 9. Out of scope

Tier-3 operators (`PermissionReduce`, `IsolationLevelSwap`, `EventPublisherSignature` — they mutate object
metadata and need a distinct emit path, `design.md` §4), SDK changes for third-party custom operators, and
any change to Tier-1 operator *behaviour* or baselines beyond the dedup interaction in §3.2.
