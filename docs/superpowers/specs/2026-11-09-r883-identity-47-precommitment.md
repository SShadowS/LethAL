# R-883: `IDENTITY_SCHEME` 47, pre-committed before any live run

Coord task R-883, run 001, branch `lethal/r883`. Written before any gate ran on the bumped branch.

## What changes

Four emit fixes (R889), found by compiling BC.History instrumented:
- A: `swap-enum-member` quotes a keyword member.
- B: `empty-block` refuses a block with no statements.
- C: `swap-rec-xrec` refuses a field-designating argument, and the receiver of a field call whose field argument is qualified.
- D: the batch copies a dot-folder that `resourceFolders` names.

B and C refuse sites. The five-set diff against master:

| set | removed | added | tuples moved | ordinals moved |
|---|---|---|---|---|
| fixtures (29) | 0 | 0 | 0 | 0 |
| cdo | 12 | 0 | 0 | 0 |
| do | 13 | 0 | 0 | 0 |
| dc | 34 | 0 | 0 | 0 |
| bch (519) | 1,192 | 0 | 0 | 19: 14 in BaseApp `WarehouseActivityLine.Table.al` (`empty-block`), 5 in Sustainability `SustainabilityServiceLine.TableExt.al` (`swap-rec-xrec`) |

The four small sets were diffed against master a41b7c0d, and bch against fd1536b5. Ordinals move, so `IDENTITY_SCHEME` goes from 46 to 47. History, `--resume` and marks recorded under 46 are not carried.

## Predictions for the gates

No fixture site changes, so no gate row moves.

- **Each of the 12 baselines at scheme 46 changes by one line, `identityScheme` 46 to 47, and nothing else.** No verdict, `killingTest`, note, count or row order changes. The 12 are:
  - BC: `bcdev`, `bcdev.names`, `bcdev.wrapped`, `harden`, `tables`, `hang.single`;
  - v3: the six `al-runner-v3.*` (`layout`, `multiobject`, `symbols-lethala`, `symbols-lethalb`, `tables`, `wrapped`).

  `envtool.baseline.json` stays as it is (R683, host only).
- **Procedure: R332, once per file.** Delete the file, record once, confirm with a run that has no record variable. v3 records on `current` with every row as committed.
- **BC gates per mutant on the final head**, on one leased server out of bc1 to bc3: `itest:bcdev`, `bcdev-names`, `bcdev-wrapped`, `tables`, `harden`, `hang`, `chunked`, `lend`. Each one PASSES with its committed figures.
- **`itest:alrunner-v3`:** every leg passes with its committed counts, on `current`.
- **Unit goldens:** the scheme-pin tests and the digests that hash the scheme move with the number. `sandbox-harden`'s equivalence mark is re-keyed to 47.

Any other difference is a BLOCK, and I report it rather than record it.
