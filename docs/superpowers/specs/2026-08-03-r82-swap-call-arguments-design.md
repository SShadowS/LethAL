# R82 — `SwapCallArguments`: operator, fixture, and what the live run may and may not conclude

Status: **IMPLEMENTED AND MEASURED 2026-08-03. All 30 pre-committed per-mutant predictions in §5
matched the live run, exactly** — `itest:tables` 84/12/10 over 106 to 109/17/10 over 136, twice.
Results and the arm-E artifact text: `docs/measurements/README.md` §"R82 live". Two things the run
added that this document did not anticipate: the arm-E kill text is PROSE that will localise (R66's
class of problem), and **no kill records its cause at all** — `failure_note` is NULL for all 109 —
filed as R86, which makes it R85's precondition. Original status line: design, pre-implementation. Supersedes nothing. Reviewed by Fable 2026-08-03 (three
amendments adopted: the pre-committed prediction table, the false-kill and R84-refusal and
expression-position arms, and "mechanism proven / rate open" as the closure wording).

## 0. What is already settled, and what this document is for

Measured and committed (`b64ec15`, `docs/measurements/README.md` §R82): on `do-rel2/Cloud` the
operator has **893** candidate sites under the rule pre-committed at `ef28f58`, of which **340** are
provably type-safe from source alone. That is 26x bar (a)'s >= 13, so **R82 cannot be refused on
cost**. Boolean/Boolean — the equivalence-risk slice — is 40 of 340 (11.76%).

The only open gate is killability. This document specifies the operator, the fixture that measures
it, and — importantly — the three separate claims the word "killability" is carrying, because the
fixture can settle only one of them.

## 1. Three claims, and which one the fixture settles

| claim | status | who can settle it |
|---|---|---|
| (a) swapping two different values can change a callee's behaviour | **tautological** | nobody needs to; do not dress this up as a measurement |
| (b) the operator, through the full pipeline, claims the right sites, emits an artifact that compiles, coexists with `void-method-call` under dedup, is attributed, and produces BOTH verdicts, scored correctly | **falsifiable, and the point of the fixture** | `itest:tables`, live |
| (c) real suites notice real swaps at a rate that justifies shipping | **unmeasurable at fixture scale** | a real project run, filed separately as R85 |

R82's pre-committed gate wording was *"does a swapped call ever change a verdict, measured live"* —
an EXISTENCE claim. The fixture satisfies its letter. Hardening it to a rate bar now would break the
pre-commitment discipline in the other direction, so the bar stands and the CLOSURE WORDING carries
the limit: **"mechanism killability proven live in both directions; rate on a real project
unmeasured."** Never "killability measured".

What keeps (b) from being a demo is that the platform sits between the construction and the verdict.
R73 is the precedent: `remove-commit` M0012 was PREDICTED killed from a measured write-transaction
refusal and came back **survived**, and that contradiction was the finding. So §5 pre-commits a
per-mutant prediction table BEFORE the live run. A run that can contradict its author is an
experiment; one that cannot is a demo.

## 2. The operator

`lethal.swap-call-arguments`, **tier 1**, in `@lethal/builtin-tier1`. Tier 1 is design.md §4's
"generic, evidence-based" set and an argument-order swap is a classic generic operator; nothing
about it is AL-specific. It declares `requiresSemantic: ["symbol-table"]`, which no tier-1 operator
has needed before — that is a property of the operator, not of the tier.

### 2.1 Predicate

Claim a `call_expression` iff ALL hold:

1. it carries an `argument_list` with >= 2 arguments;
2. some pair (i, j), i < j, are BOTH bare `identifier` nodes;
3. both resolve to the SAME declared type, compared on the FULL declaration (R84), not the
   truncated head;
4. their whitespace-normalised source text differs;
5. `isMutableSite` — there is an enclosing statement to wrap.

One mutant per site, on the lexicographically first qualifying (i, j). A call with three
same-typed arguments admits more swaps than are emitted; that is the pre-committed counting rule
and it is a deliberate under-count, not an oversight.

### 2.2 Why bare identifiers only — this is the type-safety proof, and it is narrower than it looks

