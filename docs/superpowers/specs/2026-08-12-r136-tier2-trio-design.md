# R136 - the Tier-2 trio: `swap-modify-flag` extended, `swap-find-direction`, `validate-to-assign`

Status: **REVIEWED AND READY FOR IMPLEMENTATION, 2026-08-12.** Written 2026-08-12 as Task A1 of
`docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`. It ratifies four of that plan's six
proposals as written and amends three of them (proposals 2, 3 and 5 keep their decisions and change
their mechanics; proposal 6 keeps its deferral and corrects the stated reason). Supersedes nothing.
Extends the operator set defined in `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md`
and follows the shape of `docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md`,
including its rule that the per-mutant prediction table is pre-committed in a SEPARATE document
before the live run (Task A9).

**Reviewed by spec-adversary 2026-08-12 (15 adopted, 1 rejected).** The review returned 1 blocker,
8 major and 7 minor findings. Every one has a verdict below, and the three findings that make
factual claims about the compiler, identifier scope or hashing were checked against the source or
against a real `alc` compile before being acted on, per this repo's rule that a behavioural change is
never adopted on a reviewer's word.

1. **Adopted (blocker).** `Insert(true)` to `Insert(false)` manufactures PLATFORM kills on real code
   (a blank key from a skipped No. Series assignment, then a duplicate key or a missing record), and
   nothing screens them. The class is named in section 2.1, section 4 refuses the corresponding
   conclusion, and arm K measures it. Part (c), the screen gap itself, is filed as R138 by the
   controller and cited here rather than re-argued.
2. **Adopted (major).** The tombstone makes the new table's `OnDelete` a unique-key write, so
   section 3.3 rule 6 now names the delete flag and the tombstone row explicitly.
3. **REJECTED (major), on measurement.** The finding rests on "`Validate`'s value parameter is `Any`,
   so it compiles where `:=` does not". Eight offline `alc` compiles measured the opposite: the
   compiler type-checks argument 2 against the field's type (AL0193), two of the finding's own three
   examples do not compile in the `Validate` form either, and the one shape where the forms differ
   compiles in both. No fifth guard. The section 5 row is rewritten to record what was measured,
   which is a compile-safety argument the first draft did not have.
4. **Adopted (major).** The implicit-receiver form now emits `Rec.F := V` rather than `F := V`, so
   the assignment cannot bind to a local, parameter or global that shares a field's name. Legality in
   all four contexts that carry an implicit `Rec` was measured, not assumed. This is the one adoption
   that changes an operator's specified behaviour.
5. **Adopted (major).** `astSubtreeHash` canonicalises identifier TEXT to a scope-relative index, so
   `Insert` and `Delete`, and `FindFirst` and `FindLast`, hash identically and same-codeunit arms
   collapse into one baseline key. Verified in the hashing source. Section 4 now routes the
   per-mutant review through `report.mutants` and Task A10 gains four durable assertions.
6. **Adopted (major).** The decoy's sort direction is now stated per arm, not just for arm E.
7. **Adopted (major), the stronger option.** Arm F drops its `SetRange` entirely, which removes an
   equivalent-by-construction collateral instead of documenting an exemption for it.
8. **Adopted (major).** The minor bump has TWO edit sites and the manifest carries the one section
   2.1 relied on, so both are named and Task A3 adds an invariant test over every registered operator.
9. **Adopted (major).** The conformance runner builds a ONE-FILE context, so a shadowing refusal test
   written that way passes for the wrong reason. Section 2.5 now requires a project-wide context and a
   shadowing red-check per new method name.
10. **Adopted (minor).** The stated mechanism for `untargetedTriggerCount` staying 0 was wrong and is
    corrected, and section 4 item 1 drops to "measured once already, re-checked here".
11. **Adopted (minor).** Arms B and C must CONSUME the read-back's return value.
12. **Adopted (minor).** The stale `tableextension`/`pageextension` line in the operator's doc
    comment gets fixed in the same edit.
13. **Adopted (minor).** One spelling for one node kind, glossed once.
14. **Adopted (minor).** The registry test, `fixtures/README.md` and CLAUDE.md are named as edit
    sites in the preflight, with their owning tasks.
15. **Adopted (minor).** Section 3.4 now says where an arm-J mis-claim actually lands.
16. **Adopted (minor).** The key-length invariant is numeric.

Four free strengthenings the review offered are also taken, marked "measured by the review" where
they appear: the target fixture's census of all six shapes, the non-zero constraint that
`return-value` imposes on every arm's asserted value, the `swap-call-arguments` compile-safety at the
`SetRange` sites, and the coverage precedent in section 4 item 1.

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

**Measured for this document with real offline `alc` compiles, 2026-08-12, twice, and both rounds
closed a hazard rather than adding a guard.** The `validate-to-assign` operator rewrites a call into
an assignment, so a shape that accepts `Validate(F, V)` but refuses `F := V` would produce a mutant
that fails to compile and poisons its whole batch. Two candidate causes were probed against a
scratch copy of `fixtures/sandbox-data`, and the repo working tree was never touched.

