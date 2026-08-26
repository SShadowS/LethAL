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

---

## 6. AMENDED: the cession fixed, and a kill measurement pre-committed

Nothing above is edited. §5's Cronus281 run stands; this adds what it could not show.

### The cession is now exact, in both directions

`receiver.ts` moved from `builtin-tier2/src/` into `packages/engine/src/semantic/`, and the cession
asks `claimsRecordMethod` — the predicate `swap-modify-flag` itself claims with — instead of
restating it. Neither tier package depends on the other, so nothing inverted; 10 Tier-2 files now
import it from `@lethal/engine`.

That alone was not enough, and the second correction is the interesting one. `swap-modify-flag`
claims the SKIP direction (an explicit `true`) or the argument-less call. It has no `false` -> `true`
direction at all, so `Rec.Modify(false)` is claimed by nobody — and ceding it left a second hole:

| cession | claimed | duplicates | ORPHANS |
| --- | ---: | ---: | ---: |
| by method name | 3,456 | 0 | **55** |
| by `claimsRecordMethod` | 3,472 | 0 | **39** |
| by `claimsRecordMethod`, `true` only | **3,511** | **0** | **0** |

### Pre-committed verdicts, Cronus283

`credit-limit` (1 site) and `sandbox-data` (13, up from 6 now that the `false` forms are no longer
ceded away). `sandbox-app` and `sandbox-hang` still have 0, so `itest:bcdev`, `itest:alrunner` and
`itest:hang` cannot move.

| # | site | mutation | predicted |
| --- | --- | --- | --- |
| C1 | `credit-limit` `WouldExceedLimit:34`, `exit(false)` | -> `exit(true)` | **killed** — the suite has a zero-limit customer (`CreateCustomer('C-10000', 0)`), and a flipped guard blocks the order it should allow |
| D1 | `Data Commit Ops.CommitThenFail:38`, `Insert(false)` | -> `Insert(true)` | **killed** — `Data Main.OnInsert` doubles `Amount`, and the persisted amount is asserted |
| D2 | `CommitThenRun:52`, `Insert(false)` | -> `Insert(true)` | **killed** — same shape |
| D3 | `CommitThenRunValueForm:89`, `Insert(false)` | -> `Insert(true)` | **killed** — same shape |
| D4 | `Data Commit Target.OnRun:17`, `Flagged := true` | -> `false` | **killed** — two tests assert `Flagged` persists |
| D5 | `Data Commit Target.OnRun:18`, `Modify(false)` | -> `Modify(true)` | **survived** — LEAST CONFIDENT. Runs `Data Main.OnModify`, whose effect on an asserted field I did not trace |
| D6 | `Data Ops.MarkProcessed:68`, `Processed := true` | -> `false` | **killed** — asserted by name |
| D7 | `Data Ops.MarkWithFlag:80`, `Processed := true` | -> `false` | **killed** — asserted by name |
| D8 | `Data Ops.InsertWithoutTrigger:92`, `Delete(false)` | -> `Delete(true)` | **survived** — the only covering test deletes the row first, so `Get` is false and the branch never runs (R161, R171) |
| D9 | `Data Ops.InsertWithoutTrigger:96`, `Insert(false)` | -> `Insert(true)` | **killed** — `InsertWithoutTriggerKeepsAmount` asserts the amount is NOT doubled |
| D10 | `Data Scope Probe.OnValidate:61`, `Bumped := true` | -> `false` | **killed** — asserted by name |
| D11 | `Data Trigger Probe.OnInsert:53`, `"Inserted By Trigger" := true` | -> `false` | **killed** — the arm asserts this field |
| D12 | `Data Trigger Probe.OnDelete:61`, `Tombstone := true` | -> `false` | **killed** — `DeleteRunTriggerLeavesTombstone` asserts the tombstone |
| D13 | `Data Trigger Probe.OnDelete:62`, `Tomb.Insert(false)` | -> `Insert(true)` | **survived** — runs `OnInsert` on the TOMB row, setting a field the tombstone assertion does not read |

Derived for the narrowed `sandbox-data` run: **10 killed, 3 survived, 0 no-coverage** over 13.
`credit-limit` moves 32 -> 33 recorded with one more kill: killed 17 -> 18, score 70.8% -> **72.0%**
(18 of 25 scored).

**This is the measurement §5 could not make.** If the kills land, a flipped boolean is demonstrably
killable by an ordinary BC suite. If they do not, the operator is emitting mutants nothing separates
and the recommendation changes.

---

## OUTCOME of §6, appended after the runs. Nothing above is edited.

### The question this spike existed to answer: YES

`credit-limit`, Cronus283 — **C1 killed by `NoCreditLimitMeansNoBlock`**, exactly as predicted, and
the score moved 70.8% -> **72.0%** as derived. A flipped boolean is killable by an ordinary BC suite.

### `sandbox-data`: 9 of 13 matched, and the 4 misses are the interesting part

Predicted 10 killed / 3 survived. Measured **6 killed / 7 survived**. Every correct prediction of a
SURVIVOR held (D5, D8, D13). Every miss went the same way — I credited the suite with an assertion it
does not make:

| # | predicted | measured | why I was wrong |
| --- | --- | --- | --- |
| D1 | killed | **survived** | `Insert(false)` -> `Insert(true)` runs `Data Main.OnInsert`, which doubles `Amount`. `CommitBeforeCodeunitRunSucceeds` asserts the row EXISTS and that `Flagged` is set. It never reads `Amount`. |
| D2 | killed | **survived** | same |
| D3 | killed | **survived** | same |
| D12 | killed | **survived** | `DeleteRunTriggerLeavesTombstone` asserts the RETURN VALUE of `DeleteWithTrigger`, not the tombstone's `Tombstone` field, so flipping that assignment is invisible |

**Those four survivors are findings about the FIXTURE, not about the operator.** `sandbox-data` is
the most worked-over suite in this repository — 259 mutants, thirteen operators, six re-freezes — and
a boolean flip found four behaviours nothing asserts. That is the product working on its own test
data.

It also means the operator is not redundant with `empty-block`, which was R159's point 2 and the
strongest argument against building it: a whole-block deletion of these procedures IS killed, while
the fine-grained boolean flip is not. Coarse and fine disagree at the same sites, which is
discrimination evidence no count could fake.

Scored alone on that fixture the operator reads 46.2% — over half its mutants survive. On a mature
suite that is a signal worth having, not noise.

### Verdict

**Build it.** Every question a spike can close is closed: 3,511 claimed sites against a bar of 13,
zero duplicates and zero orphans after the cession fix, compile-proven on both halves, 9 conformance
cases, and live runs on two containers where the kill question is now answered YES with a named
killing test.

Landing cost, measured: `itest:tables` +13, `credit-limit` +1, the gift-card demo +2.
`itest:bcdev`, `itest:alrunner` and `itest:hang` cannot move.

The build's pre-commitment must carry all 16 verdicts, and the four D-row corrections above are the
measured values to use — not the predictions that produced them.
