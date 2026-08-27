# LethAL · AL Mutation Testing Tool · Design

Working document. Captures decisions made so far. Open questions at the bottom.

## 1. Purpose

A mutation testing tool for AL / Business Central that measures whether a test suite actually verifies behavior, not just executes code. Produces actionable per-PR signal about which tests are weak and where.

## 2. Non-Goals

- Not a coverage tool. Assumes coverage exists as input.
- Not a general-purpose AL static analyzer. Mutations only.
- Not a replacement for test-writing guidance. Output drives developer action, not autonomous fixes.
- Not MVP-scoped. We are building for "best", not "easiest".

## 3. Foundational Decisions

### 3.1 Mutant Schemata over N-Compiles

Compile the project once with all mutations embedded behind a runtime dispatch. Activate one mutant per test run via a selector.

Dispatch mechanism: `MutationSelector` is a **SingleInstance codeunit** holding the active mutant id. The instrumented project calls `MutationSelector.Active('M042')` at each mutation site. Lookup is a single in-memory comparison — zero I/O, near-zero overhead when no mutant is active (one boolean check against a `AnyActive` flag, early exit). State is set by the test harness at runner invocation; reset is automatic because every test runs in a fresh runner invocation (see §6).

Unified representation across mutation site kinds (boolean conditions, value expressions, statements, blocks) is handled by the **wrap-lift-duplicate** compiler described in §3.5.

Rationale: BC compile is the dominant cost. One compile + N fast test runs beats N compiles by 10x to 100x. This is the architectural keystone; retrofitting it later means a rewrite.

### 3.2 AST-Based, Not Text-Based

All mutations are produced as AST transformations via `tree-sitter-al`, rendered back to source via a formatting-preserving printer. No string splicing.

Rationale: multi-line expressions, comments inside ranges, and operator tokens that appear as substrings all break text-based approaches.

### 3.3 Semantic Analysis Layer

Before generating mutants, build a symbol table and control flow graph from the AST. Used to:

- Detect equivalent mutants pre-execution
- Skip unreachable mutation sites
- Identify stillborn mutants (type errors, compile failures) statically

This layer is reusable infrastructure; the profiler and future AL tooling benefit from it.

### 3.4 Coverage-Informed Test Selection

Tests that don't execute a mutated line cannot kill its mutant. Run coverage once, then per mutant run only the test subset covering that line. 10x to 100x speedup on large suites, with zero correctness loss.

### 3.5 Unified Mutation Representation · wrap-lift-duplicate

Every operator emits a uniform `MutationSpec { before, after, parentContext }`. The schemata compiler then picks one of three AL-grammar-aware wrapping forms based on where the mutation sits in the AST. Procedure extraction is **never** used — it breaks AL scoping for `Rec`/`xRec`, trigger implicit params, and control-flow primitives (`exit`, `break`).

**1. Wrap (statement-position mutation)** · default case, covers most mutations.

```al
// original
Rec.CalcFields(Amount);

// wrapped (deletion form)
if not MutationSelector.Active('M042') then
  Rec.CalcFields(Amount);

// wrapped (substitution form)
if MutationSelector.Active('M043') then
  Rec.Modify(false)
else
  Rec.Modify(true);
```

Both branches share the same lexical scope. Locals, `Rec`, `xRec`, `exit` targets preserved exactly.

**2. Lift (value expression nested in a larger expression)** · AL has no expression-level ternary, so sub-expressions can't be inline-swapped.

```al
// original
X := f(Amount * 2) + g(Y);

// lifted — _m044 declared in the enclosing procedure's `var` block
if MutationSelector.Active('M044') then
  _m044 := 0
else
  _m044 := Amount * 2;
X := f(_m044) + g(Y);
```

The conditional-assign statement is placed in the narrowest enclosing statement block (inside any enclosing loop body, not at procedure top) so re-evaluations match the original. The lifted local is declared in the enclosing procedure's `var` block — AL has no inline var declarations. Side-effect order preserved: conditional assign runs before the surrounding expression.

**3. Duplicate (short-circuit-sensitive operand mutation)** · when the mutation changes an operator whose evaluation semantics include short-circuit behavior (e.g., `and` ↔ `or`), lifting loses the short-circuit signal the mutation is meant to test.

