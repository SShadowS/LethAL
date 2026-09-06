# Design: hang-capable sites are tagged and stopped, not refused (R196)

Status: DRAFT revision 2, 2026-09-06, for review before any code. Revision 1 was reviewed
adversarially by gpt-5.6-sol and refused on four blockers; all four and the fifteen smaller findings
are applied here and listed in §11. Sol also corrected three things in the pre-spec design, credited
inline. Closes [[R196]] for the shapes it can see, and says plainly which it cannot.

## 1. What breaks, and what it costs

Four operators can turn a terminating loop into a non-terminating one by mutating a variable the
loop's condition reads. Measured on the Document Output Templates slice (741 mutants, 2026-09-03):
**eight mutants never terminate**. Without `--stop-hung-sessions` each cost a 180 s budget, an
`in-flight-unknown` quarantine, a `force-reset-lease`, a redeploy and a resume: **about 40 of the
run's 148 minutes**.

Revision 1 said "about 5 of 8" would be caught. "About" is not good enough for eight known mutants,
and the prose enumerated seven. The plan's first task is to recover the eight from run 3's store
and fill this table exactly; the design does not ship on an estimate.

| # | line | procedure | operator | site | `classifyHangCapable` tags it? |
|---|---|---|---|---|---|
| 1 | 74 | `FindMatchingTemplateLine` | `remove-assignment` | loop 1, increments `CriterionIndex` | **yes** |
| 2 | 76 | `FindMatchingTemplateLine` | `remove-assignment` | loop 1, sets `LineDone` | **yes** |
| 3 | 76 | `FindMatchingTemplateLine` | `flip-boolean-literal` | loop 1, same site as #2 | **yes** |
| 4 | 84 | `FindMatchingTemplateLine` | `remove-assignment` | loop 2, sets `LineDone` | **yes** |
| 5 | 84 | `FindMatchingTemplateLine` | `flip-boolean-literal` | loop 2, same site as #4 | **yes** |
| 6 | 85 | `FindMatchingTemplateLine` | `empty-block` | loop 2's guarded block | **no** (§3.2.5: not an assignment) |
| 7 | 107 | `FindMatchingTemplateLine` | `remove-assignment` | loop 2, increments `CriterionIndex` | **yes** |
| 8 | 322 | `SubstituteDateFormulas` | `remove-assignment` | assigns `Rest`; the enclosing loop's own condition reads a different variable, reached only through a call one line later | **no** |

**Recovered exactly, task 3 (2026-09-06), from run 3's own store** (`lethal-53470-run3/lethal.sqlite`,
run 1: killed 448, survived 237, no-coverage 48, timeout-killed 8, summing to the 741 deployed
mutants this section already cites) and cross-checked line-for-line against
`scripts/census-hang-capable.ts`'s tagged rows on `do-lethal-53470/Cloud`. Full measurement in
`docs/measurements/README.md` and `.superpowers/sdd/2026-09-06-r196-plan-a-classifier/task-3-report.md`.

Two corrections to revision 1/2's account, both found by the recovery rather than assumed:

- **`FindMatchingTemplateLine` has TWO structurally identical `while` loops, not one.** Rows 2-3
  above were the only `LineDone` pair revision 1/2 named; rows 4-5 are the SECOND loop's matching
  pair, structurally identical, and the earlier prose never described them.
- **Row 6's "condition mutation" is not one of the eight, and never was.** Run 3's deployed set has
  no operator that swaps a boolean connective; `negate-conditional` is the nearest real analogue, at
  both loops' conditions, and both instances scored plain `killed`, not `timeout-killed`. It is
  dropped from the corrected table above; the eight are exactly rows 1-8.

**Row 8 is the one the classifier misses**, and it misses it for exactly the reason §3.2 point 3
already names: the enclosing `while`'s own condition names a variable this assignment does not
touch, and the variable it DOES touch reaches that condition only through a call on the next line,
i.e. progress through a CALL. Revision 1's row 7 hedged "expected yes, IF the condition reads
`Rest`"; measured, the condition does not, so the honest answer is a plain no, not a hedge.

