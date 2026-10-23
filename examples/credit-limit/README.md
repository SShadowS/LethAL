# The credit limit demo

A second demo in the gift-card mold: a small Business Central extension whose test suite is green,
looks reasonable in review, and is blind to three real gaps. Built as the example for the
sshadows.dk post on mutation testing; the gift-card demo stays reserved for presentations.

It exists because the gift-card app deliberately cannot show `remove-calcfields` (it sums with
`CalcSums` and reads no FlowField). This app checks a customer's exposure by reading a FlowField
through `CalcFields`, so that operator gets a stage of its own.

## What it does

Credit management. A customer has a credit limit, a balance (FlowField over a ledger table), and
open orders. Registering an order checks exposure first:

`Balance + open orders + the new order > Credit Limit` blocks the order. A limit of 0 means no
limit.

| Object | Purpose |
|---|---|
| `table 90200 "Credit Customer"` | No., Credit Limit, and `Balance` as a FlowField over the ledger. |
| `table 90201 "Credit Ledger Entry"` | The movements. `Entry No.` is `AutoIncrement`. |
| `table 90202 "Credit Order"` | Orders with Open/Invoiced status. SIFT key for `CalcSums`. |
| `enum 90203 "Credit Order Status"` | Open or Invoiced. |
| `codeunit 90204 "Credit Limit Mgt"` | `RegisterOrder`, `CheckCreditLimit`, `WouldExceedLimit`, posting helpers. |
| `codeunit 90250 "Credit Limit Tests"` | Five tests, in `examples/credit-limit-tests`. |

## The three planted gaps

All three MEASURED on a Cronus283 container (BC 28), first run 2026-08-24, not predicted:

1. **Nobody orders exactly the limit.** The tests go under (400 of 1000) and over (1200 of 1000),
   never to exactly 1000. `conditional-boundary` on `Exposure > "Credit Limit"` (`WouldExceedLimit`, line 39):
   **survived**.
2. **Nobody ever owes anything.** No test writes a ledger entry, so `Balance` is 0 in every test
   and `CalcFields` never changes anything. `remove-calcfields` (`WouldExceedLimit`, line 36): **survived**,
   with `attribution: "exact"` and `executionProven: true`, covered by all five tests. The posting
   helpers (`PostInvoice`, `PostPayment`, `PostEntry`) are called by no test, so all 11 of their
   mutants come back `no-coverage` (8 at the first run; `remove-assignment` added 3).
3. **There is only ever one customer.** Every test creates `C-10000` and nothing else, so the
   `SetRange("Customer No.", ...)` in `OutstandingOrderAmount` is never load-bearing.
   `remove-setrange` on it (`OutstandingOrderAmount`, line 56): **survived**. The Status filter next to it: **killed**
   by `InvoicedOrdersStopCounting`, as intended.

Also measured, not planted: four more survivors. `CreditOrder.Init()` removed and
`Insert(true)` flipped to `Insert(false)`, both in `RegisterOrder`, survive as near-equivalent mutants (a fresh
record variable, and a table with no OnInsert trigger), and both `Credit Customer.OnInsert` mutants
survive because no test inserts a customer with a blank `No.`. Two shrugs, one small
real gap.

## The measured result

First run against Cronus283 (BC 28) on 2026-08-24, and re-frozen there on 2026-08-26 when `lethal.shift-integer`
shipped. Re-frozen again on 2026-10-23 (R560), on bc1 (BC 28.4 W1), at identity scheme 41 under
`coverageMode: "fenced"`. Every mutant's verdict matched the 2026-08-26 freeze, and a second run matched the new
baseline mutant by mutant, with every mutated text checked:

```
dry run: 2 file(s), 46 mutant site(s), 42 deployed mutant(s), 1 batch(es)
score: 74.2%  (killed 23, survived 8, no-coverage 11, deadline-exceeded 0, timeout-killed 0, known-survivor 0, error 0 [unstable 0])
TIMING: total 13.0s = generate 0.0s + deploy 2.6s + baseline 0.7s + mutants 1.3s + overhead 8.5s
```

The report this section quotes is `demo.report.json` next to this file (with
`demo.events.ndjson`). It was produced by the command in Running it below, with `--config` naming bc1's
gitignored `lethal.config.bc1.json` (written by `scripts/r560c-credit-limit-setup.ts`) and `--progress-out` writing
the events file. It is FROZEN:
`demo.baseline.json` holds the same run's verdicts per mutant, so a re-run is checked mutant by
mutant rather than by total.

```bash
lethal campaign compare --manifest examples/credit-limit/campaign.json \
                        --stage demo --report your-rerun.json
```

Run that before quoting these numbers anywhere. Each survivor named above is a claim about ONE
mutant, and a total that still reads 23 / 8 / 11 can hide a verdict that moved.

Named by procedure and operator, never by mutant code. Codes are per-run labels that renumber
the moment an operator lands earlier in the file — `flip-boolean-literal` shifted all three of
these by one — which is why the frozen baseline keys on the mutated subtree's hash instead.

Note that `InvoicedOrdersStopCounting` flips an order to Invoiced without posting anything. That is
a demo shortcut, and it is also what keeps gap 2 clean: the suite never touches the ledger at all.

## Running it

Same drill as the gift-card demo, whose README has the full detail (dev-scope publishing, the
`TestPermissions = Disabled` requirement, why the `bcdev` backend is the one to use with
`asserterror` tests, and how `selectorIds` work). This app declares its own dedicated
`90297..90299` range for the injected objects; two apps must not share the three ids on one
service instance, and the gift-card demo holds `90197..90199`.

```bash
lethal run --project examples/credit-limit --dry-run
lethal run --project examples/credit-limit \
           --tests   examples/credit-limit-tests \
           --backend bcdev \
           --config  examples/credit-limit/lethal.config.local.json \
           --out     report.json
lethal explain demo.report.json --top 10
```

Copy `lethal.config.example.json` to `lethal.config.local.json` and fill in your own server. That
filename is the one `.gitignore` covers.