```al
// original
if A and B then DoThing();

// duplicated
if MutationSelector.Active('M045') then begin
  if A or B then DoThing();
end else begin
  if A and B then DoThing();
end;
```

Bloats the statement; only one branch executes at runtime so no duplicate side effects. Acceptable cost for exactness.

**Selection rule in the compiler**

1. Mutation sits in a position where `if` statements are grammatically valid AL → **wrap**.
2. Mutation is a value expression nested inside another expression → **lift**.
3. Mutation is on a short-circuit-sensitive operator in an enclosing statement whose side effects depend on the operator → **duplicate**.
4. Never extract to a procedure.

## 4. Mutation Operators

### Tier 1 · Generic, evidence-based

Conservative set with documented effectiveness in the mutation testing literature.

**The two tables below are GENERATED from the registry** (`packages/builtin-tier1/src/index.ts` and
`packages/builtin-tier2/src/index.ts`) by `bun scripts/operator-tables.ts`; never hand-edit them, and
`scripts/operator-tables.test.ts` fails when they disagree with the code. They were hand-written
until 2026-08-19 and had drifted: they listed `RemoveSetLoadFields` and `EmptyTrigger`, neither of
which is built, and omitted four operators that ship. Every example is lifted from the operator's
own conformance suite, which runs at registration, so an example that stops being true fails a gate
rather than misleading a reader.

<!-- operators: tier1 -->
| Operator | Version | Example | What weak test it catches |
|---|---|---|---|
| `lethal.conditional-boundary` | 1.0.0 | `A > 0` → `A >= 0` | an off-by-one at a boundary no test pins |
| `lethal.flip-boolean-literal` | 1.0.0 | `true` → `false` | a flag nobody checks the other setting of |
| `lethal.negate-conditional` | 1.0.0 | `Cust.Next() = 0` → `Cust.Next() <> 0` | a branch that is taken but never checked |
| `lethal.negate-guard` | 1.0.0 | `Cust.Get('X')` → `not (Cust.Get('X'))` | a plain `if Rec.Get(...) then` guard nobody tests the other side of |
| `lethal.toggle-blank-string` | 1.0.0 | `'FOO'` → `''` | a blank check nobody drives with a blank value |
| `lethal.void-method-call` | 1.1.0 | `DoThing()` → _(deleted)_ | a call whose effect nothing observes |
| `lethal.return-value` | 1.0.0 | `exit(42)` → `exit(0)` | a return value the caller never asserts |
| `lethal.empty-block` | 1.0.0 | `begin DoThing(); end` → `begin end` | a whole body nothing depends on |
| `lethal.swap-call-arguments` | 1.0.0 | `Foo(A, B)` → `Foo(B, A)` | two same-typed arguments passed in the wrong order |
| `lethal.remove-assignment` | 1.0.0 | `Total := 5` → _(deleted)_ | a value written that nothing downstream depends on |
| `lethal.remove-not` | 1.0.0 | `not Cust.IsEmpty()` → `Cust.IsEmpty()` | a negated guard whose two branches nobody tells apart |
| `lethal.swap-additive` | 1.0.0 | `A + B` → `A - B` | a sum or difference whose value no test checks |
| `lethal.shift-integer` | 1.0.0 | `5` → `6` | an off-by-one nothing notices, at a constant the test never varies |
| `lethal.loop-truncate` | 1.0.0 | `Cust.Next() = 0` → `true` | a loop no test drives over more than one row |
| `lethal.loop-skip` | 1.0.0 | `N < Limit` → `false` | a loop body nothing depends on, asked in a way that cannot hang |
<!-- /operators: tier1 -->

### Tier 2 · AL-specific, high value

Operators that exploit AL/BC semantics to surface weak tests.