- **Field kind.** A FlowField two-argument `Validate`, a FlowField assignment, the normal-field
  control, and a FlowField single-argument `Validate`: all four exit 0 with zero diagnostics. A
  FlowField is not a counterexample.
- **Value type, the axis the A2 review said was the real one.** The review's claim was that
  `Validate`'s value parameter is `Any` and therefore unchecked at compile time, while `:=` is
  statically checked. Eight compiles, four shapes in both forms, measured the opposite. The compiler
  DOES type-check the value against the field's type inside the call, and reports
  `AL0193: Argument 2: cannot convert from 'Text' to the type of Argument 1 'Decimal'`. Text into a
  Decimal field and Text into a Date field fail in BOTH forms, the call form failing one step earlier
  than the assignment's `AL0122`. A Variant value compiles in both. The single shape where the two
  forms differ at all is an Integer into an Enum field, where BOTH compile and only the assignment
  earns the `AL0603` implicit-conversion WARNING, and the artifact compiler passes no
  warnings-as-errors flag and fails only on a non-zero exit code, so a warning cannot fail a batch.

Together those give the operator a compile-safety argument rather than a hope, in the same form R82
used for argument swaps: **if the `Validate` call compiles, its value argument is already convertible
to the field's declared type, so the assignment compiles too.** What the probes do NOT clear is
recorded in section 5.

**Also measured, for the implicit-receiver decision in section 2.3**: `Rec.<field> := <value>`
compiles with zero diagnostics in all four contexts that carry an implicit `Rec` in this product's
rules, namely a table's own procedure, one of its field `OnValidate` triggers, a `tableextension`
procedure, and a `page` procedure with a `SourceTable`.

**Measured for this document as well**: `fixtures/sandbox-app` contains zero sites for all three
operators. A case-insensitive search of that fixture for `FindFirst`, `FindLast`, `Validate(`,
`Insert(true)`, `Delete(true)` and `SetFilter` returns nothing. So `itest:bcdev`, `itest:alrunner`
and `itest:envtool` must come back UNCHANGED, and any movement in them is a finding about the
operators' claiming rather than about the fixture.

**And the same census of the TARGET fixture, which is stronger than "no existing mutant moves"**
(measured by the A2 review and re-run here): `fixtures/sandbox-data` today holds zero `FindFirst`,
zero `FindLast`, zero `FindSet`, zero `Insert(true)`, zero `Delete(true)`, and zero `Validate` CALLS,
its six `Validate` hits all being `trigger OnValidate()` declarations. So every mutant these three
operators produce in the tables gate is genuinely NEW, and the fixture's existing negative shapes
(`Insert(false)`, `Delete(false)`, `Modify(RunTrigger)` and the zero-argument `Modify()`) stay
refused and keep their meaning.

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

**THE BUMP HAS TWO EDIT SITES AND ONLY ONE OF THEM REACHES THE MANIFEST.** Every operator in this
product declares its version twice: the `version` field on the operator object, and a hard-coded
`operatorVersion` literal inside its own `generate()`. The string that reaches
`MutantManifestEntry.operatorVersion`, and therefore the provenance the paragraph above leans on, is
the LITERAL, not the field. Bump only the field and the manifest keeps saying 1.0.0 while nothing
fails: the registry test checks only that the field matches a semver shape, and no test anywhere
compares an operator's declared version against the version its `generate()` emits. So Task A3 must
edit BOTH sites, and it must add one invariant test over `tier1Operators` and `tier2Operators`
asserting that every generated spec carries `operatorVersion` equal to its operator's own `version`.
That test is worth having for all twelve operators, not just this one, because every one of them
hard-codes the pair independently. Deriving the literal from a module-level constant in this operator
is the better fix and is preferred where it is a small edit.

**The name stays `lethal.swap-modify-flag`** even though it now covers three methods. A rename moves
`operatorName`, which IS part of the identity key, so it costs exactly the re-key the minor bump
avoids. The doc comment carries the explanation: the name is historical, the coverage is the three
record methods that take a run-trigger flag.

**Limits, inherited and unchanged.** The mutant is only observable when the table's `OnInsert`,
`OnModify` or `OnDelete` does something a test asserts. The semantic layer cannot see base-app
triggers, so an equivalent mutant on a base-app record cannot be hinted away. A `tableextension`'s
implicit `Rec` resolves to the extended table and IS claimed; a `pageextension`'s is refused. The
parenthesis-less call form (`Rec.Insert;`) never reaches the predicate and is silently not claimed,
because it parses as a `field_access` node rather than a call.

**One term, one spelling, glossed once.** `ALNodeKind.field_access` is the kind whose grammar name is
`member_expression`. They are the same node, and this document says `field_access` everywhere. An
implementer who reads the two names as two kinds will add a second branch for a node that does not
exist.

