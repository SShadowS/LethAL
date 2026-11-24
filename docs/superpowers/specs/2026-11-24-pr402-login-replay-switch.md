# PR-402 pre-commitment (R1182 step 1): an opt-in switch for al-runner's login replay, default off

**Source:** coord task PR-402 and lethal-code's adoption plan `/coord/handoff/R1182/adoption-plan.md` (§2). bugs' daily report
(2026-11-24) says the login replay (`ALRUNNER_LOGIN_REPLAY`, `_CHECK`) is on upstream main and edge. PR-360 pins
`ALRUNNER_LOGIN_REPLAY=0` on every al-runner child (`v3ChildEnv`, and `mergeChildEnv` drops any ambient `ALRUNNER_LOGIN_REPLAY*`).
So today no run can turn the replay on. This task builds the switch. It does not turn the replay on anywhere, and it runs no
DO A/B.

## What is built
1. **Config `alRunnerV3.loginReplay`** (boolean, absent = off), parsed in `al-runner-v3-config.ts` like `stopGroups`. A
   non-boolean is refused by name (`al-runner-v3-config-refused`). No environment variable: arms of an A/B differ by
   config file, as PR-359's did.
2. **The build fact** `login-replay` (`LOGIN_REPLAY_FACT` in `al-runner-v3-pins.ts`, read as `batchFacts["login-replay"]
   === "matches"`, like `stop-groups`).
3. **The refusal.** With the flag on, `status()` refuses unless the build's gate record reads that fact as `matches`:
   `al-runner-v3-login-replay-unsupported: "alRunnerV3.loginReplay" is on, but this build's gate record (lethalCommit ...)
   does not read the capability fact login-replay \`matches\` ...`. The fact is the capability probe: it is measured by the
   update gate, never guessed from a version string.
