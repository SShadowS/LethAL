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
   never to exactly 1000. `conditional-boundary` on `Exposure > "Credit Limit"` (M0019, line 39):
   **survived**.
2. **Nobody ever owes anything.** No test writes a ledger entry, so `Balance` is 0 in every test
   and `CalcFields` never changes anything. `remove-calcfields` (M0015, line 36): **survived**,
   with `attribution: "exact"` and `executionProven: true`, covered by all five tests. The posting
   helpers (`PostInvoice`, `PostPayment`, `PostEntry`) are called by no test, so all 8 of their
   mutants came back `no-coverage`.
3. **There is only ever one customer.** Every test creates `C-10000` and nothing else, so the
   `SetRange("Customer No.", ...)` in `OutstandingOrderAmount` is never load-bearing.
   `remove-setrange` on it (M0025, line 56): **survived**. The Status filter next to it: **killed**
   by `InvoicedOrdersStopCounting`, as intended.

Also measured, not planted: four more survivors. `CreditOrder.Init()` removed (M0005) and
`Insert(true)` flipped to `Insert(false)` (M0006) both survive as near-equivalent mutants (a fresh
record variable, and a table with no OnInsert trigger), and both `Credit Customer.OnInsert` mutants
(M0001, M0002) survive because no test inserts a customer with a blank `No.`. Two shrugs, one small
real gap.

## The measured result

Run against Cronus283 (BC 28), 2026-08-24:

```
dry run: 2 file(s), 36 mutant site(s), 32 deployed mutant(s), 1 batch(es)
score: 70.8%  (killed 17, survived 7, no-coverage 8, error 0)
TIMING: total 16.3s = generate 0.1s + deploy 6.4s + baseline 0.9s + mutants 6.8s + overhead 2.3s
reliability: full
```

The report this section quotes is `demo.report.json` next to this file (with
`demo.events.ndjson`), produced by the command in Running it below. It is FROZEN:
`demo.baseline.json` holds the same run's verdicts per mutant, so a re-run is checked mutant by
mutant rather than by total.

```bash
lethal campaign compare --manifest examples/credit-limit/campaign.json \
                        --stage demo --report your-rerun.json
```

Run that before quoting these numbers anywhere. Every id above (`M0015`, `M0019`, `M0025`) is a
claim about one mutant, and a total that still reads 17 / 7 / 8 can hide a verdict that moved.

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