<!-- operators: tier2 -->
| Operator | Version | Example | What weak test it catches |
|---|---|---|---|
| `lethal.remove-testfield` | 1.1.0 | `Rec.TestField("No.")` → _(deleted)_ | validation tests with weak assertions |
| `lethal.remove-setrange` | 1.1.0 | `Cust.SetRange("No.", 'A')` → _(deleted)_ | tests that never verify the filter |
| `lethal.remove-calcfields` | 1.1.0 | `Rec.CalcFields("No.")` → _(deleted)_ | no assertion on a computed FlowField |
| `lethal.swap-modify-flag` | 1.2.0 | `Cust.Modify(true)` → `Cust.Modify(false)` | trigger execution that no test checks |
| `lethal.remove-commit` | 1.1.0 | `Commit()` → _(deleted)_ | reliance on an implicit commit |
| `lethal.swap-rec-xrec` | 1.0.0 | `xRec.Amount` → `Rec.Amount` | before-value gaps in `OnValidate` and `OnRename` |
| `lethal.swap-find-direction` | 1.0.0 | `Cust.FindFirst()` → `Cust.FindLast()` | a suite whose fixture only ever holds one row |
| `lethal.validate-to-assign` | 1.1.0 | `Rec.Validate(Name, NewName)` → `Rec.Name := NewName` | the field value asserted, the `OnValidate` side effect not |
| `lethal.flip-filter-literal` | 1.0.0 | `Cust.SetFilter("No.", '<>%1', No)` → `Cust.SetFilter("No.", '=%1', No)` | a filter string BC re-parses at run time, never asserted |
| `lethal.swap-enum-member` | 1.0.0 | `"S"::Open` → `"S"::Released` | a state machine whose resulting state nothing asserts |
<!-- /operators: tier2 -->

Two operators named in earlier drafts of this table are **not built**, each for a recorded reason:
`RemoveSetLoadFields` is refused on cost after a live measurement proved it killable but
near-universally surviving on real code (see `packages/builtin-tier2/src/index.ts`), and
`EmptyTrigger` is subsumed by `empty-block`, which empties a trigger body like any other.

### Tier 3 · Advanced — **not built; the category was measured away (R13)**

| Operator | Example | outcome |
|---|---|---|
| PermissionReduce | `TableData X = RIMD` to reduced sets | **refused on cost** — the only genuinely declarative one; 423 grant sites (2.21%) against the 5% bar for a new activation mechanism. It IS killable (measured), but only in a session a test has lowered itself, which is 10 of 1,290 tests on the project censused. |
| IsolationLevelSwap | change `LockTable` behavior | **refused on footprint** — not metadata at all: `LockTable()` is a `call_expression` in statement position, and 25 of its 36 sites already carry a shipped `void-method-call` mutant, leaving 11 marginal sites against a bar of 13. |
| EventPublisherSignature | mutate event arg types/order | **refused as specified** — a signature is fixed at compile time and the only emittable form is a duplicate publisher no subscriber binds to. The observable version is an argument swap at the raise site: a different, non-event-specific operator, filed as ROADMAP R82. |

Full reasoning, census and live measurements:
`docs/superpowers/specs/2026-08-02-r13-tier3-decision.md` and `docs/measurements/README.md` §R13.

### Operator Interface

All operators — built-in and custom — implement this interface. Custom operators load as TypeScript modules into the LethAL host (operators run outside AL; only emitted AL is consumed by the AL compiler).

```typescript
interface MutationOperator {
  name: string;                          // "continia.cts-module-name"
  version: string;                       // semver; major version participates in history key
  tier: 1 | 2 | 3 | "custom";

  // declarative manifest, validated at registration
  targetNodeKinds: ALNodeKind[];         // AST kinds this operator inspects
  producesNodeKinds: ALNodeKind[];       // AST kinds present in the mutation's `after` form
  requiresSemantic: SemanticCapability[]; // "symbol-table" | "cfg" | "type-info"

  targets(node: ALSyntaxNode, ctx: SemanticContext): boolean;
  generate(node: ALSyntaxNode, ctx: SemanticContext): MutationSpec[];
  isEquivalent?(spec: MutationSpec, ctx: SemanticContext): boolean;

  conformanceTests: ConformanceCase[];   // mandatory golden-file suite
}

interface MutationSpec {
  operatorName: string;
  operatorVersion: string;
  astNodeId: AstNodeId;
  before: ALSyntaxNode;
  after: ALSyntaxNode;
  parentContext: "statement-position" | "expression-position" | "short-circuit-operand";
  equivalenceHint?: "likely-equivalent" | "unknown";
}
```

### Operator SDK

Custom operators depend on `@lethal/operator-sdk`, which exposes:

- `ALNodeKind` — enumerated AL AST kinds drawn from tree-sitter-al.
- `ALSyntaxNode` — read-only AST nodes.
- `SemanticContext` — source-derived symbols, CFG, types, caller lookup. No access to BC's post-compile symbol graph (the AL compiler is closed; semantic info is source-derived only).
- `build.*` — typed constructors for valid AL forms (`build.binaryOp`, `build.booleanLiteral`, `build.procedureCall`, etc.). Each validates AL-level well-formedness at call time. Operators cannot construct AL syntax AL doesn't have (e.g., there is no `build.ternary`).
- `ConformanceCase` — golden-file test harness and runner.

### Conformance gate at load time

On startup, LethAL for each configured operator:

1. Validates manifest against schema (kinds exist in `ALNodeKind`, semantic capabilities are known, version is semver).
2. Runs the operator's `conformanceTests` golden-file suite. A single failure blocks registration.
3. Fuzzes against a 10k-snippet real-AL corpus (shipped with the SDK). Operator must not crash; every returned spec must pass schema validation and compile through the wrap-lift-duplicate compiler.
4. Writes an `OperatorRegistration` row to the results DB so historical analysis can attribute behavior to specific operator versions.

Rejected operators emit actionable errors; the run proceeds with the remaining operators' mutants.

### Runtime safety

Each operator runs in a Bun Worker with budgets: 256 MB memory, 500 ms per AST file scanned. Blown budget skips that file's mutations from that operator and logs it. Chronic blown budgets (>5% of files) disable the operator for the run with a warning. A buggy custom operator cannot take the tool down.

### Tier 3 emit path (noted) — **the premise was measured false (R13, 2026-08-02)**

~~Tier 3 operators (`PermissionReduce`, `IsolationLevelSwap`, `EventPublisherSignature`) mutate AL object metadata rather than expressions/statements. They need a distinct emit path and a narrower interface.~~

Measured against the grammar, **only `PermissionReduce` is declarative**: it parses as a `property` under `declaration_body`, so `isMutableSite` refuses it and `generateMutationSet` drops it as a non-executable site. `IsolationLevelSwap` targets `call_expression`/`assignment_statement` in statement position — the emit path Tier 2 already uses — and `EventPublisherSignature`'s observable effect sits at the executable raise site. There is therefore **no distinct Tier-3 emit path to specify**, and none is built. See `docs/superpowers/specs/2026-08-02-r13-tier3-decision.md`.

### Distribution

Operators ship as npm packages. `lethal.config.ts` references them:

```typescript
export default {
  operators: [
    "@lethal/builtin-tier1",
    "@lethal/builtin-tier2",
    "@continia/lethal-operators",
    "./custom/our-team-operators.ts",
  ],
};
```

The SDK ships a `lethal-operator-check` CLI for authors to run conformance + fuzz locally and in their own CI before publishing.

## 5. Selection Pipeline

Applied in order, each stage narrows the mutant set before execution.

1. **Diff scoping** · mutate only lines in the PR diff
2. **Coverage filtering** · drop mutants on lines no test covers
3. **Flamegraph weighting** · prioritize mutants on hot paths via `.alcpuprofile` integration; cold-path mutants deferred to nightly full runs
4. **History filtering** · a mutant surviving on main and still surviving on PR is noise; newly surviving mutants are signal. Identity key: `(ast_subtree_hash(node), enclosing_codeunit_object_name, operator_name, operator_major_version)`. See §5.1 for rationale and refactor survival.

### 5.1 History identity key

The key is chosen to survive refactors that preserve the mutation site's semantics and invalidate when the site's code actually changes.

- `ast_subtree_hash(node)` — normalized hash of the mutation target subtree (whitespace stripped, local variable names canonicalized to positional ids, comments dropped). Invariant under formatting and local-rename edits. Changes when the expression's structure or operators change.
- `enclosing_codeunit_object_name` — AL's most stable scope unit. Procedures rename, split, and move within codeunits; codeunit object names are comparatively durable.
- `operator_name` + `operator_major_version` — major version bump means operator semantics changed; old history is intentionally reset for that operator's mutants.

`file` and `line` leave the identity key entirely — they become display metadata on each row but don't participate in equality.

**Refactor migration.** Before applying history on each run, LethAL inspects `git log --diff-filter=R` since the last recorded run's commit:

- **Codeunit rename** (`Foo.Codeunit.al` → `Bar.Codeunit.al`): unambiguous remap of all keys from `('…', 'Foo', op, v)` to `('…', 'Bar', op, v)`.
- **Codeunit split** or **procedure move across codeunits**: AST-subtree matching across the new file set. If a historical key's `ast_hash` appears in exactly one new codeunit, migrate there. If in multiple, fork the history row into each (duplicated expression → both new keys inherit the record). If in none, mark `archived`.
- **Ambiguous cases**: key reset with a reported `history reset due to ambiguous refactor in commit <sha>` annotation.

**Manual fallback.** `lethal history migrate --from <OldCodeunit> --to <NewCodeunit>` for cases git detection misses (e.g., delete-plus-create patterns).

**Report transparency.** Each PR mutant row is annotated when migration happened (`history carried from Foo.Codeunit.al → Bar.Codeunit.al since commit abc123`) or when reset happened.

## 6. Execution Model

Correctness guarantee enforced end-to-end: a mutant is reported as killed only if a test reliably passes at baseline and reliably fails under the mutant, attributable to the mutant's semantic effect independent of sibling-test leakage. The mechanisms below exist to uphold that guarantee; cost is accepted where necessary.

### 6.1 Container Pool

- Compile instrumented app once on PR trigger.
- Deploy to pool of warm BC containers (start at 4, scale by queue depth).
- Workers pull test-invocation units from the queue (see §6.3 for the unit).
- Results stream to results DB.

Reuses the PR review orchestrator pattern already in place.

### 6.2 Isolation · Codeunit enforced (Function-level is a later goal)

**As built (Layer 5C-A):** the server-side `RunMutant` primitive runs each method through the BC AL Test Suite framework under **Codeunit isolation** — the platform's `Test Runner - Isol. Codeunit` (codeunit 130450), confirmed live on Cronus281. This is the isolation the tool actually enforces today: DB state rolls back at the codeunit boundary between mutant runs, and each `RunMutant` call activates → runs exactly one method → clears the active mutant on every terminal path (§5), so the container is left unmutated after each call regardless of isolation granularity. The fixture's per-mutant frozen table (bcdev 3/10/3) was verified to reproduce identically through this Codeunit-isolation path — no silent verdict move versus the earlier hub isolation (§I1 disposition).

**Function-level (future):** Function-level rollback is the tightest DB isolation BC offers, and moving per-test isolation from Codeunit to Function is a later hardening goal — a test codeunit whose methods share intra-codeunit DB state could, under Codeunit isolation, let one method's writes reach the next. LethAL's `RunMutant` runs exactly one named method per call, which bounds this exposure, but does not make it Function-tight. When Function-level isolation is adopted, the tool will enforce it as a precondition and refuse projects that do not meet it, reporting the offending codeunits.

### 6.3 Per-Test Fresh Runner Invocation

Every test runs in its own BC test runner invocation. Never batched, never reused across tests. Rationale: BC has no session-state reset API, and `Clear(var)` only clears what LethAL can enumerate — third-party and base-app SingleInstance codeunits are opaque. A new runner invocation is the only sound way to guarantee a fresh session.

At each invocation:

1. Restore DB snapshot if this is the first test for a new mutant (see §6.5).
2. Start BC test runner with the single named test as its target.
3. At session start, set `MutationSelector` (SingleInstance, fresh) to the active mutant id (or inactive for baseline runs).
4. Run the test. Record pass/fail.
5. Tear down.

This eliminates SingleInstance leakage, in-memory caches, and cross-test session state as sources of non-determinism.

### 6.4 Pre-flight Flakiness Detection

Before mutant runs, LethAL runs the full baseline (all tests, `MutationSelector` inactive) per-test in fresh invocations, 3×. Any test with non-identical outcomes across the three runs is flagged `unstable`, reported to the user, and excluded from kill judgment for this run. Fixes categories of non-determinism orthogonal to DB state (time, random seeds, external calls) before they contaminate mutant results.

Threshold is strict: any variance across the three runs marks the test unstable. Even small flakiness compounds across thousands of mutant runs.

### 6.5 DB Snapshot Between Mutants

Applied once per mutant, not per test (per-test is handled by `TestIsolation=Function`). Covers non-transactional state BC rollback cannot reach: number sequences, external-system mock state stored in tables, any state written via out-of-transaction paths.

