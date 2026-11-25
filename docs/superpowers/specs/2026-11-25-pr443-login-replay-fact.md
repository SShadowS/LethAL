# PR-443 pre-commitment (R1182 step 2, PR-420 refiled): the leg-C `login-replay` fact, then replay on against off on DO

Status: pre-commitment r2 (coord PR-443, lethal-code, 2026-11-25), before the build. r2 replaces r1 (a088441b2) after
the spec-adversary (1 BLOCKER, 7 SERIOUS, 3 MINOR) and a second premise probe. Ruling (orchestrator): (b). Land the fact
with every fact fix and keep refusal as the default. S8 is filed as R1223, and PR-402's flag must require BOTH the fact
and R1223. Sources: PR-402's spec, PR-360 (R1185's off pin, which stays the default), PR-420's parked probe, and PR-442
(leg C at 52 facts; on master at 62795fcc2).

## The premise, measured (`/coord/handoff/PR-443/premise-v2.md`, `probe443b.ts`)
- **The apps** (invented):
  - PR-420's stand-in login, a `--dep` app.
  - A probe app whose login-path subscriber writes DISTINCT values per mutant key (NONE 1, M1 2, M2 3) into: a row,
    WorkDate, GlobalLanguage, a SingleInstance global, a temp table in a SingleInstance, a manual subscriber bound in a
    SingleInstance, a real row, and a NumberSequence. Only M2's login also writes IsolatedStorage.
  - Two test codeunits, A and B, each with `KeyRow` (passes only for NONE) and `State` (always fails, reporting every
    value).
- **The run.** Five orders across the two codeunits, in `test` and in `codeunit` isolation, on three `v3MutantDaemonEnv`
  daemons (OFF; ON; ON+CHECK, which adds `_CHECK=1`), with an offline argv.
- **The fork build** (`+measure-split 75946a31f`):
  - Rows are identical across all three daemons, with every channel at its own key's values. That includes a replay
    across test codeunits.
  - ON replays 8 logins and never images M2's login, which writes IsolatedStorage ("not imaged: field
    isolated_set_in_test").
  - CHECK compares 9 sessions, 3 of them across test codeunits, 0 differ.
- **`current`:** ON prints no `login start:` line.

## The fact `login-replay` (`LOGIN_REPLAY_FACT`, PR-402), gate-only, outside `V3_CAPABILITY_FACTS`
- **The corpus is the premise's**, as invented AL in the contract: the stand-in login plus the probe app, five orders,
  two isolation modes, three daemons. It is not the whole contract corpus (ruling: the DO A/B covers breadth).
  PR-442's entry runs are NOT used: their apps have no login path, so they carry no replay evidence (review S7).
- **The argv:** the entry facts' offline argv (`packagesDir`, `--bc-version`, `--no-download`, `--environment`) plus
  `--dep <stand-in>`. Each daemon's stderr goes to a file under the fact's root (`stderrFileFor`).
- **The judge** (pure, exported, unit-tested) reads `matches` only when ALL of these hold, in both isolation modes:
  1. **Exact expected rows** (review B1, S2), pinned per request, for OFF, ON and ON+CHECK alike:
     - each entry's `KeyRow` passes for NONE and fails (`no NONE row`) for M1 and M2;
     - each `State` message is exactly the key's values: NONE
       `items=50801; workdate=2031-01-01 language=1031 si=101 temp=201; manual=1 rows=301; iso=- seq=1;`, and M1 and
       M2 their own (`5080x`, `203x`, `103x`, `10x`, `20x`, `30x`, `iso=403` for M2 only, `seq=x`).
     - Anything else is `diverged` with `dead probe:` (equal-but-wrong rows included).
  2. **Per-request, monotonic counts, equal to the pinned cumulative figures** (review S6). The judge reads the lines
     starting `login start:` and `login replay check:` that each request added, one per request:
     - ON: replayed 1, 2, 5, 7, 8; kept 2, 4, 4, 4, 4; not imaged 0, 0, 0, 1, 2.
     - ON+CHECK: sessions 3, 6, 9, 12, 15; compared 1, 2, 5, 7, 9; across test codeunits compared 0, 2, 2, 2, 3; replay
       vs run 1, 2, 5, 7, 8.
     - Every "N differ" on every line is 0, the round-trip count included. A line that does not parse is `diverged`.
  3. **OFF prints no `login start:` line.**
