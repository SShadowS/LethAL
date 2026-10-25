# R753 pre-commitment: quieting the gap warnings inside a nameless split member moves no gate

Coord task R-753, lane lethal-code, branch `lethal/r753`. Committed to master BEFORE any live run on the branch.

## The change (warning-only)
- New `LineMap.inUnnamedSpan`: true only inside a nameless SPLIT procedure (`preproc_split_procedure*`, an R318
  renamed member with no coverage name). A nameless PLAIN procedure is not in it, so its rows still warn.
- `buildFencedCoverageMap`: such a row no longer feeds the two gap warnings (`fenced-coverage-no-procedure-lines`,
  `fenced-coverage-gap-beside-members`). It still goes to the CoverageMap's `namingGaps`.
- `isNamingGap`, `lookup` and `namingGaps` are untouched, so attribution, `unplaceable` and R318's 2026-10-06 ruling
  are unchanged (changing `isNamingGap` would have turned such a member's mutants into plain `no-coverage`, the R175
  defect).
- The fenced-coverage dump's `gaps` rows gain `inUnnamedMember`.

## Prediction: no pinned warning set moves, no frozen figure moves
Proven in normal mode on the final head with every leg selectLegs picks for the final diff:
- bc1: `bcdev`, `lease`, `tables`, `chunked`: PASS with every `GATE_WARNINGS` set unchanged.
- `coverage-differential` (sandbox-app, fenced vs none): the same result as R-739's run (`PASS — no blocking
  difference`; 4 `no-coverage -> survived` for the four `Sandbox Pricing` mutants, 0 identity mismatches; fenced
  killed 3 / survived 12 / no-coverage 4).
- `al-runner-v3`: cannot move. Its coverage index (`al-runner-coverage.ts`) never builds `namingGaps` and never calls
  `isNamingGap`; it uses `lookup`, `renamedMemberAt` and `inRenamedSpan` only. Every leg PASS with its figures.

**Why.** No gate fixture has a nameless split member or a nameless plain procedure, and R-748's observe pass recorded
zero naming-gap rows on every fenced leg, so the warnings' inputs are empty on every gate either way. Any difference
is a BLOCK, reported to the orchestrator before it is explained.
