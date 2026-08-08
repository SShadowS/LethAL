# Campaign manifest — `2026-08-08-r85-swap-population`

A verdict file without its configuration is an unreproducible aggregate. This is the configuration.

## What is being measured

R85: the rate at which Continia Document Output's own test suite notices a swapped pair of
arguments. Instrument **(b)** — a LethAL run against the real app.

This is a NEW campaign, not a retune of `2026-08-07-r85-swap-rate`. That one stands as written; its
rung 1 scored 3 swaps, all false kills, and its own result says a tighter rate needs a fresh
pre-commitment rather than a second pass under the same rule. Re-tuning after seeing coverage is
selecting on a variable correlated with the outcome.

## Why this one can exist and that one could not be repeated

R127 landed on 2026-08-08: `--operator <name>` narrows a run to one operator. The 2026-08-07 campaign
had no such knob, so it had to buy every other operator's mutants in the files it chose — 894
deployed to score 3 swaps — and it therefore needed a seeded file-budget sampling rule. With the
operator filter the WHOLE swap population is cheaper than that truncated run was, so there is no
sample, no seed, and nothing to select on.

## Pinned configuration

| | |
| --- | --- |
| target project | `U:/Git/do-lethal/Cloud` (554 `.al` files) |
| test project | `U:/Git/do-lethal/Test` |
| target source commit | `5f2a71d3` ("Merged PR 51384: Bug #77641: Opt-in template-linked scheduling on Document Output queue") |
| target worktree state | `Test/app.json` differs by LINE ENDINGS only (CRLF); one UNTRACKED test file, `Test/Src/AutomaticDocuments/CDOAutStatementFeatureTests.Codeunit.al` |
| LethAL provenance | run FROM SOURCE, `bun packages/runner/src/cli.ts`, at LethAL commit recorded in `rung2.result.md`; not the `U:/Git/do-lethal/lethal.exe` binary the 2026-08-07 campaign used, which predates `--operator` |
| config | `U:/Git/do-lethal/lethal.config.envtool.json` (gitignored; holds credentials) |
| selector ids | selector 6175468, control 6175467, table 6175466 — inside DO's own range 6175271..6175468 |
| environment | Continia hosted `f5f11bf2-4b02-48f1-9707-2bd49f81bf2b` ("lethal-do-campaign"), BC 28.0.0.0, expires 2026-08-18 |
| environment tool | `U:/Git/CLI/continia.exe` via the config's `envTool` block |
| results db | `U:/Git/do-lethal/lethal-r85-rung2.sqlite` (outside the LethAL tree) |

**The published TEST app is whatever `f5f11bf2` already carries.** LethAL publishes the target on
every run and treats publishing the test app as the user's own workflow, so the untracked test file
above is present in the SOURCE and is not necessarily present in the DEPLOYED test app. R31's
stale-test-app detector is the thing that would notice; whatever it reports is recorded in the
result rather than assumed away.

## Target-stack provisioning runbook

None is committed for this stack, and this campaign does not need one: `f5f11bf2` is an ALREADY
PROVISIONED environment that the 2026-08-07 campaign published into, so no bare-environment
dependency ordering is exercised here. If a future rung needs a fresh environment, that runbook has
to be written first — it belongs to the Continia stack, not to this skill or this campaign.

## Records in this directory

| file | what it is |
| --- | --- |
| `rung2.precommit.md` | expectations, fixed and COMMITTED before the run |
| `analyse.ts` | the analysis, written and committed before any verdict is seen |
| `rung2.report.json` | the run's own `--out` report |
| `rung2.baseline.json` | per-mutant frozen baseline, minted by `campaign freeze` |
| `rung2.analysis.txt` | `analyse.ts` output, verbatim |
| `rung2.result.md` | the reading, written after |
