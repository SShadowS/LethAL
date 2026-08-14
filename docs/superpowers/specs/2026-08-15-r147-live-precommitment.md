# R147 live pre-commitment: what `itest:alrunner` must report

Written 2026-08-15, BEFORE the gate ran, and committed before the gate ran. Never edited afterwards:
a contradicted prediction is the finding, and a prediction edited to match the result is nothing.

The change under test is `packages/runner/src/al-runner-transport.ts`'s `buildAlRunnerArgv`, which
now omits `--auto-provision` and sends `--package-cache <pinned platform-apps dir>` on every
per-mutant invocation once `runSession` has pinned one. The spec is
`docs/superpowers/specs/2026-08-15-r147-pinned-platform-apps.md`.

## Command

```
LETHAL_ITEST_ALRUNNER=1 \
LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" \
bun run itest:alrunner
```

Run in the background, to a log file. Never piped.

## The prediction

**Nothing about the verdicts moves.** That is the whole claim, and it is the only kind of claim worth
making about a change to the argv that produces them.

1. **Counts: killed 3, survived 13, no-coverage 0, over 16 mutant sites.** The frozen figures,
   unchanged.
2. **`baselineGreen` true.**
3. **Per-mutant: every one of the 16 entries matches `packages/runner/itest/al-runner.baseline.json`
   exactly**, on verdict, killing test, coverage-filtered flag and error class. `assertMatchesBaseline`
   is the judge. An aggregate match with a per-mutant difference is a FAILURE, not a pass.
4. **The three kills are all in `SandboxLogic.Codeunit.al`**, from exactly
   `lethal.conditional-boundary`, `lethal.return-value` and `lethal.empty-block`.
5. **The three `SandboxPricing` mutants survive**, never killed.
6. **Determinism holds:** the two consecutive runs the gate makes are 100% verdict-identical to each
   other, including `killingTest`.
7. **`bcBuild` is populated** and is a four-part version, with the announcement containing it (R129,
   unchanged by this work).

## What is NEW in this run, and predicted

8. **`platformAppsDir` is populated on an execution context**, and ends in `platform-apps`. This is
   the R147 assertion added to the gate. If it is ABSENT the gate fails and the run also emits an
   `al-runner-platform-apps-unpinned` warning naming which check refused; read that warning rather
   than guessing.
9. **The pinned directory is `.../28.0.46665.53671/platform-apps` or a HIGHER 28.0 build.** Not
   asserted by the gate and deliberately not: al-runner resolves the project's version prefix forward
   to the latest Microsoft build, which moved from `...53655` on 2026-08-14 to `...53671` today, so a
   fixed value would be a pin dressed as a test. Recorded here so that if it comes back lower,
   something is wrong.
10. **al-runner reports `v2.1.2.0`** as the gate's first line. If it reports anything else the tool
    updated under this measurement and the comparison is against a different binary. Read it before
    calling a difference a regression.

## What is NOT asserted, on purpose

**The wall-clock improvement.** The measured per-invocation saving is 17.1 s down to 6.8 s on a warm
cache, and it is the entire reason this change exists, but it depends on the network, on Microsoft's
publish cadence and on whether al-runner's own AL output cache is warm. A gate that held a timing
number would fail for reasons that have nothing to do with LethAL. What the gate asserts instead is
the MECHANISM: that a directory was pinned at all.

The run's elapsed time will be recorded in the closing note as an observation, not as a pass
condition.

## What would make this a BLOCK rather than a result

Any per-mutant difference, any count difference, `baselineGreen` false, or a missing
`platformAppsDir`. In each case: stop, report the mismatch verbatim, and do NOT reconcile it by
editing this file or the baseline. The baseline is re-recorded by deleting it and re-running, and
there is no reason in this change that should be necessary — a pin that does not work fails loud with
exit 2 and scores mutants `error`, which would show up as counts moving, not as a baseline that needs
rewriting.
