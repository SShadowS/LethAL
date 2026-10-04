# R-389: a Variant handed to another app's code can hold a test-app codeunit (short plan, r2)

Task: `/coord/tasks/R-389/task.md`. Item: `docs/roadmap/R389.md`. Branch `lethal/r389` (r1 was cut
at master 409ac537; the branch now also carries the live probe, ed343f09 / 6e9b20ed). To be
committed by the orchestrator as `docs/superpowers/plans/2026-10-04-R-389-variant-interface-reach.md`.
Line numbers are at 409ac537.

## Changes from r1

Review: `/coord/reviews/R-389-plan/claude-adversary-r1.md` (CHANGES REQUIRED; this is the last round).

1. **Hand-outs through a `var` parameter or a return value (review #1).** r1 read hand-outs only
   where a Variant is a call ARGUMENT (`argHolds`). A test-app procedure that other code CALLS can
   also hand a value back: a subscriber's `var Handler: Variant` set to a mock, a `var Impl:
   Interface I`, or `GetInner(): Interface I begin exit(InnerMock) end`. r2 adds "entry
   procedures" (procedures external code can call) and classifies every Variant, Interface,
   RecordRef or FieldRef `var` parameter and return value there with the same table. New section
   "Hand-outs from entry procedures"; new tests 8-11; probe extended and re-run.
2. **The wrong claims are corrected.** r1's "Interfaces are already safe today", "folded whole ...
   is complete" and "every test-app codeunit implementing I ... is complete" each missed the route
   above. They are restated below with the limit that makes them true.
3. **`this` outside a codeunit (review #2):** class c, the fallback. Reason in the table's notes.
4. **Open question 2 is answered** by the live probe (Cronus284, 6e9b20ed): external code DID run
   a Variant-held test-app codeunit, three ways. R-389 does not close as a ruling.
5. Found while drafting r2 (same direction, same fix): a `var` RecordRef or FieldRef parameter of
   a subscriber can carry a test-app record back (`RecRef.GetTable(TestRec)`), whose triggers the
   publisher can then fire. It takes the table fold, like a RecordRef argument does today.

Everything else in r1 is kept: the argument rule and its table, the safe fallback, the
no-scheme-bump ruling, the pins, the stop rule, and the build gate on DC / do-rel2.

## Problem

`lethal verify` decides whether a test is old or new by a per-test digest (R-371): a hash of the
test-app code the test can run. When a test hands a value to code in another app ("external
code"), that code can run test-app code the walk never sees. R-371's rule for that
(`Scanner.passesTestApp`, `argHolds`, testpage-scan.ts:1671-1758):

- a test-app codeunit, record, page, `this`, or an Interface variable handed out: the test takes
  the WHOLE-SOURCE digest (a hash of every `.al` file; called "the fallback" below);
- a Variant, RecordRef or FieldRef handed out: every test-app table is folded in (testpage-scan.ts:1726).

A Variant can also hold a test-app CODEUNIT. Nothing folds that codeunit, so an edit to it leaves
the digest unchanged and verify treats the test as old. That is the unsafe direction.

**Measured, not assumed.** The live probe (`scripts/r389-probe/`, run on Cronus284, BC 28.x,
2026-10-04) showed external code running a test-app codeunit it received in a Variant, with no
test-app code involved, three ways: `I := V as IExt` (R1c), `if V is IExt then` + cast (R1d), and
`Format(V)` (which returns the codeunit's object ID) then `Evaluate` then `Codeunit.Run(id)`
(R4d, not predicted). `Codeunit.Run(<integer id>)` on any id (S1) is filed separately as R431 and
is OUT of R-389's scope.

Found while drafting r1 (same direction, same fix): the table fold reads only a Variant that is a
plain NAME. A Variant reached as an element or a return (`L.Get(1)`, `Arr[i]`, `MakeVariant()`)
folds nothing at all today, not even the tables. R-389 covers these too.

Found in review r1 (same direction, same fix): a value can leave the test app by a second road. A
test-app procedure that external code CALLS can hand a value back through a `var` parameter or
its return value. Today nothing reads either:

- a subscriber `OnGetHandler(var Handler: Variant) begin Handler := Mock; end`, after which the
  publisher in the other app does `I := Handler as IExt` (live route R1c). `subscriberFold`
  (test-digest.ts:120-147) reaches only what the subscriber CALLS; `Handler := Mock` is no call.
- the same with `var Impl: Interface IExt; ... Impl := Mock`.
- `GetInner(): Interface I begin exit(InnerMock) end` in a codeunit external code can call.

**Correction of r1's interface line.** An Interface variable handed out as an ARGUMENT
(`holdsTestApp`, testpage-scan.ts:1847) and a call through one (case 12, :1952) already take the
fallback. An Interface handed back through a `var` parameter or a return value is NOT seen today.
r1 said "Interfaces are already safe today"; that was false for this route.

## The rule, part 1: argument hand-outs (unchanged from r1)

Read at the site where a Variant argument is handed to external or platform code: the same
place R-371 folds the tables (`argHolds`, case `name`). The table fold stays exactly as it is, for
every Variant, so no test whose Variant holds only records moves. On top of it, the walk traces
what the Variant can hold, INSIDE the procedure that hands it out:

| The Variant is ...                                                  | Class | What is added to the digest |
|---------------------------------------------------------------------|-------|-----------------------------|
| assigned from a Record, RecordRef or FieldRef, a value, a built-in's return, or never assigned | a / d | nothing (today's table fold) |
| assigned from a `Codeunit X` variable, X in the test app; or `this` in a codeunit | b | codeunit X, folded whole (as an entry, part 2) |
| assigned from an `Interface I` variable                             | bi    | every test-app codeunit that implements I, or an interface that extends I, folded whole (as entries) |
| assigned from a page, report, query or xmlport variable of a test-app object | bo | that object, entered (`enterObject`) |
| assigned from `this` in a page, table, report or any non-codeunit object | c | the fallback |
| assigned from another local Variant                                 | -     | trace that one, the same way (a cycle is "cannot see") |
| a PARAMETER of the procedure (by value or `var`)                    | c     | the fallback |
| a GLOBAL of the object                                              | c     | the fallback |
| a `foreach` loop variable, or assigned element-wise (`V[i] :=`)     | c     | the fallback |
| handed as an argument to a test-app procedure whose parameter there is `var` | c | the fallback |
| assigned from a call's return (a test-app procedure returning Variant), a collection element, or a shape the walk does not model | c | the fallback |
| an array or collection of Variant, or a Variant element or return handed out directly | c | the fallback |

**`this` outside a codeunit is class c (review #2), not class bo.** It is safe, and it is the
cheaper rule to get right: what a page or report instance in a Variant lets external code do has
not been measured (the probe measured codeunits only, and R4d showed a Variant's conversions can
surprise: `Format` gave the object ID), and the probes found zero such sites on any corpus here.
Entering the object (bo) would be a narrowing, to be measured first if a corpus ever shows the
shape is common.

"Folded whole" is what `foldImplementation` does today for an enum's implementation codeunit
(testpage-scan.ts:1796): every procedure and trigger of the codeunit, and everything they reach.
**Correction of r1's "complete" claim.** r1 said this is complete for what external code can run
on the instance. It is complete for the code the instance's OWN procedures run, but those
procedures can hand out more test-app code through a `var` parameter or a return value (review
r1 #1). So a codeunit folded whole is also an ENTRY: part 2 applies to each of its procedures, to
a fixpoint. With that, the claim holds: external code can only call the codeunit's own procedures
(it cannot name the test app's types), every value they hand back is classified, and `walkTest`
runs `foldIdTargets` afterwards, so ids named in the folded code are folded too.

Every class unions: a Variant assigned twice, once from a record and once from a mock codeunit,
folds the codeunit. A class the walk cannot place is "c". The answer is never "nothing" for a
value the walk cannot see.

**Interface variables.** An `Interface I` variable can hold only a codeunit that implements I
(or an interface that extends I). The test app's implementations are listed in the source:
`codeunit ... implements I, J` and `interface K extends I`. A dependency's implementations are
EXTERNAL, covered by the dependency fingerprint. So "every test-app codeunit implementing I,
transitively through `extends`" is the complete set of test-app codeunits such a variable can
HOLD. **Correction of r1:** r1 called this complete without qualification; what those codeunits
can hand out is covered only because each is folded as an entry (part 2). The name is matched
like any other reference (last dotted segment, every candidate). A name that is not one plain
name, or a test app with parse damage, falls back (the existing `outside` condition, :1919).

R-389 does NOT change the two ARGUMENT interface cases that already fall back (an Interface
variable handed out directly as an argument, and a call through one). Moving them to the
implementation fold is a narrowing, a different change (see Open questions). Keeping them means
no test outside R-389's reach moves.

## The rule, part 2: hand-outs from entry procedures (new in r2)

**Entry procedures** are the test-app procedures external code can CALL, as opposed to
procedures reached through a call the walk follows. They are exactly the roots a fold enters:

1. every `[EventSubscriber]` procedure (`subscriberFold`; into every digest);
2. every procedure and trigger of an enum's implementation codeunit (`foldImplementation`; into
   every digest);
3. every procedure and trigger of a codeunit a class b or bi folds (part 1, or part 2 itself), into
   the digest that folds it (per test, or every digest when the fold happens in the closure).

Not entries, with the reason: the other procedures of a subscriber codeunit (external code cannot
name the codeunit; if it receives an instance, that is a hand-out and case 3 applies); a codeunit
folded by `foldIdTargets` (by id, external code can only `Codeunit.Run` it, and `OnRun` has no
parameter or return value of these types); triggers of tables, pages, reports and extensions, and
the test codeunit's handler functions (their signatures are fixed by the platform and never
declare a Variant, Interface, RecordRef or FieldRef `var` parameter or return value). Applying the
check to every root is still allowed and costs nothing; the list says where it MATTERS.

In every entry procedure, each of these is a **hand-out**:

| Hand-out | Class | What is added |
|---|---|---|
| a `var` parameter or a return value of type `Interface I` (or a list of Interface I) | bi | every test-app implementation of I, transitively, folded whole as entries. No tracing: the type alone bounds what it can hold. |
| a `var` parameter or a return value of type Variant | traced | what is assigned to it in the procedure, and for a return also every `exit(<value>)` and every assignment to a named return value, classified with part 1's table. Being the procedure's own parameter is NOT class c here (it is the thing being traced); every other row stands, so `Handler := OtherParam`, `Handler := SomeGlobal`, `Fill(Handler)` into a test-app `var` parameter, or `Handler := MakeVariant()` still fall back. Never assigned: nothing. |
| a `var` parameter or a return value of type RecordRef or FieldRef | a | the table fold (`foldTables`), as for a RecordRef argument |
| an array or collection of Variant, as a `var` parameter or a return | c | the fallback |

By-value parameters are inputs, not hand-outs: an assignment to one is not seen by the caller.

The examples from the review, under the rule: `OnGetHandler(var Handler: Variant) ... Handler :=
Mock` is class b (fold Mock, into every digest, since a subscriber is in the closure); `var Impl:
Interface I` is class bi; `GetInner(): Interface I begin exit(InnerMock) end` in an entry is class
bi (fold I's implementations, InnerMock among them).

The fold is to a fixpoint and terminates: each codeunit is entered as an entry once per
`ReachState`, and there are finitely many. A class c anywhere in the closure's entries puts EVERY
test on the fallback; that is the stop rule's second trigger, unchanged.

## The fallback, and why it is the safe minimum

For class c the choices were:

1. **The existing table fold only.** Not safe: that is today's bug.
2. **Fold every test-app codeunit** (plus the table fold). Exact only if a Variant can hold nothing
   but records and codeunits. That is a claim about Business Central nobody has measured here,
   and on a real test app most of the source IS codeunits, so it buys little.
3. **The whole-source digest** (`fallBack`, the path every other "cannot see" edge already takes).
   Safe whatever a Variant can hold. Its cost is already reported (the `fallback` reason), and
   the probe below found ZERO class-c sites on the data available.

The plan takes 3. If DC's measurement shows class c is common, option 2 or the parameter
tracing below can be measured as a narrowing later, never before the safe version lands.

## Where it goes

- `testpage-scan.ts`, `procFrom` (:721): new plain facts per procedure, only for names whose
  declared type in the procedure's scope is Variant (or array/collection of Variant), to keep the
  model small: `variantSources: ReadonlyMap<string, readonly VariantSource[]>`, read from the body's
  `assignment_statement` (left an identifier: its right side as a `Recv` via `toRecv`; left a
  subscript: "element-assigned"), `foreach_statement` variables, and every call argument that is
  such a name (callee name, arity, position). Plus `varParams: ReadonlySet<number>` per procedure.
  **r2:** also `varParamNames: ReadonlySet<string>` (the names of its `var` parameters, from the
  parameter's `modifier`), `exitValues: readonly Recv[]` (each `exit_statement`'s `return_value`,
  only when the return type is Variant), and `returnName` (the named return value, already in
  `scope`; tree-sitter field `return_value` on the procedure). No syntax node outlives the file
  (the module's memory rule).
- `buildUnit` (:825): `implements: readonly string[]` from the `implements_clause`.
  `buildObjectUnit` for an `interface`: `extendsInterfaces: readonly string[]` from
  `extends_interface`. Neither changes any hash.
- `Scanner`: an index "interface name -> implementing test-app codeunits" (transitive), and
  "procedure name|arity -> var positions" (every test-app procedure of that name and arity; one
  `var` anywhere counts, the safe reading).
- `argHolds` (:1706): in case `name`, after `foldTables`, when a type is Variant:
  `this.foldVariantSources(p, key, st)`. In cases `index`, `member` and `call`: when the value's
  type (`typesOf`) is Variant, or the base is an array or collection of Variant, fall back.
- **r2:** one method `foldEntryUnit(u, st)` that every whole-codeunit fold goes through:
  `foldImplementation` (:1796) and the new class b / bi folds. It marks the unit in a new
  `ReachState.entryUnits: Set<Unit>` (a codeunit is checked once), reaches every procedure and
  trigger, and runs `handOuts(p, st)` on each. A second method `foldEntryProc(p, st)` (reach plus
  `handOuts`) serves a single subscriber procedure. `handOuts` applies part 2's table, reusing
  `foldVariantSources` with the parameter itself allowed as the root.
- `test-digest.ts`, `subscriberFold` (:129): **r2 changes one line**: a procedure with
  `p.subscriber` goes through `scanner.foldEntryProc(p, st)` instead of `scanner.reach(p, st)`;
  the subscriber codeunit's other procedures keep `reach`. `foldIdTargets` still runs after, so ids
  named in newly folded code are folded too. Nothing else in the digest changes.
- The comment at :1722-1725 that states the limit is replaced by the rule.

## Tests (red first, then red-checked)

New file `packages/runner/tests/r389-variant-reach.test.ts`, synthetic AL sources in the test
(no corpus source), shaped like the probe's self-check fixture (`/coord/handoff/R-389/r389-probe-synth/`).
The property tested is the real one: **edit the mock codeunit; the test's digest must move.**

Red on HEAD (each written and seen red before the fix):
1. `V := Mock; Ext.Go(V)`: editing `Mock` moves the digest. Also: editing an UNREACHED codeunit
   does not move it (proves a fold, not the fallback).
2. `I := Mock; V := I; Ext.Go(V)` with `Mock implements I`: same two checks. A second codeunit
   implementing an interface that extends I is folded too.
3. `W := Mock; V := W; Ext.Go(V)`: the Variant chain.
4. A helper `PassOn(P: Variant)` handing `P` out: fallback, with a reason naming the parameter.
5. A global Variant, a `var` argument filled by a test-app helper, `V := MakeVariant()`,
   `Ext.Go(L.Get(1))`, `Ext.Go(Arr[1])`: each falls back, reason checked.

New in r2, red on HEAD, one per shape the review names:
8. **`var` parameter, Variant, in a subscriber:** `OnGetHandler(var Handler: Variant) begin
   Handler := Mock; end` in a test-app subscriber codeunit. Editing `Mock` moves EVERY test's
   digest (the closure); editing an unreached codeunit moves none.
9. **`var` parameter, Interface, in a subscriber:** `OnGetImpl(var Impl: Interface I) begin
   Impl := Mock; end`, `Mock implements I`. Same two checks.
10. **Return value, Interface and Variant, in a codeunit external code can call:** a test hands
    out `Mock` (class b); `Mock.GetInner(): Interface I begin exit(InnerMock) end`. Editing
    `InnerMock` moves the test's digest. Same with `GetAny(): Variant begin exit(Inner) end`, and
    with a NAMED return `GetNamed() R: Variant begin R := Inner end` in an enum's implementation
    codeunit (into every digest).
11. **Fallbacks from an entry:** `Mock.GetBad(var X: Variant) begin X := GlobalV end` puts the
    test that hands out Mock on the fallback, reason naming `X`; the same procedure in a
    subscriber puts every test on it.
12. **RecordRef `var` parameter in a subscriber:** `OnX(var RecRef: RecordRef) begin
    RecRef.GetTable(TestRec) end`. Editing the test-app table's `OnModify` moves every digest.

Green on HEAD and after (controls):
6. `V := Cust; Ext.Go(V)` (a record): digest byte-identical to HEAD's, pinned as a literal.
7. A RecordRef and a FieldRef handed out: unchanged, pinned.
13. A subscriber whose `var Handler: Variant` is never assigned, and one with only by-value
    Variant / Interface parameters: digests byte-identical to HEAD's, pinned (CDO has two of the
    first shape).

Red-check (mutation-red-checker): remove the codeunit fold (1 and 3 go red); remove the
interface index (2 goes red); remove each fallback branch (the matching case in 4/5 goes red);
make the fold use the fallback instead (the "unreached codeunit" halves of 1 and 2 go red).
**r2 adds:** restore `reach` for subscriber procedures in `subscriberFold` (8, 9, 12 go red);
drop the `var` parameter half of `handOuts` (8, 9, 11, 12 go red, 10 stays green); drop the
return half (10 goes red, 8 and 9 stay green); drop the entry check in `foldEntryUnit` (10 and the
per-test half of 11 go red); let the root parameter count as class c (8 goes from fold to
fallback, so its "unreached codeunit" half goes red). Report each red and the restored green.

## Pins: no digest moves that should not

- `r420-handlers.test.ts`'s snapshot (every committed fixture and example: digests, span hashes,
  parts hashes) must pass UNCHANGED, no `--update-snapshots`. The probe shows why that is
  expected: no fixture or example test app hands out a Variant at all, and none has a subscriber
  procedure or an enum implementation (no entry procedures). That also means the snapshot cannot
  see this change; tests 6, 7 and 13 are the pins that can.
- R-424's split-member tests and R-420's handler tests stay green as they are.
- CDO (5f2a71d): a measurement script digests all 1,287 tests at master and at the branch and
  diffs them. Expected: 0 moved (the r2 probe below: every argument site a or d, every entry
  hand-out a or d, and the closure folds the tables already). Any move is explained by name before
  the build is called done.

## Scheme: no `TEST_DIGEST_SCHEME` bump

The digest's format and line kinds do not change. A test whose Variant holds only records hashes
the same lines as before. A test that gains a fold or the fallback gains lines, so its new digest
can never equal the one recorded under the old build: verify treats it as new once, which is the
safe direction (it re-runs the new-test checks). A bump would make verify refuse EVERY recorded
run (verify.ts:836) and force a fresh source run on every user, for no safety gain. `explainNewTests`
reports such a test as `reach` (or `fallback`), which is the truth; no identity or explain change.
(Review r1 agreed: digests only move in the safe direction, verify.ts:876.) Part 2 adds no new line
kind either: an entry fold adds `P`/`U` lines through `reach`, like any reach.

## Measurement, and the stop rule (stated before measuring)

Run the probe (`/coord/handoff/R-389/r389-probe.ts <label> <test-dir>`) on DC and do-rel2, the
R-371 corpora (host-only), and the built product through `product-measure.ts` on the same.

**Stop and report before building on, if on any corpus:** more than half of the tests go newly
to the whole-source digest; or the subscriber closure (folded into every digest) hits class c,
which puts every test on the fallback. R-371's blow-up was exactly the second: one of DC's 194
Variant arguments sat in the closure. **r2:** "the closure hits class c" now also counts a class c
hand-out from a subscriber or enum-implementation entry, or from a codeunit the closure folds.

If DC stops on class c "parameter" (a library helper taking a Variant and handing it on), the
measured next step is tracing a parameter through every test-app call site of its procedure
(the callers' `argFacts` are already in the model), still falling back on anything unseen.

**The build stays gated** on the DC and do-rel2 numbers (owner question
q-20261004T034114-1c77361f, still pending: the corpora are host-only) and on this stop rule.

## Probe results (offline, 2026-10-04)

The probe runs the product walk unchanged and wraps the private `argHolds` to see every argument
the R-371 ruling reads, then classes each Variant by part 1. **r2:** it also lists every entry
procedure (subscriber procedures, enum implementation codeunits, and the codeunits a b / bi folds,
to a fixpoint) and classes each Variant, Interface, RecordRef or FieldRef `var` parameter and
return value by part 2. Stated limit: argument sites INSIDE a codeunit the new folds take in are
not re-walked through the product's `argHolds`; the probe prints how many such codeunits there
are, and it is zero on every corpus below, so the limit did not matter here.

Self-check (`r389-probe-synth/`, extended in r2 with one case per new shape): every r1 class found,
and every r2 shape found with the expected class: subscriber `var Variant` set to a codeunit (b),
subscriber `var Interface` (bi), NAMED Variant return in an enum implementation codeunit (b),
Interface return in a handed-out codeunit (bi), Variant return by `exit` (b), and a `var Variant`
set from a global (c).

r1 numbers (argument hand-outs only), kept:

| Corpus | Tests | Today on fallback | Tests handing out Variant/RecordRef/FieldRef/Interface | Variant sites by class | Closure | New fallback | New fold only |
|---|---|---|---|---|---|---|---|
| CDO 5f2a71d (`/work/src/do-lethal/Test`; NOT R-371's do-rel2) | 1,287 | 6 | 263 (78 with a Variant, 0 with an Interface) | a 73, d 2, d (never assigned) 5; b 0, bi 0, c 0 | 2 Variant sites, both d; 36 RecordRef | 0 | 0 |
| 7 fixture test apps + 2 examples (the R-420 snapshot set) | 100 | 0 | 0 | none | none | 0 | 0 |
| DC, do-rel2 | not available here (host-only) | | | | | | |

r2 numbers (re-run 2026-10-04, same inputs; argument hand-outs AND entry hand-outs):

| Corpus | Entry procedures | Entry hand-outs by class | Codeunits newly folded | New fallback | New fold only | Tests whose digest moves |
|---|---|---|---|---|---|---|
| CDO 5f2a71d | 31 subscriber procedures; 1 enum implementation codeunit; 0 per-test folds | RecordRef `var` 19 (a; the closure folds every table today already, so no cost); Variant `var` 2 (d, never assigned); Interface `var` or return 0; Variant return 0; c 0 | 0 | 0 | 0 | **0 of 1,287** |
| 7 fixture test apps + 2 examples | 0 (no subscriber, no enum implementation) | none | 0 | 0 | 0 | 0 of 100 |
| DC, do-rel2 | not available here (host-only) | | | | | |

The stop rule does not trigger on this data. The data that matters (DC) is still missing.

## Open questions for the orchestrator

1. DC and do-rel2 are needed for acceptance 2. Can the owner run the probe on the host, or make
   the corpora available here? (Pending as q-20261004T034114-1c77361f.)
2. ~~Can external code actually RUN a test-app codeunit it receives in a Variant?~~ **Answered by
   the live probe (6e9b20ed): yes, by R1c, R1d and R4d.** R-389 is built, not closed as a ruling.
   `Codeunit.Run(<integer id>)` (S1) is R431, outside R-389.
3. The 6 CDO tests on the fallback today hand a test-app MOCK codeunit straight to external code
   (`SetHttpClient`). The same fold would take them off the fallback, and the same would hold for an
   Interface variable handed out directly as an argument. That is a narrowing and outside R-389;
   file it as its own item?
