> **R-516 + R-515: `itest:alrunner` pre-commitment (r2; written before any live run).** [r2]
> Revised for the plan-r1 review: scope stated (I1), the canary kept off `oneShotLimits`, and the
> D3 cost noted (I5).
>
> Prediction: NO figure of any `itest:alrunner` leg moves. Every frozen count, every per-mutant
> verdict and killing test, every baseline file (`al-runner.baseline.json`, `.cli-default`,
> `.layout`, `.multiobject`, `.symbols-lethala`, `.symbols-lethalb`, `.wrapped`) and every
> server-equals-one-shot check is unchanged: 3 / 12 / 4 (main fixture, every leg), 5 / 4 / 0 per
> symbol set, 7 / 3 / 0 for the layout pair, R147's platform-apps pin on the one-shot legs only.
>
> Why none can move:
> - D1 (confirm every position-1 timeout) and D4 (R515 re-budget) act only on a covering run that
>   answers `timeout`. The verdict domain of all seven al-runner baselines is killed 51 / survived
>   54 / no-coverage 7: no `timeout-killed`, no `error`. So no confirm and no re-budget happens.
> - D3 changes one-shot's in-run limit from `floor(budget / 2000)` s to `ceil(budget / 1000)` s and
>   the client deadline from `budget` to `2 x budget`. A larger limit and a later deadline change
>   only a run that hits them; no al-runner leg's run does (no `timeout`, no `deadline-exceeded`,
>   since no `error` verdict). Baseline runs (at 120 000 ms) get 120 s in-run instead of 60 s; every
>   fixture test runs in well under a second. The cost D3 adds (a one-shot hang runs to the full
>   budget, twice as long as before) applies only to a hang, and no leg has one.
> - [r2] `oneShotLimits` is used by `sendOneShot` only. `runAlRunnerCanary`
>   (`CANARY_TEST_TIMEOUT_SECONDS`), the contract probe (`HANG_TIMEOUT_SECONDS`), the predefined
>   symbol probe and provisioning keep their own fixed timeouts, so the canary's printed results and
>   the R147 provisioning sentence cannot move.
> - The `--server` and resource-with-server legs do not use `sendOneShot`'s limits at all. [r2] This
>   build claims NOTHING about them: their in-run limit is al-runner's 60 s default, and the false
>   kill there is filed as its own item (plan D3b). Their verdicts must still equal the one-shot
>   leg's per mutant, as today.
> - Wall-clock timings are printed, not asserted.
>
> A changed verdict, count or killing test on any leg is a regression: a BLOCK, never a re-record.
> The gate prints the al-runner build first; read it before calling a difference a regression.
