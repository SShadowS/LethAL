# Rung 2 — pre-commitment

Written and committed **before** the run.

## The module, and why this one

**`Codeunit 6175296 CDO E-Mail Template Management`** + **`Codeunit 6175278 CDO E-MailTemplateImportExport`**
— **991 mutation sites** across 2 files.

Chosen by measurement, not by name:

- **Size.** 991 sites. Rung 1 measured a 176-site file deploying 148 mutants (~84% after §3.2 dedup),
  so this lands near ~830 deployed — inside the plan's 500–1500 band and, importantly, **under
  `LARGE_RUN_MUTANT_THRESHOLD = 1_000`**, so no `--allow-large-run` is needed. If the deployed count
  does exceed 1,000 the run will be refused, and that refusal is correct — it is not to be overridden
  without recording the decision.
- **Dedicated tests.** `Src/Templates/` holds **101 tests** in 6 files, including
  `CDOEmailTemplateMgtTests` and `CDOTemplateImportExportTests` — tests written for exactly these two
  codeunits, rather than an area that merely touches them.
- **Zero `TestPage` files** in `Src/Templates/`, measured. This is the screening the plan requires: a
  baseline `in-flight-unknown` quarantines unconditionally (`orchestrator.ts:2360-2365`), the stop
  machinery does not reach the baseline, and R69 Task 7 measured that hang deterministic and
  unrescuable. `Email/` (2 TestPage files) and `General/` (1) were rejected on this basis despite
  also referencing the target codeunits.

Operator mix, recorded so drift is attributable:

| operator | count |
|---|---|
| `void-method-call` | 498 |
| `negate-conditional` | 182 |
| `empty-block` | 154 |
| `remove-setrange` | 59 |
| `remove-calcfields` | 35 |
| `swap-call-arguments` | 27 |
| `return-value` | 27 |
| `conditional-boundary` | 7 |
| `remove-commit` | 2 |
| **total sites** | **991** |

## Invocation

```
--only "Al/Codeunit/Codeunit 6175296 CDO E-Mail Template Management.al"
--only "Al/Codeunit/Codeunit 6175278 CDO E-MailTemplateImportExport.al"
--tests-only "Src/Templates/**"
--stop-hung-sessions
--mutant-timeout-ms 180000
```

**`--mutant-timeout-ms 180000` is mandatory, carried from rung 1.** The 30 s floor (R47) is too low
for this codebase: a `void-method-call` deleting a `SetCurrentKey` makes the following filtered query
scan, and on the fenced path a budget overrun is indistinguishable from a genuine strand, so the tier
quarantines instead of scoring the mutant. This module carries 59 `remove-setrange` and 498
`void-method-call` mutants — the same shape, at five times the scale.

## Pre-committed cardinality

**991 sites.** The deployed mutant count — what `SessionReport.mutants[]` holds after dedup — is
**not** predicted here, because rung 1 showed those are different quantities and predicting the
second from the first is what produced that error. The deployed count is read from run 1 of this rung
and asserted against run 2.

## Gates

1. **No baseline quarantine.** A baseline strand is a flat gate failure — only mutant-phase strands
   have a recovery story.
2. **Two runs, verdict-identical per mutant**, semantic-identity keyed, run 1 frozen to
   `rung2.baseline.json`.
3. **Survivor count > 0.** Otherwise gate 4 passes vacuously.
4. **Every survivor has `guardObserved === true`.** R46. Stated weakness carried from the plan:
   `true` is the weak direction — any guard in the artifact firing sets `observedAny`, not
   necessarily this mutant's. `false` on a survivor is the strong signal and must never appear.
5. **`notInstrumented` reconciles against the independent oracle** —
   `reconcileNotInstrumented` runs the header-kind census over the report's own
   `notInstrumented.files` and requires `instrumentable === 0`. Not the dry-run, which mirrors the
   same producer.

## What this rung cannot tell us

Unchanged from the spec: nothing about the ~41% of DO that no operator claims (R40), and nothing
about GUI-guarded behaviour (R60) — every verdict describes the `GuiAllowed=No`, `ClientType=ODataV4`
branch.

Carried from rung 1 as a thing to watch rather than a gate: **88 of 133 covered mutants there were
`object`-attributed vs 45 `exact`**. Object attribution runs every green test for the object instead
of a precise covering set, so a survivor under it is a weaker statement than one under `exact`.

---

# SUPERSEDED — module changed, and why

The module above (`CDO E-Mail Template Management` 660 + `CDO E-MailTemplateImportExport` 331)
**cannot be published to a hosted environment at all.** Measured 2026-08-05:

- Single batch, 991 guards → `continia publish` returned `{"success": false, "message": "The
  operation timed out."}`, and the deployment verifier then correctly reported an identity mismatch
  (`server reports artifact 5310a359…`). R44's proxy-timeout class, at a new scale.
- Retried with `--max-guards-per-batch 200`. The runner reported honestly that **batches split at
  FILE granularity**, so each of the two files became its own oversized batch (331 and 660 guards)
  and the budget could not help. Publish failed again.
- That second failure surfaced as a **bare `Error` with no message** — R65's class ("a failed tool
  spawn can report nothing at all"), here on the publish path.

**So `--max-guards-per-batch` cannot rescue a single large file.** A file whose instrumented form
exceeds the proxy's publish budget is unmeasurable on a hosted environment, full stop. The
publishable ceiling is bounded by measurement between **176 guards (rung 1, published in 36–97 s)**
and **331 (fails)**.

## The replacement module

Four codeunits, each individually at or below rung 1's proven-publishable size, all exercised by
`Src/Utilities` (**409 tests, zero `TestPage` files** — the largest clean test area in the suite):

| codeunit | sites |
|---|---|
| 6175362 `CDO Telemetry` | 229 |
| 6175274 `CDO Continia Online PDF Mgt` | 196 |
| 6175317 `CDO Core Event Handler` | 43 |
| 6175370 `CDO Merge Field Cache` | 8 |
| **total** | **476** |

Below the 500–1500 band the plan named. That band was my invention and is not what rung 2 is for:
the rung exists to run a real module through every gate with several publish batches, and 476 sites
across 4 files does that. Inflating it by re-adding an unpublishable file would fail the rung for a
reason that has nothing to do with what it measures.

**`CDO Telemetry` at 229 is deliberately included.** It sits in the unmeasured gap between 176 and
331, so this run bounds the publish ceiling as a side effect of measuring the module. If its batch
fails, the ceiling is < 229 and the run is repeated with the remaining three files (247 sites) —
that outcome is recorded, not hidden.

Invocation adds `--max-guards-per-batch 200`; everything else (gates, `--mutant-timeout-ms 180000`,
the cardinality rule, the TestPage screen) is unchanged from above.
