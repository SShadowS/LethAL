# R159 spike: is `flip-boolean-literal` worth building?

Written before the live half. §5's verdicts were fixed before the operator was registered anywhere.

## 1. Why this candidate

`scripts/census-node-kind-coverage.ts`, re-run 2026-08-26 on `do-rel2/Cloud`: **23 behaviour-carrying
node kinds are claimed by no operator, over 20,265 occurrences**. That is down from R159's recorded
26 / 26,865, and the difference is exactly `if_statement` + `unary_expression` +
`additive_expression` — now claimed by `negate-guard`, `remove-not` and `swap-additive`.

`boolean` is the largest remaining kind that a single, standard operator covers: 3,620 occurrences,
and `true`↔`false` replacement is a staple of every comparable tool.

## 2. The marginal number took three measurements, and the two wrong ones matter

R159's own point 1 says overlap must be measured per candidate rather than assumed away. It took
three attempts to measure it correctly:

| measure | result | why it is wrong |
| --- | ---: | --- |
| literal sits INSIDE a span another operator claims | 26 marginal | `empty-block` claims the enclosing block of nearly every boolean. R159's point 2 says exactly why this is not overlap: a whole-block deletion is coarse and the fine-grained mutant is what separates suites. §3.2 displaces on the SAME site, not a containing one. |
| EXACT span match only | 3,594 marginal | misses a real duplicate: `swap-modify-flag` claims the CALL `Rec.Modify(true)`, not the literal inside it, so the spans differ while the mutation is identical |
| exact match, plus ceding the run-trigger flag | **3,456 claimed** | the number this operator actually emits, after both refusals in §3 |

Cross-checked in both directions on the corpus: **0** sites are claimed by this operator AND inside a
`swap-modify-flag` call, so the cession leaves no duplicate.

## 3. Two refusals, both of which had to be MEASURED

The first draft claimed it compiles "by construction" because `true` and `false` are the only two
values of AL's `Boolean` type. That argument is true and it was not sufficient, twice — the same
shape as `swap-multiplicative`, whose proof was true about its operands and silent about the result
type.

**Case labels (AL0402).** `case F of true: ... false: ... end` — flip either label and both branches
carry the same one, which `alc` rejects. The naive compile probe failed 2 of 10 shapes on it. True
about the TYPE, silent about the CONTEXT: a case label must also be unique among its siblings.

