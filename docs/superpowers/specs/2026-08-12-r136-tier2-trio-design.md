# R136 - the Tier-2 trio: `swap-modify-flag` extended, `swap-find-direction`, `validate-to-assign`

Status: **DRAFT, awaiting adversarial review.** Written 2026-08-12 as Task A1 of
`docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`. It ratifies four of that plan's six
proposals as written and amends three of them (proposals 2, 3 and 5 keep their decisions and change
their mechanics; proposal 6 keeps its deferral and corrects the stated reason). Supersedes nothing.
Extends the operator set defined in `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md`
and follows the shape of `docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md`,
including its rule that the per-mutant prediction table is pre-committed in a SEPARATE document
before the live run (Task A9).

The amendment log for the adversarial review goes at the top of this file when Task A2 lands, in
R82's form: "Reviewed by <agent> <date> (N amendments adopted: ...)".

## 0. What is already settled, and what this document is for

**Populations, from R136's own census** (658-file Continia Document Output snapshot, 2026-08-12).
`FindFirst` 236 sites and `FindLast` 42. `Validate(` calls at most 179, which is an upper bound
because the census counts the single-argument form this operator refuses. `Insert(true)` 91 and
`Delete(true)` 86, against the 43 `Modify(true)` sites `swap-modify-flag` covers today. So the
cheapest of the three changes multiplies one existing operator's population by about five, and none
of the three can be refused on cost.

**Refusals already decided, and not re-litigated here**: `Next()` arithmetic mutation and
`IsEmpty`/`Find` negation inside conditions (both refused in R136), and `remove-setfilter` (refused
in R134). Section 5 records them again with their reasons so a reader of this file alone does not
have to reconstruct them.

**Product machinery these operators build on, all of it existing and tested**: receiver proof
(`claimsRecordMethod` in `packages/builtin-tier2/src/receiver.ts`), argument counting that cannot be
inflated by comments (`packages/builtin-tier2/src/mutate-helpers.ts`), dedup identity
(`packages/schemata/src/dedup.ts`), the guarded dispatch chain that carries a mutant's replacement
text into compiled AL (`packages/schemata/src/dispatch.ts`), and baseline identity
(`packages/runner/src/selection.ts`).

**Measured for this document, 2026-08-12, and it closed a hazard rather than adding a guard.** The
`validate-to-assign` operator rewrites a call into an assignment, so a field kind that accepts
`Validate(F, V)` but refuses `F := V` would produce a mutant that fails to compile and poisons its
whole batch. The candidate was a FlowField. Four offline `alc` compiles against a scratch copy of
`fixtures/sandbox-data` (a FlowField two-argument `Validate`, a FlowField assignment, the
normal-field control, and a FlowField single-argument `Validate`) all returned exit code 0 with zero
diagnostics. So a FlowField is not a counterexample and no field-kind guard is added on its account.
The residual risk, which this probe does NOT clear, is recorded in section 5 with the probe recipe
that would clear it.

**Measured for this document as well**: `fixtures/sandbox-app` contains zero sites for all three
operators. A case-insensitive search of that fixture for `FindFirst`, `FindLast`, `Validate(`,
`Insert(true)`, `Delete(true)` and `SetFilter` returns nothing. So `itest:bcdev`, `itest:alrunner`
and `itest:envtool` must come back UNCHANGED, and any movement in them is a finding about the
operators' claiming rather than about the fixture.

**What is open is killability through the pipeline.** That is what the fixture in section 3
measures, and section 1 says which of the several things "killability" could mean it can settle.

## 1. Three claims, and which one the fixture settles

| claim | status | who can settle it |
|---|---|---|
| (a) skipping a run-trigger flag, reading the wrong end of a filtered set, or skipping an `OnValidate` chain can change behaviour | **tautological** for all three operators; do not dress any of it up as a measurement | nobody needs to |
| (b) each operator, through the full pipeline, claims the right sites, refuses the sites it says it refuses, emits an artifact that compiles, coexists with `void-method-call` under dedup, is attributed to a covering test, and produces BOTH verdicts, scored correctly | **falsifiable, and the point of the fixture** | `itest:tables`, live |
| (c) real suites notice these mutants at a rate that justifies shipping them | **unmeasurable at fixture scale** | a real-project run, the R85 instrument |

The claim that carries the risk is (b), and the reason is the same one R82 gave: the platform sits
between the construction and the verdict. R73 is the standing precedent, where a mutant predicted
killed from a measured platform behaviour came back survived and the contradiction was the finding.
So Task A9 pre-commits a per-mutant prediction table before the live run, and a contradicted
prediction is written up as a finding rather than quietly reconciled.

