# Rung 2 — result

**Gate verdict: PASSED**, with one recorded validity degradation that the pre-committed gate list
did not cover and should have.

## The module actually measured

Four codeunits, 476 sites → **473 deployed mutants**, driven by `Src/Utilities`' 409 tests:
`CDO Telemetry` (229 sites), `CDO Continia Online PDF Mgt` (196), `CDO Core Event Handler` (43),
`CDO Merge Field Cache` (8). Four publish batches, `--max-guards-per-batch 200`.

| | run 1 | run 2 |
|---|---|---|
| killed | 35 | 35 |
| survived | 125 | 125 |
| no-coverage | 313 | 313 |
| error | 0 | 0 |
| total | 473 | 473 |
| wall clock | 1077.9 s | 1032.0 s |

**Per-mutant verdict-identical**, semantic-identity keyed. Score 21.9% over the 160 scored.

## Gates

| # | gate | result |
|---|---|---|
| 1 | No baseline quarantine | **PASS** — none; 4 batches published, 0 errors |
| 2 | Two runs verdict-identical per mutant | **PASS** |
| 3 | Survivor count > 0 | **PASS** — 125 |
| 4 | Every survivor `guardObserved === true` | **PASS** — 125 of 125 |
| 5 | `notInstrumented` reconciles | **PASS, trivially** — under `--only` the report's `notInstrumented` is empty (fileCount 0), so there is nothing to reconcile. Recorded as vacuous rather than claimed as evidence. |

## The degradation the gate list missed

**The baseline is RED: 11 of 409 tests fail.** The report flags itself
`narrowed-degraded [baseline-red, narrowed, tests-narrowed]`.

All 11 are in one unrelated codeunit — `CDO Log Management Tests`, every one a Job Queue test
(`CreateLogCleanupJob_*`, `EnableDeleteLogJob_*`). None exercises the module under measurement; they
are in `Utilities` because that area is a grab-bag.

**This was not retuned away.** Rung 2's pre-committed gate list did not include "baseline green" —
rung 1's anchor 1 did, and it should have been carried. Adding the gate after seeing it fail is the
rationalisation this campaign refuses, so it is recorded as a **plan defect found by running the
plan**: any future rung must carry baseline-green as a gate, decided in advance.

Why it matters rather than being cosmetic: R55 measured that tests failing at baseline are dropped
from the green set, and mutants covered only by them are recorded `no-coverage` — a real survivor
converted into a non-finding.

## The other finding: module selection by name is too weak

**313 of 473 mutants are `no-coverage` — 66%**, against rung 1's 10% (15 of 148).

Attribution split: `exact` 135, `object` 25, absent 313.

`Utilities` has the largest clean test count in the suite (409 tests, zero `TestPage`), but its tests
barely exercise these four codeunits — the area references `CDO Telemetry` and
`CDO Contnia Online PDF Mgt.` once each. The plan called for ranking candidate modules by **coverage
density** using R69's per-test coverage data; I never confirmed that data still exists and
substituted a name-matching proxy. The substitution is visible in the result.

For any future rung: rank by measured coverage, or accept that a large test area is not the same as a
covering one.

## Publish ceiling, now bounded by measurement

The originally-chosen module (`CDO E-Mail Template Management` 660 + `CDO E-MailTemplateImportExport`
331) **could not be published at all**:

- 991 guards in one batch → `{"success": false, "message": "The operation timed out."}`, then a
  correctly-reported artifact identity mismatch.
- `--max-guards-per-batch 200` did not help: **batches split at FILE granularity**, so each file
  became its own oversized batch. The runner said so explicitly rather than dropping work silently.
- That second failure surfaced as a **bare `Error` with no message** — R65's class, on the publish
  path.

| guards in one file | publishes? |
|---|---|
| 176 (rung 1) | yes, 36–97 s |
| **229 (`CDO Telemetry`, this rung)** | **yes** |
| 331 (`CDO E-MailTemplateImportExport`) | **no — times out** |
| 660 (`CDO E-Mail Template Management`) | **no — times out** |

So the ceiling on this hosted environment lies between **229 and 331 guards per file**, and
`--max-guards-per-batch` cannot rescue a file above it. A file that large is unmeasurable here.

## Costs measured

| phase | run 1 | run 2 |
|---|---|---|
| deploy (4 batches) | 149.2 s | 141.0 s |
| **baseline** | **740.6 s** | **708.9 s** |
| mutants (473) | 170.8 s | 166.0 s |
| per-mutant | mean 1067 ms, median 433 ms, p95 6375 ms | — |

**The baseline dominates at 69% of wall clock**, because R45's rule holds: the baseline is paid
per batch, and 409 tests × 4 batches is the real cost. Mutant execution is cheap by comparison —
median 433 ms. Narrowing tests, not narrowing mutants, is the lever that matters at this scale.