If the call compiles today, argument A fits parameter *i* and B fits *j*. When A and B share a
declared type, A fits *j* and B fits *i* too, so the swap is COMPILE-safe whatever the callee's
signature is. The one hazard the arguments cannot settle is a **`var` parameter**: AL matches those
by exact type and refuses a non-lvalue. Restricting to bare identifiers makes both members lvalues
of one exact type, which discharges it without resolving the callee.

**That proves compile-safety and nothing else.** §4 arm E is the counterexample that keeps this
honest: two `Code[20]` variables passed to a callee whose second parameter is `Code[10]` compile
fine both ways and the swapped call dies at RUNTIME on a length overflow. The operator will
manufacture such sites on a real project; the census cannot exclude them because it deliberately
never resolves the callee.

### 2.3 Emit form — the first two-point edit in the product

Every shipped operator replaces or deletes ONE contiguous span. A swap moves two spans, and dedup
identity is `kind:start:end:after.text` (`packages/schemata/src/dedup.ts:23`) with one span per
spec. So the spec's `before` is the whole `call_expression` and its `after` is that node's text with
both argument spans substituted — the text BETWEEN the arguments (commas, comments, whitespace) is
carried through untouched, exactly as `swap-modify-flag`'s `replaceArgument` carries the rest of the
call. Splice the LATER span first so the earlier span's offsets stay valid.

Consequence, and it is the reason a hand-edit measurement would prove nothing (§6): whether
`emitDispatch`, the guard chain and dedup behave for an after-text spanning argument commas is a
pipeline question, unanswerable by editing AL by hand.

### 2.4 Not restricted to statement position

452 of the 893 DO sites (the majority) are NOT in statement position. `swap-modify-flag` already
established that an argument rewrite is safe outside statement position — it changes no
control flow, unlike a deletion — and restricting there would gate the minority shape. Arm B is the
fixture's expression-position site.

### 2.5 Dedup

At a statement-position site, `lethal.void-method-call` deletes the call (`after.text` empty) while
this operator rewrites it. Different identity, so both mutants coexist and the site carries TWO
mutants. This is the same coexistence `swap-modify-flag` documents, and it is what makes R82's
"marginal == gross" true rather than argued — arm A pins it live.

## 3. R84 is on the critical path

`extractType` (`packages/engine/src/semantic/types.ts`) keeps only the first whitespace-delimited
token, so `Record "Sales Header"` and `Record "Purchase Header"` both answer `Record`. Measured:
135 of the 893 sites (15.1%) are same-head-different-type. An operator trusting that answer emits
an artifact that fails `alc` on a real project — after the expensive part.

Fixed here rather than worked around in the operator, because the type table should have one answer
for the whole product:

- keep the FULL declaration text, whitespace-collapsed;
- `Label 'Posting…'` and `Label 'Done'` normalise to `Label` — same type, different constant, and
  comparing raw declarations would reject a safe swap. (A `Label` declares as `basic_type` +
  `string_literal`, NOT `type_specification`; reading only the latter silently drops every Label,
  which the census hit and its own discrepancy check caught.)
- `Code[20]` and `Code[10]` stay DISTINCT. Conservative: it refuses some safe swaps, and arm E
  shows why the conservative direction is the right one.

No shipped code reads `ctx.types` today (only its own unit tests), so this change cannot regress a
verdict. It is red-checked: reverting it must turn a specific new test red.

## 4. The fixture — six arms, in `fixtures/sandbox-data`

New target codeunit **79311 "Data Swap Ops"**, new tests in `Data Tests` (79310). `sandbox-data`
feeds ONE frozen gate; `sandbox-app` feeds three (`itest:bcdev`, `itest:alrunner`, `itest:envtool`),
so it is not touched — and that is verified offline, not assumed, before the live run.