**Closure wording, pre-committed now so it cannot drift later**: "mechanism killability proven live
for all three operators, in both find directions and on both `Insert` and `Delete`, with the
qualified and implicit receiver forms of `Validate` both measured; rate on a real project
unmeasured." Never "killability measured".

## 2. The operators

### 2.1 `lethal.swap-modify-flag`, version 1.0.0 becomes 1.1.0

**Ratified as proposed.** `targets()` claims a `procedure_call` when `claimsRecordMethod(node, ctx,
m)` holds for `m` in `["Modify", "Insert", "Delete"]`, and the call still carries exactly one
argument which is the literal `true` (any case). Everything after the claim is already
method-name-agnostic: the boolean-argument predicate, the argument splice, and the honest
`parentContext` computation all stay untouched.

**Direction stays `true` to `false` only.** The reverse direction is a different bug class. A
`false` to `true` mutant ADDS a trigger run, so its observable effect is whatever side effect the
trigger has, and a suite that does not assert that side effect cannot see it. Its population is also
unmeasured (R136 censused the `true` spellings). Out of scope, recorded here so it is not read as an
oversight.

**The bump is MINOR, and here is the whole verification chain rather than the assertion.** Four
facts, each read from the code that carries it:

1. A baseline is keyed on `astHash|codeunitName|operatorName|operatorMajor`
   (`packages/runner/src/selection.ts`, and the same key is rebuilt in
   `packages/runner/itest/mutant-equality.ts`).
2. `astHash` is `astSubtreeHash(spec.before)` (`packages/schemata/src/project.ts`), a hash of the
   ORIGINAL subtree. It does not see the operator's version and does not see the replacement text.
3. `operatorMajor` is `Number(operatorVersion.split(".")[0])`, so 1.0.0 and 1.1.0 are both 1.
4. The per-mutant baseline compares only key, verdict, killing test, coverage-filtered flag and
   error class (`normalizeForComparison`). No committed baseline file stores an operator version at
   all, which a search of `packages/runner/itest/*.json` confirms.

So every existing `Modify(true)` mutant keeps its identity and its verdict, the baseline gains rows
and loses none, and no re-key is scheduled. The same reasoning covers the known-survivor history in
`filterHistory`: a survivor recorded under 1.0.0 still matches under 1.1.0, which is correct because
its AL is unchanged.

The cost of that choice, stated so the review can weigh it: identity ignores the minor segment, so
two runs of the same site under 1.0.0 and 1.1.0 are indistinguishable at the identity level. The
full version string is still written into every manifest entry
(`MutantManifestEntry.operatorVersion`), so provenance survives where it is needed. A MAJOR bump
would buy that distinction at the price of re-keying every existing `swap-modify-flag` row in three
frozen baselines, which is a real cost for a distinction nothing reads.

**The name stays `lethal.swap-modify-flag`** even though it now covers three methods. A rename moves
`operatorName`, which IS part of the identity key, so it costs exactly the re-key the minor bump
avoids. The doc comment carries the explanation: the name is historical, the coverage is the three
record methods that take a run-trigger flag.

**Limits, inherited and unchanged.** The mutant is only observable when the table's `OnInsert`,
`OnModify` or `OnDelete` does something a test asserts. The semantic layer cannot see base-app
triggers, so an equivalent mutant on a base-app record cannot be hinted away. No site inside a
`tableextension` or `pageextension` is claimed through an implicit `Rec` beyond what
`receiver.ts` already documents. The parenthesis-less call form (`Rec.Insert;`) parses as a member
expression, never reaches the predicate, and is silently not claimed.

**Cost of the three-name loop**: `claimsRecordMethod` compares the callee name before it does any
symbol-table work, so a non-matching node costs three cheap callee parses and nothing more. The loop
short-circuits on the first match.

### 2.2 `lethal.swap-find-direction`, new, tier 2, version 1.0.0

**Ratified**: the target, both directions, one mutant per site, the zero-argument guard, and the
decision not to restrict to statement position. **Amended**: how `generate()` finds the span it
rewrites.

Claim a `procedure_call` when both hold:

1. `countArguments(node) === 0`. `Find('-')`, `FindSet()` and `FindSet(true)` are different
   operations, not direction variants, and are refused. This guard is the one whose absence is
   dangerous rather than merely incomplete, because a `FindSet` rewritten to `FindLast` changes an
   iteration into a single read.
2. `claimsRecordMethod(node, ctx, "FindFirst")` or `claimsRecordMethod(node, ctx, "FindLast")`.
   Whichever matches gives the direction. That predicate carries the receiver proof, the
   case-insensitivity, and rule 3, which refuses a call whose name a project procedure declares on
   that table.

