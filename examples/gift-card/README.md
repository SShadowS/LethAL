# The gift card demo

A small Business Central extension whose test suite is green, looks thorough, and does not notice
that one line is wrong. It exists to be run with LethAL in front of people.

Point LethAL at it before you point LethAL at your own app: it takes seconds, and it shows what a
survivor, a no-coverage row and a killed mutant each look like on code you can read in one sitting.

## What it does

Store credit. Issue a gift card, redeem against it, keep an entry per movement, and block expired
cards in a nightly job.

| Object | Purpose |
|---|---|
| `table 90100 "Gift Card"` | The card. `OnInsert` stamps the issued date; `Customer No.` refuses a blank on validate. |
| `table 90101 "Gift Card Entry"` | The movements. `Entry No.` is `AutoIncrement`. |
| `enum 90103 "Gift Card Entry Type"` | Issue or Redemption. |
| `codeunit 90102 "Gift Card Mgt"` | `Issue`, `Redeem`, `GetBalance`, `BlockExpiredCards`, and a local `PostEntry`. |
| `codeunit 90150 "Gift Card Tests"` | Eight tests, in `examples/gift-card-tests`. |

The domain is deliberately ordinary. Every BC partner has built one, so nothing has to be explained
before the interesting part, and a wrong balance is money, which is legible as dangerous in a way a
wrong `Calculator` result is not.

## The bug

`GetBalance` (`src/GiftCardMgt.Codeunit.al:53`):

```al
GiftCardEntry.SetRange("Gift Card No.", CardNo);
GiftCardEntry.CalcSums(Amount);
exit(GiftCardEntry.Amount);
```

Delete the `SetRange` and `GetBalance` sums **every entry in the table**: one customer's card
balance becomes the store's entire outstanding liability. Ship that and the first customer with a
second card in the system gets someone else's money.

The suite does not notice, and the reason is the interesting part: **every test creates exactly one
gift card**, and each test method's writes are rolled back at its end (`TransactionModel::AutoRollback`,
the platform default), so one card is all that is ever there. With one card in the table, "all entries" and "this card's entries" are the same set,
so the filter is never load-bearing and every balance assertion passes either way. The test that
looks like it covers this — `RedeemReducesBalance`, which asserts `GetBalance = 60` — is green with
the line deleted.

That is not a coverage gap. A test provably executed the line: the report says
`coverageAttribution: "exact"` and `executionProven: true`, and names the covering test. It ran, and
nothing checked it.

## What else the run finds

All three MEASURED on a live container (see The measured result, below), not predicted:

- **`Redeem`'s balance guard** (`:40`), `if GiftCard."Remaining Amount" < Amount`. Flip `<` to `<=`
  and a customer can never spend a card down to exactly zero. No test redeems the exact balance:
  they redeem 40 of 100 and 80 of 50, never 50 of 50. A genuine, shippable bug.
- **`Redeem`'s expiry guard** (`:37`), `if GiftCard."Expiry Date" < WorkDate()`. Flip it and a card
  stops working ON its expiry date rather than after it. Is that a bug? Nobody wrote the rule down.
  This is the honest one: a survivor is a lead, not a verdict, and no tool can read your spec.
- **`BlockExpiredCards`** is called by no test at all, so all seven of its mutants come back `no-coverage`.
  Expiry *is* tested, at redeem time, which is exactly why a coverage-percentage mindset files
  expiry as handled. The nightly job that runs in production ran zero times in the suite.

## The measured mutant inventory

From `lethal run --project examples/gift-card --dry-run`, which executes nothing:

```
dry run: 2 file(s), 40 mutant site(s), 36 deployed mutant(s), 1 batch(es)
  src\GiftCardMgt.Codeunit.al  sites=35  deployed=32
  src\GiftCard.Table.al        sites=5   deployed=4
```

