# R132 pre-commitment — the assertion-screen twin pair, verdicts stated before the run

Written 2026-08-14, **before** any live run of the grown fixture, and committed before the gate is
started. A prediction edited after the run is not a prediction; if the gate contradicts anything
below, the contradiction is the finding and this document does not move.

Design: `docs/superpowers/specs/2026-08-14-r132-assertion-screen-partial-design.md`.
Roadmap row: `docs/roadmap/R132.md`. Feasibility measured in `scripts/r132-assert-probe/`.

## What this wave adds

`codeunit 79318 "Data Assert Ops"` — two procedures of identical shape — plus two tests in
`fixtures/sandbox-data-tests/src/DataTests.Codeunit.al` that differ ONLY in how they raise:

- `AssertScreenSeesAnAssertionFailure` uses `Library Assert.AreEqual`. Measured failure text
  (probe, Cronus283, 2026-08-14): `Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2>
  (Integer). probe message.` — begins with `Assert.`, so R121's screen does NOT flag its kills.
- `AssertScreenSeesABareErrorFailure` raises through bare `Error(...)`, the style every other test
  in this fixture uses, so the screen DOES flag its kills.

The test app gains a dependency on Microsoft's `Library Assert` (28.0.0.0; 28.0.46665.49944 is
installed Global on both fixture containers) and is bumped 1.0.0.12 -> 1.0.0.13. Its symbols came
from the container's own dev endpoint.

## Census reconciliation (offline, `bun scripts/census-fixture-mutants.ts fixtures/sandbox-data/src`)

| | before (`510f029`) | with the arm | delta |
| --- | --- | --- | --- |
| raw specs | 248 | 252 | +4 |
| deployed | 228 | 232 | +4 |
| `lethal.empty-block` | 82 | 84 | +2 |
| `lethal.return-value` | 37 | 39 | +2 |
| `lethal.flip-filter-literal` | 6 | 6 | 0 |
| every other operator | unchanged | unchanged | 0 |

No displacement: neither site is a call, so no Tier-2 operator competes for either span.

## Per-mutant verdicts — four new mutants

All four are in `DataAssertOps.Codeunit.al`. The VERDICT column is what the run must produce; the
SCREEN column is the point of the wave.

| # | site | operator | mutation | PREDICTED verdict | PREDICTED screen | why |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | `:38` `DoubledLevel` body | `lethal.empty-block` | `begin end` | **killed** | **not flagged** | returns 0, `Assert.AreEqual` expects 50; its text begins with `Assert.` |
| A-2 | `:39` `exit(Level * 2)` | `lethal.return-value` | `exit(0)` | **killed** | **not flagged** | same test, same reason |
| B-1 | `:43` `TripledLevel` body | `lethal.empty-block` | `begin end` | **killed** | **flagged** | returns 0, the bare `Error(...)` test expects 75; no `Assert.` prefix |
| B-2 | `:44` `exit(Level * 3)` | `lethal.return-value` | `exit(0)` | **killed** | **flagged** | same test, same reason |

Same operators, same code shape, same verdict, opposite screen outcome. If all four land on the same
side of the screen, the wave has failed even though every verdict matched — which is exactly why the
gate asserts membership per mutant and not a count.

## Invariants

| invariant | value |
| --- | --- |
| killed | 187 -> **191** |
| survived | **31** (unchanged) |
| no-coverage | **10** (unchanged) |
| deployed | 228 -> **232** |
| raw specs | 248 -> **252** |
| score | 187/218 -> **191/222** |
| `assertionScreen.discrimination` | `vacuous` -> **`partial`** |
| `platformArtifactKills.killedCount` | **1** |
| `untargetedTriggerCount` | **0** |
| baseline failures | **exactly 1**, `Data Tests.PageActionComputesNonZero` |
| every pre-existing mutant's verdict | **unchanged, per mutant** |

## The bcdev gate's prediction, stated here too

The tables gate gives up its `vacuous` pin, so `itest:bcdev` takes it. Its suite
(`fixtures/sandbox-tests`) raises through bare `Error(...)` only.

**PREDICTED: `vacuous`.** The competing possibility is `no-text` — no kill carrying failure text at
all — which R132's own table lists because nobody has measured which of the two that gate produces.
If the measurement says `no-text`, that is a finding: it is recorded on the row, and the assertion is
set to the measured value with the measurement cited, never silently.

## How the run is judged

1. Per mutant against `report.mutants`, and per mutant against `assertionScreen.flaggedMutants`.
2. Any differing verdict or differing screen membership is a BLOCK: stop, report verbatim, do not
   reconcile by editing this file.
3. Second, separate gate run after the baseline is re-recorded.