The emitted mutant replaces the method NAME and nothing else, so the receiver, the parentheses and
any trivia inside them are carried through exactly as written. The replacement text is always the
canonical spelling (`FindLast` or `FindFirst`), because AL is case-insensitive and the identifier's
own casing carries no meaning. This mirrors how `swap-modify-flag` always emits lowercase `false`.

**Amendment, and the reason.** The plan proposed locating the method-name identifier as "the last
identifier-kind named descendant that starts before the argument list and whose text matches the
claimed method". That is a second parser for a fact `claimsRecordMethod` already resolves, and
`receiver.ts` itself states the rule this repo learned the hard way: a second parser for the same
node shape is exactly what drifts. So `receiver.ts` gains one small export that returns the callee
NAME NODE for a call, derived from the same `function` field and the same `field_access` member path
`claimsRecordMethod` uses internally. Both new operators splice over that node's span. If the
accessor returns nothing, the operator emits no mutant rather than guessing, guarded the same way
`replaceArgument` guards a span that does not fall inside the node's own text.

One consequence worth naming: a quoted method spelling (`Rec."FindFirst"()`) is claimed today,
because the receiver predicate strips quotes when comparing names. Splicing the canonical bare name
over the quoted span produces `Rec.FindLast()`, which is valid AL. Nothing needs to change; it is
recorded so the review does not have to rediscover it.

**`parentContext` is computed, not asserted.** `if Rec.FindFirst() then` is a common and real form,
and the swap preserves the expression shape, so the operator uses the same honest
`isStatementPosition` hint `swap-modify-flag` uses. R82's arm B is the standing live proof that an
expression-position rewrite is emitted and scored correctly, so this path is measured rather than
assumed.

**Dedup**: the replacement text is never empty, so the mutant coexists with `void-method-call`'s
deletion at a statement-position site. Nothing is displaced.

**Equivalence class, documented rather than feared.** The mutant is equivalent whenever the filtered
set holds zero or one row, and it is invisible to any test that only asks whether something was
found. That is the same data-dependence `remove-setrange` documents, and it is why R136 required
decoy rows in the fixture. The operator does NOT tag such sites `likely-equivalent`: today that hint
changes exactly one thing, which of two colliding specs wins in dedup, and using it as a "probably
survives" annotation would be describing a scoring feature that does not exist.

**What the operator does not reason about**: which key the record is currently sorted on. `FindFirst`
and `FindLast` follow the current key and any `Ascending` state, both of which may be set elsewhere.
The mutation is still a direction reversal at that site under whatever ordering is in force, which
is precisely the wrong-record bug class R136 named. No claim about ordering is made or needed.

### 2.3 `lethal.validate-to-assign`, new, tier 2, version 1.0.0

**Ratified**: the rewrite, the four guards, and the refusal of the single-argument form.
**Amended**: the argument accessor's contract, and the derivation of the receiver prefix.

`R.Validate(F, V)` becomes `R.F := V`, and the implicit-receiver form `Validate(F, V)` becomes
`F := V`. The mutant deletes the `OnValidate` trigger chain while leaving the field value correct,
which is a BC-specific bug class nothing else in the product models. The tables fixture already
holds `OnValidate` sites whose mutants are killed, so the kill path is established rather than
hoped for.

Claim a `procedure_call` when ALL hold:

1. `isStatementPosition(node)`.
2. `claimsRecordMethod(node, ctx, "Validate")`.
3. the call carries exactly two value arguments.
4. the FIRST argument is a plain field identifier: a bare identifier or a double-quoted identifier,
   with no member access, no subscript, no call and no other expression inside it.

**Why statement position, and what the guard actually protects.** It is not the deletion hazard the
three deletion operators guard against, because this is a rewrite. It is the splice target. The
guarded dispatch chain replaces the enclosing statement's span with a branch whose body is that
statement's text with the mutant's span substituted, so an assignment can only be spliced where a
STATEMENT is expected. `isStatementPosition` is the only predicate in the product that measures
that, and it measures `false` for an un-braced then-branch.

That costs a real shape: `if Cond then Rec.Validate(F, V);` is refused, even though
`if Cond then Rec.F := V;` would be perfectly legal AL. The refusal is the safe direction and it
stands for Wave A. Its cost is UNMEASURED, and the cheap way to measure it is a census of
`then <receiver>.Validate(` shapes on the Document Output snapshot alongside the 179 total. If that
population turns out to be material, widening the guard is a MINOR bump on this operator by the same
identity reasoning as section 2.1, so the decision is reversible without a re-key.