Four sites are raw-but-not-deployed: a Tier-2 operator claimed the site and displaced the Tier-1
`void-method-call` that would otherwise sit there (the `TestField` at `:22`, the two `SetRange`s at
`:53` and `:62`, and the `TestField` in the table's `OnInsert`). The dry run prints each one and
says so, which is worth showing: the difference between "sites" and "deployed" is a thing people ask
about.

Ten of the twelve operators appear. `remove-calcfields` does not, because the app sums with
`CalcSums` rather than reading a FlowField, and `swap-find-direction` does not, because entries are
numbered by `AutoIncrement` rather than by `FindLast` + 1. That last choice is deliberate: a
`FindLast` to `FindFirst` swap here would collide on the primary key, which scores as killed while
asserting nothing — a platform artifact rather than a test doing its job.

**One measured surprise worth knowing before you present it:** the `Blocked` guard at `:34`
(`if GiftCard.Blocked then`) produces **no mutant at all** — no operator claims a bare boolean
condition. So `RedeemBlockedCardFails` kills nothing of its own. It is a perfectly reasonable test
that mutation testing does not reward, and saying so out loud is more useful than pretending every
test earns its place.

## Running it

The test suite raises through `Error()` and `asserterror` only, and contains no `TestPage` test
(LethAL cannot score one, and one kind can hang a whole run).

**Publish both apps to the DEV scope.** This is the one step that will waste an afternoon otherwise.
`Publish-BcContainerApp` defaults to global (AppSource) scope, and the dev endpoint then refuses to
let LethAL replace the target: *"tries to replace the existing AppSource app 'Gift Card Demo' ...
which is a dependency to the following AppSource apps: 'Gift Card Demo Tests by LethAL'"*. The error
names a dependency, so it reads like an app-design problem when it is a publishing one.

```powershell
docker context use desktop-windows
$cred = Get-Credential
Publish-BcContainerApp -containerName <container> -appFile GiftCardDemo.app `
    -skipVerification -sync -install -useDevEndpoint -credential $cred
Publish-BcContainerApp -containerName <container> -appFile GiftCardDemoTests.app `
    -skipVerification -sync -install -useDevEndpoint -credential $cred
```

LethAL republishes the target itself on every run; publishing the TEST app stays your own workflow,
which is why it is here and the target is only here to satisfy the dependency the first time.

Note also that the test codeunit declares **`TestPermissions = Disabled`**. Without it, AL's
Restrictive default strips a test body of write permission on its own app's tables and every test
that inserts a card fails at the platform. Measured here on 2026-08-16: omitting it failed 5 of the
8 tests. LethAL names the condition, names the fix and lists the tests, and records their mutants as
score-excluded rather than as a silent `no-coverage`.

**Use the `bcdev` backend.** Several kills depend on `asserterror`, which `al-runner` cannot fail —
on that backend those mutants come back survived, which would make the demo look wrong for a reason
that has nothing to do with the app.

```bash
lethal doctor --config examples/gift-card/lethal.config.local.json
lethal run --project examples/gift-card --dry-run
lethal run --project examples/gift-card \
           --tests   examples/gift-card-tests \
           --backend bcdev \
           --config  examples/gift-card/lethal.config.local.json \
           --out     report.json
lethal explain report.json --top 10
```

Copy `lethal.config.example.json` to `lethal.config.local.json` and fill in your own server. That
filename is the one `.gitignore` covers, and it holds credentials: a config named anything else is
one `git add` away from being published, in a repository that is public.

**Note the `selectorIds` block in it.** LethAL injects three objects into the copy of your app it
builds, and their ids must fall inside an id range your app declares. This app reserves
`90197..90199` for exactly that, and the config points LethAL at those three. Without it you get a
compile failure at publish time that has nothing to do with your code. The fixtures under
`fixtures/` do the same thing with `79197..79199`.

## The measured result

Run against a BC 28 container on 2026-08-16:

```
score: 69.0%  (killed 20, survived 9, no-coverage 7, error 0)
baseline batch 0: 8/8 passed
TIMING: total 13.8s = generate 0.0s + deploy 3.9s + baseline 0.8s + mutants 6.8s + overhead 2.3s
reliability: full
```

**13.8 seconds**, which is what makes this runnable live rather than narrated. All 36 verdicts were
PRE-COMMITTED in
[`docs/superpowers/specs/2026-08-16-gift-card-demo-precommitment.md`](../../docs/superpowers/specs/2026-08-16-gift-card-demo-precommitment.md)
before the run, and **all 36 matched** — including the two rows that file flagged as its least
confident.

The planted bug came back `survived` with `coverageAttribution: "exact"` and `guardObserved: true`,
covered by `Gift Card Tests.RedeemReducesBalance`. That is the whole demo in one row: a test
provably executed the line and did not notice.

**Use `--top 10`, not `--top 5`.** `explain` ranks survivors by how much evidence each carries, ties
broken by file and line, and the planted bug lands **sixth of nine**. Confirmed on the real report,
not predicted: `--top 5` cuts the headline off the list.

That run is FROZEN under [`docs/campaign/2026-08-16-gift-card/`](../../docs/campaign/2026-08-16-gift-card/):
the report, the per-mutant baseline, and the pre-commitment it was checked against. Before
presenting, re-run and `lethal campaign compare` against that baseline, so drift between the
rehearsal and the stage is a diff rather than a surprise.

The archived report is also the sample the docs point at: `lethal explain
docs/campaign/2026-08-16-gift-card/rehearsal.report.json --top 10` works with no server. It keeps its
source text, unlike every other committed report, because this app is ours -- see
`scripts/redact-first-party-reports.json`.

Both projects are compiled offline by `bun run compile:fixtures`, which covers `examples/` as well
as `fixtures/`. A demo app that has stopped compiling is not something to discover in front of a
room.