**The doc comment being edited for the historical name carries a stale line, and it gets fixed in the
same edit.** It currently claims no site inside a `tableextension` or `pageextension` is ever claimed,
which R30 made false: both kinds are admitted as enclosing objects, and only a `pageextension`'s
implicit `Rec` is refused. Leaving a false limit in place next to a freshly written explanation is how
the next reader builds on it.

**THE PLATFORM-KILL CLASS, which is this operator's sharpest hazard on real code and was absent from
the first draft.** The limits above describe the SURVIVOR direction. The dangerous direction is a kill
the suite did not earn. The most common real shape for `Insert(true)` in BC is a table whose
`OnInsert` assigns the primary key, typically from a No. Series. With `Insert(false)` the trigger does
not run, the key stays blank, and one of two things happens. Insert the same shape twice and the
second insert raises a duplicate primary key. Insert once and the caller's next `Get` or `Modify` on
the expected key raises "the record does not exist". Either way the test dies on a platform error
before any assertion is evaluated, and the mutant is scored `killed`.

That is the R82 arm E class, it is why R86 exists, and **nothing screens it**: the
`platformArtifactKills` screen tags only the write-transaction mechanism `remove-commit` reports, so
these kills arrive looking like assertion kills. The screen gap is filed as **R138** and is not
re-argued here. What this spec owes is that the class is named (here), that the conclusion it forbids
is refused (section 4), and that the fixture MEASURES it rather than leaving it as prose (arm K).
On this fixture the ordinary arms are safe from it because they assign their own keys, which is
exactly why a dedicated arm is needed to see it at all.

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

**This operator does not manufacture the platform kills section 2.1 warns about, and that is worth
recording as a positive.** `FindFirst` and `FindLast` return the same found-or-not-found answer over
the same filtered set, so the swap can never turn a found into a not-found and can never raise at the
site where the original did not. Only which ROW is loaded changes. The review stated this as the
operator being free of the class outright, and that goes one step too far to be worth asserting: a
DIFFERENT row carries different DATA, so a downstream statement can still raise on it, which is
precisely the R82 arm E mechanism one statement later. The honest form is the one this spec keeps: the
swap adds no error at its own site, and a downstream platform error caused by the other row's data
remains possible and would be diagnosed as arm E was. `Delete(true)` to `Delete(false)` is similarly
mild, because skipping `OnDelete` removes work rather than adding a write, unless that trigger is what
maintains something a later statement depends on.

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
**`Rec.F := V`, always qualified** (amended after review, see below). The mutant deletes the
`OnValidate` trigger chain while leaving the field value correct, which is a BC-specific bug class
nothing else in the product models. The tables fixture already holds `OnValidate` sites whose mutants
are killed, so the kill path is established rather than hoped for.

**Why the implicit form emits `Rec.` rather than a bare field name.** `Validate`'s first argument is
resolved in the record's FIELD scope. A bare assignment target is resolved in ordinary identifier
scope, which in this product's own receiver resolution means trigger local, then procedure local, then
parameter, then object global, and only then a field. So a bare `Level := V` inside a table procedure
that happens to declare a local named `Level` would assign the LOCAL, leave the field untouched, run no
`OnValidate`, and still compile and score normally. The mutant would then mean something different
from what this section says it means, and a survivor there would be uninterpretable.

Qualifying removes the ambiguity at no cost, and the cost part is measured rather than assumed:
`Rec.<field> := <value>` compiles clean in all four contexts where this product admits the implicit
form (see section 0). What is NOT settled here is the underlying binding question, namely which
declaration `Validate`'s own first argument binds to when a local shadows a field. A compile cannot
answer it, since both spellings compile when the types agree; a runtime probe on a deliberately
shadowed name would, and that shape is pathological enough that nobody should write it. The
qualification is adopted because it is correct under EITHER answer, which is a better reason than
knowing the answer.

**Compile safety, which the section 0 typing measurement now supports directly.** If the original
`Validate(F, V)` call compiles, the compiler has already checked that `V` converts to `F`'s declared
type, and it reports `AL0193` when it does not. So the assignment the operator emits compiles wherever
the call it replaces compiled. The one measured asymmetry is a warning, not an error (an Integer into
an Enum field earns `AL0603` on the assignment), and the artifact compiler fails on a non-zero exit
code only. This is the same shape of argument R82 made for argument swaps: a narrow claim about
compile-safety, and nothing more.

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
verbatim text. The prefix is the call's own text up to the start of the method-name node for a
qualified call, and the literal `Rec.` for the implicit form. Because the text is assembled rather
than spliced, trivia BETWEEN the arguments is dropped: `Validate(Level, X /* why */)` yields
`Rec.Level := X`. That cannot change behaviour, and the emitted branch is machine-generated AL that
nobody reads for its comments, so it is accepted. It is stated because it is the one respect in which
this operator differs from every other rewrite in the product, all of which preserve interstitial
text.

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
  operator package the trio is about to be added to. It is filed as **R137** and is not this wave's
  work to fix, but it IS the pattern this wave must not copy. Every refusal in section 5 that belongs
  to one of these three operators gets a unit test that asserts the generated spec list is empty.
