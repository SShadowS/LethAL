# Gift card demo — pre-committed verdicts for all 36 deployed mutants

**Written BEFORE any run against a live server.** This file exists so that a contradiction between
what it predicts and what a container answers is a FINDING, recorded as one, rather than something
reconciled quietly afterwards. The precedent in this repository is direct: R136 pre-committed 51
verdicts and all 51 matched; R134 pre-committed 32 and all 32 matched; R82 pre-committed 30, R72
five, same result. The demo deserves the discipline more than any of those did, because those had a
gate to catch them and this has a room.

Date: 2026-08-16. Target: `examples/gift-card` plus `examples/gift-card-tests`, backend `bcdev`.
Roadmap row: `docs/roadmap/R155.md`.

Rows are keyed on **(procedure, operator, the statement)** rather than on line number or mutant
code. Mutant codes renumber and line numbers move; the statement does not. Line numbers are given
for convenience and were true at commit `d5cc350`.

Inventory measured by `lethal run --project examples/gift-card --dry-run`: **40 mutation sites, 36
deployed, 1 batch.** The four undeployed are Tier-1 `void-method-call` mutants displaced at a site a
Tier-2 operator claimed, and they are listed at the end rather than predicted.

## Predicted totals

| | Count |
|---|---|
| killed | 20 |
| survived | 9 |
| no-coverage | 7 |
| **deployed** | **36** |

Mutation score = 20 / 29 = **68.97%**. Baseline: 8 tests, all expected to pass.

## `table 90100 "Gift Card"` (4 deployed)

| # | Site | Operator | Verdict | Why |
|---|---|---|---|---|
| 1 | `OnValidate` of `Customer No.` (:17) | `empty-block` | **killed** | The blank check disappears, so `IssueRequiresCustomer`'s `asserterror` gets no error and fails. |
| 2 | `if "Customer No." = ''` (:18) | `negate-conditional` | **killed** | Inverted, a NON-blank customer now raises, so every test that issues a card with `C10000` fails. Killed several times over. |
| 3 | `OnInsert` (:56) | `empty-block` | **killed** | `IssueCreatesCard` asserts `"Issued Date" = WorkDate()`, and the stamp is in this block. |
| 4 | `TestField("No.")` (:57) | `remove-testfield` | **survived** | Nothing ever inserts a card with a blank `No.` — every test goes through `Issue`, which is handed one. A real gap, and a small one. |

## `codeunit 90102 "Gift Card Mgt"` (32 deployed)

### `Issue` (10)

| # | Site | Operator | Verdict | Why |
|---|---|---|---|---|
| 5 | procedure body (:12) | `empty-block` | **killed** | No card is created; `IssueCreatesCard` fails on `Get`. |
| 6 | `if Amount <= 0` (:13) | `conditional-boundary` | **survived** | `<=` becomes `<`, so issuing a ZERO-amount card is now allowed. No test issues zero; `IssueRejectsNegativeAmount` uses -50 and still raises. |
| 7 | `GiftCard.Init()` (:16) | `void-method-call` | **survived** | The record variable is local and freshly declared, so `Init()` is close to redundant here. **Lowest-confidence prediction in this file** — see Uncertainties. |
| 8 | `Validate("Customer No.", ...)` (:18) | `void-method-call` | **killed** | The customer is never set at all, so the blank check never runs and `IssueRequiresCustomer` fails. |
| 9 | `Validate("Customer No.", ...)` (:18) | `validate-to-assign` | **killed** | The assignment skips `OnValidate`, so the same test fails. This pair is a nice demo of two operators reaching the same defect by different routes. |
| 10 | `TestField("Expiry Date")` (:22) | `remove-testfield` | **killed** | `IssueRequiresExpiryDate` passes `0D` and expects a raise. |
| 11 | `Insert(true)` (:23) | `void-method-call` | **killed** | No card row; `IssueCreatesCard` fails. |
| 12 | `Insert(true)` (:23) | `swap-modify-flag` | **killed** | `Insert(false)` skips `OnInsert`, so `"Issued Date"` is never stamped and `IssueCreatesCard`'s third assertion fails. **This kill must NOT be tagged a platform artifact:** R143 narrowed `insertSkipCanRaise` to drop the tag when the receiver's `OnInsert` provably does not assign the primary key, and this one assigns `"Issued Date"`. If the report tags it, that is a finding about R143, not about the demo. |
| 13 | `PostEntry(CardNo, CustomerNo, ...)` (:25) | `void-method-call` | **killed** | Without the issue entry, `GetBalance` returns -40 instead of 60 in `RedeemReducesBalance`. |
| 14 | `PostEntry(CardNo, CustomerNo, ...)` (:25) | `swap-call-arguments` | **killed** | The entry is filed under `C10000` instead of the card, so `GetBalance('GC-REDEEM')` sums only the redemption. |

