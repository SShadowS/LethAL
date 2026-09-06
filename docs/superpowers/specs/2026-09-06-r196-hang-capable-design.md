# Design: hang-capable sites are tagged and stopped, not refused (R196)

Status: DRAFT for review, 2026-09-06. Closes [[R196]] for the shapes it can see, and says plainly
which it cannot. Second opinion: gpt-5.6-sol, which corrected three things in an earlier draft of
this design and is credited inline where it did.

## 1. What breaks, and what it costs

Four operators can turn a terminating loop into a non-terminating one by mutating the variable the
loop's condition reads. Measured on the Document Output Templates slice (741 mutants, 2026-09-03):
**eight mutants never terminate**, all in two loops —
`FindMatchingTemplateLine`'s `while (not LineDone) and (CriterionIndex <= …)` (a removed
`CriterionIndex += 1` at two sites, a removed or flipped `LineDone := true` at two sites, the
guarded block emptied, the condition's `and` negated to `or`) and `SubstituteDateFormulas`'s
`Rest := CopyStr(Rest, ClosePos + 1)`. That is 1.1% of the mutants. Without
`--stop-hung-sessions` each cost a 180 s budget, an `in-flight-unknown` quarantine, a
`force-reset-lease`, a redeploy and a resume: **about 40 of the run's 148 minutes**.

[[R164]] already rules that a hang-capable site must not enter a scored gate, and
`negate-conditional` refuses `until X.Next() = 0` on that ruling. Nothing else looks.

## 2. The ruling this implements, and why it differs from R164/R179

R164 and R179 REFUSE. This design TAGS and lets the mutant run.

The difference is that both earlier cessions had a terminating substitute that asks nearly the same
question — `loop-truncate` for `negate-conditional` at a `repeat` exit, `loop-skip` for
`empty-block` on a `while` body. Deleting a loop's progress assignment has no such substitute, so
refusing it deletes the finding outright. On the Templates slice those eight are eight real gaps:
a suite that does not notice an infinite loop has a hole, and BC's own session stop makes it
scoreable. R196's own text calls keeping the mutant "the more honest answer"; this design agrees.

**The ruling.** A site the classifier names is tagged `hangCapable`. The orchestrator applies the
session-stop hook to a tagged mutant REGARDLESS of `--stop-hung-sessions`, announces that it will,
and scores a resulting timeout as `timeout-killed` — the same verdict, with the same stated
weakness, that R53 already gives every timeout, but reached through one new check (§6): the killing
test must PASS when re-run unmutated.

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

**Which loops count.** `while_statement` and `repeat_statement` only. `for_statement` is
EXCLUDED in v1 and the reason is honest ignorance, not a claim: whether an AL `for` can be made
non-terminating by mutating its control variable inside the body depends on whether the platform
re-evaluates the bound and re-reads the variable each iteration, and **this repository has not
measured that**. The `/al-probe` skill exists for exactly this question and closing it is filed as
§9 work. Until it is measured, a `for` body's assignments are unclassified, like everything else in
§3.2. (The kinds come from `ALNodeKind`, which already names all three — `node-kinds.ts:61-63`.)

**The rule.** Walk outward from the assignment through EVERY enclosing `while`/`repeat`, to the
procedure boundary — not only the nearest, because an assignment in a nested loop or `if` can
govern an outer one. For each, ask whether that loop's CONDITION reads the assignment's target.
If any does, tag the site `loop-condition-target`.

**Symbol identity, not text.** Resolve the target through `SemanticContext.symbols`. Text matching
confuses same-named fields on different record variables, and a local shadowing a codeunit global.
Where the symbol does not resolve, fall back to a case-insensitive name match and record that the
fallback fired, so the corpus measurement can say how often it does. Symbol resolution is NOT the
inference this codebase refuses: the refused class is "this assignment is the loop's only progress"
or "this value can never reach the sentinel", which is about VALUES. Asking which declaration a
name refers to is not.

### 3.1 `shift-integer` stays in, and the reason an earlier draft dropped it was wrong

An earlier draft removed `shift-integer` on the grounds that its only rewrite is `n → n + 1`, so at
`Counter += 1` it yields `+= 2`, which still advances. That covers one shape of two. It also claims
directly-assigned literals, and there the same rewrite hangs (sol):

```al
Remaining := 1;
while Remaining > 0 do
    Remaining := 0;        // shift-integer: `:= 1` — the condition never goes false
```

The live fixture's 6 killed / 2 survived / 0 timed-out `shift-integer` rows prove only that its
particular `+= 1` sites keep advancing; they do not license removing the operator.