**Amendment 1: the argument accessor takes an exact count, not an index.** The plan proposed
`argumentAt(call, index)` plus a `countArguments(node) === 2` check. Index access alone reopens a
hole `mutate-helpers.ts` deliberately closed. That file filters comments out of the argument list
but deliberately leaves other trivia the grammar admits as named children (a pragma, a `#region`)
IN, on the stated ground that every consumer treats a longer-than-expected list as a refusal. An
indexed read does not treat it that way: with a pragma sitting first inside the parentheses,
`argumentAt(call, 0)` returns the pragma. So the shared helper is an exact-count accessor: it
returns the N argument expressions only when the top-level comma count says N AND the comment-filtered
named-child count is also N, and null otherwise. `soleArgument` must keep its existing behaviour
exactly, which that contract gives it for N of 1, and the existing `swap-modify-flag` and
`remove-setrange` tests must stay green through the refactor. If any of them changes, the refactor
changed behaviour and is wrong.

**Amendment 2: the receiver prefix comes from the shared name-node accessor**, the same one section
2.2 adds, and not from a separately derived "text up to the method name". One accessor, two
operators, no drift.

**The emit form is a REBUILD, not a splice, and that has one consequence.** The mutated text is the
receiver prefix, then the first argument's verbatim text, then ` := `, then the second argument's
verbatim text. Because it is assembled rather than spliced, trivia BETWEEN the arguments is dropped:
`Validate(Level, X /* why */)` yields `Level := X`. That cannot change behaviour, and the emitted
branch is machine-generated AL that nobody reads for its comments, so it is accepted. It is stated
because it is the one respect in which this operator differs from every other rewrite in the
product, all of which preserve interstitial text.

Quoted field names are preserved verbatim, so `Rec.Validate("No.", V)` yields `Rec."No." := V`. An
arbitrary expression is fine as the VALUE argument and is carried verbatim.

`parentContext` is the literal `"statement-position"`, because guard 1 already required it. That is
the `remove-setrange` precedent, and it is honest here in a way it would not be for the other two
operators.

**Refusals, each recorded with its reason**: the single-argument `Validate(F)` has no assignment
equivalent, so it is refused rather than approximated (and it is real AL, which the probe in section
0 confirmed compiles). A first argument that is not a plain field identifier is refused because the
rewrite would have to reason about what it denotes. A call outside statement position is refused as
above.

**Grammar check before the code is finalised.** The first-argument rule is expressed above in terms
of node shape, not a regular expression. The implementing task must print the actual `kind`,
`rawKind` and named children of the first argument of `Validate("No.", X)` and `Validate(Name, X)`
under the vendored grammar and write the guard against what the tree actually contains. The repo has
been bitten by both directions of this: a quoted identifier is a distinct raw kind, and a comment is
a named child.

**Dedup**: the replacement text is never empty, so the mutant coexists with `void-method-call`'s
deletion at the same span. Nothing is displaced.

### 2.4 Dedup and displacement, stated once for all three

Dedup identity is `before.kind`, `before.startIndex`, `before.endIndex`, `after.text`
(`packages/schemata/src/dedup.ts`). All three operators emit non-empty replacement text, and a
deletion's after text is the empty string, so at every shared site the Tier-1 mutant and the Tier-2
mutant have different identities and BOTH survive dedup. Section 3.2 precedence never fires between
them. This is the coexistence `swap-call-arguments` measured live in R82, so the claim here is that
the same mechanism holds for three more operators, not that a new mechanism works.

**The fixture makes that claim sharper than a count can.** Two of the arms below put a Tier-1
deletion and a Tier-2 rewrite on the SAME span with DIFFERENT predicted verdicts: arm B (the flag
swap survives, the deletion kills) and arm H (the assignment survives, the deletion kills). A report
that dropped one of the pair, or merged them, cannot produce two different verdicts at one span. An
arm where both members are killed proves much less.

**One displacement the census WILL show, and it is pre-existing.** At the `SetRange` sites the find
arms need, Tier-2 `remove-setrange` and Tier-1 `void-method-call` both emit an empty after text at
the same span, so they share an identity and Tier 2 wins. That marker is the dedup mechanism working
as designed and is not a displacement caused by this wave. Task A8 must not read it as one.

### 2.5 Shared mechanics the three implementations must not each reinvent

- **The callee name-node accessor** in `receiver.ts`, used by both new operators (sections 2.2 and
  2.3). One resolution of "which node holds the method name", shared with the predicate that already
  resolves it.
- **The exact-count argument accessor** in `mutate-helpers.ts` (section 2.3), with `soleArgument`
  keeping its current behaviour.