**Net: `classifyHangCapable` tags 6 of the actual 8 (75%).** Six correctly tagged (rows 1-5, 7), one
correctly out of scope for an assignment-only classifier (row 6, a block deletion), one a real miss
squarely inside the design's own documented exclusion (row 8, §3.2.3). No row was tagged that should
not have been.

[[R164]] is the **precedent**, not a universal rule: it establishes a narrow cession at one exact
`repeat`-exit position and deliberately preserves condition mutations nested inside it. Revision 1
called it a general ruling that "a hang-capable site must not enter a scored gate", which this
design would then immediately violate by design. It does not: R164 addressed one measured hazard
with the tool available there (a substitute operator), and this addresses another with the tool
available here.

## 2. The ruling this implements

R164 and R179 REFUSE a hang-capable site. This design TAGS it and lets the mutant run.

Both earlier cessions had a terminating substitute asking nearly the same question —
`loop-truncate` for `negate-conditional` at a `repeat` exit, `loop-skip` for `empty-block` on a
`while` body. Deleting a loop's progress assignment has no such substitute, so refusing deletes the
finding outright. On the Templates slice those are real gaps: a suite that does not notice an
infinite loop has a hole, and BC's own session stop makes it scoreable. R196's own text calls
keeping the mutant "the more honest answer".

**The ruling.** A site the classifier names is tagged `hangCapable`. The orchestrator forces the
session-stop hook for that mutant regardless of `--stop-hung-sessions`, announces before deploying
that it will, and scores a resulting timeout as `timeout-killed` — subject to §6's confirmation and
§6.3's stated residuals.

## 3. The classifier

One shared module, `packages/builtin-tier1/src/loop-hazard.ts`, consulted by four operators. Not
four copies of one predicate: [[R80]] is this repository's row about two copies of one rule drifting
apart.

**The candidate assignment**, per operator:

| operator | the assignment it mutates |
|---|---|
| `remove-assignment` | the statement itself |
| `swap-additive` | the assignment enclosing the `+`/`-` |
| `flip-boolean-literal` | the assignment enclosing the literal |
| `shift-integer` | the assignment enclosing the literal |

**Which loops count.** `while_statement` and `repeat_statement`. `for_statement` is EXCLUDED in v1,
and the reason is honest ignorance rather than a claim: whether an AL `for` can be made
non-terminating by mutating its control variable depends on whether the platform re-evaluates the
bound and re-reads the variable each iteration, and **this repository has not measured that**. The
`/al-probe` skill exists for exactly that question; closing it is §10 work.

**The walk.** Outward from the assignment through EVERY enclosing `while`/`repeat` — not only the
nearest, since an assignment in a nested loop or `if` can govern an outer one — stopping at the
enclosing **procedure OR trigger** boundary. All four operators generate inside triggers, and
revision 1 said only "procedure", leaving trigger loops unspecified.

**The test.** Does that loop's CONDITION read the assignment's target? If any enclosing loop does,
tag the site `loop-condition-target`.

### 3.1 Identifier resolution is work, not an available API

Revision 1 said "resolve the target through `SemanticContext.symbols`". **That API does not exist.**
`SymbolTable` (`semantic/symbol-table.ts:122-140`) offers `resolveObject`, `resolveProcedure`,
`globalsOf`, `localsOf`, `fieldsOf` — declaration lookups, with no `resolveIdentifier(node)`. Sol
caught this; it is the same overclaim class as the budget check.

So the plan builds one, `resolveVarRef(node, ctx)`, and it must handle, each with a test:

- the owning object, and procedure/trigger scope;
- parameters as well as locals and globals;
- AL's case-insensitive names, and quoted identifiers;
- shadowing (a local or parameter hiding a global);
- identifier positions that are NOT variable reads — a member or method name after `.`.

**Unresolved sites are DECLINED, not name-matched.** Revision 1 proposed a case-insensitive
fallback "recorded so the corpus can count it", which contradicted §4's single reason value and,
worse, would let a guess force a session stop. An unresolved target is counted as unclassified in
the corpus measurement and emits no tag. For an operation that ends sessions on a user's server,
identity-backed or nothing.

