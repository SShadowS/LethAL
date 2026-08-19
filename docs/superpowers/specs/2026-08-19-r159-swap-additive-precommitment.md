# R159 pre-commitment: `swap-additive`, and the nine mutants it adds

Written **before** the live run. A verdict that differs from this document is a finding, not a
number to update.

## The operator

`lethal.swap-additive`, Tier 1, 1.0.0. Rewrites `a + b` to `a - b` and back, only where BOTH
operands resolve to a numeric type (`Integer`, `Decimal`, `BigInteger`, `Byte`). An operand the type
table cannot answer for is REFUSED.

The multiplicative half is deliberately absent and stays a separate future operator: `x * y` to
`x / y` divides by zero whenever `y` is zero, which is a kill no test earned, and its 13 marginal
sites do not pay for the screen that would need.

**Compile safety is proven in both directions** (`scripts/r159-aor-spike/compile-proof.ts`): on
`fixtures/sandbox-data` every claimed site compiles (8/8) and every site refused as non-numeric is
REJECTED when mutated anyway (4/4), each with `error AL0175: Operator '-' cannot be applied to
operands of type 'Text' and 'Text'`.

## Footprint, measured before the run

| project | `swap-additive` sites |
| --- | ---: |
| `do-rel2/Cloud` | **93** |
| `fixtures/sandbox-data` | **8** |
| `fixtures/sandbox-app` | **1** |
| `examples/gift-card` | 0 |
| `fixtures/sandbox-hang` | 0 |
| `fixtures/sandbox-probes` | 0 |

So the demo campaign and `itest:hang` cannot move. **Two gates move**, and one of them is the
authoritative `itest:bcdev`.

No displacement anywhere: nothing else claims an `additive_expression`, so every site is +1 raw and
+1 deployed.

## `itest:bcdev`: one mutant, and it is NOT scored

| site | mutant | predicted |
| --- | --- | --- |
| `codeunit 79001 "Sandbox Pricing"`, `DiscountedPrice` | `Price - (Price * Pct / 100)` → `Price + (...)` | **no-coverage** |

`Sandbox Tests` has two tests and neither mentions `Sandbox Pricing`: `OverBudgetDetected` and
`ClampPercentRuns` both go through `Sandbox Logic`. So no test executes this procedure and the
mutant is excluded from the score rather than scored against a suite that never ran it.

**Predicted `itest:bcdev`: killed 3 / survived 10 / no-coverage 4** (from 3 / 10 / 3).
`assertionScreen.discrimination` stays **`vacuous`** — a no-coverage mutant adds no kill, so nothing
about that suite's raise style changes.

## `itest:tables`: eight mutants, six killed and two survived

| # | site | mutant | predicted | why |
| --- | --- | --- | --- | --- |
| 1 | `Data Filter Ops.CountInRange` | `LowBound + 2` → `- 2` | **killed** | the arm-H test seeds three rows and asserts exactly 2 in the closed range `79190..79192`. Mutated the range becomes `79190..79188`, which is inverted and matches nothing, so the count is 0. |
| 2 | `Data Filter Ops.CountTaggedInBand` | `LowBound + 3` → `- 3` | **killed** | arm I asserts exactly 2 non-blank rows in the band `79200..79203`. Mutated the `SetRange` is `79200..79197`, empty. |
| 3 | `Data Main`, field 1 `"No."` `OnValidate` | `Touched := Touched + 1` → `- 1` | **survived** | **nothing in the suite reads `Touched`.** The string does not appear in the test codeunit. `Touched` is an `Integer`, so going negative raises nothing. |
| 4 | `Data Main`, field 4 `Processed` `OnValidate` | `Touched := Touched + 1` → `- 1` | **survived** | same field, same reason. |
| 5 | `Data Ops.RunUserDefinedBuiltins`, outer | `… * 10 + Builder.RangeWidth()` → `- Builder.RangeWidth()` | **killed** | the test asserts exactly 372 = 3*100 + 7*10 + 2. Mutated: 368. |
| 6 | `Data Ops.RunUserDefinedBuiltins`, inner | `Loader.LoadedFieldNo() * 100 + Validator.SeenTotal() * 10` → `-` | **killed** | same assertion. Mutated: 300 - 70 + 2 = 232. |
| 7 | `Data Validator.TestField` | `Seen := Seen + Value` → `- Value` | **killed** | `Validator.TestField(7)` then makes `SeenTotal()` return -7, so the same 372 assertion sees 232. |
| 8 | `Data Swap Ops.Accumulate` | `Total := Total + Delta` → `- Delta` | **killed** | `SwapRedirectsTheAccumulatorWriteback` asserts `RunningTotal(10, 5) = 15`. Mutated: 5. |

Sites 5 and 6 are NESTED — the outer additive expression contains the inner one — so they land in one
containment component and become siblings in a single dispatch chain. Both are still separate
mutants.

### Predicted frozen figures

| | before | after |
| --- | ---: | ---: |
| killed | 195 | **201** |
| survived | 32 | **34** |
| no-coverage | 10 | **10** |
| deployed | 237 | **245** |
| raw specs | 257 | **265** |
| mutation score | 195/227 | **201/235** |

Unchanged, and predicted deliberately: `untargetedTriggerCount` **0**,
`platformArtifactKills.killedCount` **2** (this operator declares no mechanism),
`assertionScreen.discrimination` **`partial`**, `declarativeSites` **1**, and the single expected
baseline failure by name.

## The two survivors are the interesting half

`Touched` is incremented by two different `OnValidate` triggers and **read by nothing in the suite**.
That is a genuine unasserted behaviour in the fixture, found by arithmetic rather than planted, and
it is the same class the demo's `Entry Type` survivors are. A fixture that exists to prove operators
work now carries two mutants proving this one works on code nobody was watching.

## What would count as a finding

- Any verdict differing from the tables above.
- A tenth mutant anywhere: the census says eight plus one.
- Either `Touched` mutant KILLED, which would mean something does read it.
- Any movement in the demo campaign or `itest:hang`, both measured at zero sites.
- An `AlcCompileError`, given the compile proof already passes on this exact fixture.
