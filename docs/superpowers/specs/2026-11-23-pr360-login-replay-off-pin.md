# PR-360 pre-commitment (R1185, before R1182): pin al-runner's login replay OFF on every al-runner child, and drop an ambient one

Written 2026-11-23, before the build. Source: `/coord/handoff/R1182/adoption-plan.md` §0.

## Why
- Upstream's planned login replay (PERF-01 step 3) is **ON by default**; `ALRUNNER_LOGIN_REPLAY=0` turns it off.
- LethAL passes the parent's environment to every child (`mergeChildEnv`, `al-runner-v3-seed.ts`). It pins only the seed,
  and drops only an ambient `AL_STRICT_SEQUENTIAL` (PR-340 S2).
- So the first build with the replay whose update-gate readings equal the pin's would become `current` mechanically, and
  every LethAL run would turn the replay on with no DO A/B (R1182's hard claim). And an ambient `ALRUNNER_LOGIN_REPLAY*`
  in a lane's shell (for example `ALRUNNER_LOGIN_REPLAY_CHECK=1` left from a PERF measurement) reaches every daemon.

## The change (`al-runner-v3-seed.ts` only)
1. `v3ChildEnv` sets `ALRUNNER_LOGIN_REPLAY=0`, AFTER `extra` (as the seed is), so no caller can turn it on. Every
   al-runner spawn site already uses it (R807), so every one-shot call, serve daemon, probe and `--version` carries it.
   `v3MutantDaemonEnv` builds on it, so mutant-run daemons carry it too.
2. `v3UnpinnedEnv` (O1's sensitivity daemon) sets it to `0` as well: it removes only the seed.
3. `mergeChildEnv` drops every ambient name starting with `ALRUNNER_LOGIN_REPLAY` (the variable and `_CHECK`, and any
   later one) unless `extra` sets that name.
- Turning the replay on is R1182's later flag (`alRunnerV3.loginReplay`, behind a leg-C fact). It replaces rule 1's
  value for the daemons it covers; nothing here anticipates it.

## Predictions (the hard claim: 0 moves)
- **Today's builds ignore the variable.** Measured 2026-11-23: the text `ALRUNNER_LOGIN_REPLAY` occurs in none of the 32
  binaries under `/work/tools/al-runner-v3/` (`current` = main-bf3a3e863 included), and once in PR-320's replay build
  (`/coord/handoff/PR-320/target-a/release/al-runner`), the control. So the full v3 gate passes with 0 verdict, `killingTest`, note, refusal or warning-set moves.
- The probe cache key holds no environment, so cached probes stay valid.
- BC legs: none read `al-runner-v3-seed.ts`'s output; `selectLegs` decides which run.

## Tests (red-checked each way)
- `v3ChildEnv`, `v3MutantDaemonEnv` and `v3UnpinnedEnv` carry `ALRUNNER_LOGIN_REPLAY: "0"`, and an `extra` of `"1"`
  does not win. Red: remove the pin.
- A real child (`defaultSpawn` and `defaultServerSpawn`) reads `0` beside an ambient `1`. Red: remove the pin.
- `mergeChildEnv({})` drops an ambient `ALRUNNER_LOGIN_REPLAY` and `ALRUNNER_LOGIN_REPLAY_CHECK`; with `extra` setting a
  name, it keeps that value; an unrelated ambient `ALRUNNER_*` name is kept. Red: remove the drop.
- Every spawn the backend's existing R807 tests see carries `"0"` beside the seed.

## Checks
VERIFY full, the Opus build review, CI, and the full v3 gate on the final head when the box frees (bugs' PR-357 holds
CPUs 0-11 now).