- **Refusal proofs belong in unit tests, never in `conformanceTests` with an empty `expectedSpecs`.**
  This is not a style preference. The conformance runner
  (`packages/operator-sdk/src/conformance.ts`) checks only that every EXPECTED spec was produced; it
  never checks for extras. A case with an empty expectation therefore passes unconditionally, on any
  input, forever. `lethal.swap-rec-xrec` has four such cases today and no unit-test file at all, so
  its four documented refusals have no offline guard whatsoever, and only the live baseline would
  notice if one broke. That is this repo's signature "empty-vs-empty matches" failure sitting in the
  operator package the trio is about to be added to. Do not copy the pattern. Every refusal in
  section 5 that belongs to one of these three operators gets a unit test that asserts the generated
  spec list is empty.
- **Every guard gets a red-check**: revert the guard, name the specific test that goes red, restore,
  confirm green, and report both outputs. The guards that must each have their own red-check are the
  three-method claim (2.1), the zero-argument guard and the receiver-proof dependency (2.2), and the
  two-argument and field-identifier guards (2.3).

## 3. The fixture arms

All arms live in `fixtures/sandbox-data`, which feeds ONE frozen gate. `fixtures/sandbox-app` feeds
three and is not touched, which section 0 measured rather than assumed.

### 3.1 What is added

One shared table, `table 79330 "Data Trigger Probe"`, and three arm codeunits, `codeunit 79314 "Data
Flag Ops"`, `codeunit 79315 "Data Find Ops"` and `codeunit 79316 "Data Validate Ops"`. All four ids
are free: the fixture's existing objects are tables 79300 to 79303 and 79309, codeunits 79304 to
79308 and 79311 to 79313, page 79320, pageextension 79321, tableextension 79322 and pages 79323 and
79324, with codeunit 79310 being `Data Tests` in the test app. The declared id range is 79197 to
79199 plus 79300 to 79399.

The table carries what the three operators need to be observable, and nothing else:

- an `OnInsert` trigger that sets a Boolean field, so skipping the insert trigger is observable;
- an `OnDelete` trigger that inserts a tombstone row with a `TOMB-` key prefix, so skipping the
  delete trigger is observable;
- a `Level` field whose `OnValidate` doubles it into a companion field `Level Doubled`, so skipping
  the validate chain is observable while the field value itself stays correct;
- a small public procedure that calls `Validate` with an IMPLICIT receiver, which is the only way to
  measure that emit path live (arm I).

Keys stay short. `'TOMB-' + "No."` must fit `Code[20]`, and R82 arm E is the standing precedent that
a length overflow produces a kill under a test that asserts nothing.

### 3.2 The arms

| arm | shape | what it is for | predicted verdict |
|---|---|---|---|
| **A** | `Data Flag Ops.InsertWithTrigger`: set the key, `Probe.Insert(true)`, return the trigger-set Boolean; the test asserts it is true | the KILL for the `Insert` half of the extension. `Insert(false)` skips `OnInsert`, the field stays false, the assertion fails | killed |
| **B** | `Data Flag Ops.InsertCounted`: same `Insert(true)`, but return whether the row can be read back; the test asserts only that a row landed | the SURVIVOR for the `Insert` half, and the first same-span discriminating pair: the flag swap survives while `void-method-call` at the same span kills, because with no insert there is no row | survived |
| **C** | `Data Flag Ops.DeleteWithTrigger`: set the key, `Probe.Delete(true)`, return whether the tombstone exists; the row is inserted by the TEST | the KILL for the `Delete` half. `Delete(false)` skips `OnDelete`, no tombstone appears, the assertion fails | killed |
| **D** | `Data Find Ops.FirstLevelInRange`: `SetRange` on the key, `if Probe.FindFirst() then exit(Probe.Level)`; the test seeds two in-range rows with distinct Levels plus one out-of-range decoy, and asserts the LOW Level | the KILL for `FindFirst` to `FindLast`, in EXPRESSION position (the call is an `if` condition). The decoy is what makes the collateral `remove-setrange` mutant deterministically killable | killed |
| **E** | `Data Find Ops.LastLevelInRange`: the same shape with `FindLast`, two in-range rows and a decoy sorting AFTER the range; the test asserts the HIGH Level | the KILL for the other direction. Both directions are measured live, which is what proposal 2's "both directions" is worth | killed |
| **F** | `Data Find Ops.AnyInRange`: `SetRange`, then `exit(Probe.FindFirst())`; the test asserts only that something was found | the EQUIVALENT-to-this-suite SURVIVOR. An existence-only assertion cannot see a direction reversal, which is exactly the limit section 2.2 documents. Also the second expression-position shape (inside an `exit`) | survived |
| **G** | `Data Validate Ops.SetLevel`: `Probe.Validate("Level", NewLevel)` in statement position, return `Probe."Level Doubled"`; the test asserts the doubled value | the KILL for `validate-to-assign`, with a QUOTED field identifier. The assignment skips `OnValidate`, the companion field stays 0, the assertion fails | killed |
| **H** | `Data Validate Ops.SetLevelWeak`: the same call, but return `Probe."Level"`; the test asserts the field value | the SURVIVOR, and the sharpest arm in the wave: the field ends up CORRECT, so the assertion passes, while `void-method-call` at the same span kills because the field stays 0. Same span, two mutants, two different verdicts, and a bug class Tier 1 cannot express | survived |
| **I** | the table's own public procedure calling `Validate("Level", V)` with no receiver, called directly from a test that asserts the doubled value | the IMPLICIT-receiver emit path, which produces an assignment with an EMPTY receiver prefix and is a distinct branch of `generate()`. Also a Tier-2 mutant sited in a `table` object rather than a codeunit | killed |
| **J** | `Data Validate Ops.TouchLevel`: assign `"Level"` by hand, then `Probe.Validate("Level")`, single argument, and return the doubled value | the REFUSAL negative, the R82 arm F role. `validate-to-assign` must emit NOTHING here. If it ever claims the site, the after text is a truncated assignment, `alc` rejects the artifact, and the gate fails loudly instead of silently scoring a wrong mutant. The site keeps its Tier-1 `void-method-call` mutant, whose verdict is pinned | no `validate-to-assign` mutant; the deletion at that span is killed |

