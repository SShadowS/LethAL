# R735 live re-run of R734's proof: pre-commitment (lane bugs, R-735, 2026-10-24)

Committed before any live run. Never edited after; changes go in a dated addendum file.

## What is proven
R735 makes compile isolation try the mutants alc's own diagnostics point at first (each confirmed by a
compile of that mutant alone), falling back to R734's halving. This re-runs R734's live proof
(`2026-10-24-r734-live-isolation-precommitment.md`, master 2b2ca272, all five predictions passed on bc3)
on the R735 head, and adds a prediction about the number of compile-only runs.

## Setup (as R734's proof, unchanged except the code)
- Code: the submitted head of `lethal/r735`; its sha is recorded in the run log.
- Project `fixtures/sandbox-app` on one of `bc1`/`bc2`/`bc3` under a coord lease, bcdev backend, the same
  `lethal run` flags and scratch stores as R734's `run-proof.sh` (`/coord/handoff/R-731/proof/`).
- Run A: the head unchanged. Run B: a scratch copy of the same head with R734's fault patch in
  `packages/schemata/src/components.ts`: a trailing ` @@` appended to the emitted mutated text of exactly
  F1 (`Sandbox Logic|IsOverBudget|lethal.return-value|1`) and F2
  (`Sandbox Logic|ClampPercent|lethal.negate-conditional|1`). Nothing in the repo changes.

## Predictions (any miss is a BLOCK)
- P1-P5: exactly R734's P1-P5 (Run A equals `packages/runner/itest/bcdev.baseline.json`; F1/F2 `error` with
  notes naming their own source line and an alc code; the other 17 equal Run A; 19 rows, one
  `compile-isolation` warning, the failing batch published once; no corrupt store, stranded mutant or
  quarantine).
- P6: every Run B mutant equals R734's Run B (`/coord/handoff/R-731/proof/run-b.json`) per identity key in
  verdict, killingTest and note text (F1's and F2's notes byte-identical).
- P7: Run B emits exactly one `compile-isolation-result` warning reading
  `batch 0: isolation used 5 of 64 compile-only runs: 2 culprit(s), 0 in pairs, 0 unresolved`
  (the empty set, the full set, F1 alone, F2 alone, the 17 clean mutants). Evidence for 5: an offline alc
  compile of Run B's full batch reports both faults (`/coord/handoff/R-735/live-n.md`; R734's proof prep saw
  the same with ` @@`). Run A emits no `compile-isolation-result` warning.

## Not claimed
No wall time. No compile order beyond P7's count. Nothing about al-runner-v3 or k > 2 (unit tests and the
offline DC measurement in `/coord/handoff/R-735/dc/` cover those).