### 6.6 Kill Confirmation Re-Run

For each test that fails in the bulk mutant run, LethAL runs one more per-test fresh invocation at baseline (`MutationSelector` inactive). If the test passes at baseline, the kill is confirmed. If it fails at baseline too, the failure is late-surfacing flakiness (should have been caught in pre-flight; belt-and-suspenders) — rejected and reported.

Cost is paid only on failing tests.

### 6.7 Timeouts

Baseline test subset time × 2. Timeout counts as killed (mutation caused observable misbehavior, including potential nontermination).

### 6.8 Machine-Global Lease + Fence (Layer 5C-B1)

**As built:** `LethAL Control` owns a machine-global lease (table `LC Lease`, id 91006, single row)
so two concurrent LethAL sessions against one container cannot interleave a publish with a
`RunMutant` and record a false verdict — the gap §6.2's 5C-A preconditions documented but did not
enforce. The row carries a `Server Generation` (random, minted at pre-seed and by every
`ForceResetLease`; the basis for cross-recycle safety, not `Epoch`, which resets on rebuild), an
`Epoch`/`Token` pair bumped per acquire, an operation marker (`Op Kind: none|publish|run`,
`Op Attempt Id`, `Op Started At`), and an `Op Seq` counter with a `Last Completed Op Seq` tombstone
that the client supplies explicitly (`opSeq = lastCompleted + 1`), so a delayed duplicate
`Begin*`/`End*`/`RunMutant` for an already-tombstoned attempt can never reopen or reclear a later op.

The lease lock (`LockTable`) is held only in short critical sections, never across a run —
no-overlap is enforced by the operation marker, not by holding the lock for the run's duration.
`AcquireLease` refuses while another session's op is unresolved and its holder is presumed alive
(`operation-busy`; bounded backoff, no durable quarantine); only a marker whose holder is presumed
dead — expired past a grace window `>= 3×` the renew period, re-checked once before quarantining —
writes a durable `operation-orphaned` → `container-needs-recycle` record.

`RunMutant` is a two-phase fence. **Phase 1 — claim** (short `LockTable` critical section, one
transaction): validates `(leaseEpoch, leaseToken, serverGeneration)` against the row, requires
`Op Kind = none`, sets `Op Kind = run` plus the attempt's `Op Seq`, and commits — releasing the lock
before any test executes. **Phase 2 — run** executes with no lease lock held, behind a catchable
`Codeunit.Run` boundary, so a server-known terminal (a test-framework or AL exception) is captured
rather than unwinding past phase 3. **Phase 3 — verify-and-clear** (short `LockTable` critical
section, ONE transaction, a single final `Commit`): re-validates the tuple and `Op Kind = run` plus
the attempt id, then — in the same transaction — conditionally clears the active-mutant row
(`ClearActiveIf`, only if it still equals this attempt's tuple) and tombstones `Op Seq`. The
in-memory attestation reset (the §6.2 attestation fence) is unconditional on both phase-3 exits, so a
stale `ExpectedArtifactId` can never survive into the next call regardless of whether the table write
happened.

A tuple mismatch or a claim onto an already-active op both return `status: lease-invalid`, but the
server reports a distinguishing `reason`: a genuinely stale `(epoch, token, serverGeneration)` — the
client's OWN lease is no longer authoritative — reports `reason: "lease-invalid"` and maps, at the
transport, to `operation: "lease-lost"`, latching the session unsafe; a claim landing on the caller's
OWN still-active attempt reports `reason: "op-in-flight"`, which is NOT lease loss — the orchestrator
reads `reason` before the lease-lost latch and polls/waits for the original attempt instead of
retrying, since retrying would double-execute the mutant against a run still genuinely in progress.
On genuine lease loss, the runner invalidates only the CURRENT batch's verdicts at session end (after
the batch loop, before the report is built); earlier batches stand, because every `RunMutant` in them
was individually phase-1/phase-3 fence-validated regardless of what happened to the lease afterward.