4. **Which processes get `=1`:** only MUTANT-RUN serve daemons (`cacheEnv(mutantRun = true)`, the same set that gets
   PR-340's `AL_STRICT_SEQUENTIAL=1`). The following keep `=0`, as today:
   - the baseline's daemons and the probe's;
   - every one-shot call;
   - `--version` and `test --help`;
   - every leg-C fact server, and every contract or probe spawn.

   Why not the baseline too (the plan's §2 said all daemons; the task says mutant daemons only unless argued):
   - A kill needs a fail under the mutant AND a pass under NONE. That NONE confirm runs on the same mutant daemon, so it
     runs under the replay too. A test that fails only because of the replay therefore fails under NONE as well, and it
     is not scored as a kill.
   - The A/B's S1 divides by the baseline's median ms per test. With the baseline unchanged, that measure stays the same
     between arms.
   - The review found a stronger point. A mutant daemon's warm-up (`startDaemon`) and `proveOnDaemon` judge its NONE rows
     against the one-shot baseline, which runs at `=0`. So a replay difference visible under NONE already fails the
     daemon there.
   - The remaining risk is a replay difference that only shows WITH a mutant active (review SERIOUS 2). Examples: a
     mutant on the login path whose change the replayed image skips (a lost kill), or an image recorded under one mutant
     and replayed for another (a possible false kill). The DO A/B's V check sees it only where DO has such mutants, so
     the step-2 fact must measure it (below).
5. **The off pin stays.** With the flag off, every process gets `=0` exactly as PR-360 made it. `mergeChildEnv` still
   drops any ambient `ALRUNNER_LOGIN_REPLAY*`, so an ambient `=1` never turns the replay on.
   - **The mechanism (review SERIOUS 1):** `v3ChildEnv` writes `=0` AFTER `extra`, so an `=1` passed in `extra` would be
     overwritten. The replay would then stay silently off while the notice said ON. So `v3MutantDaemonEnv` takes the flag
     and sets `ALRUNNER_LOGIN_REPLAY=1` AFTER `v3ChildEnv`, as it already does for `AL_STRICT_SEQUENTIAL`.
   - `mergeChildEnv` keeps that `=1`, because `extra` sets it.
   - `ALRUNNER_LOGIN_REPLAY_CHECK` is never set by the flag, and an ambient value is still dropped.
   - **A spawn-time guard (review MINOR 1):** `cacheEnv(true)` throws `al-runner-v3-login-replay-unsupported` when the
     flag is on and no `login-replay` fact was read. A rig or itest that skips `status()` therefore cannot get `=1`
     without the fact. A unit-test seam forces the fact, like `seams.stopGroupsFact`.
   - The guard throws its own class, `AlRunnerV3LoginReplayError` (extends `Error` directly). `sendKillPairOn` rethrows
     it like `AlRunnerV3StopGroupsError`, so it is never swallowed as `al-runner-v3-pair-skipped` (delta review). The
     same applies to every catch-all around the warm-up and R786's fallback, so the guard cannot turn into a quiet
     fallback to one-shot calls at `=0`. A test fires the guard during the mutant phase and expects the session to refuse
     with the code.
6. **In the fingerprint** (`v3LoginReplay: true` when on, nothing when off, like `v3StopGroups`), so `--resume` refuses
   across a flip. It is also in the lending build tag (` login-replay`), so a lent snapshot never crosses a flip.
   - `store.unfinishedRunUnderOtherEnvironment` strips the end-anchored tag list, so it must learn ` login-replay` too
     (review MINOR 3).
   - The tag goes before ` isolation-auto`, which `runMayLend` requires to be last.
7. **A notice line**, printed once per session by `status()` when the flag is on and the fact reads `matches`:
   `[lethal] al-runner-v3 login replay ON: ALRUNNER_LOGIN_REPLAY=1 on mutant daemons only (R1182; experimental, opt-in)`.
   Nothing is printed when the flag is off.
   - The notice says the flag is on, not that replays happened (review MINOR 2). If R786's fallback moves a session to
     one-shot calls, everything runs at `=0`.
   - The DO A/B's pre-commitment must therefore void an arm B that printed the fallback notice. Arm B must also show
     replay counts above 0 once step 2 prints them.

**Not built here (deliberately):**
- **The leg-C fact.** It stays PENDING: no build LethAL may run reads `login-replay` today. The gated `current`,
  main-bf3a3e863, does not carry the replay, so the fact can be neither measured nor recorded on it. The fact's probe
  follows the plan's §2: `=1` with `_CHECK=1` gives `N checked, 0 differ` with N > 0, rows equal to a `=0` server's, and
  `=0` measured off (`0 replayed`). It is step 2, on the first candidate that carries the replay, under its own
  pre-commitment of the figures. Until then the flag is always refused, which is the safe state.
  - **Pre-committed now for step 2 (review SERIOUS 2):** the fact must also send, on one `=1` daemon, a fixture mutant
    whose change runs during login (for example a company-open subscriber). It sends it in the orders NONE, M, NONE and
    M1, M2, NONE, and compares every row with a `=0` server's. `matches` needs them equal. Any difference reads
    `diverged`, and the flag stays refused.
- **A report field** (as `runnerBuild.stopGroups`): the fingerprint and the lending tag make a flip visible. A report
  field ripples through the schema and the sample reports (CLAUDE.md), so it waits for the A/B, where it is read.
- **The serve-entries replay counts:** they need the build's output shape, which only a carrying build shows. They are part
  of step 2.

## Pre-committed results
- **No figure moves on any gate:** the flag is off by default, and an off run's environment is byte-for-byte today's
  (`=0` everywhere). On the v3 gate: 0 verdict, 0 killingTest moves, and the same note, refusal and warning sets on every
  leg. BC legs, as `selectLegs` picks them: no moves (v3-only change).
- **Unit tests, each red-checked.** The env tests read the env each spawn site actually spawns with, through the
  backend's `serverSpawn` and `spawn` seams. Never a direct call to the helper, which would hide SERIOUS 1.
  - off: a mutant daemon, a baseline daemon and a one-shot all carry `ALRUNNER_LOGIN_REPLAY=0`. Red if the flag's `=1`
    leaks into the off path.
  - on: a mutant daemon carries `=1`, both when started by `startDaemon` and when restarted by `spawnRestarted`. The
    baseline daemon and a one-shot carry `=0`. Red if the `=1` is dropped (including the `extra`-overwrite mistake), or
    if it reaches the baseline.
  - the spawn-time guard: flag on with no fact read makes a mutant daemon spawn throw the code.
  - config to backend: `"loginReplay": true` in a config reaches the backend's cfg (`buildAlRunnerV3Backend`).
  - on with an ambient `ALRUNNER_LOGIN_REPLAY_CHECK=1`: the child does not get `_CHECK`.
  - refusal: flag on with a record without the fact gives `status()` not ok, naming `al-runner-v3-login-replay-unsupported`.
    Flag on with the fact `matches` is ok and prints the notice once. Flag off prints nothing. Red each way.
  - config: `"loginReplay": "yes"` is refused by name, and `true`/`false` are accepted.
  - fingerprint: on and off differ, and the lending tag carries ` login-replay` only when on.
