# Layer 6 — Tier-2 AL-specific mutation operators (Design)

Status: approved for planning, 2026-07-25.
Supersedes nothing. Builds on `design.md` §4 (operator tiers, operator interface, conformance gate).

## 1. Goal

Ship the Tier-2 operator set: mutations that exploit AL/Business Central semantics to expose tests that
look thorough but assert nothing meaningful. Tier 1 catches sloppy boolean logic, which any language has.
Tier 2 targets the specific way BC test suites go wrong — a test that inserts a record, calls the right
procedure, and never checks that validation actually fired.

## 2. What changed after adversarial review (and why)

The first draft of this design was reviewed by three independent models (Anthropic Fable 5, Google Gemini
3.1 Pro, OpenAI GPT-5.5), each reading the codebase in isolation. Three findings were then **verified
directly against the source** by the author before being accepted. They reshaped the design:

| First draft | This design | Verified evidence |
|---|---|---|
| 8 operators, all built | 6 built, `EmptyTrigger` dropped, `SwapRecXRec` gated on an experiment | `ALNodeKind.trigger` is in `BODY_PARENT_KINDS` (`packages/builtin-tier1/src/empty-block.ts:12`), so Tier-1 `empty-block` **already** empties trigger bodies. `EmptyTrigger` would double-count every trigger site. |
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

Extend `injectMutationSelectorVar` to handle `table` objects, respecting AL's member ordering (fields, then
keys, then the global `var` section, then triggers). Emitting the `var` section in the wrong position is a
structural compile failure, so this is verified by a real `alc` compile rather than by unit test alone.

### 3.2 Mutant identity and dedup

A single rule, applied where the manifest is built: a mutant's identity is
`(file, startIndex, endIndex, after-form)`. When two operators produce the same identity, the **more specific
operator wins** — Tier 2 over Tier 1 — and the losing mutant is not emitted.

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

### 3.4 Phase 0 exit criterion

One mutation inside a table trigger compiles, publishes, activates, and returns a real verdict (not
`no-coverage`) on a live container.

## 4. Phase 1 — the four operators that survive scrutiny

All four are statement-position only, and all four claim their site from `void-method-call` via §3.2.

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
- **Negative targets** that a sloppy predicate would wrongly claim: a user-defined procedure named `Commit`,
  an `Insert(false)`, a `SetRange` with no value, a `SetLoadFields()` with no arguments, a
  `Modify(SomeBoolean)`.
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

- **AL member ordering in tables** (§3.1) is unverified against the real compiler; assume at least one
  `alc` correction cycle.
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
