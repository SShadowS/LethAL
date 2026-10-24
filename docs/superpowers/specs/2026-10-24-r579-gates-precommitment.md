# R-579 (roadmap R579, R580): pre-commitment for the gates (2026-10-24)

Written BEFORE any live gate of the R-579 head (`lethal/r579`), from `/coord/handoff/R-579/plan.md` (with its plan and
build reviews). Any difference is a BLOCK.

## What changes (`packages/runner/src/line-map.ts`)
- **R579:** `pragma` is trivia in `NOT_AN_OBJECT`, so a `#if` holding only pragma, namespace, using or comment lines
  is no object wrapper anywhere (v3, the index, the BC path).
- **R580 and the B1 ruling:** `CODE_FREE_KINDS` gains enumextension, controladdin and dotnet. `alRunnerAdmitsWrappedFile`
  admits a file whose wrapped objects are all code-free and hold no code, with no bare object beside them.
- **Fail-closed addition:** `ERROR` is in `CODE_KINDS`.
- **A new v3-only fixture pair,** `fixtures/sandbox-codefree(-tests)`, in no gate. The plan-emit golden is re-recorded,
  additions only for that pair.

## Offline evidence (ran before this file; no live gate has)
- Census on the built `alRunnerCoverageSupport`: BC.History 14 -> 3 coverage-off source projects (Base Application,
  E-Document Core, EU 3-Party Trade Purchase); CDO, DC and DO 0.
- v3 coverage differential on `sandbox-codefree` (per-procedure tests, a driver that fails if coverage is off):
  coverage on (14 tests with coverage sets, 43 covered), verdicts identical to coverage none (38 killed, 5
  survived), no lost kill.

## The live gates: every per-mutant verdict unchanged
The legs come from `selectLegs` on the final diff: `bcdev`, `lease`, `stale-publish`, `tables`, `chunked`,
`alrunner-v3`, `coverage-differential`, `hang` (copied literally; the new fixture's files are unmatched, as it is in no
gate).
- Every gate passes, with every per-mutant verdict and killing test unchanged against its committed baseline
  (scheme 42), and every gate-page figure unchanged. No scheme-change line.
- The build review's scan of all 111 fixture `.al` files found no existing fixture whose wrapped status, admission or
  ERROR content changes, so no figure can move.
- `itest:alrunner-v3` runs all 13 legs (C, S1, S3, N1, X, L1, Y-A, Y-B, MO, WR, D1, D1c, T), with
  `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set.
- **`coverage-differential`** (no script; the skill's procedure):
  - on bc1, `probe-r58-differential.ts` on `fixtures/sandbox-app` in `--mode fenced` against `--mode none`, compared
    by `probe-r58-compare.ts`: no lost kill (ATTRIBUTION LOST 0), no blocking move;
  - plus the v3 fixture differential above, re-run on the final head with the same result.
- BC legs run on servers proven for them (`hang` on bc3), one gate per server, each under a lease, in separate
  worktrees.