| arm | shape | what it is for | predicted verdict |
|---|---|---|---|
| **A** | `Accumulate(var Total: Decimal; Delta: Decimal)` called as `Accumulate(Total, Delta)`, statement position, both bare Decimal locals; test asserts the running total | the KILL, and the live proof of §2.2's `var`-parameter argument — the swapped call must COMPILE and must redirect the writeback. Also pins §2.5 coexistence: this site carries a swap mutant AND a `void-method-call` mutant | killed |
| **B** | `InRange(Value: Integer; Limit: Integer): Boolean` called inside `if InRange(Amount, Cap) then`, EXPRESSION position | the majority shape (452 of 893). Proves emit + scoring outside statement position | killed |
| **C** | `RecordFlags(FlagA: Boolean; FlagB: Boolean)` whose body is commutative (`or`), covered by a test that asserts the result | the EQUIVALENT survivor — `swap-modify-flag`'s problem, measured rather than feared | survived |
| **D** | `StampCodes(Primary: Code[20]; Secondary: Code[20])` writing its two arguments to two DIFFERENT fields; covering test asserts neither field | the UNDERTESTED survivor. Distinct from C: the mutant is observable, the suite just does not look. Both flavours must be readable apart, because the real-project report will be full of them | survived |
| **E** | two `Code[20]` locals into `NarrowStamp(Wide: Code[20]; Narrow: Code[10])`, under a test that asserts NOTHING | the FALSE-KILL arm. Compiles both ways; the swap sends the long value into `Code[10]` and BC raises at runtime, so a test with no assertion still kills | killed, by a platform artifact — **not** by an assertion |
| **F** | `Link(Main: Record "Data Main"; Related: Record "Data Related")` called with two bare record vars, statement position | the R84 REFUSAL negative. Truncated heads match, full types differ; the operator must refuse. If it ever claims the site the artifact fails `alc` and the gate fails loudly — the same shape R70 used to make a silent precedence bug visible | no swap mutant; the site keeps its `lethal.void-method-call` mutant, whose verdict is pinned |

Arm E's definition of a false kill, worth stating because it is sharper than "a kill for the wrong
reason": **a false kill is one a WEAK test still produces.** Pairing E with an assert-nothing test is
what makes the property measurable rather than asserted. Per R72's discipline the verdict STAYS
`killed` — a diagnosis must not move a verdict (design.md §6.7) — and no detector is built until a
real artifact text exists. Arm E produces that text.

A kill from the callee's own `TestField`/`Error` firing on a swapped value is NOT in this category:
that is production validation detecting a bad state, the signal `remove-testfield` already trades
in. The distinction matters for reading a real-project report, so R85 must split kills by cause.

Not measured live, because it is free offline: pair-choice determinism at a three-same-typed-argument
site. Unit test in spec generation.

**Collateral.** Every new callee brings tier-1 mutants (`return-value`, `void-method-call`,
`conditional-boundary`, `empty-block`). Each one gets a row in the §5 table or it arrives at the
gate as an unexplained baseline entry — the failure mode R30's growth avoided by naming every new
key in advance.

## 5. The pre-committed prediction table

Every new mutant key with its predicted verdict and the mechanism that produces it, written BEFORE
the live run. The run either matches or contradicts it; a contradiction is a FINDING and gets
written up as one, R73-style, not quietly reconciled.

Offline, before any of this was predicted: `--dry-run` puts the fixture at **148 raw specs**, up 30
from 118, all 30 in `src\DataSwapOps.Codeunit.al`. `fixtures/sandbox-app` measured **16 sites,
unchanged**, so `itest:bcdev`, `itest:alrunner` and `itest:envtool` are untouched — measured, not
assumed. And all five swapped calls COMPILE: a scratch copy of the fixture with every swap applied
by hand went through `alc` with zero errors and zero warnings, which is what makes arm E a runtime
event rather than a compile error.

