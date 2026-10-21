# R-394: al-runner coverage ON by default (pre-commitment)

Committed to master BEFORE any gate record (R332). Lane `lethal-preproc`, 2026-10-11. Plan: `/coord/handoff/R-394/plan.md`
(r2). The flip changes ONE default: `alRunner.coverage` becomes "al-runner" when the config does not set it. Every
guard stays (the R407 frame probe, the R298 wrapped-shape refusal) and runs on the effective coverage.

## What moves: the CLI-default leg of `itest:alrunner` only

`packages/runner/itest/cli-default-leg.ts` runs `fixtures/sandbox-app` through the CLI defaults (`--server`, the
resource selector, and now coverage on). Its frozen figures move from **3 / 16 / 0** to **3 / 12 / 4**.

| row (`al-runner.cli-default.baseline.json`) | before | after |
|---|---|---|
| Sandbox Pricing / DiscountedPrice / conditional-boundary | survived | **no-coverage** |
| Sandbox Pricing / DiscountedPrice / return-value | survived | **no-coverage** |
| Sandbox Pricing / DiscountedPrice / swap-additive | survived | **no-coverage** |
| Sandbox Pricing / DiscountedPrice / empty-block | survived | **no-coverage** |
| every other row (15) | unchanged | unchanged |

- **The cross-check:** after the flip, every row's `verdict` and `killingTest` EQUAL leg A's
  (`al-runner.baseline.json`, the one-shot leg that already runs with coverage on) for the same key. This matches
  R220's pre-commitment (`2026-09-09-r220-alrunner-coverage-precommitment.md`) and R394's own text.
- **The 3 kills:** they keep their killing tests.
- **The identity record:** `identityScheme` and `mutatedTextSha256` stay as R-560 recorded them; only the verdicts
  above change.

## What does not move
Every other `itest:alrunner` leg passes coverage explicitly or builds its backend directly, so the default does not
reach it: leg A, `--server`, resource, layout, multiobject, wrapped and the R321 symbol legs. Their baselines must
PASS unchanged. No BC gate is affected (al-runner only).

Any other difference is a BLOCK: report it, do not record it.

## Procedure (R332)
1. Build the flip, with its unit tests.
2. Delete `al-runner.cli-default.baseline.json`.
3. Run `LETHAL_ITEST_ALRUNNER=1 LETHAL_ITEST_RECORD_BASELINE=al-runner.cli-default.baseline.json bun run itest:alrunner`;
   it must exit 3.
4. Check the new file against the table above and against leg A, per key.
5. Confirm: `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` must PASS, with no UNVERIFIED line.
6. Commit, citing this file's commit.
