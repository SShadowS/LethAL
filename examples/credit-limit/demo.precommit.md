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

## Amended 2026-08-26 by R159: the stage is re-frozen at 42 mutants

`lethal.shift-integer` ships (Tier 1, 1.0.0). One site here: `WouldExceedLimit`'s
`if "Credit Limit" = 0`, shifted to `= 1`.

**Killed, by `NoCreditLimitMeansNoBlock`**, and predicted killed in the spike before the run. It is
the same test and the same branch `flip-boolean-literal` reached from the other side, which is the
part worth reading: the zero-limit customer stops short-circuiting, exposure of 400 exceeds a limit
of 0, and the order the test expects to register is blocked. Two operators, one branch, one test,
and both kills are earned rather than incidental.

Totals 41 -> 42, killed 22 -> 23; survivors and no-coverage are unchanged at 8 and 11. The score
rises from 73.3% to **74.2%**, the right direction for an arm that adds one kill and no survivors.

The re-run behind this freeze was executed TWICE against Cronus283 and the two runs are per-mutant
identical, so the demo is reproducible and not merely recorded.

## Amended 2026-10-23 by R-560c: re-frozen at the current identity scheme, on bc1 (written before the run)

**Why.** R560: this stage predates R556 and R355. Its baseline records no identity scheme, no mutated-text hash
and no coverage mode, so a mutant changed under an unchanged key is not caught here. Only a fresh live run can add
them (`campaign freeze` refuses a report with no `coverageMode`).

**The run, twice.**
- **Server:** bc1 (BC 28.4 W1, company `CRONUS International Ltd.`), under lane bugs' coord lease. Cronus283 is gone.
- **LethAL:** branch `lethal/r560c`, head `dba8db9d327bae3f92b83348a7bd1a0331239f5b`, from source.
- **Setup:** `bun scripts/r560c-credit-limit-setup.ts --server bc1`. It writes the gitignored
  `lethal.config.bc1.json` (selector ids 90297-90299) and publishes credit-limit and credit-limit-tests in Dev
  scope, by content.
- **Command:** `lethal run --project examples/credit-limit --tests examples/credit-limit-tests --backend bcdev
  --config examples/credit-limit/lethal.config.bc1.json --out <scratch>/demo.report.json --progress-out
  <scratch>/demo.events.ndjson`, with the default coverage mode (`fenced`).

**Prediction: per-mutant identical to the committed `demo.baseline.json`.**
- 46 sites, 42 deployed. Checked offline at this head: the dry run gives 46 and 42, with the same operator counts
  as the baseline's keys.
- A 5-test baseline, all green. Killed 23, survived 8, no-coverage 11, error 0. The same verdict, `killingTest`,
  `coverageFiltered` and `errorClass` for every key.

**The check, in this order.**
1. Run 1, then `lethal campaign compare --manifest examples/credit-limit/campaign.json --stage demo --report <run 1>`
   against the committed baseline. It must report a per-mutant match. Its identity and coverage-mode UNVERIFIED notes
   are expected: the stage records neither.
   - **Any per-mutant difference is a BLOCK.** Archive the report as `demo.mismatch.report.json`, re-freeze nothing,
     and report it.
2. On a match: delete `demo.baseline.json` and run `lethal campaign freeze --stage demo` on run 1. Review the diff:
   the same keys, and per key the same verdict, `killingTest`, `coverageFiltered` and `errorClass`. Only
   `identityScheme`, `coverageMode` and the per-row `mutatedTextSha256` are new.
   - A key that changes, appears or disappears is a BLOCK, as above.
3. Run 2, then `campaign compare` against the new baseline. It must match per mutant, with every row's text checked.
4. Commit: the new baseline, `demo.report.json` and `demo.events.ndjson` from run 1, and the README's measured-result
   section updated to run 1's figures and server.