### `Redeem` (8)

| # | Site | Operator | Verdict | Why |
|---|---|---|---|---|
| 15 | procedure body (:31) | `empty-block` | **killed** | Nothing is redeemed; the remaining amount stays 100. |
| 16 | `GiftCard.Get(CardNo)` (:32) | `void-method-call` | **killed** | The record stays blank, so `"Expiry Date"` is `0D`, the expiry guard raises, and `RedeemReducesBalance` fails. |
| 17 | `if "Expiry Date" < WorkDate()` (:37) | `conditional-boundary` | **survived** | `<=` makes a card stop working ON its expiry date. Tests use `+1Y` and `-1D`; neither is today. **The honest survivor** — whether this is a bug depends on a spec nobody wrote. |
| 18 | `if "Remaining Amount" < Amount` (:40) | `conditional-boundary` | **survived** | `<=` means a card can never be spent to exactly zero. Tests redeem 40 of 100 and 80 of 50, never the exact balance. **A genuine, shippable bug.** |
| 19 | `Modify(true)` (:44) | `void-method-call` | **killed** | The new balance is never persisted; `RedeemReducesBalance` asserts 60. |
| 20 | `Modify(true)` (:44) | `swap-modify-flag` | **survived** | `Modify(false)` skips a trigger the table does not have. Near-equivalent, and a good second honesty beat: the tool cannot know the table has no `OnModify`. |
| 21 | `PostEntry(..., -Amount)` (:46) | `void-method-call` | **killed** | No redemption entry, so `GetBalance` returns 100. |

### `GetBalance` (4)

| # | Site | Operator | Verdict | Why |
|---|---|---|---|---|
| 22 | procedure body (:52) | `empty-block` | **killed** | Returns 0 against an asserted 60. |
| 23 | `SetRange("Gift Card No.", CardNo)` (:53) | `remove-setrange` | **survived** | **THE PLANTED BUG.** Every test creates exactly one card, so filtered and unfiltered sum the same rows. This single row is what the demo is for; if it comes back killed, the demo does not work and the cause is almost certainly test isolation (see Uncertainties). |
| 24 | `CalcSums(Amount)` (:54) | `void-method-call` | **killed** | `Amount` stays 0. |
| 25 | `exit(GiftCardEntry.Amount)` (:55) | `return-value` | **killed** | A changed return value fails the balance assertion. |

### `BlockExpiredCards` (7) — every one `no-coverage`

| # | Site | Operator | Verdict |
|---|---|---|---|
| 26 | procedure body (:61) | `empty-block` | **no-coverage** |
| 27 | `SetRange(Blocked, false)` (:62) | `remove-setrange` | **no-coverage** |
| 28 | `SetFilter("Expiry Date", '<%1', WorkDate())` (:63) | `void-method-call` | **no-coverage** |
| 29 | `SetFilter("Expiry Date", '<%1', WorkDate())` (:63) | `flip-filter-literal` | **no-coverage** |
| 30 | `Modify(true)` (:67) | `void-method-call` | **no-coverage** |
| 31 | `Modify(true)` (:67) | `swap-modify-flag` | **no-coverage** |
| 32 | `if GiftCard.FindSet() then` (:64, reported at :68) | `negate-conditional` | **no-coverage** |

