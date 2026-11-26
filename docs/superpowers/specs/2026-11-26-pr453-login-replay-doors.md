# PR-453: closing R1223 and R1226 under PR-447's shape C, the real hit rate, and a go/no-go — r1 (no build)

lethal-code, 2026-11-26. The orchestrator ruled PR-447's C not to be built yet (owner principles 1, 4, 13 and 16):
- its value was modelled;
- it added a flag beside today's path;
- R1223 and R1226 were unbuilt.

This spec measures all three and designs the closures. Evidence: `/coord/handoff/PR-453/` (`findings.md`, `capture/`,
`life/`, `alrunner-step2.md`). Names and numbers only.

## 1. Measured

- **The real per-daemon request order (§4: measure, never "likely").**
  - A full DO run with c5's settings ran under strace, which recorded each serve daemon's stdin.
  - 28 daemon lives, 1,395 entries requests, 44,702 entries.
  - al-runner's LRU replayed over each real life:

  | cap | today's selector | C |
  |---|---|---|
  | 8 | 9.5% | 58.3% |
  | 32 | 13.9% | 82.3% |
  | 112 | 17.9% | 92.3% |

- **One real daemon life, replayed on al-runner's limits fork (221d1f631, gated) with the C prototype.** 247 requests,
  9,198 entries.

  | arm | replayed | peak RSS |
  |---|---|---|
  | off | — | 3.55 GiB |
  | cap 8 | 5,600 (61%) | 3.44 GiB |
  | cap 32 | 7,975 (87%) | 3.51 GiB |
  | cap 128 | 9,088 (99%) | 3.98 GiB |

  - Rows are identical, per request, in all five arms.
  - The CHECK arm at cap 128 compared 9,088 sessions with 0 differ, and 0 differ across 109 test codeunits.
- **Kill-pair symmetry over the real order** (requests holding kill pairs: 357). A request is asymmetric when some of
  its pair entries replay while others log in for real:

  | cap | asymmetric | NONE replays while the mutant logs in for real |
  |---|---|---|
  | 8 | 29 | 1 |
  | 32 | 1 | 0 |
  | 112 | 0 | 0 |

- **Keyed apart from NONE under C:** 2,470 entries (5.5%), from 42 distinct mutants: the login-path buckets.

## 2. Why replay can be wrong at all (both doors are one question)

- **The key's inventory.** al-runner's login key holds every login input: by content or a SHA-256 digest, or the input
  is gated (no start), engine-level, untouched, or read only after the login (`login_start/outside.rs`).
  - An al-runner test fails for any static it does not list.
  - The key holds the clock's DAY (`Key::clock`), the database and uncommitted-row digests, and the session state
    (WorkDate included). It also holds the seed, the license, the flags and the resource texts the login read.
- **So a replayed login can differ from a real one only if the key is incomplete.** Both doors are that one question:
  - R1223, the false-kill direction: NONE replays while M logs in for real;
  - R1226, the survivor direction: a login's read set changes inside one daemon life (the date or data).
  - R1223's own example, a login across midnight, gets a NEW key.
- **The evidence the key is complete for DO:**
  - CHECK, 0 differ in 9,088 sessions of one real life;
  - PR-443, 0 differ;
  - PR-446/PR-447's P0 and keying probes.
  - None of this proves an input that DO never exercises. That is the residue a closure must still cover (§1: correct
    first; §5: unknown is not no).

## 3. The closure: one rule for both doors, a CHECK canary that fails closed

- **The canary lane.** In a replay-on run, ONE lane (lane 0) runs its daemon with `ALRUNNER_LOGIN_REPLAY_CHECK=1`.
  - Check mode never replays. It runs every login for real and compares it with the key's stored image.
  - LethAL reads its daemon's `login replay check:` line after every request.
  - **Any `differ > 0` latches the session unsafe**, by the same path as PR-454's degraded window. Every verdict since
    the run started is invalidated in the store, the report and `--resume`, by name: `login-replay-check-differ`.
  - That is the whole run, not a window: an incomplete key may have affected any replay.
  - A missing line is treated as differ (§5).
- **Why it closes both doors.** The canary lane receives the same kinds of requests from the same queue: kill pairs,
  prefetches, echoes, across days and data.
  - Any key incompleteness that shows on lane 0 stops the run.
  - One that never occurs on lane 0 during the run is not seen. The canary is a sample, which is stated as a LIMIT. It
    is not claimed as proof.
  - The rate at which lane 0 sees each kind of request is reported per run.
- **The cost of the canary:**
  - lane 0 saves nothing (1/N of the saving);
  - its RSS is higher: 6.04 GiB at cap 128 vs 3.55 GiB off. Measured with CHECK, which runs both the real login and
    the image. At cap 8 the canary's extra memory is bounded by about 29 MB of images.
  - The canary therefore runs at cap 8.
- **Dropped: R1223's Form A** (every kill pair on a replay-off daemon).
  - Measured at cap ≥ 32, pairs are symmetric in practice (1 and 0 of 357).
  - Its soundness rests on the same key-completeness question the canary watches.
  - Its cost is an extra ~3.5 GiB daemon per lane, which c5's memory hold would turn into a lost lane.
  - The canary covers the false-kill direction AND the survivor direction, which Form A never did (R1226).
- **R1226** is closed by the same canary, plus the key's clock-day field.
  - Limit, stated: no measured run crossed midnight. al-runner's own test
    (`a_session_whose_run_clock_began_on_another_day_runs_its_own_login`) is the evidence for the day boundary.
  - A leg-C case cannot set the clock (a set clock start takes no start).

## 4. The shape of the build (principle 16: replace, not dual)

- **No new flag beside today's path.** C plus replay becomes THE v3 mutation-daemon path, once:
  - its facts hold: PR-447's four facts and the login-replay fact (PR-443's design);
  - the canary is built;
  - al-runner's cap setting is on the gated build.
- Before that, nothing changes.
- `alRunnerV3.loginReplay` is retired, not kept as a toggle. PR-402's guard becomes the build's precondition, checked
  by the update gate's facts.
- **Default cap 32 (87% of entries replayed, +0.1 GiB per daemon):**
  - cap 128 adds only 12 points (99%) for +0.43 GiB;
  - c5's memory hold caps lanes, so the cap is a `--profile` choice (principle 17: a trade-off is an opt-in profile).
  - The heavy-slot presets add cap × 3.6 MB per daemon: al-runner does not count images against its memory limit.

## 5. Go / no-go

- **GO for C, on the shape in §4,** after the ruling.
- **The saving, at today's 0.25 s per real login (PR-439):** at cap 32, about 82% of ~157k entries replay, ≈ 32k
  lane-s.
  - Minus C's selector cost: +6-8% user instructions, ≈ 27-37 ms per entry, ≈ 4-6k lane-s.
  - Minus the canary lane's lost share: 1/8 of the replays.
  - **Net ≈ 23-24k lane-s ≈ 24% of c5's mutants phase (98,792 lane-s).**
  - It is reported as a calculation from measured parts. The lane time of a built run is the build's own first gate
    measurement, compared interleaved with a replay-off run (PR-447 step 2).
- **NO-GO conditions:**
  - the canary sees any differ on DO;
  - the upstream cap setting is refused (cap 8 is still ≈ 15%);
  - the build's replay-on vs replay-off per-mutant verdicts differ.

## 6. For the spec-adversary

- Is a sampled canary sound enough under §1/§5, or must every lane check?
- Is invalidating the whole run at a differ the right scope?
- Is dropping Form A sound?
- Does the canary lane see every request kind?
- Is retiring the flag compatible with users who have no gated build carrying the cap?
