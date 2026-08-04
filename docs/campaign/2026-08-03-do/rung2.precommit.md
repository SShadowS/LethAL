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
