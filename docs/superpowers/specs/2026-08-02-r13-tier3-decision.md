# R13 — Tier 3: what it is, what it is not, and why none of it ships

**Status:** decision, 2026-08-02, **revised after an adversarial review that overturned one of the
two legs it originally stood on.** Supersedes `design.md` §"Tier 3 · Advanced" and §"Tier 3 emit
path (noted)". Produced under the go/no-go thresholds written into `ROADMAP.md` at `349901a`,
**before** any candidate site was counted.

`design.md` sketched Tier 3 two weeks before Tier 2 existed: three operators — `PermissionReduce`,
`IsolationLevelSwap`, `EventPublisherSignature` — which "mutate AL object metadata rather than
expressions/statements" and therefore "need a distinct emit path and a narrower interface". Every
clause in that sentence is an assumption. This document tests them and reaches a single answer:

> **Tier 3, as a category defined by a distinct metadata emit path, does not exist.** One of the
> three operators is genuinely declarative; it is **killable — measured, not assumed** — and is
> refused on COST alone, with the threshold that would reopen it written down. The other two are
> not metadata operators at all: their observable effects live in executable positions the existing
> emit path already reaches. One of those two is already shipped as a Tier-1 mutant at 25 of its 36
> sites; the other is a different operator wearing this one's label, and is re-filed rather than
> refused.

Nothing is built. R13 closes as *designed, measured, refused on cost* — not as *unprofitable*.

## 0. What the review changed, and why it is recorded rather than quietly fixed

The first draft of this document concluded that `PermissionReduce` was "refused twice over — on
cost and on measured killability, either alone sufficient". **The killability leg was wrong.** It
rested on seven live arms that between them covered two modes (`TestPermissions = Disabled`, and
Restrictive) and on the sentence *"There is no third mode."* There is a third mode, and it is in
the very project the census ran on: a test codeunit declares `TestPermissions = Disabled` — so it
counts inside the "every real suite declares it" evidence — and then lowers the session itself with
`LibraryLowerPermissions.SetO365Basic()`. Permission checks are ON, the session is not SUPER, and
production code runs under it.

An eighth arm measured that mode and **`PermissionReduce` kills there** (§3). The first draft's
confident negative was produced by the same process as its correct findings, which is the reason
this section exists at all.

## 1. Is the emit path actually distinct?

`schemata` instruments by rewriting an executable site into a flat guard chain
(`packages/schemata/src/dispatch.ts`, `duplicate.ts`):

```al
if MutationSelector.Active('<mutantId>') then begin <mutated> end else begin <original> end;
```

Runtime selection is the whole architecture: ONE artifact carries every mutant and the selector
picks one per test invocation. A site that cannot hold an `if` cannot be mutated this way.

**Measured against the vendored tree-sitter-al v3.0.1 wasm** (a codeunit carrying all three shapes;
zero ERROR/MISSING nodes):

| sketched operator | what the site actually parses as | position |
|---|---|---|
| `PermissionReduce` | `property` → `property_name` + `tabledata_permission_list` → `tabledata_permission` → `permission_type`, directly under `declaration_body` — a **sibling of `procedure` and `trigger_declaration`** | **declarative** |
| `IsolationLevelSwap` | `Cust.LockTable()` is a `call_expression` under `statement_block`; `Cust.ReadIsolation := IsolationLevel::UpdLock` is an `assignment_statement` | **executable** |
| `EventPublisherSignature` | the signature is the `parameter_list` of a `procedure` preceded by an `attribute_item` (`IntegrationEvent`/`BusinessEvent`); **the raise** is a `call_expression` with an `argument_list` under `statement_block` | declarative **and** executable |

Confirmed downstream of the grammar: a spec whose `before` is a `property` node has no enclosing
statement, so `isMutableSite` (`packages/schemata/src/enclosing.ts:39`) is false and
`generateMutationSet` drops it into `nonExecutableSites` (`packages/runner/src/orchestrator.ts:290`)
— the same path the 204 dropped `SubPageLink`-style declarative sites take on this very project.

