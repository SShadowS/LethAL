# R748 pre-commitment: `fenced-coverage-gap-beside-members` moves no gate

Coord task R-748, lane lethal-code, branch `lethal/r748`. Committed to master AFTER the observe pass (which asserts
nothing) and BEFORE any proving run.

## The change
- A new warning code, `fenced-coverage-gap-beside-members`, for a declared, non-refused object that has a naming-gap
  row AND a member row in one test. `fenced-coverage-no-procedure-lines` keeps "a gap and no member row". One
  has-member set splits the two, so no object gets both.
- `LETHAL_FENCED_COVERAGE_DUMP` records gain `gaps` (every naming-gap row, uncapped). Diagnostic only.
- Warning-only: attribution (`entries`, `namingGaps`) is unchanged.

## What the observe pass measured (head 1eaab53d, `/coord/handoff/R-748/observe/`)
Every fenced leg, each gate with its own dump: bc1 bcdev, bcdev-names, bcdev-wrapped, tables, chunked, harden, lend,
verify, testapp, agreement; bc3 hang. 416 dump records, zero naming-gap rows; neither code fired; every warning set
equal to its pin.

## Prediction: no pinned warning set moves, no frozen figure moves
The proving run is normal mode on the final head, with every leg selectLegs picks for the final diff, plus
al-runner-v3 (which does not read bcdev fenced coverage). Every `GATE_WARNINGS` set stays as it is, and every frozen
per-mutant figure is unchanged. Any emission of either code on a proving leg is a BLOCK, reported to the orchestrator
before it is explained.

## Limits of the claim
- **Fires: unit-proven only (the 1-2 line shift test); no live positive case.**
- **Quiet: proven on the fixtures only.** The fenced legs never reach page field source expressions (TestPage tests
  are refused in the fenced session), computed report or query columns, runtime property expressions (`Visible`,
  `Editable`, `StyleExpr`, `CaptionClass` from an expression), or R318 renamed split members with no coverage name
  (R753: a row there counts as a gap and would give a false warning beside a named member).
- A 1-2 line shift that lands every row in trigger spans stays quiet.
