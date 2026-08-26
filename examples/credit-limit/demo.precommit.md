# Stage `demo` — freeze record for the credit limit demo

**This is not a pre-commitment, and calling it one would be a lie.** The file has that name because
`lethal campaign freeze` looks for `<stage>.precommit.md`, and the gift-card demo's file at the same
position genuinely is one: its 36 verdicts were written down before any run touched a server.

This stage was frozen from a run that had already happened. Predicting verdicts after reading them
proves nothing, so nothing here is predicted.

## What this freeze is actually worth

The README quotes specific numbers and names specific mutants by id — M0015 `remove-calcfields`
survived, M0019 `conditional-boundary` survived, M0025 `remove-setrange` survived, the Status filter
beside it killed. Until this freeze, nothing re-checked any of that. A fixture edit, an operator
change or a coverage-attribution regression could have moved a verdict and the README would have gone
on claiming the old one, which is [[R56]]'s shape: a claim no gate checks.

With a baseline committed, `lethal campaign compare` answers per mutant instead of per total.

## The one real verification behind it

The demo was first measured 2026-08-24 against Cronus283 (BC 28). It was **re-run on 2026-08-26**,
after `negate-guard` shipped and after R166 changed the identity key, and the result was compared with
`diffMutants` — the same per-mutant comparison the live gates use, not a total:

```
re-run     killed=17 survived=7 noCoverage=8 recorded=32 score=70.8%
committed  killed=17 survived=7 noCoverage=8 recorded=32 score=70.8%
per-mutant IDENTICAL
```

An independent reproduction two days and two operator changes later is worth more than a retroactive
prediction would have been. That is the evidence this stage rests on.

## What is frozen

| | |
| --- | --- |
| deployed mutants | **32** (36 raw sites, 4 displaced by tier precedence) |
| killed | 17 |
| survived | 7 |
| no-coverage | 8 |
| mutation score | 70.8% |
| baseline | 5 tests, all passing |

Three of the seven survivors are the planted gaps the README explains; two more are near-equivalent
mutants and two are a small real gap in `Credit Customer.OnInsert`. The README says which is which,
and that split is the thing a re-run must preserve — not the count.

## Amended 2026-08-26 by R159: the stage is re-frozen at 33 mutants

`lethal.flip-boolean-literal` ships (Tier 1, 1.0.0). One site here: `WouldExceedLimit`'s
`exit(false)` on the zero-limit branch, flipped to `exit(true)`.

**Killed, by `NoCreditLimitMeansNoBlock`.** The suite creates a customer with a limit of 0, which the
app treats as "no limit"; flipped, that customer always exceeds and the order the test expects to
register is blocked instead. Predicted killed in the spike before the run, and killed.

Totals move 32 -> 33 and killed 17 -> 18; survivors and no-coverage are unchanged. The score rises
from 70.8% to **72.0%**, the right direction for an arm that adds one kill and no survivors.

**A note for anyone quoting this app in writing.** The README used to name three survivors by mutant
CODE (`M0015`, `M0019`, `M0025`). This operator inserted a mutant at line 34 and every code after it
shifted by one, so all three then named a different mutant. Codes are per-run labels —
`assignMutantIds` restarts numbering per batch, which is exactly why the frozen baseline keys on the
mutated subtree's hash and never on the code. The README now names survivors by procedure and
operator instead.

## Amended 2026-08-26 by R159: the stage is re-frozen at 41 mutants

`lethal.remove-assignment` ships. Eight sites here, all MEASURED in its spike before this build:
**4 killed, 1 survived, 3 no-coverage**. The three uncovered ones are in `PostInvoice`,
`PostPayment` and `PostEntry` — the posting helpers this README already names as called by no test,
which is exactly where they should land.

Totals 33 -> 41, killed 18 -> 22, survived 7 -> 8, no-coverage 8 -> 11. Score 72.0% -> **73.3%**.