- **A refusal test whose semantic context is too NARROW passes for the wrong reason too, one layer
  down.** The conformance runner builds a ONE-FILE context, and `claimsRecordMethod`'s
  project-declared-procedure rule can only fire over a project-wide context, which its own contract
  block in `receiver.ts` states. So a test for "a table that declares its own `Insert` refuses the
  site" written against a single-file context produces an empty spec list because the GUARD NEVER RAN,
  and it would keep passing if the guard were deleted. Every shadowing refusal test therefore builds a
  multi-file project context, using the `projectContextFor` helper the Tier-2 test plumbing already
  exports for exactly this. This matters concretely: the trio puts four new method names
  (`Insert`, `Delete`, `FindFirst`, `FindLast`) plus `Validate` onto that rule's surface, and the
  fixture's own shadowing negative covers only `SetRange` and `TestField`.
- **Every guard gets a red-check**: revert the guard, name the specific test that goes red, restore,
  confirm green, and report both outputs. The guards that must each have their own red-check are the
  three-method claim (2.1), the zero-argument guard and the receiver-proof dependency (2.2), the
  two-argument and field-identifier guards (2.3), and **one shadowing refusal per new method name**,
  each over a project-wide context per the bullet above. The version invariant test from section 2.1
  is red-checked the same way: revert one operator's `generate()` literal and it must go red.

## 3. The fixture arms

All arms live in `fixtures/sandbox-data`, which feeds ONE frozen gate. `fixtures/sandbox-app` feeds
three and is not touched, which section 0 measured rather than assumed.

### 3.1 What is added

One shared table, `table 79330 "Data Trigger Probe"`, three arm codeunits, `codeunit 79314 "Data Flag
Ops"`, `codeunit 79315 "Data Find Ops"` and `codeunit 79316 "Data Validate Ops"`, and one small
second table, `table 79331 "Data Key Probe"`, which exists only for arm K. All five ids are free: the
fixture's existing objects are tables 79300 to 79303 and 79309, codeunits 79304 to 79308 and 79311 to
79313, page 79320, pageextension 79321, tableextension 79322 and pages 79323 and 79324, with codeunit
79310 being `Data Tests` in the test app. The declared id range is 79197 to 79199 plus 79300 to 79399.

`Data Key Probe` is separate rather than folded into the shared table on purpose. Arm K needs an
`OnInsert` that assigns the PRIMARY KEY when it is blank, and putting that behaviour on the shared
table would couple arms A, B and C to it: the collateral `negate-conditional` mutant on the
key-blank test would then overwrite the keys those arms pass in, and their verdicts would depend on a
mutant in another arm's trigger. One extra table object is cheaper than that coupling.

The table carries what the three operators need to be observable, and nothing else:

- an `OnInsert` trigger that sets a Boolean field, so skipping the insert trigger is observable;
- an `OnDelete` trigger that inserts a tombstone row with a `TOMB-` key prefix, so skipping the
  delete trigger is observable;
- a `Level` field whose `OnValidate` doubles it into a companion field `Level Doubled`, so skipping
  the validate chain is observable while the field value itself stays correct;
- a small public procedure that calls `Validate` with an IMPLICIT receiver, which is the only way to
  measure that emit path live (arm I).

**The key-length invariant, as arithmetic rather than as advice: every `"No."` written to
`Data Trigger Probe` anywhere in the suite is at most 15 characters, because `'TOMB-'` is 5 and the
field is `Code[20]`.** R82 arm E is the standing precedent for why this is an invariant and not a
style note: a length overflow produces a kill under a test that asserts nothing, so a 16-character key
would manufacture a false kill in whichever arm happened to hold it.

### 3.2 The arms