Quarantine is two-tier. `container-needs-recycle` (durable, tier-keyed, `~/.lethal/quarantine`) is
written only for an orphaned op or a session ending with an unreconcilable marker, and is cleared by
an explicit recovery sequence: restart the NST/container → `ForceResetLease` (mints a new generation,
clears the marker/token/nonce, and clears the committed `LC Mutation Active` row in one transaction)
→ a post-recovery probe → `lethal clear-quarantine`. Note that "restart first" is **procedural
discipline the server cannot verify** (spec §14 deviation D1): `Server Generation` is persistent, so
a pre-restart read of it is byte-identical to a post-restart one and `ForceResetLease`'s generation
echo therefore buys replay protection only, never NST-incarnation binding.

`lease-lost` on an otherwise-clean container (an
epoch/generation mismatch, no stranded op) is session-local — latch, abort, invalidate the current
batch — with NO durable tier quarantine, since the container itself is fine.

**Precondition, documented rather than enforced:** the lease is per-container, but BC app
publication is service-instance-wide — a second tenant publishing to the same service instance falls
entirely outside the lease. AL has no tenant-enumeration API reachable from an extension (System
Application codeunit 417 exposes only the current tenant), so the client cannot detect this; 5C-B1 is
therefore a stated single-tenant-container support constraint, not a fenced one — see
`fixtures/README.md` for the operator-facing statement and out-of-band verification steps.

## 7. Equivalence Detection

Correctness framing: two error modes are not symmetric. A **false-positive equivalence** (tool says "equivalent" when a test could kill it) hides real signal; this is the failure mode to avoid. A **false-negative equivalence** (tool says "not equivalent" when it is) adds noise but the developer can manually mark and move on. Policy: **sound techniques filter, unsound techniques advise**.

**Filters (sound, suppress from reports)**

- **Syntactic AST canonicalization** — small, auditable ruleset (`x + 0 ≡ x`, dead branches, double-negation, etc.). Each rule preserves semantics or it's a bug in the canonicalization. Applied before mutant generation to deduplicate equivalent-by-construction mutations.

**Advisories (unsound, annotate but do not suppress)**

- **Dataflow "value may not be observable"** — if a mutated expression's value does not flow to any `Error`, `Message`, field write, or externally-used return within reachable CFG, annotate the mutant report with `⚠ value may not be observable — verify`. Never suppresses. Missed observations through event subscribers, reflection, or metadata make this unsound; advisory only.
- **Kill diversity ranking** — mutants killed by >90% of covering tests are low marginal information; downweight in PR report ranking but do not hide. Full detail remains in the dashboard.

**Developer feedback loop (project-specific truth)**

Developers can mark any surviving mutant as `manually confirmed equivalent`. The decision is stored in the results DB keyed by the same identity key as history (§5.1). Future runs suppress it project-wide. This is the only mechanism that closes the FP-equivalence gap, and it converges over time.

**Not used: binary diff**

The §3.1 schemata model compiles once; there is no per-mutant `.app` to diff. Adopting binary diff would require reintroducing per-mutant compiles, contradicting the architectural keystone. Dropped.

## 8. Reporting

### 8.1 PR Comment

Markdown table per file, sorted by flamegraph weight:

```
| Line | Operator | Mutation | Covering Tests | Status |
```

Linked to detail view.

### 8.2 Detail View

- Full AST context of mutation
- Tests that ran
- Tests covering the line but not killing the mutant (candidates for strengthening)
- Suggested assertions that would kill this mutant

### 8.3 Historical Dashboard

- Mutation score trend per file, per module
- Operators with lowest kill rate (systematic test weakness indicators)
- Tests killing the most mutants (high-value tests)
- Tests killing nothing (deletion candidates)

### 8.4 IDE Integration

VS Code extension:
- Gutter icons on mutation sites
- Surviving mutant = warning
- Click shows mutation + tests that should have caught it
- Shares results DB with CLI

Natural home inside the Puffin/ALive extension work.

## 9. Observability

Every run produces structured events shipped to Azure Log Analytics.

**Run-level dimensions** (one event per LethAL invocation):

- Schemata generation time (AST mutate + emit)
- Schemata compile time (single BC compile of instrumented project)
- Pre-flight time and unstable-test count
- Total mutants generated per operator per file

**Mutant-level dimensions** (one event per mutant evaluated):

