# R-894: `IDENTITY_SCHEME` 48, pre-committed before any live run

Coord task R-894, run 001, branch `lethal/r894`. Written before any gate ran on the bumped branch.

## What changes

R893: `r893WalkJump`, in `openItemHangRefuses`, refuses `swap-find-direction` on a FindFirst, FindLast or Find(...) of a walk's own record inside its `repeat ... until R.Next()` or `while R.Next()` body. Such a swap can rewind the walk, and that hung `bc5`. The five-set diff against master b2c7cbeb:

| set | removed | added | tuples moved | ordinals moved |
|---|---|---|---|---|
| fixtures (29) | 1 (`sandbox-optin`, which no gate reads) | 0 | 0 | 0 |
| cdo | 2 | 0 | 0 | 0 |
| do | 2 | 0 | 0 | 0 |
| dc | 12 | 0 | 0 | 4 (`CDCApprovalManagement.Codeunit.al`) |
| bch (519) | 43 | 0 | 0 | 2 (`WhsePostShipment.Codeunit.al`) |

Ordinals move, so `IDENTITY_SCHEME` goes from 47 to 48. History, `--resume` and marks recorded under 47 are not carried.

## Predictions for the gates

No site a gate reads changes: the one fixture site is in `sandbox-optin`, and no gate reads it.

- **Each of the 12 baselines at scheme 47 changes by one line, `identityScheme` 47 to 48, and nothing else.** No verdict, `killingTest`, note, count or row order changes. The 12 are:
  - BC: `bcdev`, `bcdev.names`, `bcdev.wrapped`, `harden`, `tables`, `hang.single`;
  - v3: the six `al-runner-v3.*`.

  `envtool.baseline.json` stays as it is (R683).
- **Procedure: R332, once per file.** v3 records on `current`; the BC files record on one leased server out of bc1 to bc3.
- **BC gates on the final head:** `bcdev`, `bcdev-names`, `bcdev-wrapped`, `tables`, `harden`, `hang`, `chunked`, `lend`. Each one PASSES with its committed figures.
- **`itest:alrunner-v3`:** every leg passes with its committed counts.
- **Unit goldens:** the scheme pins and the digests that follow from the scheme. `sandbox-harden`'s mark is re-keyed to 48. `instrumented-output-golden.json`'s `sandbox-optin` entry moves from 125 to 124 mutants, because of the refused site.

Any other difference is a BLOCK, and I report it rather than record it.