| arm | shape | what it is for | predicted verdict |
|---|---|---|---|
| **A** | `Data Flag Ops.InsertWithTrigger`: set the key, `Probe.Insert(true)`, return the trigger-set Boolean; the test asserts it is true | the KILL for the `Insert` half of the extension. `Insert(false)` skips `OnInsert`, the field stays false, the assertion fails | killed |
| **B** | `Data Flag Ops.InsertCounted`: same `Insert(true)`, then `exit(Probe.Get(No))` with the return value CONSUMED; the test asserts only that a row landed | the SURVIVOR for the `Insert` half, and the first same-span discriminating pair: the flag swap survives while `void-method-call` at the same span kills, because with no insert there is no row | survived |
| **C** | `Data Flag Ops.DeleteWithTrigger`: set the key, `Probe.Delete(true)`, then `exit(Tomb.Get('TOMB-' + No))` with the return value CONSUMED; the row is inserted by the TEST | the KILL for the `Delete` half. `Delete(false)` skips `OnDelete`, no tombstone appears, the assertion fails | killed |
| **D** | `Data Find Ops.FirstLevelInRange`: `SetRange` on the key, `if Probe.FindFirst() then exit(Probe.Level)`; the test seeds two in-range rows with distinct Levels plus one out-of-range decoy, and asserts the LOW Level | the KILL for `FindFirst` to `FindLast`, in EXPRESSION position (the call is an `if` condition). The decoy is what makes the collateral `remove-setrange` mutant deterministically killable | killed |
| **E** | `Data Find Ops.LastLevelInRange`: the same shape with `FindLast`, two in-range rows and a decoy sorting AFTER the range; the test asserts the HIGH Level | the KILL for the other direction. Both directions are measured live, which is what proposal 2's "both directions" is worth | killed |
| **F** | `Data Find Ops.AnyRow`: `exit(Probe.FindFirst())` and NOTHING ELSE, no filter and no parameters; the test seeds one row and asserts only that something was found | the EQUIVALENT-to-this-suite SURVIVOR. An existence-only assertion cannot see a direction reversal, which is exactly the limit section 2.2 documents. Also the second expression-position shape (inside an `exit`). The `SetRange` the first draft gave this arm is DELETED: removing a filter cannot change an existence answer while an in-range row is present, so its `remove-setrange` collateral was equivalent by construction and would have been read as a fixture defect. Dropping it also removes a `swap-call-arguments` collateral and two parameters | survived |
| **G** | `Data Validate Ops.SetLevel`: `Probe.Validate("Level", NewLevel)` in statement position, return `Probe."Level Doubled"`; the test asserts the doubled value | the KILL for `validate-to-assign`, with a QUOTED field identifier. The assignment skips `OnValidate`, the companion field stays 0, the assertion fails | killed |
| **H** | `Data Validate Ops.SetLevelWeak`: the same call, but return `Probe."Level"`; the test asserts the field value | the SURVIVOR, and the sharpest arm in the wave: the field ends up CORRECT, so the assertion passes, while `void-method-call` at the same span kills because the field stays 0. Same span, two mutants, two different verdicts, and a bug class Tier 1 cannot express | survived |
| **I** | the table's own public procedure calling `Validate("Level", V)` with no receiver, called directly from a test that asserts the doubled value | the IMPLICIT-receiver emit path, a distinct branch of `generate()`: after the review's finding 4 it emits the SYNTHESISED prefix `Rec.`, so this arm is what proves live that `Rec."Level" := V` compiles, deploys and scores inside a table object. Also a Tier-2 mutant sited in a `table` rather than a codeunit | killed |
| **J** | `Data Validate Ops.TouchLevel`: assign `"Level"` by hand, then `Probe.Validate("Level")`, single argument, and return the doubled value | the REFUSAL negative, the R82 arm F role. `validate-to-assign` must emit NOTHING here. If it ever claims the site, the after text is a truncated assignment, `alc` rejects the artifact, and the gate fails loudly instead of silently scoring a wrong mutant. The site keeps its Tier-1 `void-method-call` mutant, whose verdict is pinned | no `validate-to-assign` mutant; the deletion at that span is killed |
| **K** | `Data Flag Ops.InsertTwiceWithKeyTrigger`: a two-iteration `for` loop whose body is `KeyProbe.Init(); KeyProbe.Insert(true);` against `table 79331 "Data Key Probe"`, whose `OnInsert` assigns `"No."` from a row count when it is blank; the covering test asserts NOTHING | this operator's own R82 arm E, and the reason the review blocked the first draft. Exactly one mutant is active per run, so a single `Insert(false)` executed TWICE is what produces the duplicate: the trigger never runs, the key stays blank both times, and the second insert raises. The kill therefore cannot have come from an assertion, because the test makes none. Its control is the `empty-block` mutant on the loop body, which must SURVIVE for that same reason | killed, by a platform error, and tagged by NO screen (R138) |

### 3.3 Rules the arms obey, each with its reason

1. **Coverage filtering isolates arms, so every row a mutant's verdict depends on must be seeded by
   that mutant's OWN covering test.** A mutant runs only against the tests coverage attributes to
   it, and these arms are ordinary public procedures, so member-level attribution should give each
   arm just its own test. Relying on rows another arm's test inserts would make a verdict depend on
   which tests happened to run. **This is the amendment to proposal 5**: the plan's find arms seeded
   only in-range rows, which leaves the collateral `remove-setrange` mutant at each of those sites
   surviving or killing depending on rows that may not exist when it runs. Each find arm's test now
   seeds one out-of-range decoy as well, which is also what R136's own text asked for.
   **The decoy's SORT DIRECTION is part of the rule, not a detail:** it sorts BEFORE the filtered range
   for a `FindFirst` arm and AFTER it for a `FindLast` arm, and its `Level` differs from the asserted
   value. Get that backwards and the unfiltered read still returns the same row, the collateral
   survives, and the arm's whole point is lost. For arm D that means keys ordered decoy, then the two
   in-range rows; for arm E, the two in-range rows, then the decoy.
