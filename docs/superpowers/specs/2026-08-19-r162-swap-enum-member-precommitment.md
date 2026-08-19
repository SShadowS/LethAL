# R162 pre-commitment: `swap-enum-member`, and the two mutants it adds to the demo

Written **before** the live run. A verdict that differs from this document is a finding, not a
number to update.

## The operator

`lethal.swap-enum-member`, Tier 2, 1.0.0. Replaces a qualified enum value with a SIBLING of the same
enum, choosing the next member in declaration order and wrapping, so the mutant is deterministic.

Four guards, and the fourth was measured rather than assumed:

1. the enum must be one **this project declares** (`enumValuesOf`, which folds in `enumextension`
   values); a base-app enum resolves to nothing here;
2. at least two members;
3. the current value must be one of them;
4. in a `case` label, the chosen sibling must not already label another arm of the same `case`.

**Guard 4 is a compile constraint, not caution.** Probed against `alc` 18.0 before the operator was
written:

```
error AL0402: Expression "R162 Status"::Open cannot be specified more than once in a 'case' statement.
```

Without the guard, one swap fails the whole project's compile as an `AlcCompileError`, after the
expensive instrument-and-publish step.

## Footprint: the headline number was a ceiling

R162 recorded 2,355 unclaimed `qualified_enum_value` nodes. That is the population, not what an
operator can honestly claim.

| | `do-rel2/Cloud` |
| --- | ---: |
| `qualified_enum_value` nodes | **2,472** |
| claimed by this operator | **65** |
| `case` labels among the nodes | 620 |
| `case` labels claimed | 11 |

The gap is guard 1: the overwhelming majority of enum values a real app writes are **base-app**
enums, whose members this project cannot see. Inventing them would emit AL naming a value that may
not exist.

**65 clears R13's bar of 13.** It is not the 2,355 the row advertised.

### This is now a pattern, and it deserves naming

Three operator candidates measured this week collapsed the same way once scoped to what the project
can actually reason about:

| candidate | ceiling | honestly claimable |
| --- | ---: | ---: |
| R159 arithmetic | 1,121 | 100 (120 after R160) |
| R165 forward trigger flag | 394 | 49 |
| R162 enum member | 2,472 | 65 |

A node-kind census answers "how much of this shape exists". It does not answer "how much of it can
this tool reason about", and for a source-derived semantic layer looking at an app built on a
platform it cannot see, the second number is one to two orders of magnitude smaller. Any future row
quoting a census figure should quote both.

## Gate impact, measured

| fixture | claimed sites |
| --- | ---: |
| `examples/gift-card` | **2** |
| `fixtures/sandbox-data` | **0** |
| `fixtures/sandbox-app` | **0** |
| `fixtures/sandbox-hang` | **0** |
| `fixtures/sandbox-probes` | **0** |

So `itest:tables`, `itest:bcdev`, `itest:envtool` and `itest:hang` are structurally unaffected. Only
the demo campaign moves. That is the mirror of R163, which moved `itest:tables` and left the demo
alone.

Both demo mutants were compile-proven offline with `alc`: **2/2 compile**.

## The two demo mutants

Both are in `PostEntry`'s caller, in `codeunit 90102 "Gift Card Mgt"`:

| site | mutant | predicted |
| --- | --- | --- |
| `Issue` | `"Gift Card Entry Type"::Issue` → `::Redemption` | **survived** |
| `Redeem` | `"Gift Card Entry Type"::Redemption` → `::Issue` | **survived** |

**Why both survive.** `PostEntry` writes the value straight into `GiftCardEntry."Entry Type"` and
changes nothing else: the card's remaining amount, the balance and every other field are identical
either way. No test in `examples/gift-card-tests` mentions `Entry Type` at all — the string does not
appear in the suite.

**This is a good result for the demo, not a bad one.** The gift card ledger records whether an entry
was an issue or a redemption, and nothing checks it. That is a plausible real bug: a statement or a
report that sums by entry type would be wrong, and the suite would stay green. It is a second
survivor class alongside the planted `remove-setrange`, found rather than planted.

### Predicted demo figures

| | before | after |
| --- | ---: | ---: |
| mutants | 41 | **43** |
| killed | 25 | **25** |
| survived | 9 | **11** |
| no-coverage | 7 | **7** |
| score | 73.5% | **69.4%** (25/36) |

The score goes DOWN, which is correct and worth saying out loud: an operator that finds two real
unasserted behaviours should lower a score, and a score that only ever rises is one nobody is
testing against new ground.

The three rows that carry the demo must not move: the planted `remove-setrange` in `GetBalance`
still survives, the `conditional-boundary` in `Redeem` still survives, and `BlockExpiredCards` is
still seven no-coverage.

## What would count as a finding

- Either mutant killed. That would mean a test asserts the entry type, which the suite does not.
- A third new mutant: the census says exactly two.
- Any movement in `itest:tables`, `itest:bcdev`, `itest:envtool` or `itest:hang`, all measured at
  zero claimed sites.
- An `AlcCompileError`, given both mutants already compile offline.
