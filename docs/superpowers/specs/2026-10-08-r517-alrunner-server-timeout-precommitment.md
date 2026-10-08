> **R-517: `itest:alrunner` pre-commitment (r2; written before any live run).** [r2] Revised for
> plan r2 (review C1, I1, I2, M2, M3). The prediction is unchanged: no figure moves.
>
> Prediction: NO figure of any `itest:alrunner` leg moves. Every frozen count, every per-mutant
> verdict and killing test, every baseline file (`al-runner.baseline.json`, `.cli-default`,
> `.layout`, `.multiobject`, `.symbols-lethala`, `.symbols-lethalb`, `.wrapped`) and every
> server-equals-one-shot check is unchanged: 3 / 12 / 4 (main fixture, every leg), 5 / 4 / 0 per
> symbol set, 7 / 3 / 0 for the layout pair, R147's platform-apps pin on the one-shot legs only and
> absent on the `--server` and resource legs (R242).
>
> One NEW check, added by this build, must pass: in the R387 CLI-default leg (`cli-default-leg.ts`,
> which records every daemon argv), every recorded `--server` argv carries `--test-timeout` followed
> by `180` exactly once. [r2] (M2) S is `ceil(max(F, baselineTimeoutMs) / 1000)`; no leg sets
> `mutantTimeoutMs` or `baselineTimeoutMs`, so S = `max(180 000, 120 000)` / 1000 = 180. The existing
> server-spawn count check (`includes("--server")`, one daemon per backend) is unaffected by the
> extra flag and [r2] still holds exactly: see the restart bullet below.
>
> The legs that run a daemon, and so receive `--test-timeout 180` where they used al-runner's 60 s
> default: R220 leg 3 (`--server`) and leg 4 (resource), the R321 `--server` and resource legs for
> `[LETHALA]` and `[LETHALB]`, the R353 layout `--server` leg, the R383 multi-object `--server` leg,
> the R-300b wrapped `--server` and resource legs, and the R387 CLI-default leg.
>
> Why none can move:
> - D1 raises the daemon's per-test stop from 60 s to 180 s. A stop changes only a run that reaches
>   it. Every fixture test runs in well under a second, and the verdict domain of all seven al-runner
>   baselines is killed 51 / survived 54 / no-coverage 7: no `timeout`, no `timeout-killed`, no
>   `error`. So no run reaches either stop. The baseline suite (sent 120 s) now runs under a 180 s
>   stop instead of 60 s; no baseline test is near either.
> - D2 changes how a position-1 timeout confirm is judged, [r2] including the stop parsed from the
>   timeout row's message (I1). No leg has a timeout, so no confirm runs and nothing is parsed (0
>   today, 0 after).
> - [r2] D4b (close the daemon on any `runTests` throw) and D4c (close it after any suite with a
>   timeout row) restart a daemon only on a deadline overrun or a timeout row. No leg has either: no
>   `timeout` and no `error` verdict in any of the seven baselines, and every suite finishes in
>   seconds against a deadline of at least 10 min. So no restart fires, every backend spawns exactly
>   one daemon as today, and R387's spawn-count check is unchanged. A second `--server` spawn on any
>   leg is itself a regression to report, never a figure to re-record.
> - [r2] M3 changes only the note on a covering test that has no row after a timeout; no leg has one.
> - D3 keeps `inRunStopIsBudget` false under `serverMode`, so R515's re-budget stays skipped there,
>   as today; on one-shot nothing about it changes.
> - The one-shot legs: `sendOneShot` still sends `oneShotLimits(budget)`; the floor never reaches the
>   one-shot argv or env. The canary, the contract and symbol probes and provisioning keep their own
>   fixed timeouts. [r2] `verdictFromRunnerTest` now parses a stop from a timeout row on one-shot too;
>   no one-shot leg has a timeout row.
> - Wall-clock timings are printed, not asserted. [r2] They should not move either: no restart, and
>   the extra flag costs nothing at start.
>
> A changed verdict, count or killing test on any leg is a regression: a BLOCK, never a re-record.
> The gate prints the al-runner build first; read it before calling a difference a regression (this
> was written against `2.12.0-main.43f76177`; [r2] on the host pin c39ad5de, unmeasured, the
> prediction is the same, because no leg reaches any stop).
>
> `itest:hang` is bcdev-only and is not re-run: D1, D4b and D4c do not touch bcdev, and D2 is the
> same rule there (bcdev's `measuredDurationMs` equals its `durationMs`, it declares no
> `inRunStopMs`, and its timeout verdicts carry no `reportedStopMs`).