2. **Reserve Level values per arm**, never reuse an asserted value on another key in this table, and
   **make every asserted value NON-ZERO** (measured by the review, and confirmed in the operator
   source): `return-value` rewrites an Integer `exit(X)` to `exit(0)` and a Boolean `exit(X)` to
   `exit(not (X))`, and it deliberately skips a site that is already `exit(0)`. So an arm that asserts
   0 has an unkillable collateral, and an arm that asserts a Boolean must assert `true`. That way no
   collateral mutant's verdict can hinge on which other rows exist, and none is equivalent by accident.
3. **Statements in the test app are free; statements in the target app are not.** The gate generates
   mutants from `fixtures/sandbox-data` only, so defensive setup, delete-before-insert idempotence
   and row seeding all belong in `Data Tests`, where they cost nothing. Every extra statement in an
   arm codeunit is another mutant somebody must pre-commit a verdict for, so arm bodies stay
   minimal. Concretely: arms G, H, I and J need no rows at all, because `Validate` runs `OnValidate`
   against the in-memory record with no database row involved, and dropping the insert and modify
   calls the plan sketched removes four collateral mutants and every duplicate-key concern from those
   arms. That AL behaviour is not assumed here: the fixture already relies on it twice, in
   `Data Tests.BlankNoValidateFails` and `Data Tests.NoTriggerValidateRunsWeak`, both of which
   `Validate` a freshly declared record variable that was never inserted and both of which reach the
   trigger. Those two tests are also the standing evidence that the arms below will behave the same
   way.
4. **Setup calls inside the target use the non-claimable spellings.** `Insert(false)` and
   `Modify(false)` are not claimed by `swap-modify-flag`, so an arm carries only the mutant it is
   about. A plain assignment in an arm codeunit is free, because no operator targets an assignment
   statement. **The table's own trigger bodies are NOT free in the same way.** `lethal.swap-rec-xrec`
   claims a `Rec`-qualified or `xRec`-qualified READ inside a field `OnValidate` or a table
   `OnRename`, so writing the doubling trigger as `Rec."Level Doubled" := Rec."Level" * 2;` would
   create a `swap-rec-xrec` mutant on the right-hand side, while the unqualified spelling
   `"Level Doubled" := "Level" * 2;` creates none. Write the unqualified form, and do not "improve"
   it by adding receivers.
5. **Every new test raises through bare `Error(...)`.** The tables gate asserts that the R121
   assertion screen reports itself as `vacuous` on this fixture, which is true precisely because no
   test here uses an assertion library. A new test that used one would change what that gate proves.
6. **Seeding is idempotent** (read, delete if present, then insert), matching the existing fixture.
   The reason is arm independence and residue from an aborted run, NOT that the fence commits
   between runs: R32 measured that platform test isolation rolls these writes back, and the fixture
   already carries a comment correcting the earlier wrong explanation.
7. **`OnDelete` writes a UNIQUE KEY, so which delete flag the SEEDING uses is a rule, not a
   preference.** The tombstone insert means running `OnDelete` twice for the same key raises a
   duplicate primary key. Left unstated, this is what happens: residue from an aborted run leaves
   `Data Trigger Probe` row X present, the seeding delete runs `Delete(true)`, the tombstone for X
   appears, the test then inserts X and calls arm C, arm C's `Delete(true)` fires `OnDelete` again, the
   second tombstone insert raises, and whichever mutant was active is scored `killed`. The baseline
   would catch it, but the reader's diagnosis would be "the fixture is dirty" rather than "the arm
   design put a unique-key write inside a trigger". So: **every delete of a `Data Trigger Probe` row
   anywhere in the suite uses `Delete(false)`, seeding deletes the TOMBSTONE row as well as the arm's
   own row, and arm C is the only code in the fixture allowed to run `OnDelete`.**

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
- **No new kill is screened, and arm K is now the fixture's measured statement of that.** The
  `platformArtifactKills` screen tags only the write-transaction mechanism `remove-commit` reports, so
  the gate's screened-kill count stays 1 even though arm K's kill is a platform artifact by
  construction. That is the screen's gap, filed as **R138**, not a number to edit here. Arm K's own
  comment must say it, so the next reader of the report is not left to infer it.
- **Where an arm-J mis-claim actually lands, since "the gate fails loudly" is true but not a shape.**
  A truncated assignment makes `alc` reject the artifact, which surfaces as `AlcCompileError`, then
  bisection isolates the culprit, and every mutant in that shard is recorded `error`. So it appears as
  an aggregate counts mismatch plus `errorClass` rows in the per-mutant baseline diff, never as a
  compiler message in the gate's own output. Knowing that is what keeps the failure from being read as
  a flaky run.

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
  they must be;
- **anything about assertion quality behind an `Insert` kill on real code.** This is the blocker
  finding's conclusion and it is refused outright. On a table whose `OnInsert` assigns the primary
  key, `Insert(false)` kills through the platform rather than through any assertion (section 2.1), and
  no screen separates the two (R138). A report may say the mutant was killed; it may not say the suite
  caught it. Arm K is the fixture's demonstration that the two are different, not a licence to read
  every `Insert` kill as either one.