The premise therefore splits three ways rather than holding for all three:

- **`PermissionReduce` is the only true metadata operator.** The reason it cannot ride the existing
  guard is not merely that a property "cannot be wrapped in an `if`" — it is that **`Permissions`
  is purely additive**. It grants indirect rights to code executing in the object (arm A5's
  `Insert` → `IndirectInsert` is that additivity visible in an error message). A reduction is only
  expressible by editing the grant on the object whose own code performs the operation.
  - The obvious escape — route the write through a shadow object carrying the reduced grant,
    `if Active(id) then Shadow.Write(Rec) else Rec.Modify()` — was **measured, not dismissed**: arm
    A9 shows a caller's grant does NOT cover a callee's write, so the routing genuinely reduces.
    It is still not cheap: AL has no generics, so a shadow procedure is needed per record type per
    grant, or the write must be re-expressed through `RecordRef`, which is a different operation
    whose permission semantics are themselves unmeasured. That is a new subsystem, not a predicate.
- **`IsolationLevelSwap` is a Tier-2 operator wearing a Tier-3 label**, and at most of its sites it
  is not even new — see §2.
- **`EventPublisherSignature` is emittable only in forms that are unobservable.** A publisher can be
  emitted twice (original plus swapped-parameter twin) with each raise guarded, so "nothing to
  select" is too strong. What kills it is that **subscribers bind to the original** — by object and
  event name, often from outside the app — so the twin has no subscribers and every such mutant is
  equivalent by construction, while the app's public event surface grows a phantom. The observable
  construction is the mirror image: duplicate the SUBSCRIBER with its two same-typed parameters
  swapped and guard the two bodies. That stays inside the instrumented app, but needs a
  procedure-level duplication emitter rather than a statement splice, and was not censused.

**This answers R13's first question and dissolves the category.** There is no Tier-3 emit path worth
specifying: the only operator that would need one is refused below on cost, one of the other two
needs nothing new, and the third is a different operator that should be specified on its own terms.

## 2. Is any of the three worth it?

Census of `U:/Git/do-rel2/Cloud` (Continia Document Output 28.4.0.0 — the version the environment
runs, and the same `censusMutants` denominator R69 used): 554 `.al` files, **19,132 deployable
mutants**. Counting rule fixed in advance: SITES, one mutant per site.

| candidate | sites | share | which bar applies |
|---|---|---|---|
| `PermissionReduce` | **38** `Permissions` properties (37 outside `.dependencies`) — codeunit 15, page 9, report 7, permissionset 6, table 1 — carrying **423** `tabledata` grants between them; 6 `permissionset` objects | 0.20% (property grain) / **2.21%** (grant grain) | **(b) >= 957** — new activation mechanism |
| `IsolationLevelSwap` | 36 raw — 25 `LockTable()` calls (all in statement position) + 11 `ReadIsolation :=` assignments + 0 `ReadIsolation(...)` calls. **25 of the 36 already carry a shipped `lethal.void-method-call` mutant**, so the marginal footprint is **11** | 0.06% marginal | (a) >= 13 — existing emit path |
| `EventPublisherSignature` | 140 event publishers, of which 40 have two parameters of one type (a swap that would still type-check); 44 raise sites reach such a publisher, **21** name an event something in the checkout subscribes to | 0.23% / 0.11% | (b) at the signature; (a) at the raise site |

The bar was calibrated on what this project already ships, censused the same way: `void-method-call`
8028 · `empty-block` 6097 · `negate-conditional` 2520 · `return-value` 952 · `remove-setrange` 808 ·
`conditional-boundary` 303 · `remove-calcfields` 218 · `remove-testfield` 93 · `remove-commit` 52 ·
`swap-rec-xrec` 48 · **`swap-modify-flag` 13**. A percentage bar in the R69 style would have refused
four operators already in the product, which is why cost splits the bar instead.

Two of these numbers need their grain stated, because the first draft got one of them wrong:

- **`PermissionReduce` is judged at both grains and fails at both.** The property grain (38) and the
  grant grain (423, i.e. `TableData X = RIMD` → a reduced set, which is what `design.md` actually
  describes) bracket the honest range; 423 is 2.21%, still short of bar (b)'s 957. An earlier draft
  printed **1,682** here, which was a grammar-NODE count off `tabledata_permission_list` — roughly
  four nodes per grant — and 1,682 would have PASSED the bar it was printed under. Corrected.
- **`IsolationLevelSwap`'s deletion half already ships.** `lethal.void-method-call` targets any
  statement-position `call_expression` (`ALNodeKind.procedure_call === "call_expression"`), so all
  25 `LockTable()` calls carry a mutant today — verified by running `generateMutationSet` over the
  project and filtering specs whose `before` text contains `LockTable`: **25 `void-method-call`**
  (plus 27 enclosing `empty-block`s). A Tier-3 operator deleting the same call at the same node
  would emit a byte-identical identity and collide, which is §4's throw, concretely. Its genuinely
  new footprint is the 11 `ReadIsolation :=` sites — **below bar (a)**. It is refused on the
  pre-committed cost bar without needing a killability argument at all.

## 3. What can each one actually kill?

Measured live on Cronus281 through the fenced path, 2026-08-02. Arm-by-arm results, verbatim
messages and bounds: `docs/measurements/README.md` §"R13". Summary:

### `PermissionReduce` — KILLABLE, in one measured mode, and that mode is rare

Three modes, not two:

| mode | the callee's `Permissions` property | outcome |
|---|---|---|
| `TestPermissions = Disabled`, session SUPER (A1–A3) | reduced / granting / absent | all three **write** — the property is inert |
| Restrictive (A4–A7) | reduced / granting / absent / on the test codeunit itself | all four **refused** — such a suite fails at baseline, so its mutants never reach a verdict |
| `TestPermissions = Disabled` **plus** `LibraryLowerPermissions.SetO365Basic()` (A8) | **granting → writes; reduced → REFUSED; absent → refused** | **the mutation changes the verdict** |

