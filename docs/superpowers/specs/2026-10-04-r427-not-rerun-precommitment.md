# R-427 pre-commitment addendum: K5 in `itest:agreement` is not rerun

Written 2026-10-04 by lethal-code BEFORE any live run of the R-427 code (branch `lethal/r427`,
commits d095e3e5..85f29c84). No gate has been run on that code. Sources: the R-427 plan
(`docs/superpowers/plans/2026-10-04-R-427-skip-rerun-unreached-tests.md`), the R-384 blind
pre-commitment (`docs/superpowers/specs/2026-10-04-r384-reach-precommitment.md`), the fixture AL it
cites, and the current gate files. This addendum only CHANGES what R-427 changes; everything the
R-384 pre-commitment and R-425's pins state stays as stated.

## Why K5 changes

`fixtures/sandbox-harden/lethal.equivalent.json` marks S5 (`BonusFor`, remove-assignment) as
equivalent, so `planVerify` puts it in `skipped`, not `running`: S = 4. The answer test K5,
`Harden Verify Answers.BonusForTwiceOnOneInstance`, calls only `Logic.BonusFor` (R-384
pre-commitment, "K5 reaches no running survivor"). The reach filter therefore sends K5 to no
survivor, so it is in `reach.unsent`, and R-427 skips its stability rerun.

## Predictions for `itest:agreement` step 3 (the only gate value R-427 moves)

| Item | Before R-427 (pinned today) | Predicted with R-427 |
|---|---|---|
| K5 `newTests[].state` | `stable` | `not-rerun` |
| K5 `newTests[].runs` | 2 runs, both `pass`, both `fresh`, two different `sessionId`s | exactly 1 run (the baseline): `outcome` `pass`, `fresh` true, `sessionId` defined |
| K1-K4 `newTests[].state` and `runs` | `stable`, 2 runs, pass, fresh, different sessions | unchanged |
| verify exit code | 0 | 0 (ruling: `not-rerun` exits 0) |
| `ok`, refusal, quarantine, one test-app publish | as today | unchanged |
| reach line on stderr | `[lethal] verify: reach filter on (fenced coverage): 5 new test(s), 0 joined every survivor because their coverage could not be used; 4 mutant run(s) instead of 20 without the filter; 0 survivor(s) no new test reaches.` | byte-identical (R-427 does not change the line) |
| per-survivor `testsRun`, verdicts, `reachNarrowed` (R-384, R-425) | S1-S4: base test + own K, killed, narrowed; S5 skipped, no `reachNarrowed` | unchanged |
| counts | `{ killed: 4, survived: 0, error: 0, skipped: 1 }` | unchanged |

Steps 1, 2, 4 to 7 of `itest:agreement` are unchanged: run B is a fresh `lethal run`, which does
not go through verify, so the agreement table (5 of 5 rows) is unchanged. Step 6 ("verify faster
than B") should still hold, by a slightly larger margin (one rerun fewer); the ratio is not
predicted.

## `itest:verify`: no value moves

Step 3's single new test, `Sandbox Tests.ZzC0206ClampRejectsAboveHundred`, reaches `ClampPercent`, a
running survivor, so it is sent and rerun: `stable`, 2 runs, as pinned today. Steps 4 and 4b have
N = 0 new tests, so there is nothing to skip. Steps 5a-5d refuse before any run. Predicted: every
`itest:verify` assertion passes unchanged.

## How the itest pins this

In `packages/runner/itest/verify-agreement.itest.ts`, the step-3 loop over `out.newTests` today
asserts `stable` and two runs for every answer test, K5 included. It is changed for K5 ONLY:

- K5: `state` is exactly `not-rerun`; `runs.length` is exactly 1; that run has `outcome` `pass`,
  `fresh` true and a defined `sessionId`.
- K1-K4: the existing assertions, unchanged.

No other assertion in either gate changes. The red-check: with the rerun skip disabled (an
uncommitted Edit making `unsent` empty), the K5 assertion fails on `state` (`stable` instead of
`not-rerun`).