No test calls this procedure. It is the nightly job, and expiry is tested at redeem time, which is
exactly why a coverage-percentage reading files expiry as handled.

### `PostEntry` (4)

| # | Site | Operator | Verdict | Why |
|---|---|---|---|---|
| 33 | procedure body (:74) | `empty-block` | **killed** | No entries at all, so `GetBalance` returns 0. |
| 34 | `GiftCardEntry.Init()` (:75) | `void-method-call` | **survived** | Same reasoning as #7, and the same low confidence. |
| 35 | `GiftCardEntry.Insert(true)` (:81) | `void-method-call` | **killed** | No entries; `GetBalance` returns 0. |
| 36 | `GiftCardEntry.Insert(true)` (:81) | `swap-modify-flag` | **survived** | The entry table has no triggers, and `AutoIncrement` is applied by the platform on insert regardless of `RunTrigger`. Near-equivalent. |

## The four displaced sites (raw, not deployed)

`void-method-call` at `GiftCard.Table.al:57`, and at `GiftCardMgt.Codeunit.al:22`, `:53` and `:62`.
Each sits where a Tier-2 operator claimed the site, and §3.2 precedence deletes the Tier-1 mutant.
The dry run prints them and says so. They receive no verdict; a run that scores one of them is a
finding about precedence, not about this app.

## Uncertainties, stated before the run

1. **Test isolation is the one thing that can break the demo.** If the fenced session does not roll
   back between tests, entries accumulate across tests, `GetBalance` without its filter starts
   seeing other cards' entries, and #23 flips to killed — or worse, flips intermittently. The
   fixtures under `fixtures/sandbox-data` insert rows and their frozen numbers are stable, which is
   evidence rollback works, but it is evidence about a different app. **If #23 comes back killed,
   check isolation before changing anything else.**
2. **#7 and #34, the two `Init()` deletions.** Predicted survived on the grounds that a freshly
   declared local record is already empty. If either comes back killed, the reason is worth
   understanding rather than patching: it would mean `Init()` does something here that the reading
   of it missed.
3. **#12's platform-artifact tag.** Predicted killed AND untagged. R143 is the machinery that
   decides, and this is a live check of its narrowing on an app it has never seen.
4. Predicted verdicts assume all 8 tests pass at baseline. A red baseline changes several rows from
   `survived` to `no-coverage` (R55) and invalidates the score.

## Verification of those four, 2026-08-16 — before any live run

Each uncertainty was chased as far as it can be chased without a container. Two are now settled, one
changed the demo, and one stays a reasoned prediction.

### 1. Test isolation — SETTLED. The concern was unfounded and is withdrawn.

This section first claimed the granularity of rollback (per test method, or per run) was unmeasured,
and the suite briefly gained a `ClearAll()` helper to be safe either way. **Both the claim and the
hedge were wrong, and both are reverted.** The transaction boundary is the test METHOD, three
times over:

1. **By definition.** Microsoft's
   [TransactionModel attribute](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/attributes/devenv-transactionmodel-attribute)
   applies to a *method* and governs "whether transactions are rolled back at the end of a test
   method". Under `AutoRollback`, "After the test method is completed, the transaction is rolled
   back and the database is returned to its initial state." These tests declare no attribute, so
   they take the platform default, `AutoRollback`. Leaking writes to a later test requires opting
   out — `AutoCommit`, `None`, or an explicit `Commit()`, which under `AutoRollback` is an error
   rather than a leak.
2. **The server enforces it.** `extensions/lethal-control/src/RunMethod.Codeunit.al` says so in the
   comment explaining why the fence uses `Codeunit.Run` rather than a `[TryFunction]`:
   "`Test Suite Mgt.RunAllTests` drives the platform test runner, whose **per-test isolation** and
   result persistence commit between methods".