| line | operator | predicted | mechanism |
|---|---|---|---|
| 43 | empty-block | killed | `RunningTotal` returns 0, not 15 |
| 46 | void-method-call | killed | no accumulation; `Total` stays 10 |
| **46** | **swap-call-arguments (ARM A)** | **killed** | writeback redirected into `Delta`; `Total` stays 10 |
| 47 | return-value | killed | `exit(0)` |
| 51 | empty-block | killed | `Accumulate` does nothing |
| 68 | empty-block | killed | `AmountWithinCap` returns false for the true case |
| 69 | return-value | killed | Boolean flip, caught by the true case |
| **69** | **swap-call-arguments (ARM B)** | **killed** | `InRange(Cap, Amount)` answers false for (5, 10) |
| 73 | empty-block | killed | `InRange` returns false |
| 74 | return-value | killed | Boolean flip |
| 74 | conditional-boundary | killed | `<=` -> `<` fails ONLY the (7, 7) assertion |
| 91 | empty-block | killed | no flag recorded |
| 92 | void-method-call | killed | no flag recorded |
| **92** | **swap-call-arguments (ARM C)** | **survived** | `or` is commutative — equivalent by construction |
| 96 | empty-block | killed | no flag recorded |
| 97 | negate-conditional | killed | `or` -> `and` gives false for (true, false) |
| 115 | empty-block | killed | no stamp; the weak assertion still catches a blank |
| 116 | void-method-call | killed | same |
| **116** | **swap-call-arguments (ARM D)** | **survived** | 'S1' instead of 'P1' is still non-blank — the assertion does not look |
| 120 | empty-block | killed | no stamp |
| 145 | empty-block | **survived** | the covering test asserts nothing |
| 146 | void-method-call | **survived** | same — the control for arm E |
| **146** | **swap-call-arguments (ARM E)** | **killed, by a platform error** | 18 characters into a `Code[10]` parameter |
| 150 | empty-block | **survived** | same |
| 175 | empty-block | killed | `PrimaryStamp` is not 'M1' |
| 178 | void-method-call | killed | same |
| **178** | **swap-call-arguments (ARM F)** | **NO MUTANT** | different record subtypes; the operator must refuse |
| 182 | empty-block | killed | same |
| 195 | empty-block | killed | `PrimaryStamp` returns blank |
| 200 | empty-block | killed | `AnyFlagSeen` returns false |
| 201 | return-value | killed | Boolean flip |

**Totals predicted: 25 killed, 5 survived, 0 no-coverage over 30 new mutants**, taking the frozen
gate from 84/12/10 over 106 to **109/17/10 over 136**.

The two ways this is most likely to be WRONG, named in advance so neither can be reinterpreted
afterwards:

1. **Arm E may survive instead.** The prediction is that BC raises on a `Code[20]` value entering a
   `Code[10]` parameter. If the platform TRUNCATES silently, the swap is unobservable to a test
   that asserts nothing and the mutant survives. Either result is a finding: the first gives the
   false-kill artifact text a future detector needs, the second retires a hazard this spec asserts.
2. **Attribution, not verdicts.** These mutants live in a codeunit reached directly from the test
   body, so procedure-level coverage should attribute them. If the fence attributes at object level
   only, some predicted kills arrive as `no-coverage` — a coverage finding, not an operator one,
   and it must be reported as such rather than absorbed by adjusting the fixture.

Ordering, and the reason: **fixture AL and operator land in ONE freeze.** Landing the fixture first
would move the frozen counts once for collateral tier-1 mutants and again when the operator ships —
two live re-freezes, and `itest:tables` runs the whole session TWICE per invocation (R9
determinism). The offline red/green loop needs no live run.

Before the live run:

1. `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`.
2. `bun run compile:fixtures` — nothing else compiles fixture AL (R56).
3. Offline `--dry-run` on `fixtures/sandbox-app`: raw spec count and per-spec keys UNCHANGED, so the
   other three gates stay untouched. Measured, not assumed.
4. Offline `--dry-run` on `fixtures/sandbox-data`: the new keys are exactly the predicted ones.
5. Republish the target and tests apps.
6. `LETHAL_ITEST_TABLES=1 bun run itest:tables`, re-record `tables.baseline.json`, and REVIEW the
   diff — re-recording is the one operation that can silently bless a regression
   (`packages/runner/itest/tables.itest.ts:92-95`).

## 6. Why not measure by hand-editing the AL first

Because for THIS operator the cheap measurement answers the tautological claim. R13's A8 hand-probe
was right because its unknown was the PLATFORM; here the platform question is (a), and every
falsifiable claim is a pipeline claim — including §2.3's two-point edit, which no hand-edit
exercises. Hand-editing has exactly one honest use, and it is on a real project, not the fixture:
see R85.

## 7. R85 — the rate, filed before anyone sees one

The fixture cannot produce a rate. The instrument that can, without self-construction: hand-swap a
pre-committed SEEDED random sample of the 340 provable DO sites, run Continia's own suite per swap,
and count how many the suite notices. It exercises none of LethAL, which is the point — it measures
the half the fixture cannot. Its bar is pre-committed BEFORE any rate is seen, per R13's discipline.
If DO's suite is not runnable that way, the rate stays open as a post-ship LethAL-on-DO run and the
row says so — R30's "partly done; measured value on a real project is +2" is the honest phrasing.