### 3.2 What this does NOT classify — unclassified, NOT safe

Revision 1 justified enclosing-only by claiming preceding initialisers cannot hang. **That is false
as a class** (sol):

```al
Position := Target + 1;    // remove-assignment → default 0; swap-additive → Target - 1
repeat
    if Position > Target then
        Position -= 1;
until Position = Target;   // the guard never fires, so the exit is never reached
```

`repeat` makes the flaw plain: the body runs BEFORE the first check, so a smaller initial value
cannot merely mean fewer iterations. AL globals weaken it further — deleting an assignment need not
expose the type default, because a codeunit global can hold state from an earlier call, deliberately
so in a `SingleInstance` codeunit.

Enclosing-only is justified by PRECISION, not safety. Excluded, and **unclassified rather than
proven safe**, in the order they should be measured for a later widening:

1. **A target read in the loop BODY rather than its condition.** `Step := 1;` then
   `while Counter < Limit do Counter += Step;` — deleting the initialiser leaves `Step` 0 and the
   loop never advances, while the condition never names `Step`.
2. **Preheader assignments** — sol's `Position := Target + 1` above.
3. **Progress through a CALL**, which is both hangs in our own fixture: `CountUpTo` calls
   `Advance()`, which writes the global `Counter` the condition reads
   (`HangLogic.Codeunit.al:33-44`); and `WalkOneRow`'s condition is `until NextRow() = 0`, naming
   nothing while `NextRow` reads `Walked` (`:61-75`). It is also the shape of the two measured
   `void-method-call` hangs. Sol's tractable approximation — one-hop summaries of same-codeunit
   local procedures, treating a global read by a procedure called from the condition as an effective
   condition read — would catch both, is still effect summarisation rather than value inference, and
   is deliberately not in v1: it is a second index over the semantic layer and deserves its own
   measurement.
4. **Record and field targets** (`Rec.Field := …` against `while Rec.Find`).
5. **Condition-side mutations** — `empty-block` on a guarded block, `and` → `or`. Rows 5 and 6 of
   §1's table are these, and they are not assignment mutations at all.

### 3.3 What a tag claims, precisely

A tag claims only that **the assignment's target is a condition-relevant variable of an enclosing
loop**. Revision 1 said "the hazardous variable" and "the loop that would spin", which overclaims.
A tag does NOT establish that:

- the mutation prevents progress;
- the assignment executes on the path that timed out;
- no other statement advances the condition;
- an `exit`, an error, or an overflow cannot end the loop anyway.

R179 holds this repository's counterexample: `DrainQueue`'s frozen loop terminated by Int32
**overflow** in about 4.4 s rather than hanging, and R179's own pre-commitment recorded that miss.
A frozen loop is not necessarily a non-terminating one.

### 3.4 A halt, not a formality

Measure the claim rate on the reference corpus BEFORE anything ships, and report beside it how many
sites were DECLINED as unresolved (§3.1). A rate in the thousands means the rule is wrong rather
than broad; a high unresolved rate means the resolver is, and either stops the design here with the
decision recorded against the number.

