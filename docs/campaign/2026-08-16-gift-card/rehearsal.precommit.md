# Stage `rehearsal` — pre-commitment for the gift card demo

The full per-mutant pre-commitment is
[`docs/superpowers/specs/2026-08-16-gift-card-demo-precommitment.md`](../../superpowers/specs/2026-08-16-gift-card-demo-precommitment.md).
It predicts all 36 deployed verdicts by (procedure, operator, statement), was written before any run
against a server, and all 36 matched on 2026-08-16 against Cronus281.

This file exists so `lethal campaign freeze` has the stage's committed pre-commitment where it
looks for it, and so the frozen baseline is not the only record of what was expected.

## Pre-committed

| | |
|---|---|
| deployed mutants | **36** (40 raw sites, 4 displaced by Tier-2 precedence) |
| killed | 20 |
| survived | 9 |
| no-coverage | 7 |
| mutation score | 68.97% |
| baseline | 8 tests, all passing |

Target: `examples/gift-card` + `examples/gift-card-tests`, backend `bcdev`, single batch.

## Why this stage is frozen at all

The demo is shown live at Directions EMEA 2026. Between now and then the tool moves, the grammar
moves, the container moves, and the app might. A frozen per-mutant baseline turns any of that into a
`lethal campaign compare` diff before the talk instead of a surprise during it.

The three rows that carry the demo, and that a diff must never silently lose:

- `GetBalance` / `remove-setrange` — **survived**. The planted bug. If this ever reads `killed`,
  the demo is broken and nothing else about the run matters.
- `Redeem` / `conditional-boundary` at the remaining-amount guard — **survived**. The genuine
  shippable bug.
- `BlockExpiredCards` — all seven mutants **no-coverage**. The nightly job no test calls.

---

## Amended 2026-08-19 by R161: the stage is re-frozen at 41 mutants, not 36

This document's predictions were made and met at 36 mutants. R161 widened six operators' guard from
`isStatementPosition` to `isStatementSlot`, so a call that is the un-braced body of a branch is now
claimed, and this app gained **five** mutants: the `Error(...)` in each of its guard clauses, which
no operator could reach before. All five are killed, each by the `asserterror` test written for that
guard. Totals move 36 -> 41 and 20 -> 25 killed; survivors and no-coverage are unchanged.

Nothing above is edited. The five new predictions were written down BEFORE their run, in
`docs/superpowers/specs/2026-08-19-r161-branch-slot-precommitment.md`, and all five matched.

**The three rows that carry the demo are all unchanged**, which is the point of checking: the
planted `remove-setrange` in `GetBalance` still survives, the `conditional-boundary` in `Redeem`
still survives, and `BlockExpiredCards` is still seven no-coverage. The demo now shows both halves
at once: a suite that catches every guard clause and still misses the thing nobody asserted.

---

## Amended 2026-08-19 again by R162: the stage is re-frozen at 43 mutants

`lethal.swap-enum-member` landed and this app gained **two** mutants, both in `Gift Card Mgt`:
`"Gift Card Entry Type"::Issue` swapped to `::Redemption` inside `Issue`, and the mirror inside
`Redeem`. Both are predicted and measured **survived**.

They are worth more to the demo than the count suggests. `PostEntry` writes the value straight into
`GiftCardEntry."Entry Type"` and changes nothing else, and the string `Entry Type` appears nowhere in
the suite. So the ledger records whether an entry was an issue or a redemption and **nothing checks
it** — a statement or a report summing by entry type would be wrong and the suite would stay green.
That is a second survivor class FOUND rather than planted, sitting beside the deliberately planted
`remove-setrange`.

Totals move 41 -> 43 and survivors 9 -> 11; killed and no-coverage are unchanged. The score falls
from 73.5% to **69.4%**, which is the right direction: an operator that finds two real unasserted
behaviours should lower a score.

Nothing above is edited. The two predictions were written before their run in
`docs/superpowers/specs/2026-08-19-r162-swap-enum-member-precommitment.md` and both matched.

**The three rows that carry the demo are still unchanged**: the planted `remove-setrange` in
`GetBalance` survives, the `conditional-boundary` in `Redeem` survives, and `BlockExpiredCards` is
still seven no-coverage.