Note the two rules are COMPLEMENTARY, not overlapping. `shift-integer` already refuses a loop-exit
CONDITION on R164's ruling — its own conformance case says so ("REFUSES a loop-exit condition:
R164's non-termination hazard", `shift-integer.ts:118-121`) — while this design classifies the
ASSIGNMENT position. The `Remaining := 0` hang above is reachable precisely because the assignment
position was never covered by that earlier refusal. `conditional-boundary` sits in the same
relationship and is NOT in scope here: it mutates the condition, not an assignment.

### 3.2 What this does NOT classify — unclassified, NOT safe

An earlier draft justified enclosing-only by claiming preceding initialisers cannot hang, because
deleting `CriterionIndex := 1` leaves AL's default 0 and the loop still terminates. **That is false
as a class**, and sol disproved it:

```al
Position := Target + 1;    // remove-assignment → default 0; swap-additive → Target - 1
repeat
    if Position > Target then
        Position -= 1;
until Position = Target;   // the guard never fires, so the exit is never reached
```

`repeat` makes the flaw plain: the body runs BEFORE the first check, so a smaller initial value
cannot merely mean fewer iterations. AL globals weaken the argument further — deleting an
assignment need not expose the type default at all, because a codeunit global can hold state from
an earlier call, deliberately so in a `SingleInstance` codeunit.

Enclosing-only is therefore justified by PRECISION, not safety: every site it names has the
hazardous variable visible in the loop that would spin. The following are excluded and are
**unclassified, not proven safe**, in the order they should be measured for a later widening:

1. **A target read in the loop BODY rather than its condition.** `Step := 1;` then
   `while Counter < Limit do Counter += Step;` — deleting the initialiser leaves `Step` 0 and the
   loop never advances, and the condition never names `Step`.
2. **Preheader assignments** — sol's `Position := Target + 1` above.
3. **Progress through a CALL.** This is both hangs in our own fixture:
   `CountUpTo` calls `Advance()`, which writes the global `Counter` the condition reads
   (`HangLogic.Codeunit.al:33-44`); and `WalkOneRow`'s condition is `until NextRow() = 0`, which
   names nothing while `NextRow` reads `Walked` (`:61-75`). It is also the shape of the two measured
   `void-method-call` hangs. Sol proposes a tractable approximation — one-hop summaries of
   same-codeunit local procedures (which globals each directly reads and writes), treating a global
   read by a procedure called from the condition as an effective condition read. That is effect
   summarisation, still syntactic, and it would catch both fixture blind spots. It is deliberately
   NOT in v1: it is a second index over the semantic layer and deserves its own measurement.
4. **Record and field targets** (`Rec.Field := …` against `while Rec.Find`). Simple identifiers
   only in v1.
5. **Condition-side mutations** — `empty-block` on a guarded block, and `and` → `or`. Three of the
   eight Templates hangs are these, and they are not assignment mutations at all.

So the honest claim: this catches about **5 of the 8** measured real-world hangs and **0 of the 2**
synthetic fixture ones, and the fixture's are excluded by design rather than by oversight.

### 3.3 A prerequisite, from R196

Measure the claim rate on the reference corpus BEFORE shipping, and treat it as a HALT, not a
formality. With tagging rather than refusal the bar differs — a false tag costs an unmutated rerun
only if that mutant actually times out — but a rate in the thousands would mean the rule is wrong,
not merely broad. The plan's first step produces this number and the design does not proceed past
it without a decision recorded against it. Report alongside it how often the symbol fallback fired
(§3), because a high fallback rate means the tag rests on name matching rather than on identity.

## 4. The tag, and how it travels

`MutationSpec.hangCapable?: HangCapableReason` — a named union, not a boolean, so the report can say
WHICH rule fired. v1 has one value, `"loop-condition-target"`; §3.2's widenings would add
`"loop-body-target"`, `"loop-preheader"`, `"callee-global"`, each with a different confidence and
failure mode that a boolean would flatten.

It travels the path `platformKillMechanism` already proves: operator → `MutationSpec` →
`MutantManifestEntry.hangCapable?: string` (beside `platformKillMechanism`, `project.ts:178`,
populated at `:479`) → orchestrator → `MutantOutcome.hangCapable?` with an explanation table shaped
like `PLATFORM_KILL_MECHANISM_EXPLANATIONS`. The full R86 ripple applies and is enumerated in the
plan rather than discovered halfway: `events.ts`, `report-fold.ts`, `report.ts` type/builder/banner,
`generate-schemas.ts`, `schemas.test.ts`, the `report-equality` snapshot, and `explain`'s projection.

## 5. The forced stop, announced

The orchestrator attaches the stop hook for a tagged mutant regardless of `--stop-hung-sessions`,
and says so twice:

- **once at session start**, naming the count: "N hang-capable site(s) found. If one exceeds its
  budget LethAL will end that BC session, because the alternative is a stranded tier. This happens
  whether or not `--stop-hung-sessions` was passed."
- **in `validity.caveats`**, so a reader of the report alone learns it too.

This is the answer to sol's objection that the opt-in exists for an operational reason — ending a
session on the user's own server — which a site tag does not remove. We still end a session the user
did not ask us to end; what changes is that they are told in advance, with the count and the reason.
The justification is that at a tagged site the alternative is not "nothing happens": it is a 180 s
burn, a quarantine, a manual lease reset, a redeploy and a resume, which leaves the container in a
worse state and blocks every mutant behind it.

**Two things it does not do.** It does not change the budget: a tagged mutant gets the same
`2 × baseline`, floor 180 s, so a slow one keeps its full allowance before anything is ended. And it
does not force the stop for UNTAGGED mutants, so R89's `SetCurrentKey` scan is untouched and keeps
stranding exactly as today unless the user opts in.

## 6. Scoring, and what the confirmation can honestly prove

A tagged mutant that times out scores `timeout-killed`.

**The confirmation is a stability check, and nothing more.** Run the killing test unmutated and
require it to PASS. That rejects a broken or flaky test, order sensitivity, and session
contamination. It is NOT additionally required to complete inside its budget, because that would
prove nothing:

| mutant | unmutated replay |
|---|---|
| genuinely infinite | finishes in 2 s |
| finite, 240 s against a 180 s budget | finishes in 2 s |

Both pass. An earlier draft of this design proposed exactly that budget check as a false-kill guard;
sol showed it does not discriminate, and this repository holds the counterexample class already —
R89's `void-method-call` deleting a `SetCurrentKey` did not hang, it made the query scan, off a
near-zero baseline. **There is no finite-time discriminator between "infinite" and "finite but
longer than this deadline."** R206's warm-timeout check is not the same thing and is not weakened by
this: there the budget comparison separates a WARM session from a cold one, which is a real
comparison with a real control.

So the policy, which is R53's existing one stated explicitly rather than newly invented: exceeding a
generous budget is itself observable misbehaviour and is scored. The report says what the evidence
is — a tool-enforced timeout, not an assertion kill — which the existing `stop-hung-sessions` caveat
already words correctly.

A killer that FAILS unmutated is today's `unstable`; no new cause is invented for it. This is new
protection either way: a position-1 timeout has no confirmation at all today.

## 7. The gate

The hang fixture has NO arm in the classifier's shape — both its hangs route through a call and are
excluded by §3.2 — so one is required. It gives a differential inside a single fixture, on the
**OFF leg**, which is where the new behaviour lives:

- the existing through-a-call hangs are UNTAGGED, so they still strand and quarantine, as today;
- the new arm's hang is TAGGED, so the stop is forced despite the flag being off, and it is scored
  `timeout-killed`.

One fixture, one leg, two hangs, opposite outcomes, and the only difference is the classifier. A
build whose tag never fires loses the second and the OFF leg strands as it does now; a build that
over-forces loses the first. The arm must also carry a tagged mutant that does NOT hang, so the
over-approximation is exercised and shown to cost nothing.

**What moves:** the hang gate's `EXPECTED_ON`, its `timeoutKilled` pin, and its OFF-leg
expectations. `tables`, `bcdev` and `alrunner` are predicted UNCHANGED in verdict — a tag changes
nothing unless the mutant times out — and that prediction is pre-committed and checked, not assumed.

**Red-check, required before it lands:** remove the tag and confirm the OFF leg strands again;
disable the forced stop and confirm the tagged hang stops being scored. A gate that cannot fail
proves nothing.

## 8. What refuses this design

- A tagged site whose timeout is scored `killed` rather than `timeout-killed`, or scored at all
  without the unmutated killer passing.
- A forced stop with no announcement at session start and no caveat in the report.
- Any claim, in code comment or report, that an excluded shape (§3.2) cannot hang.
- A classifier that reads values rather than symbols and syntax.
- Verdict movement on `tables`, `bcdev` or `alrunner`.

## 9. Out of scope, and filed separately

- The four widenings in §3.2, in that order, each separately measured.
- A correction to a false statement in shipped code, found by sol during this review:
  `empty-block.ts:43-66` says a `while` body "must" advance its condition so emptying it "CANNOT
  terminate". That is untrue for a self-advancing condition such as `while Rec.Next() <> 0 do`, and
  the same overstatement appears in the `DrainQueue` fixture commentary. The cession itself remains
  correct as a conservative policy; only its stated reason is wrong. Worth fixing whether or not
  this design ships.