- **The other verdicts:**
  - **`absent`, recorded as `diverged`:** ON prints no `login start:` line while its stderr holds every
    `request N done` marker. This is a build without the switch, such as `current`. `measured` starts `absent:`, and leg
    C prints `al-runner-v3-login-replay-absent`.
  - **`diverged`:** any other failed condition. Leg C prints `al-runner-v3-login-replay-differs` (`dead probe:` for
    unexpected rows).
  - **`unmeasurable`:** no answer, a request marker missing from a stderr file, or no stderr file at all (review S6d).
- **The gate rule** (as PR-342's `stop-groups`):
  - `diverged` never fails the gate, and both codes are printed in leg C only;
  - `unmeasurable` is an infra-fail.
- **PR-402's guard is tightened** (ruling): `alRunnerV3.loginReplay` is refused unless the fact reads `matches` AND
  R1223 (kill pairs on a replay-off daemon) is built. Until R1223 lands, the flag is refused with a code that names
  R1223, whatever the fact reads.
- **R1185's off pin is untouched.** Only the fact's own ON daemons get `=1`, and only ON+CHECK gets `_CHECK` in `extra`.
- **The plumbing:** the `legCBatchFacts` filter; `classifyLegC`; `V3_LEG_C_FACTS` 52 → 53 and its pins; the spawn guard
  (r807) counts the new daemons; the gate page. No DotNet.

## Predictions for step 1 (any difference is a BLOCK until explained)
- **On `current`:** `login-replay` reads `diverged` with `absent:`, the gate passes, and leg C prints
  `al-runner-v3-login-replay-absent`. The 14 `entry-no-cross` facts are unchanged.
- **The v3 gate:** no per-mutant verdict, killing test, note, refusal or warning-set move in any leg, except leg C's new
  line and code.
- **The BC legs** (if `selectLegs` names them): no figure moves.
- **Unit tests, red both ways:**
  - the fork build's recorded answers give `matches`;
  - equal-but-wrong rows give `dead probe`;
  - one count off by one gives `diverged`;
  - a non-zero `differ` anywhere gives `diverged`;
  - OFF with a `login start:` line gives `diverged`;
  - no ON line with all markers gives `absent`;
  - a missing marker or stderr file gives `unmeasurable`;
  - the guard refuses the flag with the fact `matches` but R1223 absent;
  - `classifyLegC` prints the right code and does not fail the gate.

## Step 2: the DO A/B (waits on R1223 and on a gated commit that includes this PR)
- **Why it waits.** PR-402's flag cannot turn on until R1223 is built (above). A private gate (PR-226) runs leg C at
  `current`'s recorded `lethalCommit`: f308441, as measured in PR-442. It moves to the script's own commit only when that
  record misses a gate leg, or when `al-runner-v3-pins.ts` moved since it (`missingLegsOf`, review M10). So the fork
  build's private gate can read `login-replay` only after this PR is merged, AND either `current` is re-gated at a
  commit that includes it (by the update gate's owner) or a pins move puts the private gate at self.
- **Then:**
  1. One scoped DO window, arms interleaved, with configs differing only in `alRunnerV3.loginReplay`, plus an OFF-vs-OFF
     pair in the same window to tell flakiness from replay (review M11).
  2. **Equal per mutant:** verdict, `killingTest`, timeout-killed, notes, refusal and withheld sets, and the set of
     scored mutants. A difference that the OFF-vs-OFF pair does not show is a BLOCK.
  3. Measure `loginMs` per entry and lane-seconds per arm; name the outside load.
  4. Report how many kills went through the withheld recheck (forced `=0`), and how many DO mutant sites sit on a login
     path; if none, say the A/B is silent on PR-402's SERIOUS 2.
  5. **Void rules, per mutant daemon:** an ON daemon that replayed 0 times, or any R786 fallback, voids the arm.
- **`current` never moves.**
