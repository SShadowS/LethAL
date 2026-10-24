# R746 pre-commitment: chunked loses `fenced-coverage-no-procedure-lines`

Coord task R-746, lane lethal-code, branch `lethal/r746`. Committed to master BEFORE the pin change and the gates.

## The change
`fenced-coverage-no-procedure-lines` (bcdev fenced coverage) fires only when some declared, non-refused row lands in
no known span (a naming gap, as a shifted base-line frame produces). It stays quiet when every such row lies in a
trigger span, is a line-0 row, or is an R318 shared line. Warning-only: attribution (`entries`, `namingGaps`) is
unchanged.

## Measured (bc1, `itest:chunked` on master 218605f7 with `LETHAL_FENCED_COVERAGE_DUMP`)
- Chunked's only firing was the test `Data Tests.NoTriggerValidateRunsWeak`. Its one declared row is table 79301
  (`fixtures/sandbox-data/src/DataNoTrigger.Table.al`) at line 11, in both legs.
- In chunked's `--only src/DataMain.Table.al` slice that file is not instrumented, so line 11 is the source line
  `if StrLen("No.") > 10 then`, inside the field-level `trigger OnValidate()` (lines 9-13). That is a trigger span,
  so not a naming gap.
- Log: `/coord/handoff/R-746/measure/chunked-rows.jsonl`.

**Correction to R739's pre-commitment (c84ae94b).** R739 described the row as "the field declaration". It is a field
trigger body. "Data No Trigger" means the table has no OBJECT-level trigger; its field "No." has an OnValidate, which
the weak test runs through `Validate` without asserting anything.

## Prediction
- `GATE_WARNINGS`: `chunked/control` and `chunked/chunked` go from `[fenced-coverage-no-procedure-lines,
  only-narrowed-run]` back to `[only-narrowed-run]`. **Nothing else moves.** The code is pinned nowhere else, and
  the new rule fires only where the old one fired.
- Proven on the final head: chunked on bc1, plus every leg selectLegs picks (hang only on bc3).
- Every frozen per-mutant figure is unchanged. Any other set difference is a BLOCK.
