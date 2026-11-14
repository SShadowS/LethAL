# R-973 pre-commitment: R976 (block-grain trigger mutants by line) and R986 (the r58 probe's OData root)

Written 2026-11-14 by lane code, before any live run of the change. Branch `lethal/r-973`. al-runner `current`: edge-736fc7677.

## The change

**R976.** A `statement`-grain mutant whose statement is a `begin ... end` block (a body's `lethal.empty-block`) had no `reachLine`, so
R975's line rule skipped it and FALLBACK 1 gave it every test that touched the object. It now carries the reach line of the block's
first statement (`firstStatementOf` in `dispatch-plan.ts`: through nested blocks; comments and a lone `;` skipped; none for an empty
block or one that opens with a `#if`), in the same frame as every other reach line: the block is entered exactly when that statement
runs. R975's rule then decides it (no hit: `no-coverage`; a hit: covered, attribution `line`). R926's baseline reach also decides
such a mutant on v3 from now on (a report field, no gate figure). The instrumented text does not change.

**R986.** `scripts/probe-r58-differential.ts` derives its OData and API roots with `odataCfgFor` (the config's `baseUrl`), as the
bcdev itests do, instead of `odataBaseUrl`'s port 7048.

## Measured offline (before any run)

- **Manifests**, every fixture emitted with master's code and with the branch's (16 fixtures): only `reachLine` added, only on
  `lethal.empty-block` entries (260), 0 other field differences; every `.al` file byte-identical. 249 of the 260 new lines equal the
  `reachLine` of another mutant on the block's first statement; the other 11 have no mutant on that statement (checked by hand on two).
  Re-pinned: the five `fixture-emission` manifest hashes, the `sandbox-data` manifest hash (`discovered-paths`, `per-file-refusal`),
  and 26 `reachLine` lines in the `orchestrator`/`resume` characterization snapshots.
- **DO** (`/coord/handoff/R-973/do-blast.out.txt`, the R-965 method on `/coord/handoff/R-942/dod.sqlite`): of the 46 block-grain survivors
  R975 left on the object fallback, **43** are now decided: **37 → no-coverage**, 6 stay survived with attribution `line`; 3 still have no
  reach line. All 204 DO survivors: 146 would be no-coverage, 55 line, 3 object.

## Predictions

A block's covering tests become those that hit its first statement's line, i.e. the covering tests of the other trigger mutants on
that line; their committed verdicts give its prediction (`/coord/handoff/R-973/predict.txt`).

- **Leg WR and WRE** (`al-runner-v3.wrapped.baseline.json`): exactly 3 rows move `survived` → `no-coverage`, the unwrapped twins'
  `OnOpenPage` `empty-block` (Wrapped View Twin, Wrapped Xtra Twin, Wrapped Y Band Twin), whose statements already moved in R975. WR
  **62 / 28 / 12** over 102 (was 62 / 31 / 9). No killing test moves. State notes unchanged (`0/M0075, 0/M0076, 0/M0082, 0/M0089`).
  WRE `entriesSent` **430** (was 436), by R975's measured 2 entries per mutant no longer sent; the run decides it, an amendment
  before any record if it differs. Expected file `packages/runner/itest/expected/al-runner-v3.wrapped.baseline.json` (this commit,
  R849's route): the committed rows with exactly those 3 moved.
- **Leg T**: 0 moves. 20 trigger `empty-block` mutants gain a line; 16 are covered by line (verdict and killing test unchanged: a
  killing test ran the body), 4 are already `no-coverage`. T's counts, pins and `TABLES_KNOWN_DIFFERENCES` (58) unchanged; no manifest
  digest moves.
- **Legs MO, L1, Y-A, Y-B**: their fixtures have no trigger `empty-block`; unchanged. **Every other v3 leg** (C, S1, S1E, DB, DBI, S3,
  N1, N1E, N1S, O1, ISO, X, K, MOE): unchanged. **D1, D1c** (the CDO slice): predicted unchanged (not computed offline; R975 moved none
  there).
- **BC gates**: unchanged. bcdev's coverage is procedure grain, so no session is line-complete and `reachLine` is not read.
- **Invented app** (R-965's `repro`, current edge-736fc7677, one-shot): M0001 (`OnAction` body `empty-block`, an action no test runs)
  `survived` (object) → **`no-coverage`**; M0006 (`OnOpenPage` body `empty-block`, run by `OpensThePage`) `survived` (object) →
  `survived`, attribution **`line`**, covering `OpensThePage`. Counts 5 survived / 27 no-coverage (was 6 / 26 after R975). Nothing else
  differs.
- **R986's leg**: `coverage-differential` on `bc2` (fenced vs none on `sandbox-app`) passes with the figures bc1 gave on 2026-11-14:
  fenced 3 / 14 / 5, the only moves the 5 `Sandbox Pricing` mutants `no-coverage` → `survived`, 0 identity mismatches.

Any other difference is a BLOCK, read before anything is recorded.