- Test-invocation count for this mutant (bulk + confirmation)
- Total test time for this mutant
- Kill outcome + which test killed it (if any)
- Equivalence annotations emitted (canonicalization, dataflow advisory, manual-mark)
- Identity key (§5.1) and history-migration annotation, if any

**Derived metrics** (from the event stream):

- Kill rate per operator, per operator version, per codeunit
- Operators with chronically low kill rate (systematic test weakness)
- Historical kill trend per identity key
- LethAL's own self-regression (e.g., mutant counts per file shifting without project changes)

Used to tune operators over time and detect regressions in the tool itself.

## 10. Stack

| Layer | Choice |
|---|---|
| Runtime | Bun + TypeScript |
| Parsing | tree-sitter-al |
| Semantic layer | custom (symbol table + CFG) |
| Queue / orchestration | existing PR review orchestrator infrastructure |
| Results DB | SQLite per project |
| Reporter | Markdown (ADO), JSON (machine), HTML (dashboard) |
| IDE | VS Code extension sharing results DB |

## 11. Build Order

Layered, each layer production-quality:

1. AST mutation engine + semantic layer (standalone package, reusable)
2. Mutation schemata compiler (transforms project to instrumented single-compile form)
3. Tier 1 operators with equivalence detection
4. Sequential execution + coverage-informed selection (proves end-to-end loop)
5. Container pool + orchestration (reuse PR review infra)
6. Tier 2 AL-specific operators
7. Reporter + PR integration
8. Historical DB + trend analysis
9. VS Code extension

## 12. Decisions

- **Tool name** · **LethAL**. No conflicting AL/BC mutation tool. Lethal Audio (music VST) and the Münster LETHAL tree-automata library exist in unrelated domains; AL/BC-qualified positioning disambiguates. README acknowledges the Münster tool to preempt confusion.
- **License** · **MIT**.
- **Schemata dispatch mechanism** · `MutationSelector` SingleInstance codeunit. In-memory state, set per runner invocation. Zero-overhead when inactive (single boolean check against `AnyActive` flag). Detail in §3.1.
- **Unified mutation representation** · wrap-lift-duplicate compiler. Procedure extraction never used. Detail in §3.5.
- **Equivalence detection policy** · sound techniques filter, unsound techniques advise. AST canonicalization filters; dataflow and kill-diversity annotate. Developer feedback loop stored in results DB closes project-specific FPs. No binary diff (incompatible with schemata). Detail in §7.
- **Test isolation** · `TestIsolation = Function` enforced; per-test fresh runner invocation throughout; pre-flight flakiness detection 3×; DB snapshot between mutants; kill confirmation re-run. Detail in §6.
- **History identity key** · `(ast_subtree_hash(node), enclosing_codeunit_object_name, operator_name, operator_major_version)`. `file` and `line` are display metadata only. Git-assisted migration for codeunit renames/splits/moves. Detail in §5.1.
- **Custom operator API** · typed TypeScript plugin via `@lethal/operator-sdk`, with mandatory conformance suite + corpus fuzz + worker budgets at load time. SDK's typed `build.*` constructors enforce AL-level well-formedness at authoring time; operators cannot mint AL syntax AL doesn't have. ~~Tier 3 metadata mutations use a distinct emit path not yet specified for custom authors.~~ (R13 measured that no distinct Tier-3 emit path is needed or built — see §4.) Detail in §4.

## 13. Open Questions

Narrower items deferred:

- ~~**Tier 3 custom-operator interface**~~ · **CLOSED by R13, 2026-08-02: there is no built-in Tier-3 path to stabilize.** Two of the three operators are not metadata operators, and the one that is (`PermissionReduce`) is refused on cost. A custom-operator surface for metadata mutation would be a surface for a category the product does not have; revisit only if a built-in tier-3 operator is ever justified. `MutationOperator.tier` still admits `3` (`packages/engine/src/operator/interface.ts`) and `tierRank` deliberately refuses to order it — see R11.
- **Pre-flight cost envelope on very large suites** · 3× per-test-invocation baseline runs may be prohibitive on suites of ~50k+ tests. Possible mitigation: sample a stable-history subset instead of full baseline. Revisit once real-project data exists.
- **Results DB format versioning** · SQLite schema versioning strategy for LethAL's own schema evolution (distinct from user-project schema evolution in §5.1). Conventional forward-only migrations expected; noted here for tracking.
