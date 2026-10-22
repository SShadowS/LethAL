# R-606 sandbox-app pre-commitment: the warm-key patch's `cached` mechanism on serve

Drafted 2026-10-21 by the bugs lane's agent, BEFORE any leg ran. The lane commits it; the legs
start only after that.

## Why this fixture

On the table fixture every v3 suite run has `notRun` rows (the 3 refused Commit tests). LethAL's
R517 I2 guard in `AlRunnerBackend` closes the daemon after any suite with a row that is neither
`pass` nor `fail`. So each of the 928 requests had its own daemon, and the patch's warm path never
ran (`/coord/handoff/R-606/tables/results.md`; filed as R612).

`sandbox-app` had **0 not-run rows** on v3 (R-586), so the close never fires. On alpha.3 its serve
legs used **1 daemon each** (`/coord/handoff/R-586/sandbox-alpha3/{server,resource}.shim.tsv`).

## Builds (select BY PATH; sha256 checked before every leg, logged on its first lines)

| Build | Path | sha256 |
|---|---|---|
| UNPATCHED 93415c0bb | `/work/tools/al-runner-v3/local-93415c0bb-unpatched/al-runner` | `379a5fad88617096698ef70d3883d741920cd76d4321244d013ff0cda861eece` |
| PATCHED 93415c0bb + `resfix.patch` | `/work/tools/al-runner-v3/local-93415c0bb-resfix/al-runner` | `f02a04ed358ec8c9ba25496767f2e9b30322a51934efedd4a30f49eb10e9acbf` |

## Fixture, driver, legs

- `fixtures/sandbox-app` + `fixtures/sandbox-tests`: 19 mutants. The target has **2 `.al` files**
  (`SandboxLogic`, `SandboxPricing`).
- They are run from the scratch worktree `/work/lethal-wt/r606-cdo-scratch` at LethAL `5eb544ef`,
  with **no LethAL change**. The only addition is the measurement-only serve tap in the scratch
  `scripts/r586-probe/v2-shim.sh`.
- Driver: R-586's `scripts/r586-probe/run-fixture.ts`. LethAL's own `AlRunnerBackend` +
  `runSession`, `--isolation test`, default ids 79199 / 79198 / 79197, a fresh store per leg,
  never `--resume`.
- **Coverage: `al-runner` (ON).** The reference `packages/runner/itest/bcdev.baseline.json` is a
  coverage-on record with **4 `no-coverage`** rows (`SandboxPricing`'s). A coverage-off run cannot
  score `no-coverage`, so it would differ from the reference by construction. On v3 serve with
  coverage on, R-586 differed from this reference on 0 of 19 mutants.
- No guard is lifted.

| Leg | Build | Transport | Selector |
|---|---|---|---|
| (c) | UNPATCHED | `serve` | RESOURCE |
| (a) | PATCHED | `serve` | RESOURCE |
| (b) | PATCHED | `serve` | STATIC (control) |

Run order: (c), (a), (b). One at a time, each in its own background job, with ≤1 other heavy job
container-wide. Each logs as it runs to `/coord/handoff/R-606/app/<leg>.log`, and none is
signal-stopped.

## References

- **R-BC:** `packages/runner/itest/bcdev.baseline.json`: **3 killed / 12 survived / 4 no-coverage**,
  per mutant, identity scheme 38.
- **R-586 alpha.3 serve** (`/coord/handoff/R-586/sandbox-alpha3/server.report.json`): 3 / 12 / 4,
  0 of 19 different from R-BC, 0 not-run rows. This is context: same fixture, earlier build.

## Predictions

1. **Per mutant:** every leg is equal to R-BC on verdict, killing test and coverage filter, 19 of
   19. All three legs are equal to each other, 19 of 19. Counts are 3 / 12 / 4 with
   `baselineGreen=true`.
   - (c) is correct because on unpatched main a changed resource is in the warm key, so serve
     recompiles.
   - (a) is correct if the patch refreshes the resource correctly.
2. **`killReproduced`** on all 3 kills of every leg. The v2 backend's `killsMustReproduce = true`
   applies on every transport and selector.
3. **Daemons:** **1 per leg**, read as the `serve` rows of `<leg>.shim.tsv`. No summary has a
   `notRun` greater than 0, which is read from `<leg>.serve-out.ndjson`.
   - More than 1 daemon on a leg is reported. The cached figures are then read per daemon.
4. **The `cached` mechanism.** Each `runTests` request is paired, in order, with its own summary
   line in the tap.
   - **(a) patched + resource:**
     - The first request of the daemon answers `cached: false`.
     - **Every later request answers `cached: true`**, because after the deploy only the resource
       file changes between requests, which is exactly the patched path.
     - Predicted: uncached n = the number of daemons (1); cached n = requests − 1.
   - **(c) unpatched + resource:**
     - Every request that follows a mutant switch answers `cached: false`, because the resource is
       in the warm key.
     - Predicted: cached n is 0, or only requests that repeat the previous request's activation.
   - **(b) patched + static:**
     - Each switch changes the source, so the request after a switch answers `cached: false`.
     - The same prediction as (c).
   - **How it is checked:** a "switch" is any request after the first, since LethAL activates a
     mutant (or the unmutated confirm) before each suite request. If a request repeats an
     activation, it is identified from the order of the run's events, and counted separately.

## Speed figures (named in advance, not targets), the three legs side by side

1. **Wall time:** run-fixture's `wall=`.
2. **Serve requests:** the `runTests` lines in `<leg>.serve-in.ndjson`, with daemons started and
   summaries vs `{"error"}` lines.
3. **Median ms:** the median of `wallSeconds × 1000` over the `cached: true` summaries, with n, and
   beside it the same for the `cached: false` summaries.

**This fixture UNDERSTATES a real app.** The target has 2 files, so a cold compile is cheap. The
wall-time difference between (a) and (c) will be small, and is not the measurement. **What this
measures is the mechanism:** (a) answers `cached: true` with the correct per-mutant verdicts, where
(c) recompiles. The cost a real app saves is its compile time per mutant switch, which this fixture
does not have.

## A difference is a FINDING, not a block

Each difference is reported with the leg, the mutant (key), what differs (verdict, killing test,
coverage filter, `killReproduced`, a `cached` value against its prediction, or a daemon count), and
a suspected cause:
- the patch: on (a) only;
- upstream main: on (c) too;
- the resource selector: (a) and (c), not (b);
- the static path: (b) only;
- not explained.

An (a)-only verdict difference is the one that matters: a stale resource answered with
`cached: true`.
