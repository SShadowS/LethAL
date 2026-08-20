# R159 pre-commitment: `swap-multiplicative`, the half that was held

Written **before** the live run. A verdict that differs from this document is a finding, not a
number to update.

## Why the hold is lifted

The arithmetic spike shipped the additive half and HELD this one: `x * y` to `x / y` divides by zero
whenever `y` is zero, which is a kill no test earned, and 13 marginal sites did not pay for the
`PlatformKillMechanism` and screen ruling that would need.

**This build removes the hazard rather than screening it.** A site is claimed only where division by
zero is impossible BY CONSTRUCTION:

- the operator is `/`, so the MUTANT is `*` and divides nothing; or
- the operator is `*` and the right operand is a **non-zero numeric literal**, so the mutant divides
  by a constant that cannot be zero.

`x * y` with a variable, field or call divisor — the only shape that could divide by zero — is
simply not claimed.

**Measured on `do-rel2/Cloud`:** 34 multiplicative expressions, 27 with both operands numeric
(20 `*`, 7 `/`), of which **25 qualify** — 18 `*` sites with a literal divisor, all 7 `/` sites, and
2 `*` sites refused. 25 clears R13's bar of 13 **with no screen at all**, where the spike's unscoped
27 needed one.

So the operator declares **no `PlatformKillMechanism`**, and that is a construction proof rather than
a judgement.

## Footprint

| project | sites |
| --- | ---: |
| `do-rel2/Cloud` | **25** |
| `fixtures/sandbox-data` | **4** |
| `fixtures/sandbox-app` | **1** |
| `examples/gift-card` | 0 |
| `fixtures/sandbox-hang` | 0 |
| `fixtures/sandbox-probes` | 0 |

The demo campaign and `itest:hang` cannot move. **Three gates share the sandbox-app fixture** and all
three move by one — `itest:bcdev`, `itest:envtool` and `itest:alrunner`. That is the omission R159's
first pre-commitment made and this one does not repeat.

## `itest:tables`: four mutants, all killed

| site | mutant | predicted | why |
| --- | --- | --- | --- |
| `Data Assert Ops.DoubledLevel` | `Level * 2` → `Level / 2` | **killed** | `LibraryAssert.AreEqual(50, DoubledLevel(25))`. The mutant returns 25/2, not 50. |
| `Data Assert Ops.TripledLevel` | `Level * 3` → `Level / 3` | **killed** | the twin, asserted through a bare `Error(...)`. 25/3, not 75. |
| `Data Ops.RunUserDefinedBuiltins` | `Loader.LoadedFieldNo() * 100` → `/ 100` | **killed** | the test asserts exactly 372 = 3*100 + 7*10 + 2. |
| `Data Ops.RunUserDefinedBuiltins` | `Validator.SeenTotal() * 10` → `/ 10` | **killed** | same assertion. |

The first two are R132's TWIN PAIR, which is the reason `assertionScreen.discrimination` is
`partial` here: identical shape, one covering test raising through Microsoft's `Library Assert` and
one through bare `Error(...)`. Two more kills arrive, one on each side of R121's screen, so the label
must stay **`partial`** — a change there would mean the screen started treating the pair differently.

An AL `/` on Integers yields a Decimal, and both procedures return `Integer`. That compiles: the
additive operator's `alc` proof covered `Level * 2` → `Level / 2` on this exact fixture.

### Predicted `itest:tables`

| | before | after |
| --- | ---: | ---: |
| killed | 201 | **205** |
| survived | 34 | **34** |
| no-coverage | 11 | **11** |
| deployed | 246 | **250** |
| raw specs | 266 | **270** |

## The sandbox-app mutant, and why one site gives two different verdicts

**Site:** `Sandbox Pricing.DiscountedPrice`, `Price * Pct / 100` → `Price * Pct * 100`. The claimed
node is the `/`, so the mutant multiplies and divides nothing.

| gate | predicted |
| --- | --- |
| `itest:bcdev` | **no-coverage** → 3 / 10 / **5** over **18** |
| `itest:envtool` | **no-coverage** → 3 / 10 / **5** over **18** |
| `itest:alrunner` | **survived** → 3 / **15** / 0 over **18** |

Neither test touches `Sandbox Pricing`, so bcdev reports no coverage for it. al-runner reports no
coverage data at all, so nothing there can be classified unreached and the same mutant is `survived`
— that difference is the al-runner gate's whole character, not a discrepancy.

`itest:envtool` is predicted but **may not be measurable**: its environment reported `Stopped` when
R165 landed and LethAL will not start one it does not own. If it cannot run, the figure stays marked
inferred, as it already is.

## What would count as a finding

- Any verdict differing from the tables above.
- A sixth mutant anywhere: the census says four plus one.
- `assertionScreen.discrimination` moving off `partial`.
- Any mutant of this operator carrying a `platformKillMechanism`: it declares none, by construction.
- An `AlcCompileError`, given the additive proof already compiled `Level / 2` on this fixture.

---

# OUTCOME 2026-08-20: the operator was BUILT, REFUTED by the live gate, and REVERTED

Nothing above is edited. The prediction was wrong in a way worth keeping.

**All four `itest:tables` verdicts matched** — 205/34/11, every multiplicative mutant killed, exactly
as predicted. The refutation came from an assertion this document did not think to make.

R132's twin-pair check asserts that a kill on `DoubledLevel`, whose covering test raises through
Microsoft's `Library Assert`, must NOT be flagged by R121's assertion screen. It WAS flagged, and the
failure text says why:

```
Overflow under conversion of Microsoft.Dynamics.Nav.Runtime.Decimal18 value 12.5 to System.Int32.
Data Assert Ops(CodeUnit 79318).DoubledLevel line 10
```

`DoubledLevel(25)` mutated to `25 / 2` yields **12.5**, and returning a Decimal from a procedure
declared `Integer` **raises** in AL rather than rounding. So the mutant died on the platform before
any assertion ran: a false kill, of exactly the class this operator was designed to avoid — reached
by a mechanism the design never considered.

**The "safe by construction" claim was true and insufficient.** It proved division by zero
impossible. It said nothing about the RESULT TYPE: `Integer * literal` is an Integer, and
`Integer / literal` is a Decimal, which then has to fit back into an Integer context.

The additive half's `alc` proof had already compiled `Level * 2` -> `Level / 2` on this exact
fixture, and that is the trap: **compiling is not running**. The conversion is legal to write and
raises at execution.

## Re-measured scope, with the real hazard included

| shape | corpus sites | safe? |
| --- | ---: | --- |
| `/` -> `*` | **7** | yes — the mutant divides nothing and narrows Decimal to Integer |
| `*` -> `/`, an operand already `Decimal` | **0** | would be safe; none exist |
| `*` -> `/`, all-Integer operands | **18** | NO — this is the overflow above |

The genuinely safe scope is **7 sites, below R13's bar of 13**, so the operator is reverted and the
multiplicative half returns to HELD.

## What this cost and bought

Cost: one operator written and removed, and one gate run. Bought: the reason for the hold is now
**measured and specific** instead of a worry about division by zero, and the fixture proved it
without a single wrong number reaching a frozen baseline. The twin pair earned its keep — it exists
to detect the screen treating two identical programs differently, and it detected a mutant that was
not the program anyone thought it was.