3. **LethAL runs one method per invocation anyway.** `RunOneMethod` builds a single-method
   `AL Test Suite` per call, so there is no multi-test run for a transaction to span even
   hypothetically.

The measured evidence in `fixtures/sandbox-data-tests` (R32 verification, 2026-07-27: four tables
holding 0 rows in both companies after 432 fenced runs) is consistent with all of this and never
contradicted it.

**Row #23's prediction is unchanged** and now rests on the correct reason: each test method's writes
are rolled back at its end, so when `RedeemReducesBalance` runs, its one card's entries are the only
entries there are. `docs/roadmap/R156.md` records the withdrawn claim rather than deleting it.

### 2. The two `Init()` deletions — NOT settled, and deliberately left alone

There is no way to answer this offline: it is a question about what BC does at runtime, not about
what LethAL generates. The reasoning is unchanged — a freshly declared local record is already
empty, and every field the code cares about is assigned explicitly afterwards — so #7 and #34 stay
predicted `survived`, and stay flagged as the least confident rows here.

They were NOT removed from the demo to make the prediction safe. `Init()` before a build-and-insert
is idiomatic AL, the audience writes it, and deleting it to tidy a prediction would make the demo
less like the code it is supposed to resemble.

### 3. The `run-trigger-skipped-insert` tag — SETTLED, statically, with a control

Ran the real `generateMutationSet` over `examples/gift-card` and read
`MutationSpec.platformKillMechanism` at every `swap-modify-flag` site:

| Project | Site | Mechanism |
|---|---|---|
| `examples/gift-card` | `GiftCard.Insert(true)` | **none** |
| `examples/gift-card` | `GiftCardEntry.Insert(true)` | **none** |
| `examples/gift-card` | both `Modify(true)` sites | none (not an insert) |
| `fixtures/sandbox-data` | `KeyProbe.Insert(true)` | **`run-trigger-skipped-insert`** |
| `fixtures/sandbox-data` | both `Probe.Insert(true)` sites | none |

The control is the load-bearing half. A probe reporting "none" everywhere would prove nothing at
all — this repository's signature bug — so it was run against the fixture where R143 is known to
tag, and it does tag there, on exactly the arm whose `OnInsert` assigns a blank `Code[20]` primary
key. So #12's "killed AND untagged" is confirmed on the untagged half. The killed half still needs a
server.

### 4. A red baseline — SETTLED, in code

The mechanism is real and is where the prediction said it is: `stale-test-app.ts` states it
(a failing test leaves the green set and every mutant covered only by it is recorded
`no-coverage`), `orchestrator.ts` implements it, and `CAVEAT_INTERPRETATIONS["baseline-red"]`
(`report.ts`) publishes it with basis `R55`. So a red baseline does move rows from `survived` to
`no-coverage` and does invalidate the score, exactly as stated. Nothing to change; the caveat is
simply a condition to check before reading anything else on the day.

## A stage-mechanics finding this exercise produced

Nine predicted survivors, and `explain --top n` ranks by evidence — `executionProven` first, ties
broken on file, then line, then mutant code. Most survivors here are execution-proven, so **the
ranking is effectively file-and-line order**, and the planted bug at `:53` sorts BEHIND the survivors
at `:13`, `:16`, `:37`, `:40` and `:44`.

**`--top 5` would cut the headline survivor off the list.** Use `--top 10` on stage, or select the
file with `--only`. This is not a defect in the ranking — it ranks by how much evidence a row
carries, which is what it promises, not by how interesting a human finds it — but it is exactly the
kind of thing to learn in a pre-commitment rather than in front of a room.

## What closes R155

A run against a container, per-mutant verdicts compared against this file, every disagreement
recorded as a finding, then `lethal campaign freeze` so drift between the rehearsal and the stage is
a diff rather than a surprise.