A8 carries its own control: the same lowered session writing DIRECTLY from the test body is refused
(`TableData 27 Item Modify`), so the lowering demonstrably took effect and the grant arm's success
is the property doing work — not a probe measuring itself (R26's mistake, written as an arm).

So the operator has a real kill mechanism. What refuses it is cost, and the reachability of that
mechanism bounds how much cost is worth paying:

- **Sites:** 423 grants (2.21% of mutants), against bar (b)'s 957.
- **Reachability:** a kill needs BOTH a grant at the site AND a covering test that lowers
  permissions. In the only real project measured, that is **10 of 1,290 tests (0.78%), in 2 of 104
  test files**. The killable set is bounded above by the smaller side of that intersection.
- **Cost:** one artifact per mutant — a compile-and-publish cycle per mutation instead of one per
  run — or the shadow-routing subsystem §1 describes. Both are a new pipeline.

**Refused on cost. Not refused as worthless**, and the difference is the point: this is a judgment
someone can overturn with a measurement rather than a claim about what BC can do. It reopens if a
project shows >= 957 grant sites, or if permission-lowering tests stop being 0.78% of a suite.

### `IsolationLevelSwap` — refused on the cost bar; its killability is deliberately left unsettled

Refused at §2 on marginal footprint (11 < 13). The killability evidence is recorded because it
bears on the 25 mutants this project **already ships** at those sites, not because the refusal needs
it:

- The operator's textbook kill mechanism is contention between concurrent transactions. LethAL gives
  a test one session and the platform test runner refuses it a second (*"Sessions can only be
  started in tests that are run by a TestRunner that has TestIsolation set to Disabled"*), so that
  mechanism is unreachable.
- One single-session observable exists and was found rather than assumed: **a bare `LockTable()`
  opens a write transaction, so a following `Codeunit.Run` aborts the whole test** with R72's *"An
  error occurred and the transaction is stopped."*, while the same code without it runs fine.
- **That measurement is in the `[Test]` method's own frame, which is NOT the frame mutants occupy.**
  LethAL instruments the target app, never the test app. R73 already measured that the same
  artifact does NOT appear when the write and the `Codeunit.Run` sit in an ordinary codeunit called
  from a test (`Data Commit Ops.CommitThenRun`'s `remove-commit` mutant survived). So no claim is
  made here about a `LockTable` deletion at a production-frame site: it is unmeasured.
- Two directions of the operator differ and must not be conflated. A **deletion** removes a
  transaction opener, so any abort sits on the unmutated side. A **strengthening** swap
  (`ReadIsolation := ...UpdLock`) puts the opener on the MUTATED side: baseline green, mutant
  aborts, scored `killed` — an R72-class **false kill** manufactured by the operator itself. An
  implementer who ships this operator must handle that direction, and `asserterror`-shaped tests
  (never measured against this artifact) can invert the deletion case too.

### `EventPublisherSignature` — refused as specified; a different operator is filed in its place

At the signature the only emittable form is unobservable (§1). At the raise site an argument swap is
emittable and observable — a subscriber receiving `(B, A)` instead of `(A, B)` can genuinely fail an
assertion. But that operator is **not the one `design.md` sketched, and not event-specific**: "swap
two arguments of the same type at a call site" applies to every call in the language, and
restricting it to event raises is arbitrary. Its event-scoped footprint (44 type-safe raise sites,
21 whose event name is subscribed somewhere in the checkout — both **generous upper bounds**, since
the publisher map is keyed on bare name and the subscriber match ignores the publishing object)
clears bar (a); its general footprint is unmeasured.

**Refused as specified, re-filed as its own item** (`SwapCallArguments`, ROADMAP R82) so it is
measured and specified on its own terms rather than inherited from a label it does not fit.

## 4. Consequence for R11 (`tierRank`)

`tierRank` (`packages/schemata/src/dedup.ts:26`) returns `NaN` for any tier that is not 1 or 2, and
`dedupeSpecs` throws rather than guessing an order. R11 filed that as a defect to fix "when tier 3
becomes real". **It does not become real**, so the two-tier ordering is correct rather than
incomplete, and the fix must not be applied speculatively — a third rank with no operator behind it
is an ordering nobody has reasoned about, waiting to resolve a collision silently and wrongly.

The collision it guards is concrete, not hypothetical: §2 shows a tier-3 `IsolationLevelSwap`
deleting `LockTable()` would emit a byte-identical identity to a shipped `void-method-call` mutant
at 25 sites of one real project.

R11 closes by making the decision an executable assertion instead of a comment: a test that a
registered tier-3 operator colliding with a tier-1 one **throws**, naming both operators and both
tiers. This repo's own rule (R70) is that a premise stated only in prose stops being true without
anyone noticing.

## 5. What this does NOT prove

- **Not** that `LockTable`'s removal is unobservable at the sites mutants actually occupy. The one
  observable found was measured in the `[Test]` frame; R73 shows the artifact behaves differently in
  the production frame; nothing was measured there.
- **Not** that `PermissionReduce`'s kill rate is 0.78%. That figure is the share of a suite's tests
  that lower permissions — an upper bound on reachability, not the intersection with sites carrying
  grants, which would need a coverage join this decision did not require.
- **Not** a statement about `InherentPermissions`. §1's additivity finding is about `Permissions`.
  AL's `InherentPermissions` constrains rather than grants and applies irrespective of the user's
  permission sets — the one object-level permission property that could refuse a SUPER session, and
  therefore a materially different (possibly better) mutation target. Continia Document Output
  carries **2** of them across 554 files, so it is not a footprint worth building for today, but the
  refusal above should not be read as covering it.
- The census is one real project. It is a large one in the relevant idiom (140 event publishers, 423
  permission grants, 25 `LockTable` calls), but a project built around permission sets or heavy
  locking would produce different counts. What site counts cannot change is §1's emit-path facts and
  §3's killability measurements.
- `IsolationLevelSwap` was never measured on its `ReadIsolation :=` half (11 of 36 sites) at all.
- Every permission arm ran on one BC 28 container, one company, as one SUPER OData user before
  lowering.
