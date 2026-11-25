# PR-443 pre-commitment (R1182 step 2, PR-420 refiled): the leg-C `login-replay` fact, then replay on against off on DO

Status: pre-commitment (coord PR-443, lethal-code, 2026-11-25), before the build. It builds on PR-442 (branch
`lethal/pr-442`): it needs PR-442's leg-C count of 52, and it reuses PR-442's entry runs. Sources: PR-402's spec
(`2026-11-24-pr402-login-replay-switch.md`; its guard and its pre-committed step-2 orders), PR-360 (R1185's off pin, which
stays the default), PR-420's parked probe (`/coord/handoff/PR-420/`), and the orchestrator's rulings on this task.

## The premise, measured (`/coord/handoff/PR-443/premise.md`)
On alrunner's fork build `+measure-split (75946a31f)`, which contains #8665, with PR-420's apps plus PR-443's
session-state case:
- **Rows are identical across three mutant-env daemons:** OFF (`v3MutantDaemonEnv(…, false)`), ON (`…, true`) and
  ON+CHECK (ON plus `ALRUNNER_LOGIN_REPLAY_CHECK=1`). This holds for all four requests: NONE,M1,NONE; M1,M2,NONE;
  M1,M1,M1; M2,NONE,M2.
- **ON replays when an entry's key repeats.** The key is the entry's resource texts. The counts read 1, 3, 6, 9 replayed
  over 12 sessions with 3 keys kept.
- **ON+CHECK never replays.** It runs the real login and compares: "9 checked, 0 differ".
- **OFF prints no `login start:` line.**
- **Session state set by the login is restored correctly per key.** WorkDate and GlobalLanguage read NONE's values
  (2030-01-01, 1030) in a NONE session after mutant sessions, and each mutant's own values (2032-01-01, 1031).

## The fact
`login-replay` (`LOGIN_REPLAY_FACT`, PR-402), measured in leg C of the update gate and of the v3 gate. Gate-only, like
`stop-groups`; outside `V3_CAPABILITY_FACTS`.

**The corpus** (the orchestrator's ruling: not the whole contract corpus; the DO A/B covers breadth):
- **The login-path cases**, on invented AL:
  - PR-420's stand-in login (a `--dep` app shaped like upstream's issue-8211 stand-in), and a probe app whose
    login-path subscriber writes a row keyed by LethAL's `active-mutant.txt`.
  - **Case 1** (a mutant changes login-path code, so its replay must not be shared with NONE's or another mutant's):
    test `NoneSeesItsRow` in orders NONE,M1,NONE and M2,NONE,M2.
  - **Case 2** (the login writes data and session state that a later test reads): the row, plus `SessionStateFromLogin`,
    which reports the WorkDate and GlobalLanguage the login set. NONE sets 2030-01-01 and 1030; a mutant sets
    2032-01-01 and 1031.
  - Also PR-402's pre-committed orders, NONE,M,NONE and M1,M2,NONE; and M1,M1,M1, LethAL's group shape, where replays
    happen.
- **PR-442's entry runs.** The 14 `entry-no-cross` facts already run every mode on a replay-0 and a replay-1 daemon. Their
  rows are compared across the two, mode by mode.

**Three daemons for the login-path cases**, each `v3MutantDaemonEnv` with the probe's argv (`--dep`,
`--environment`): OFF, ON, and ON+CHECK. ON+CHECK is the only daemon given `ALRUNNER_LOGIN_REPLAY_CHECK=1`. Each
daemon's stderr goes to a file under the fact's root (`stderrFileFor`); the judge reads its `login start:` and
`login replay check:` lines.

**The judge (pure, exported, unit-tested)** reads `matches` only when ALL of these hold:
1. **Equal rows:** every login-path case's rows (entry id, test, status, message) are equal across OFF, ON and
   ON+CHECK, request by request.
2. **ON replays:** ON's last `login start:` line reads replayed > 0.
3. **ON+CHECK compared and found no difference:** its last check line reads N compared, with N > 0, and 0 differ; and
   its `login start:` line reads `replay vs run: N checked, 0 differ`.
4. **OFF does not replay:** OFF prints no `login start:` line with replayed > 0.
5. **PR-442's entry runs are equal across replay 0 and 1,** mode by mode.

**The other verdicts:**
- **`absent`, recorded as `diverged`:** ON prints no `login start:` line at all, so the build has no replay switch.
  `measured` starts `absent:`, and leg C prints `al-runner-v3-login-replay-absent`. This is a build without the switch,
  for example `current` (it has only the CHECK).
- **`diverged`:** any other failed condition. `measured` names the case and the difference, and leg C prints
  `al-runner-v3-login-replay-differs`.
- **`unmeasurable`:** no answer.

**The gate rule**, as PR-342's `stop-groups`:
- `diverged` never fails the gate, and both codes are printed in leg C only;
- `unmeasurable` is an infra-fail;
- PR-402's guard reads `batchFacts["login-replay"] === "matches"`, so anything else keeps `alRunnerV3.loginReplay`
  refused.
- R1185's off pin is untouched: every daemon outside these three keeps `=0`, and `mergeChildEnv` still drops any ambient
  `ALRUNNER_LOGIN_REPLAY*`. The fact daemons set their values through `v3MutantDaemonEnv`'s flag, plus `_CHECK` in
  `extra` for ON+CHECK only.

**The plumbing:** the `legCBatchFacts` filter gains `login-replay`; `classifyLegC` gains the branch;
`V3_LEG_C_FACTS` 52 → 53 and its pins; the spawn guard (r807) counts the new daemons; the gate page. No DotNet.

## Predictions for step 1 (any difference is a BLOCK until explained)
- **On `current` (edge-e5176a9fd, CHECK only):** `login-replay` reads `diverged` with `absent:`, the gate passes, and
  leg C prints `al-runner-v3-login-replay-absent`. All 14 `entry-no-cross` facts are unchanged (`matches`).
- **The v3 gate:** no per-mutant verdict, killing test, note, refusal or warning-set move in any leg except leg C's new
  line and its code.
- **The BC legs:** no figure moves (v3-only change). They run if `selectLegs` names them.
- **Unit tests, red both ways:**
  - the premise rows give `matches`;
  - a row that differs gives `diverged`;
  - ON with 0 replayed gives `absent` (no line) or `diverged` (a line reading 0);
  - a CHECK that differs gives `diverged`;
  - OFF replaying gives `diverged`;
  - entry runs that differ across replay give `diverged`;
  - a missing daemon answer gives `unmeasurable`;
  - `classifyLegC` prints the right code and does not fail the gate.

## Step 2: the DO A/B (after step 1 lands)
- **Why it must wait.** A private gate (PR-226) runs leg C at `current`'s recorded `lethalCommit`, not at a branch head
  (measured in PR-442: it ran at f308441). So the fork build's private gate can record `login-replay` only after:
  1. PR-443 is merged, and
  2. the update gate's owner has re-gated `current` at a master commit that includes it.
- **Then:**
  1. Re-gate the fork build privately; its `.gated` must read `login-replay: matches`.
  2. One scoped DO run window, arms interleaved, with configs differing only in `alRunnerV3.loginReplay`.
  3. Per mutant, verdict and killing test must be equal across the arms (a difference is a BLOCK).
  4. Measure `loginMs` per entry and lane-seconds per arm; name the outside load.
  5. Void an ON arm that printed R786's serve fallback, or that shows 0 replays.
- **`current` never moves.** R1182's full-DO A/B stays for when a gated `current` carries the switch.
