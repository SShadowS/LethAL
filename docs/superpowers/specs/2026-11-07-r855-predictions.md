# R855 predictions: each added mutant's verdict, by hand arithmetic, before any live run

Part of [the pre-commitment](2026-11-07-r855-operator-batch-precommitment.md). A row that runs differently is a finding and a stop, never an edit to this file.

Test names are `Codeunit.Method`. "All other rows" notes: AL evaluates both operands of and/or, so deleting one operand changes the value only where the two operands differ.

## fixtures/sandbox-app (tests: sandbox-tests, codeunit "Sandbox Tests")
Only two tests: OverBudgetDetected (IsOverBudget) and ClampPercentRuns (ClampPercent(50), ApplyAudit(10), no assertion).

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| SandboxLogic:12 | delete-logical-right | (V<0) or (V>100) -> (V<0) | survived | - | Only input is 50: both forms false, result unchanged, and the result is not asserted anyway |
| SandboxLogic:12 | delete-logical-left | ... -> (V>100) | survived | - | 50>100 false, same as original false; no assertion |
| SandboxPricing:7 | delete-additive-right | Price - (Price*Pct/100) -> Price | no-coverage | - | No test calls Sandbox Pricing |

## fixtures/sandbox-codefree (tests: sandbox-codefree-tests, "CF Tests")

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| CFActive:10 | delete-additive-right | A+B -> A | killed | CF Tests.ActiveAddKills | Add(2,3)=2, expected 5 |
| CFActive:10 | delete-additive-left | A+B -> B | killed | CF Tests.ActiveAddKills | Add(2,3)=3, expected 5 |
| CFActive:20 | delete-logical-right | P and Q -> P | killed | CF Tests.ActiveBothKills | Both(true,false)=true, test expects false |
| CFActive:20 | delete-logical-left | P and Q -> Q | survived | - | Calls (T,F) and (T,T): P always true, so Q equals P and Q; no test passes P=false |
| CFInactive:10 | delete-additive-right | A-B -> A | killed | CF Tests.InactiveSubKills | Sub(7,3)=7, expected 4 |
| CFInactive:20 | delete-logical-right | P or Q -> P | killed | CF Tests.InactiveEitherKills | Either(false,true)=false, expected true |
| CFInactive:20 | delete-logical-left | P or Q -> Q | survived | - | Calls (F,F) and (F,T): P always false, so Q equals P or Q |
| CFPlain:5 | delete-additive-right | X+1 -> X | killed | CF Tests.PlainIncKills | Inc(5)=5, expected 6 |

Note: the CFActive/CFInactive rows assume the build defines the symbols the way the gate does; "Inactive" code is still plain code in its own file, so I assume it is mutated and reached.

## fixtures/sandbox-coverage-probe (no test project found)

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| CoverageCapabilityProbe:47 | delete-logical-right | ...Type=5 and ...ID=79320 -> Type=5 | no-coverage | - | Probe app has no test codeunit; this code is a probe procedure, not called by any test |
| CoverageCapabilityProbe:47 | delete-logical-left | -> ID=79320 | no-coverage | - | same |
| TwoObjects:25 | delete-additive-right | N-1 -> N | no-coverage | - | `Narrow` is never called by any test |

(Wait: row names say additive-right for `N - 1`; same prediction.)