### 3.3 Rules the arms obey, each with its reason

1. **Coverage filtering isolates arms, so every row a mutant's verdict depends on must be seeded by
   that mutant's OWN covering test.** A mutant runs only against the tests coverage attributes to
   it, and these arms are ordinary public procedures, so member-level attribution should give each
   arm just its own test. Relying on rows another arm's test inserts would make a verdict depend on
   which tests happened to run. **This is the amendment to proposal 5**: the plan's find arms seeded
   only in-range rows, which leaves the collateral `remove-setrange` mutant at each of those sites
   surviving or killing depending on rows that may not exist when it runs. Each find arm's test now
   seeds one out-of-range decoy as well, which is also what R136's own text asked for.
2. **Reserve Level values per arm** and never reuse an asserted value on another key in this table.
   That way no collateral mutant's verdict can hinge on which other rows exist, even if attribution
   turns out coarser than expected.
3. **Statements in the test app are free; statements in the target app are not.** The gate generates
   mutants from `fixtures/sandbox-data` only, so defensive setup, delete-before-insert idempotence
   and row seeding all belong in `Data Tests`, where they cost nothing. Every extra statement in an
   arm codeunit is another mutant somebody must pre-commit a verdict for, so arm bodies stay
   minimal. Concretely: arms G, H, I and J need no rows at all, because `Validate` runs `OnValidate`
   against the in-memory record, and dropping the insert and modify calls the plan sketched removes
   four collateral mutants and every duplicate-key concern from those arms.
4. **Setup calls inside the target use the non-claimable spellings.** `Insert(false)` and
   `Modify(false)` are not claimed by `swap-modify-flag`, so an arm carries only the mutant it is
   about. Assignments in the target are free: no current operator claims an assignment statement.
5. **Every new test raises through bare `Error(...)`.** The tables gate asserts that the R121
   assertion screen reports itself as `vacuous` on this fixture, which is true precisely because no
   test here uses an assertion library. A new test that used one would change what that gate proves.
6. **Seeding is idempotent** (read, delete if present, then insert), matching the existing fixture.
   The reason is arm independence and residue from an aborted run, NOT that the fence commits
   between runs: R32 measured that platform test isolation rolls these writes back, and the fixture
   already carries a comment correcting the earlier wrong explanation.

### 3.4 Collateral to expect, with the census as the authority

Every new arm brings Tier-1 mutants. `empty-block` on each new procedure body and each new trigger
body, `void-method-call` on each statement-position call, `return-value` on each `exit`,
`remove-setrange` on the find arms' `SetRange` calls (displacing `void-method-call` there, see
section 2.4), and `swap-call-arguments` on those same `SetRange` calls, whose two `Code[20]`
parameters are bare identifiers of one declared type and therefore a qualifying pair.

Two collateral shapes are worth naming in advance because they are easy to misread:

- **Arm C's setup, if it lived in the target, would produce a platform kill rather than an
  assertion kill.** Deleting an insert that a following `Delete` depends on makes the platform raise
  before any assertion runs, which is the R82 arm E false-kill class. Moving that insert into the
  TEST removes the shape entirely, which is why rule 3 above is written the way it is.
- **No new kill is screened.** The `platformArtifactKills` screen only tags the write-transaction
  mechanism that `remove-commit` reports, so the gate's screened-kill count stays 1 even if a new
  kill has a platform-shaped cause. That is a known limit of the screen, not a number to edit.