**Declarative surfaces, caught only by the EMIT path.** The first draft refused `label_attribute`
alone, because that is what the corpus census showed. The instrumented artifact then failed to build:
`resolveSite: no enclosing statement for node at 271..275`, which was `Clustered = true` on a table
key. A property value has no statement to wrap a runtime guard around. **The naive splice could never
have found this** — `Clustered = false` is perfectly valid AL — and it is the clearest argument yet
for running both compile halves. The refusal is now an ALLOW-list ("must be inside a procedure or
trigger body"), because a deny-list of declarative parents is only ever as complete as the last
person's memory.

## 4. Compile, both halves, after those fixes

- **Naive splice**, mutant text from the operator's own `generate()`, one `alc` run each against a
  probe project carrying every position the corpus contains: **7 of 7 compile**, on a baseline proven
  clean first.
- **Real emit path**, `writeInstrumentedProject` with the operator beside every shipped Tier-1 and
  Tier-2 operator: **artifact compiles, 0 errors**, and the probe refuses to report a pass unless it
  finds the emitted dispatch, which it prints.
- **Conformance: 8 cases, PASS**, including four refusals — case label, table property, and both
  ceded run-trigger flags — plus a control proving a boolean argument to some OTHER method is still
  claimed.

## 5. Live half, pre-committed

Sites per fixture, measured: `gift-card` **2**, `sandbox-app` **0**, `sandbox-data` **6**,
`credit-limit` **1**. So `itest:bcdev` and `itest:alrunner` cannot move at all.

Cronus281's demo is the cheap probe, and its two sites are both in `BlockExpiredCards`:

| # | site | mutation | predicted | why |
| --- | --- | --- | --- | --- |
| G1 | `Gift Card Mgt.BlockExpiredCards`, `GiftCard.SetRange(Blocked, false)` | `false` -> `true` | **no-coverage** | no test calls `BlockExpiredCards`; its other eight mutants are already `no-coverage` |
| G2 | `Gift Card Mgt.BlockExpiredCards`, `GiftCard.Blocked := true` | `true` -> `false` | **no-coverage** | same procedure, same reason |

Derived: 45 recorded -> **47**, killed 26 unchanged, survived 11 unchanged, no-coverage 8 -> **10**,
scored 37 unchanged, mutation score **70.3% unchanged** (a `no-coverage` row is excluded from it).

**Stated plainly: this run cannot measure kill behaviour.** Both predicted verdicts are
`no-coverage`, so what it proves is that the operator survives a real generate → instrument →
compile → publish → execute cycle against a live server, and that it lands where predicted. Whether
an existing suite KILLS a flipped boolean is unmeasured here, and the sites that would measure it are
`credit-limit`'s `WouldExceedLimit` and `sandbox-data`'s six, both on Cronus283.

---

## OUTCOME, appended after the run. Nothing above is edited.

**Both pre-committed verdicts matched**, on Cronus281:

```
M0036  src\GiftCardMgt.Codeunit.al:62  lethal.flip-boolean-literal  no-coverage
M0040  src\GiftCardMgt.Codeunit.al:66  lethal.flip-boolean-literal  no-coverage
score: 70.3%  (killed 26, survived 11, no-coverage 10, error 0)
```

47 recorded, killed 26 and survived 11 both unchanged, no-coverage 8 -> 10, score unchanged at
70.3%. Exactly as derived, including the score staying put because a `no-coverage` row is excluded
from it.

The operator survives a real generate → instrument → compile → publish → execute cycle against a
live BC server and lands where predicted. **Kill behaviour remains unmeasured**, for the reason §5
gave in advance rather than as an excuse afterwards: both of Cronus281's sites are in a procedure no
test calls.

## Recommendation

**Build it, but measure a kill first.** Everything a spike can settle is settled: 3,456 claimed
sites against R13's bar of 13, zero duplicate overlap, compile-proven on both the naive and the real
emit path, 8 conformance cases including four refusals, and a live run whose verdicts were predicted.

What is missing is the one thing this fixture cannot show. Before registering, run the seven sites on
Cronus283 — `credit-limit`'s `WouldExceedLimit` and `sandbox-data`'s six — with verdicts
pre-committed. `sandbox-data`'s six sit in `OnRun`, `MarkProcessed`, `MarkWithFlag` and three table
triggers, all of which its suite exercises, so that is where a kill will or will not appear.

Landing cost, measured: `itest:tables` +6, the gift-card demo +2, `credit-limit` +1.
`itest:bcdev`, `itest:alrunner` and `itest:hang` cannot move — `sandbox-app` and `sandbox-hang` have
zero sites.

## What this spike did NOT measure

- **Kill behaviour**, as above.
- **The cession's robustness.** It cedes by METHOD NAME (`Modify`/`Insert`/`Delete`) while
  `swap-modify-flag` claims by name AND a resolved Record receiver. Measured on the corpus, that
  mismatch ORPHANS 55 sites: calls named `Modify`/`Insert`/`Delete` whose receiver that operator
  cannot resolve, which this operator then refuses and nobody claims. **That is R171's seam bug
  reproduced in an operator written the same week the seam was fixed**, and it is the strongest
  argument in this document for a structural fix rather than a careful list: `claimsRecordMethod`
  should move from `builtin-tier2/src/receiver.ts` into a layer both tiers import, so ONE predicate
  decides. Neither tier package depends on the other today — both sit on `engine`, `operator-sdk` and
  `schemata` — so the move inverts nothing.
- **Equivalent-mutant rate.** A flipped boolean that no path reads is invisible to this operator, as
  it is to every Tier-1 operator.
- **One corpus, one vendor.**
