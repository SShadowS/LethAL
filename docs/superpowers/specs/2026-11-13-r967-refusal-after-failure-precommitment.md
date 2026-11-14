# R-967 pre-commitment: a v3 refusal that only cascades from an earlier failure no longer ends the mutant (R978)

Committed before any code change, 2026-11-13. Coord task R-967 (lethal-bugs). Related: R978 (filed by R-964), R639 (the same rule for a
refusal that cascades from a timeout).

## What was measured (R-964 batch 11, `/coord/handoff/R-964/recur.run.report.json`, `recur.run.sqlite`)

Microsoft's Recurrence Schedule tests (29, baseline 29 green), al-runner edge-c8fe56e05, codeunit isolation. 76 of 280 mutants are
`error` with al-runner's refusal `a test before this one in the codeunit did not pass (<T>: failed (Assert...)) and could draw random
numbers, ... this failure is not trusted`. Per mutant, from the store: the covering loop recorded passes, then the refused row, and
stopped; the failing test `<T>` was never consulted. In all 76, `<T>` is one of the mutant's own covering tests (checked against
`coveringTests`), and `<T>` was the call's first non-passing row. Example: M0007 (`CreateWeekly`, swap-call-arguments), covering 11,
rows recorded 4 (3 pass, then the refusal), `<T>` = `TestWeeklyMonday`.

So each is a kill BC would score: a covering test failed under the mutant, from a clean state (every earlier test of the call passed),
and the refusal only concerns a LATER test of the same call. LethAL ended the mutant at the refusal because its covering order put the
refused test before `<T>`.

## The change

The v3 backend flags a `runner-refused` row as a cascade (as R639 flags one after a timeout) when the call's FIRST non-passing row came
before it and is a plain failure (not a refusal, not a timeout). The covering loop then goes on; if no covering test decides the mutant,
the refusal ends it as an error, as today. A kill found this way is confirmed and reproduced by the existing rules (R577), and a kill
from a row after the failing one keeps its codeunit-state note, as today.

## Predictions

1. **Recurrence Schedule:** re-run on master with the change (same pool, environment onprem, edge-c8fe56e05): the 76 mutants become
   `killed`, each with `killingTest` = its `<T>`; the 77th error (CalcDate out of range) stays `error`; every other mutant keeps its
   verdict and killing test (killed 92 -> 168, error 77 -> 1, survived 54, no-coverage 57). Any other move is a finding to explain.
2. **The v3 gate:** no pinned figure moves (no gate fixture has a refusal after a failure in one call). A moved figure is a BLOCK.
3. **Unit tests:** a red test each way: a refusal after a plain failure lets a later covering failure kill; a refusal after an earlier
   refusal, or after a timeout handled by R639's own rule, behaves as before.