Task A8's census is the authority on the exact list, and Task A9 must give every entry in it a
verdict and a mechanism. The classes above are what to expect, not a substitute for running it.

## 4. What the live run may and may not conclude

**May conclude**, if every pre-committed verdict matches:

- all three operators claim their sites, emit artifacts that compile, are attributed, and produce
  both verdicts, scored correctly (claim (b));
- the flag extension works on `Insert` AND on `Delete`, each proven by its own arm;
- the find swap kills in BOTH directions, and in expression position;
- `validate-to-assign` works in the qualified AND the implicit-receiver form, and with a quoted field
  identifier;
- Tier-2 rewrites coexist with Tier-1 deletions at one span, proven by two same-span pairs whose
  verdicts DIFFER;
- the MINOR version bump moves no identity, proven per mutant: every pre-existing
  `swap-modify-flag` row must keep its key and its verdict in the re-recorded baseline.

**May not conclude**, and no wording in the roadmap or a report may imply otherwise:

- any rate on real code. The DO populations are census counts of syntactic sites, not counts of
  killable sites, and the fixture cannot turn one into the other;
- anything about the `false` to `true` flag direction, `FindSet`, the single-argument `Validate`, or
  the un-braced then-branch `Validate` shape. All four are refused or deferred here;
- anything about equivalence rates for the find swap. The fixture holds one deliberate equivalent
  survivor, which demonstrates the class and measures nothing about its frequency;
- anything about the assertion screen's discriminating power. This fixture is the measured vacuous
  case by construction;
- anything new about the three codeunit gates beyond "unchanged", which is what section 0 measured
  they must be.

**The ways this is most likely to be WRONG, named in advance so none can be reinterpreted
afterwards:**

1. **Attribution, not verdicts.** Arm I sites a mutant in a table PROCEDURE, and `DataMain.Table.al`
   already records that a trigger needs only object-level credit while a table procedure needs a
   member-level entry. If arm I arrives `no-coverage`, that is a coverage finding, reported as one,
   not absorbed by moving the arm into a trigger.
2. **Arm H may kill instead of survive.** The prediction is that assigning the field without running
   `OnValidate` leaves the field value correct and the test blind. If the platform runs any
   validation on a plain field assignment, the value could differ and the mutant would be killed.
   Either result is a finding: the first is the bug class the operator exists for, the second would
   retire a premise this spec asserts.
3. **Arm F may kill.** If anything in the seeded data makes the existence answer differ between
   directions, the survivor becomes a kill and the arm stops demonstrating the equivalence class.
   That means the arm's data was not as neutral as designed and the arm needs fixing before the
   claim is made.
4. **A `remove-setrange` collateral may survive** if the decoy discipline in rule 1 is not
   implemented exactly. That is a fixture defect, and the honest response is to fix the fixture and
   re-pre-commit, not to accept the survivor.

**Gate deltas expected**: the tables gate grows in `totalMutantSites`, `killed` and `survived`;
`platformArtifactKills` stays 1; `assertionScreenDiscrimination` stays `vacuous`;
`untargetedTriggerCount` stays 0, because each of the new table's three triggers is exercised by at
least one named test, so object-level coverage places them through the ordinary fallback rather than
through the run-everything one. A non-zero value there is a finding about attribution, and the gate's
own comment already says it must be explained before the number is edited. The one permitted
baseline failure stays exactly `Data Tests.PageActionComputesNonZero`, by name.

## 5. Refusals and deferrals, recorded