**How the per-mutant review must be done, because the frozen key cannot tell these arms apart.** This
is a requirement on Tasks A9 and A10, not an observation. `astSubtreeHash` canonicalises every
identifier's TEXT to a scope-relative index, which the hashing source confirms, and a method name in a
qualified call is an identifier. So `Probe.Insert(true)` and `Probe.Delete(true)` hash IDENTICALLY, as
do `Probe.FindFirst()` and `Probe.FindLast()`, and the key carries no file, procedure or site text.
Arms A, B and K collapse into one key for `lethal.swap-modify-flag`; arms D, E and F into one for
`lethal.swap-find-direction`; arms G and H into one for `lethal.validate-to-assign` and another for
`lethal.void-method-call`. Detection still mostly works, because `diffMutants` compares per-key
MULTISETS including the killing test and each arm has its own covering test, so a lost or swapped
verdict shows up as a group-size or killing-test change. But two things follow:

1. **The per-mutant review reads `report.mutants`, not baseline rows.** `MutantOutcome` carries `file`,
   `line`, `procedureName`, `originalText`, `mutatedText`, `coveringTests` and
   `platformKillMechanism`; a baseline row carries none of them, and a survivor's killing test is null,
   so the collapsed groups cannot be disambiguated from the baseline file at all.
2. **Task A10 adds four durable gate assertions**, in the style of the existing trigger-attribution
   check, pinning exactly what the key cannot: a `killed` `lethal.swap-modify-flag` mutant whose
   `originalText` contains `Insert(true)`, another whose `originalText` contains `Delete(true)`, a
   `killed` `lethal.swap-find-direction` mutant whose `mutatedText` contains `FindLast`, and another
   whose `mutatedText` contains `FindFirst`. Without them, section 4's per-arm conclusions are earned
   once by a human reading one run's output and never re-checked by anything.

**The ways this is most likely to be WRONG, named in advance so none can be reinterpreted
afterwards:**

1. **Attribution, not verdicts, and this one is weaker than the first draft claimed.** Arm I sites a
   mutant in a table PROCEDURE, which needs a member-level coverage entry where a trigger needs only
   object-level credit. `DataMain.Table.al` records that distinction as MEASURED, and this fixture's
   existing table procedures already attribute, so the honest framing is "already measured once,
   re-checked here" rather than a leading risk. If arm I still arrives `no-coverage`, that is a
   coverage finding, reported as one, not absorbed by moving the arm into a trigger.
2. **Arm H may kill instead of survive.** The prediction is that assigning the field without running
   `OnValidate` leaves the field value correct and the test blind. If the platform runs any
   validation on a plain field assignment, the value could differ and the mutant would be killed.
   Either result is a finding: the first is the bug class the operator exists for, the second would
   retire a premise this spec asserts.
3. **Arm F may kill.** If anything in the seeded data makes the existence answer differ between
   directions, the survivor becomes a kill and the arm stops demonstrating the equivalence class.
   That means the arm's data was not as neutral as designed and the arm needs fixing before the
   claim is made.
4. **A `remove-setrange` collateral may survive** in arm D or arm E if the decoy discipline in rule 1,
   including its sort direction, is not implemented exactly. There that is a fixture defect, and the
   honest response is to fix the fixture and re-pre-commit rather than accept the survivor. **This item
   applies to arms D and E only.** Arm F no longer has a `SetRange` at all, precisely so that no
   correct-but-equivalent survivor here can be mistaken for a defect and "fixed" by strengthening the
   assertion that makes arm F an equivalence-class arm in the first place.

**Gate deltas expected**: the tables gate grows in `totalMutantSites`, `killed` and `survived`;
`platformArtifactKills` stays 1; `assertionScreenDiscrimination` stays `vacuous`;
`untargetedTriggerCount` stays 0. The first draft gave the wrong mechanism for that, so here is the
right one: the fallback that keeps the count at 0 consumes a NON-EMPTY object-level coverage entry for
the table, which requires BC to report an observation against that object during a GREEN BASELINE test.
A test can exercise a trigger and still contribute nothing, if the observation is not reported or not
keyed to the object. "Every trigger has a test" is necessary and not sufficient. The precedent that it
does work on this fixture is `Data No Trigger`, whose only route in is a `Validate` on a never-inserted
record and which sits in the gate today with the count at 0. A non-zero value is a finding about
attribution, and the gate's own comment already says it must be explained before the number is edited.
The one permitted baseline failure stays exactly `Data Tests.PageActionComputesNonZero`, by name.

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
| a fifth guard requiring the value argument's type to equal the field's declared type | **REFUSED on measurement, and this is the A2 review's one rejected finding** | the demand rested on `Validate`'s value parameter being `Any` and therefore unchecked at compile time. Eight offline compiles measured the opposite (section 0): the compiler checks argument 2 against the field's type and reports `AL0193`, and two of the finding's three examples fail in the CALL form too, so they are not sites this operator can ever see. Wherever the call compiles, the assignment compiles. A type guard would refuse safe sites to prevent a failure measured not to occur, and it would need `ctx.types` to answer for base-app fields, which a source-derived type table cannot |
| an Integer value assigned into an Enum field | **accepted, recorded** | the single measured asymmetry between the two forms. Both compile; only the assignment earns the `AL0603` implicit-conversion WARNING. The artifact compiler passes no warnings-as-errors flag and fails only on a non-zero exit code, so this cannot fail a batch. It does mean a campaign's build output can carry `AL0603` lines the original source did not, which is noise rather than a defect |
| field kinds and value shapes beyond the five measured | **residual risk, recorded, not cleared** | the probes covered a FlowField in both forms plus four value shapes (Text into Decimal, Integer into Enum, Variant into Decimal, Text into Date). A FlowFilter field, or a kind nobody has thought of, could still differ. What would settle it is the same compile recipe with more kinds added, and it is cheap. Until then the exposure is limited to real projects, because this fixture's fields are all normal, and the failure mode is the safe one: `AlcCompileError`, then bisection, then `error` verdicts for that shard, never a mis-scored kill |