## fixtures/sandbox-data (tests: sandbox-data-tests, "Data Tests")

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| DataBandExt:38 | delete-additive-right | N+1 -> N | no-coverage | - | `Unreached`; header says no test calls it |
| DataFilterOps:220 | delete-additive-right | LowBound+2 -> LowBound | killed | Data Tests.ClosedRangeCountIsScopedByMainNo | Range 79190..79190 holds only 1 FLT-H row; test expects 2 |
| DataFilterOps:268 | delete-additive-right | LowBound+3 -> LowBound | killed | Data Tests.NotBlankFilterCountsOnlyTaggedRows | Range 79200..79200 holds 1 tagged row; test expects 2 |
| DataMain:24 | delete-additive-right | Touched+1 -> Touched | survived | - | Field "No." trigger is reached, but only Touched changes and only TouchCount() reads it, which no test calls. (If coverage were line-exact this line is never run past the Error, then it would be no-coverage; see least sure.) |
| DataMain:63 | delete-additive-right | Touched+1 -> Touched | survived | - | Same: Processed trigger; Touched never read by a test |
| DataOps:126 | delete-additive-right | a*100 + b*10 + c -> a*100 + b*10 | killed | Data Tests.UserDefinedBuiltinsRun | 370 vs expected 372 |
| DataOps:126 | delete-additive-right | a*100 + b*10 -> a*100 | killed | Data Tests.UserDefinedBuiltinsRun | 300+2=302 vs 372 |
| DataOps:126 | delete-additive-left | a*100 + b*10 -> b*10 | killed | Data Tests.UserDefinedBuiltinsRun | 70+2=72 vs 372 |
| DataSwapOps:52 | delete-additive-right | Total+Delta -> Total | killed | Data Tests.SwapRedirectsTheAccumulatorWriteback | RunningTotal(10,5)=10, expected 15 (other swap tests may also fail) |
| DataSwapOps:52 | delete-additive-left | Total+Delta -> Delta | killed | Data Tests.SwapRedirectsTheAccumulatorWriteback | =5, expected 15 |
| DataValidator:15 | delete-additive-right | Seen+Value -> Seen | killed | Data Tests.UserDefinedBuiltinsRun | Seen stays 0, SeenTotal 0: 300+0+2=302 vs 372 |
| DataValidator:15 | delete-additive-left | Seen+Value -> Value | survived | - | Single call TestField(7) on fresh codeunit: Seen=0, so 0+7 = 7; equivalent mutant |

## fixtures/sandbox-layout (tests: sandbox-layout-tests, "Layout Tests")

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| LayoutBeta:6 | delete-additive-right | X+1 -> X | killed | Layout Tests.GrowAboveTen | Grow(20)=20, expected 21 |

## fixtures/sandbox-multiobject (tests: sandbox-multiobject-tests, "Multi Tests")

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| MultiPair:5 | delete-additive-right | X+7 -> X | no-coverage | - | `Multi A.Never` is never called (name says so) |
| MultiPair:14 | delete-additive-right | X+1 -> X | killed | Multi Tests.ReachedBothWays | Reached(20)=20, expected 21 |

## fixtures/sandbox-names (tests: sandbox-names-tests, "Names Tests")
Every row: X+1 -> X, test calls Step(5) and expects 6; result is 5, so killed.

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| NamesCalc:5 | delete-additive-right | x+1 -> x | killed | Names Tests."Space Step" | 5 vs 6 |
| NamesCalc:10 | same | | killed | Names Tests."Dash-Step" | 5 vs 6 |
| NamesCalc:15 | same | | killed | Names Tests."Paren(Step)" | 5 vs 6 |
| NamesCalc:20 | same | | killed | Names Tests."Dot.Step" | 5 vs 6 |
| NamesCalc:25 | same | | killed | Names Tests."Slash/Step" | 5 vs 6 |
| NamesCalc:30 | same | | killed | Names Tests."Amp&Step" | 5 vs 6 |
| NamesCalc:35 | same | | killed | Names Tests."7Digit Step" | 5 vs 6 |
| NamesCalc:40 | same | | killed | Names Tests.Default | 5 vs 6 |
| NamesCalc:45 | same | | killed | Names Tests."Blåbær Step" | 5 vs 6 |
| NamesCalc:50 | same | | killed | Names Tests."Twin Pair" | 5 vs 6 |
| NamesCalc:55 | same | | killed | Names Tests.Twin_PairLong | 5 vs 6 |
| NamesCalc:60 | same | | killed | Names Tests.PlainControl | 5 vs 6 |

## fixtures/sandbox-symbols (tests: sandbox-symbols-tests, "Symbol Tests"); assumes the no-symbol build (the `#else` branch is live)

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| SymbolLogic:17 | delete-additive-right | X+ForNone -> X | killed | Symbol Tests.RateSmall | Rate(1)=1, expected 2 |
| SymbolLogic:17 | delete-additive-left | X+ForNone -> ForNone | killed | Symbol Tests.RateSmall | ForNone=1, expected 2 (X=1 and ForNone=1, so both give 1) |