| item | decision | reason |
|---|---|---|
| `Next()` arithmetic mutation | refused | its natural mutants are non-terminating loops, the hang class; an operator that mostly produces hangs spends the full timeout per verdict to say very little (R136) |
| `IsEmpty` / `Find` negation inside a condition | refused | already covered by `negate-conditional` on the enclosing comparison (R136) |
| `remove-setfilter` | refused | `void-method-call` already emits the identical deletion at every such site, so a Tier-2 twin adds a name and no information (R134) |
| flag direction `false` to `true` | out of scope | different bug class, adds a trigger run whose effect a suite rarely asserts, population unmeasured (section 2.1) |
| `FindSet` direction swap | **deferred, with a corrected reason** | the plan called this a property rewrite and therefore R135 territory. That is wrong: `Ascending` is a record METHOD, not a property. The real obstacles are that a reversed set needs a SECOND statement inserted before the find, which no operator in this product emits today, and that the ascending state outlives the call, so the mutation would not be local to its site. Deferral stands; the reason on the record is now the one that survives inspection |
| `Find('-')`, `FindSet()`, `FindSet(true)` | refused | different operations, not direction variants; the zero-argument guard is what refuses them (section 2.2) |
| single-argument `Validate(F)` | refused | no assignment equivalent exists. It is legal AL, which the section 0 probe confirmed, so the refusal must be an explicit guard rather than an accident of the grammar |
| `Validate` first argument that is not a plain field identifier | refused | the rewrite would have to reason about what the expression denotes |
| `Validate` outside statement position | refused | an assignment can only be spliced where a statement is expected; the cost is the un-braced then-branch shape, and widening later is a MINOR bump (section 2.3) |
| the parenthesis-less call form (`Rec.FindFirst;`) | not claimable | it parses as a member expression, never reaches `claimsRecordMethod`, and is silently not claimed. A documented grammar limit shared with Tier-1 `void-method-call` |
| a `pageextension`'s implicit `Rec` | refused, inherited | its record is the extended page's source table, which this project usually cannot see, and guessing it would claim sites wrongly. Measured on Document Output: zero Tier-2-shaped calls of that shape exist there |
| field kinds other than FlowField for the assignment rewrite | **recorded risk, not cleared** | the section 0 probe cleared FlowField only. A FlowFilter field, or any field kind where `Validate(F, V)` compiles and `F := V` does not, would produce a non-compiling mutant that poisons its batch. The probe that clears it is the same four-compile recipe with the other field kinds added, and it is cheap. Until it is run, the exposure is limited to real projects, because this fixture's fields are all normal, and the compile-failure bisection path would isolate such a mutant at a cost rather than mis-scoring it |

## 6. Ratification log against the plan's six proposals

| proposal | decision | what changed |
|---|---|---|
| 1. extend `swap-modify-flag` to `Insert`/`Delete`, direction unchanged, MINOR bump to 1.1.0, name kept | **ratified as written** | nothing. Section 2.1 adds the four-fact verification chain behind the MINOR claim and states the provenance cost the choice accepts |
| 2. new `lethal.swap-find-direction`, both directions, zero-argument guard, not statement-restricted | **ratified, mechanics amended** | the method-name span comes from a shared accessor exported by `receiver.ts`, not from a re-derived "last identifier before the argument list" heuristic |
| 3. new `lethal.validate-to-assign` with four guards | **ratified, mechanics amended** | the argument accessor takes an exact count instead of an index, so trivia cannot be mistaken for an argument, and `soleArgument` keeps its behaviour; the receiver prefix uses the same shared name-node accessor; the rebuild's trivia loss is stated; the statement-position guard's cost is named with a way to measure it |
| 4. dedup interplay: all three coexist with `void-method-call`, none displaces a Tier-1 mutant | **ratified, strengthened** | two arms are designed so a same-span pair carries DIFFERENT verdicts, which no aggregate can fake; and the one displacement the census will show at the `SetRange` sites is named in advance as pre-existing |
| 5. the fixture arms table | **ratified, amended** | each find arm's test seeds an out-of-range decoy, because coverage filtering means only that arm's own tests run; Level values are reserved per arm; the validate arms drop their insert and modify calls, which removes four collateral mutants and all key handling from them; two arms are added, the implicit-receiver arm I and the refusal negative arm J |
| 6. refusals recorded | **ratified, one reason corrected** | the `FindSet` deferral stands, but the reason is now the two-statement emit shape and the non-local ascending state, not a property rewrite, because `Ascending` is a method |

## 7. Order of work, and the preflight that must not be skipped

Operators and fixture AL land in ONE freeze, per R82's reasoning: landing the fixture first would
move the frozen counts once for collateral Tier-1 mutants and again when the operators ship, and the
tables gate runs the whole session twice per invocation. The offline loop needs no live run.

Before the live gate:

1. `bun run typecheck`, then remove `packages/*/dist`, then `bun test`.
2. `bun run compile:fixtures`. Nothing else compiles fixture AL, and a docs-only commit has already
   broken a fixture procedure while the gate stayed green for days (R56).
3. Census `fixtures/sandbox-app` and confirm its spec list is byte-for-byte unchanged, so the other
   three gates are untouched by measurement rather than by argument.
4. Census `fixtures/sandbox-data` before and after, and confirm the new keys are exactly the
   predicted ones, that no existing mutant moved, and that no NEW displacement of a Tier-1 mutant
   appeared beyond the pre-existing `SetRange` one.
5. Republish the target and test apps.
6. Run the gate, re-record the baseline through the delete-and-rerun path only, REVIEW the per-mutant
   diff against Task A9's table, then run the gate again so the new baseline compares against itself.

A differing verdict is a BLOCK, never "close enough". A contradicted prediction is a finding to
write down, not to erase.
