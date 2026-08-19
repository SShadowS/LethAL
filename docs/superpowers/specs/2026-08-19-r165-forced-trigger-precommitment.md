# R165 pre-commitment: the forward run-trigger direction, and the one mutant it adds

Written **before** the live run. A verdict that differs from this document is a finding, not a
number to update.

## What changed

`lethal.swap-modify-flag` 1.1.0 → **1.2.0** (MINOR: it gains sites and changes no existing mutant,
so `design.md` §5.1's history reset must not fire).

It now also claims the ARGUMENT-LESS form. `Rec.Modify()` means `RunTrigger = false`, so the mutant
is `Rec.Modify(true)`, which makes the table's `OnModify` RUN where it did not.

**Scoped, and both refusals are measured** (`scripts/r165-probe/`, 394 argument-less calls on
`do-rel2/Cloud`):

| refused because | sites |
| --- | ---: |
| implicit `Rec` receiver, no table to reason about | 93 |
| receiver's table not declared by this project | 81 |
| table declared but declares no matching trigger | 171 |
| **claimed** | **49** (Insert 37, Delete 10, Modify 2) |

A base-app trigger is invisible here, so no screen could classify a kill at such a site; and forcing
a trigger that does not exist is close to equivalent, which is what `RemoveSetLoadFields` was refused
for. 49 clears R13's bar of 13 and is *smaller* than the 62 the skip direction claims, the opposite
of this row's first estimate.

## The new mechanism, and why it can be precise

`run-trigger-forced`. Forcing a trigger writes MORE than the unmutated program, so unlike SKIPPING
one it can add an error — an `Error`, a `TestField`, a `FieldError`, or a write to another table
hitting a duplicate key. R138 ruled that `Delete` and `Modify` need no mechanism when skipping,
precisely because skipping can add nothing.

Unlike `run-trigger-skipped-insert`, which is a blanket tag on every `Insert` mutant, this one is
emitted **only where the trigger body provably contains a raise-capable statement**. That is possible
because the operator is scoped to tables this project declares and that declare the trigger, so the
detector always has the trigger in front of it. It under-tags for a raise reached through a project
procedure, which is the honest direction for a screen whose value is that a tag means something.

## Footprint on the fixtures

Exactly **one** new mutant anywhere:

| fixture | new forward-direction mutants |
| --- | ---: |
| `fixtures/sandbox-data` | **1** |
| `fixtures/sandbox-app` | 0 |
| `examples/gift-card` | 0 |
| `fixtures/sandbox-hang` | 0 |
| `fixtures/sandbox-probes` | 0 |

So `itest:bcdev`, `itest:envtool`, `itest:alrunner`, `itest:hang` and the demo campaign cannot move.

## The one mutant

**Site:** `pageextension` `Data Main List Ext`'s `OnOpenPage`
(`src/DataMainListExt.PageExt.al`), `Main.Modify()` → `Main.Modify(true)`.

The fixture states the mechanism itself, in a comment written long before this operator existed:

> `Modify()` (i.e. RunTrigger = false) on purpose: running OnModify would add 1 to the very field
> being asserted.

**Predicted verdict: `no-coverage`.**

Not `killed`, and the difference matters. `Data Main`'s `OnModify` does
`"Modify Count" := "Modify Count" + 1`, so forcing it WOULD corrupt the asserted value — but the test
that would catch it, `PageExtCountsMatchingRelated`, **no longer exists**. It was removed after being
measured twice against Cronus283 to wedge the fenced session: `in-flight-unknown` at baseline and the
whole 84-mutant run quarantined. That is why this pageextension's four existing mutants are already
`no-coverage` (M0122 to M0125), and the fifth joins them.

**No tag.** `forcedTriggerCanRaise` reads `Data Main`'s `OnModify`, finds one assignment and no
raise-capable call, and emits no `platformKillMechanism`. So `platformArtifactKills.killedCount`
stays **2**: this mutant is not killed and carries no tag either way.

### Predicted frozen figures

| | before | after |
| --- | ---: | ---: |
| killed | 201 | **201** |
| survived | 34 | **34** |
| no-coverage | 10 | **11** |
| deployed | 245 | **246** |
| raw specs | 265 | **266** |
| mutation score | 201/235 | **201/235**, unchanged |

The score does not move because no-coverage is excluded from it. `untargetedTriggerCount` **0**,
`platformArtifactKills.killedCount` **2**, `assertionScreen.discrimination` **`partial`**,
`declarativeSites` **1**, all unchanged.

## What would count as a finding

- The mutant `killed`, which would mean a test reaches that `OnOpenPage` after all.
- The mutant carrying `run-trigger-forced`, which would mean the detector found a raise-capable
  statement in an `OnModify` that has only an assignment.
- A second new mutant anywhere: the census says exactly one.
- Any movement in the four gates measured at zero new sites.