In a LETHALA or LETHALB build, line 17 is inactive text and these rows would not exist.

## fixtures/sandbox-wrapped (tests: sandbox-wrapped-tests, "Wrapped Tests")

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| WrappedPre:11 | delete-additive-right | X+1 -> X | killed | Wrapped Tests.GrowPre | Grow(20)=20, expected 21 |
| WrappedPreTwin:11 | delete-additive-right | X+1 -> X | killed | Wrapped Tests.GrowPreTwin | Grow(20)=20, expected 21 |
| WrappedTop:9 | delete-additive-right | X+1 -> X | killed | Wrapped Tests.GrowTop | Grow(20)=20, expected 21 |
| WrappedTopTwin:9 | delete-additive-right | X+1 -> X | killed | Wrapped Tests.GrowTopTwin | Grow(20)=20, expected 21 |

All four are the `exit(X + 1)` in `Grow`, with codes M0010, M0018, M0026 and M0035. The corpus dump lists 2 of them, the twins; why it does not list the two wrapped files was not checked. The instrumented project and `wrapped-fixture.ts`'s table hold all 4.

## examples/credit-limit (tests: examples/credit-limit-tests, "Credit Limit Tests")
No test posts a ledger entry, so Balance is always 0. Limit 1000 in four tests.

| file:line | operator | before -> after | verdict | killing test | reason |
|---|---|---|---|---|---|
| CreditLimitMgt:37 | delete-additive-right | Bal+Out+New -> Bal+Out | killed | Credit Limit Tests.OrderOverLimitIsBlocked (also OpenOrdersCountTowardTheLimit) | Exposure ignores the new 1200 (0 > 1000 false), so no error and the asserterror fails; second test: 600 > 1000 false, also fails |
| CreditLimitMgt:37 | delete-additive-right | Bal+Out -> Bal | killed | Credit Limit Tests.OpenOrdersCountTowardTheLimit | Second order: 0+600 > 1000 false, no error. Over-limit test still errors (1200 > 1000), so only this one fails |
| CreditLimitMgt:37 | delete-additive-left | Bal+Out -> Out | survived | - | Balance is always 0 in every test, so Out equals Bal+Out |

## examples/gift-card
#35 and #41 add no mutant here. #42's one mutant, `swap-call-arguments` in `Redeem`, is lethal-bugs' row.

## Totals

| project | killed | survived | no-coverage | unknown |
|---|---|---|---|---|
| sandbox-app | 0 | 2 | 1 | 0 |
| sandbox-codefree | 6 | 2 | 0 | 0 |
| sandbox-coverage-probe | 0 | 0 | 3 | 0 |
| sandbox-data | 8 | 3 | 1 | 0 |
| sandbox-layout | 1 | 0 | 0 | 0 |
| sandbox-multiobject | 1 | 0 | 1 | 0 |
| sandbox-names | 12 | 0 | 0 | 0 |
| sandbox-symbols | 2 | 0 | 0 | 0 |
| sandbox-wrapped | 4 | 0 | 0 | 0 |
| credit-limit | 2 | 1 | 0 | 0 |

(sandbox-data: 12 rows = 8 killed + 3 survived + 1 no-coverage; the survived ones are DataMain:24, DataMain:63, DataValidator:15 left.)

## Least sure
1. DataMain:24 and DataMain:63 (survived vs no-coverage): depends on whether coverage is line-exact or object-level for table triggers. Line 24 is never executed past the Error in any test; line 63 likewise.
2. sandbox-coverage-probe rows: I found no test project; if the gate drives a hidden one, verdicts change.
3. DataValidator:15 delete-additive-left: equivalent only if the codeunit variable is fresh per call (it is a local var).
4. sandbox-symbols: depends on which symbol build runs.
5. credit-limit row 1: which of the two failing tests runs first.