## 6. Ratification log against the plan's six proposals

| proposal | decision | what changed |
|---|---|---|
| 1. extend `swap-modify-flag` to `Insert`/`Delete`, direction unchanged, MINOR bump to 1.1.0, name kept | **ratified as written** | nothing. Section 2.1 adds the four-fact verification chain behind the MINOR claim and states the provenance cost the choice accepts |
| 2. new `lethal.swap-find-direction`, both directions, zero-argument guard, not statement-restricted | **ratified, mechanics amended** | the method-name span comes from a shared accessor exported by `receiver.ts`, not from a re-derived "last identifier before the argument list" heuristic |
| 3. new `lethal.validate-to-assign` with four guards | **ratified, mechanics amended** | the argument accessor takes an exact count instead of an index, so trivia cannot be mistaken for an argument, and `soleArgument` keeps its behaviour; the receiver prefix uses the same shared name-node accessor; the rebuild's trivia loss is stated; the statement-position guard's cost is named with a way to measure it. After review, the implicit-receiver form emits `Rec.F := V` rather than a bare `F := V`, which is the only change in this pass to what an operator EMITS |
| 4. dedup interplay: all three coexist with `void-method-call`, none displaces a Tier-1 mutant | **ratified, strengthened** | two arms are designed so a same-span pair carries DIFFERENT verdicts, which no aggregate can fake; and the one displacement the census will show at the `SetRange` sites is named in advance as pre-existing |
| 5. the fixture arms table | **ratified, amended** | each find arm's test seeds an out-of-range decoy with its sort direction specified, because coverage filtering means only that arm's own tests run; Level values are reserved per arm and must be non-zero; the validate arms drop their insert and modify calls, which removes four collateral mutants and all key handling from them; arm F drops its `SetRange`; three arms are added, the implicit-receiver arm I, the refusal negative arm J, and the platform-kill arm K with its own small table |
| 6. refusals recorded | **ratified, one reason corrected** | the `FindSet` deferral stands, but the reason is now the two-statement emit shape and the non-local ascending state, not a property rewrite, because `Ascending` is a method |

## 7. Order of work, and the preflight that must not be skipped

Operators and fixture AL land in ONE freeze, per R82's reasoning: landing the fixture first would
move the frozen counts once for collateral Tier-1 mutants and again when the operators ship, and the
tables gate runs the whole session twice per invocation. The offline loop needs no live run.

Before the live gate:

1. `bun run typecheck`, then remove `packages/*/dist`, then `bun test`. **Three edit sites will fail
   the build or the gate if they are missed, so they belong here rather than in the wreckage of a
   two-run live gate.** The Tier-2 registry test asserts its operator list EXACTLY and in registration
   order, so both new operators must be appended there (Tasks A4 and A5). `fixtures/README.md` carries
   the tables fixture's frozen figures and arm inventory, and CLAUDE.md carries the `itest:tables`
   frozen line; both are updated with the new counts and the new arms (Task A10, alongside the gate's
   own `EXPECTED` block). The version invariant test from section 2.1 lands in Task A3.
2. `bun run compile:fixtures`. Nothing else compiles fixture AL, and a docs-only commit has already
   broken a fixture procedure while the gate stayed green for days (R56).
3. Census `fixtures/sandbox-app` and confirm its spec list is byte-for-byte unchanged, so the other
   three gates are untouched by measurement rather than by argument.
4. Census `fixtures/sandbox-data` before and after, and confirm the new keys are exactly the
   predicted ones, that no existing mutant moved, and that no NEW displacement of a Tier-1 mutant
   appeared beyond the pre-existing `SetRange` one.
5. Republish the target and test apps.
6. Add the four durable assertions section 4 requires, run the gate, re-record the baseline through the
   delete-and-rerun path only, REVIEW the per-mutant results against Task A9's table reading
   `report.mutants` rather than baseline rows (section 4 says why the rows cannot answer), then run the
   gate again so the new baseline compares against itself.

A differing verdict is a BLOCK, never "close enough". A contradicted prediction is a finding to
write down, not to erase.
