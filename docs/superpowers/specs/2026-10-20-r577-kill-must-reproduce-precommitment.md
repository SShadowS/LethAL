# R577 pre-commitment: "a kill must reproduce" on al-runner (2026-10-20, lethal-preproc)

**Addendum (2026-10-21), written before the confirming run.** R-557 (master 0ca868e6) added the names legs
(`fixtures/sandbox-names`; A1 and A2 one-shot, A3 and A4 `--server`; coverage `al-runner` and `none`). The
merge into `lethal/r577` is 24d16995. Predicted, NOT measured:
- **Verdicts:** every names leg is unchanged against `al-runner.names.baseline.json` (36 killed) and R-557's
  own pre-committed table, per mutant.
- **New figures:** every kill carries `killReproduced`, none is `kill-not-reproduced`, and
  `killerRowsPerKill` is **2** for `names/one-shot` and `names/server`.
- **Why 2:** in the orchestrator, both the store's `test_results.method` and `killing_test` come from the
  same LethAL-side test reference; R-557 maps al-runner's mangled names back inside the backend. The
  fixture's 12 test method names are unique.
- A different figure is a BLOCK, reported as it is.

Everything below stands.

Written BEFORE the confirming `itest:alrunner` run and BEFORE the rule-on slice runs. Plan:
`docs/superpowers/plans/2026-10-18-r577-kill-must-reproduce.md`. Branch `lethal/r577`. al-runner build
`v2.12.0-main.f06ee78c` (`/work/tools/al-runner/current`).

The figures in §1 come from one MEASURING run of the built code at `102821df`
(`/coord/handoff/R-577/scratch/itest-measure.log`). That run failed by design, because the table was still
empty. Its only failure was the "not yet measured" check, and every per-mutant verdict table passed.

## 1. `itest:alrunner` (every leg, the rule ON through `AlRunnerBackend.killsMustReproduce`)

**Verdicts do not move.** On every leg, every mutant's verdict, `killingTest` and `errorClass` stay equal to
its committed baseline. No baseline is re-recorded.

| Leg | Baseline | Killed (all reproduced) |
|---|---|---|
| sandbox (one-shot, server, resource) | `al-runner.baseline.json` | 3 |
| layout (one-shot, server) | `al-runner.layout.baseline.json` | 7 |
| multiobject (one-shot, server, resource) | `al-runner.multiobject.baseline.json` | 6 |
| wrapped (one-shot, server, resource) | `al-runner.wrapped.baseline.json` | 58 |
| symbols LETHALA (three legs) | `al-runner.symbols-lethala.baseline.json` | 5 |
| symbols LETHALB (three legs) | `al-runner.symbols-lethalb.baseline.json` | 5 |
| cli-default | `al-runner.cli-default.baseline.json` | 3 |

**New figures, asserted** (`REPRODUCTION_EXPECTED` in `packages/runner/itest/kill-reproduction.ts`):
- **Every leg:**
  - every `killed` mutant carries `killReproduced`;
  - no mutant has cause `kill-not-reproduced`;
  - the store's kill count equals the report's;
  - `killerRowsPerKill` = **2**: two MUTATED `test_results` rows for the killing test, the first run and its
    reproduction.
- **cli-default:**
  - `activations` **23**: the old 20 plus one per kill;
  - `serverSuiteRuns` **22**: 1 baseline, 15 covered mutants, 3 unmutated confirmations, 3 reproductions.
- **Unchanged:** `groupedCalls` 0, `warmKills` 0, every `killPosition` 1, cli-default's 3 one-shot spawns.
- **Timeout kills:** 0 on every leg (none in any baseline), so the timeout half of the rule is not exercised
  live here. It rests on the unit tests until R582 runs `itest:hang`.

The result must be PASS, with no `R577:` "not yet measured" line. Any verdict change, any
`kill-not-reproduced`, or any figure different from the above is a BLOCK, reported as it is.

## 2. The R-577 slice with the rule on (a measurement, not a gate)

- **Slice:** BC.History Simplified Bank Statement Import, the scratch copy and flags in
  `/coord/handoff/R-577/measure.md` (38 mutants, coverage `"none"`, default transport `--server` +
  resource). At least 6 runs, one at a time.
- **Predicted, per run:**
  - **zero false kills:** every `killed` mutant is one of M0005, M0006 and M0007, killed by
    `LoadCsvWithAmountWithCommaThousandsSeparator`, with `killReproduced`;
  - M0005, M0006 and M0007 are killed and reproduced in EVERY run;
  - when `WizardAllStepsCsvSeparatorSemicolonAndDecimalSeparatorComma` fails at random under a mutant (about
    0.6% of its runs, so 0 to a few across the runs), that mutant is `error` / `kill-not-reproduced`, never
    `killed`, unless a later covering test kills it and reproduces;
  - every other mutant is `survived`.
- **Not predicted:** how many `kill-not-reproduced` appear. Zero across all runs is consistent with the rate
  and does not refute the rule. A `kill-not-reproduced` on any test OTHER than that wizard test, or a
  `killed` mutant outside M0005-M0007, is a finding, reported as it is.
