# R-871: `IDENTITY_SCHEME` 46, pre-committed before any live run

Coord task R-871, run 002, branch `lethal/r871`. Written before any gate ran on the branch.

## What changes

`recursionDepthHangs` (R865, `packages/builtin-tier1/src/recursion-hazard.ts`) makes `swap-additive` and `delete-additive-*` refuse the depth argument of a direct recursion. Measured by the corpus-snapshot diff against master 1aba1bf6:

| set | removed | added | tuples moved | ordinals moved |
|---|---|---|---|---|
| fixtures (27 projects) | 0 | 0 | 0 | 0 |
| cdo | 0 | 0 | 0 | 0 |
| do | 0 | 0 | 0 | 0 |
| dc | 2 | 0 | 0 | 0 |
| bch (519 projects) | 24 | 0 | 0 | 4, all in BaseApp/Source/Base Application |

Ordinals move, so `IDENTITY_SCHEME` goes from 45 to 46. History, `--resume` and marks recorded under 45 are not carried.

## Predictions for the gates

No fixture site changes, so no gate row moves.

- **Each of the 12 baselines at scheme 45 changes by one line, `identityScheme` 45 to 46, and nothing else.** No verdict, `killingTest`, note, count or row order changes. The 12 are `bcdev`, `bcdev.names`, `bcdev.wrapped`, `harden`, `tables`, `hang.single`, and the six `al-runner-v3.*` (`layout`, `multiobject`, `symbols-lethala`, `symbols-lethalb`, `tables`, `wrapped`). `envtool.baseline.json` stays as it is (R683, host only).
- **Procedure: R332, once per file.** Delete the file, record once, then confirm with a run that has no record variable. v3 records on `current` with every row as committed, so no `itest/expected/` file is needed (R849: a stale one is refused).
- **BC gates per mutant on the final head:** `itest:bcdev`, `bcdev-names`, `bcdev-wrapped`, `tables`, `harden`, `hang`, `chunked`, `lend`. Each one PASSES with its committed figures. `chunked` and `lend` have no scheme-pinned baseline, and their tables do not move.
- **`itest:alrunner-v3`:** every leg passes with its committed counts, on `current`.
- **Unit goldens:** the scheme-pin tests and the digests that hash the scheme move with the number. `instrumented-output-golden.json` and the `report-equality` snapshot change only where the scheme appears. `sandbox-harden`'s equivalence mark is re-keyed to 46.

Any other difference is a BLOCK, and I report it rather than record it.

## Addendum 1, before any live run: `sandbox-optin`

The table above was measured against master 1aba1bf6. R868 landed after that measurement, adding the fixture `sandbox-optin`. Re-measured against master 9c91e69d, fixtures (29 projects): **`sandbox-optin` loses 2 specs** (one `swap-additive`, one `delete-additive-right`, both in `OptinLogic.Codeunit.al`), with 0 tuples and 0 ordinals moved. Every other fixture is identical.

- No gate reads `sandbox-optin`, so the gate predictions above stand.
- R868's pre-commitment pins only the opt-in operators' rows, not these two. So its hand check is unchanged.
- `instrumented-output-golden.json` moves for this file: 127 to 125 mutants, with a new sha256.