**ANSWERED 2026-09-06, halt decision: PROCEED, with two stated limits.** Measured, decided, and
recorded in full in `docs/measurements/README.md` (section "The hang-capable classifier's claim rate
on two real corpora, and the eight recovered"). Not restated here: this section stays as the
question it originally asked, and the answer lives beside the numbers that produced it.

## 4. The tag, and how it travels

`MutationSpec.hangCapable?: HangCapableReason` — a named union, not a boolean, so the report can say
WHICH rule fired. v1 has one value, `"loop-condition-target"`; §3.2's widenings would add
`"loop-body-target"`, `"loop-preheader"`, `"callee-global"`, each with a different confidence that a
boolean would flatten.

It travels the path `platformKillMechanism` already proves: operator → `MutationSpec` →
`MutantManifestEntry.hangCapable?: string` (`project.ts:178`, populated at `:479`) → orchestrator →
`MutantOutcome.hangCapable?` with an explanation table shaped like
`PLATFORM_KILL_MECHANISM_EXPLANATIONS`. Ripple, enumerated rather than discovered: `events.ts`,
`report-fold.ts`, `report.ts` type/builder/banner, `generate-schemas.ts`, `schemas.test.ts`, the
`report-equality` snapshot, and `store.ts` if the tag is persisted for resume (§8).

**`explain` is NOT in the ripple, and revision 1 was wrong to promise it.** `ExplainOutput` has
survivors, not-measured mutants, caveats and tool conditions — there is no killed-mutant list, so
adding a field to `MutantOutcome` puts nothing in `lethal explain`. Giving it one is a new output
shape with its own schema-version decision. v1 relies on the §5 caveat, which `explain` does carry,
plus the raw report rows. Filed in §10.

### 4.1 Operator integration, which is not free

- `remove-assignment.generate` currently calls `targets` with a **fabricated empty context**
  (`remove-assignment.ts:59-66`). A context-dependent tag cannot be produced that way; the plan
  either threads the real `ctx` or separates context-free eligibility from tag generation.
- `remove-assignment` and `shift-integer` declare `requiresSemantic: []`
  (`remove-assignment.ts:53`, `shift-integer.ts:77`). If the emitted spec depends on symbols, that
  declaration becomes `"symbol-table"` or the dependency is undeclared.
- `ConformanceCase.expectedSpecs` can assert only `parentContext` and before/after text
  (`operator/interface.ts:100-107`). **All four operators could ship untagged with every conformance
  test green.** The plan extends the case shape to assert the tag, or the operator layer has no
  test that the tag is emitted at all.
- `shift-integer` stays in scope, and the two rules are complementary rather than overlapping: it
  already refuses a loop-exit CONDITION under R164 (`shift-integer.ts:118-121`), while this design
  classifies the ASSIGNMENT position. The hang below is reachable precisely because that position
  was never covered:

  ```al
  Remaining := 1;
  while Remaining > 0 do
      Remaining := 0;        // shift-integer: `:= 1` — the condition never goes false
  ```

  Its own conformance case (`Total := 41` → `42`) confirms it claims directly-assigned literals.
  `conditional-boundary` is NOT in scope: it mutates the condition, not an assignment.

## 5. The forced stop: plumbing, capability, announcement, caveat

### 5.1 There is no per-mutant stop control today

`RunOpts` is `{coverage, timeoutMs}` (`backend.ts:174-177`), `RunManyOpts` has no stop field, and
`BcDevMcpBackend` passes its construction-time `stopHungSessions` to every dispatch
(`bcdev-backend.ts:791`). The orchestrator therefore **cannot** force the hook for one mutant.
Revision 1 assumed it could.

The plan adds `RunOpts.stopHungSession?: boolean` and `RunManyOpts.stopHungSessions?: boolean`, with

```text
effectiveStop = configuredGlobalStop || perDispatchForcedStop
```

**Baseline calls never inherit the force** — a baseline overrun is not a mutant hazard and R89's
note about baseline overruns stands. Confirmation calls inherit it deliberately (§6.2).

### 5.2 Stoppability is a backend capability, not an assumption

An al-runner run can contain tagged mutants and cannot end a BC session. The announcement and the
force are gated on a declared capability rather than on `authoritative`, and on a backend without it
a tagged mutant behaves exactly as today.

### 5.3 The announcement needs a real data path

"N hang-capable sites found" must count **deployed, post-dedup** mutants and must be emitted BEFORE
deployment, so it cannot be derived from scored outcomes — a quarantine truncates those, and the
number would silently shrink. `generateMutationSet` already computes `siteCount` and `deployedCount`
(`orchestrator.ts:2130-2165`); the plan adds `hangCapableCount` to the `mutation-set-generated`
event and emits a warning with a fixed code, tested for presence and ordering.

Text: *"N hang-capable site(s) found. If one exceeds its budget LethAL will end that BC session,
because the alternative is a stranded tier. This happens whether or not `--stop-hung-sessions` was
passed."*

### 5.4 The existing caveat will not fire, and would lie if it did

`report.ts:2008` pushes `"stop-hung-sessions"` only when `input.stopHungSessions === true &&
counts.timeoutKilled > 0`. A forced timeout with the flag off gets **no caveat at all**, and the
existing interpretation says the verdict was scored "through `--stop-hung-sessions`", which would be
false.

v1 adds a separate caveat, `"hang-capable-auto-stop"`, rather than broadening the existing one:
user opt-in and automatic override are different facts and a reader deserves to see which happened.
It fires when **an automatic stop actually occurred** — not merely when tagged sites were deployed —
because a caveat qualifies a claim, and with no forced timeout there is no claim to qualify. The
deployed-sites fact is the §5.3 announcement's job. This is the ambiguity revision 1 mixed.

Any new caveat value enters `explain`'s value domain and may force an `EXPLAIN_SCHEMA_VERSION`
decision; the plan checks that explicitly.

### 5.5 Documentation is part of the change

`docs/using-lethal-from-an-agent.md` currently tells an agent not to pass `--stop-hung-sessions`
unasked. After this, tagged sites may end a session anyway, and that document must say so. A runtime
announcement does not discharge a written instruction that contradicts it.

## 6. Confirmation, and what it can honestly prove

### 6.1 One confirmation, never two

At group position **k > 1** a tagged timeout already gets R206's `confirmWarm`, which replays
methods 1..k unmutated in a fresh session and requires method k inside its own budget. **That is the
confirmation.** Revision 1 said "run the killing test unmutated", which would add a second replay,
duplicate side effects, possibly contradict the first, break the pinned
`groupedCalls = scored + warmKills` arithmetic, and compare a cold killer-only context against a
warm original.

At position **1** the prefix is the killer alone, so the confirmation is the existing single-method
cold rerun (`runFenced`, `coverage: "none"`) that today's `fail` path already uses — `op_kind`
single, so `groupedCalls` is untouched and no gate arithmetic moves.

Both require: the replay **passes**, AND its `durationMs` is within the killer's own budget.

### 6.2 The duration check is restored, narrowly worded

Revision 1 deleted it, reasoning that completing unmutated inside budget cannot distinguish an
infinite mutant from a finite slow one. That is true, and it was an over-correction: under grouped
execution the watchdog polls periodically, so an unmutated replay can itself run past budget and
finish between polls, returning `pass` with `durationMs > budget`. A pass-only rule would confirm
the timeout on that evidence.

So the check is **necessary but not sufficient**: necessary to reject a replay that was itself too
slow, insufficient to prove the mutant was infinite. It is stated that way and claimed no further.

A confirmation that itself times out inherits the forced stop (so it cannot strand the tier) and
always produces an **error**, never a kill.

### 6.3 Accepted residuals, named rather than implied

There is no finite-time discriminator between "infinite" and "finite but longer than this deadline".
The policy is R53's existing one — exceeding a generous budget is itself observable misbehaviour —
and these are the cases where a `timeout-killed` may not be a real finding. They are accepted, and
the report says what the evidence is rather than implying more:

1. **A transient, non-reproducing delay.** Database contention, an external service, another
   extension or platform load makes one invocation slow; the stop fires; the transient clears; the
   unmutated replay passes. Compounding it, a stopped response carries no guard attestation, so — as
   `CAVEAT_INTERPRETATIONS["stop-hung-sessions"]` already says — the run "cannot even say whether an
   instrumented site executed". Coverage is procedure-level and over-approximates, so the mutated
   site may not have run at all.
2. **[[R204]]'s rollback window**, which is deterministic and open: the test passes, its progress
   write has not committed, the stop lands, the write rolls back, the 408 arrives, the post-stop read
   cannot prove completion, and the unmutated replay passes because the test genuinely passes. R198's
   narrowing catches only completion that became durably visible before the stop.
3. **Post-stop contamination.** A fresh session is not a fresh environment: explicitly committed
   writes, external calls, background sessions and their locks survive the stop. A failed replay may
   therefore be contamination rather than flakiness, and must not be reported as "unstable" with the
   confidence that word carries.

The replay's honest claim, replacing revision 1's wording: *it rejects a failure or timeout that
reproduces unmutated under the replay's conditions. It does not prove causation, and does not
exclude transient environmental delay, non-reproducing flakiness, an unreached mutation site, or
R204's window.*

Closing residual 1 properly needs a durable per-attempt "this exact selector executed" marker that
survives a session stop. That is filed in §10, not assumed here.

## 7. The gate

### 7.1 Revision 1's gate could not work

The OFF leg quarantines at the FIRST hang and stops scoring — measured today:

```
[stop-hung-sessions OFF] killed=1 timeoutKilled=0 survived=2 errors=1
    M0001 killed    :34 empty-block
    M0002 survived  :35 remove-assignment
    M0003 survived  :35 shift-integer
    M0004 error     :37 void-method-call   note=quarantined
```

Four mutants, then it stops. An arm appended to `HangLogic.Codeunit.al` — where R206's `SpinUntil`
went — would never be reached on that leg, and the differential revision 1 specified would simply
not occur.

### 7.2 The gate that does work

The tagged hang must precede EVERY untagged hang in manifest execution order. The arm therefore goes
in a **separate target file whose path sorts before `HangLogic.Codeunit.al`** — which also avoids
renumbering the thirty-odd line-pinned rows in `EXPECTED_ON`, a cost revision 1 accepted needlessly.

The OFF leg then reads, in one fixture:

1. the new arm's **tagged** hang → stop forced despite the flag → `timeout-killed`, its confirmation
   row passing, **and the run continues past it** — which is impossible in today's build;
2. the existing **untagged** through-a-call hang at `HangLogic:37` → strands → quarantines, exactly
   as today;
3. nothing after that control is scored.

All four are asserted by exact mutant identity, taken from a `--dry-run` manifest and pre-committed,
not by counts. The arm must also carry a **tagged mutant that does not hang**, so the
over-approximation is exercised and shown to cost nothing.

### 7.3 The red-check must name the arm

Revision 1's red-check — "remove the tag and confirm the OFF leg strands again" — passes trivially,
because the fixture already contains untagged hangs that strand. It must instead assert that **the
new arm's own mutant becomes the strand point** when its tag is removed, and that **that exact
mutant** stops being scored when the forced stop is disabled.

### 7.4 What else moves

Adding a target file and tests perturbs R197's kill ledger and R206's test ordering, and this
fixture already treats test names as load-bearing (`HangLogic.Codeunit.al:116-134`,
`HangTests.Codeunit.al:62-91`). Every changed `killPosition` and `warmKills` is pre-committed before
the run. `tables`, `bcdev` and `alrunner` are predicted UNCHANGED in verdict — a tag changes nothing
unless the mutant times out — and that prediction is pre-committed and checked, not assumed.

## 8. Resume

`buildResumeIndex` accepts `timeout-killed` only when the CURRENT session's global
`stopHungSessions` is true (`resume.ts:149-160`), and its comment gives the principle: carrying such
a verdict into a session not allowed to stop sessions "would import a verdict this run could not
have produced … on the strength of a permission it does not hold."

That principle is right and this design breaks its premise, because the permission stops being one
global boolean. Restated: **a session may carry a `timeout-killed` if it could have produced it —
global flag ON, or the mutant is `hangCapable` in the CURRENT manifest.** Without this, run 2 with
the flag off re-runs every forced timeout and repays 180 s each, which is the cost R196 exists to
remove.

The ordering is awkward and the plan must address it: resume resolution happens before mutation
generation, so the current manifest's tag is not yet known. Either generate the manifest before
final carry filtering, or index timeout verdicts provisionally and apply eligibility in
`carriedVerdictFor`/`batchCarriesEntirely` against the current `MutantManifestEntry`.

Tests, both directions: a tagged timeout carries with the global flag off; an untagged timeout from
an earlier opt-in run does NOT carry when the flag is off.

## 9. What refuses this design

- A tagged site's timeout scored without its confirmation passing AND within budget.
- A second confirmation at k > 1, or any change to `groupedCalls = scored + warmKills`.
- A forced stop with no pre-deploy announcement or no `hang-capable-auto-stop` caveat.
- A tag emitted from a name match rather than a resolved symbol.
- Any claim, in code, comment or report, that an excluded shape (§3.2) cannot hang, or that a tag
  proves the mutation prevents progress (§3.3).
- A resume that re-runs a tagged timeout with the flag off.
- Verdict movement on `tables`, `bcdev` or `alrunner`.
- An OFF-leg gate whose tagged hang is not provably first in manifest order.

## 10. Out of scope, filed separately

- §3.2's four widenings, in that order, each separately measured.
- Whether an AL `for` loop can be made non-terminating by mutating its control variable — an
  `/al-probe` question.
- A durable per-attempt "this selector executed" marker that survives a session stop, which is what
  would close §6.3's residual 1.
- An `explain` projection for killed mutants, with its schema-version decision.
- A correction to shipped code found by sol: `empty-block.ts:43-66` says a `while` body "must"
  advance its condition so emptying it "CANNOT terminate". That is untrue for a self-advancing
  condition such as `while Rec.Next() <> 0 do`, and the same overstatement appears in the
  `DrainQueue` fixture commentary. The cession stands as conservative policy; only its stated reason
  is wrong. Worth fixing whether or not this design ships.

## 11. Review of revision 1 (gpt-5.6-sol, 2026-09-06), and what revision 2 does

| # | finding | revision 2 |
|---|---|---|
| B1 | The confirmation still permits false kills; §6 overstated what the replay rejects | §6.3 names three accepted residuals (transient/unreached site, R204's window, post-stop contamination) and restates the replay's claim narrowly |
| B2 | The OFF-leg gate is order-dependent and, as written, unreachable | §7.1 shows it measured; §7.2 puts the arm in a file sorting FIRST and pins identities; §7.3 strengthens the red-check |
| B3 | No per-mutant stop control exists in the backend API | §5.1 adds `RunOpts.stopHungSession`/`RunManyOpts.stopHungSessions` with `effectiveStop`, baseline excluded |
| B4 | `--resume` drops forced timeouts when the global flag is off | §8 restates the eligibility principle around the current manifest's tag, with tests both directions |
| 5 | `SemanticContext.symbols` has no identifier resolver | §3.1: it is specified as work, with its own test list |
| 6 | Name fallback contradicts the single reason value and lets a guess stop a session | §3.1: unresolved sites are DECLINED and counted as unclassified |
| 7 | The walk omits triggers | §3: procedure OR trigger boundary |
| 8 | "the hazardous variable" overclaims | §3.3, with R179's overflow counterexample |
| 9 | The eight-mutant accounting does not add up | §1's table, to be completed from the store as the plan's first task |
| 10 | R164 described as a universal rule this design then violates | §1: precedent, not universal rule |
| 11 | Two confirmations would collide at k > 1 | §6.1: one confirmation; position 1 uses the single-method path |
| 12 | The budget check was removed too aggressively | §6.2: restored, necessary but not sufficient |
| 13 | `remove-assignment.generate` fabricates an empty context | §4.1 |
| 14 | `requiresSemantic: []` would be undeclared | §4.1 |
| 15 | Conformance cases cannot assert a tag | §4.1: the case shape is extended, or the tag has no operator-level test |
| 16 | The announcement has no data path and must precede deployment | §5.3: `hangCapableCount` on `mutation-set-generated` |
| 17 | The existing caveat will not fire and would lie | §5.4: a separate `hang-capable-auto-stop`, firing on an actual stop |
| 18 | `explain` cannot project a killed mutant's tag | §4: removed from the ripple, filed in §10 |
| 19 | The confirmation's own stop behaviour was unspecified | §6.2: inherits the force, always an error |
| 20 | Docs tell agents the opposite | §5.5 |
