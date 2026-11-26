# PR-453: closing R1223 and R1226 under PR-447's shape C, the real hit rate, and a go/no-go — r2 (no build)

lethal-code, 2026-11-26.
- **r1** was a9aa5ef1f: a one-lane CHECK canary, Form A dropped, GO.
- **r2** answers r1's spec-adversary, marked "(B1)" and so on.
  - It gave 4 BLOCKs and 5 SHOULDs.
  - The orchestrator asked for its weight on the canary, because retiring the flag makes C plus replay the only v3 path.
- **r2's verdict: NO-GO now,** on three named conditions (§5).

Evidence: `/coord/handoff/PR-453/` (`findings.md`, `capture/`, `life/`, `alrunner-step2.md`). Names and numbers only.

## 1. Measured (and what it does NOT cover)

- **The real per-daemon request order.**
  - A DO run with c5's settings ran under strace (stdin of every serve daemon).
  - It was stopped by an outer timer at 9,000 s with 10,979 mutants left unscored, so this is the run's first part.
  - 28 daemon lives (2 to 9,198 entries each), 44,702 entries.
  - **Hit rate:** al-runner's LRU over each real life, under C: 58.3% / 82.3% / 92.3% at caps 8 / 32 / 112. Today's
    selector gets 9.5% / 13.9% / 17.9%.
  - **The model is validated:** on the probed life alone it predicts 5,600 / 7,975 / 9,088 replays, and the live probe
    counted exactly those (NIT1).
- **One real life, replayed on alrunner's limits fork** (221d1f631, gated) with the C prototype, `MAX_MB` = 1024:
  - replayed 61% / 87% / 99% at 8 / 32 / 128;
  - peak RSS 3.44 / 3.51 / 3.98 GiB, against 3.55 GiB off;
  - rows identical per request in all five arms;
  - CHECK at 128: 9,088 compared, 0 differ.
- **Not covered: (B2) all 2,470 entries whose C key differs from NONE's sit in 3 of the 23 lives** (pids 1787006,
  1905189, 1747701). The probed life has ZERO of them (its keys differ only in `test_codeunit`).
  - So there is NO CHECK evidence on the login-path keys, which are where R1223 lives.
  - The capture has no pid-to-lane mapping.
- **(S2) Direct life walls, reported though confounded** (run in sequence, not interleaved, the on arms at load1
  20-80): off 4,400 s; on at cap 8 4,942 s; cap 32 6,317 s; cap 128 6,340 s; CHECK 5,415 s. They point AGAINST the
  modelled saving. They are confounded, but they are not dismissed (principle 6).
- **(S3) Every probe arm set `MAX_MB` = 1024.** al-runner's default byte cap of 64 MB evicts at about 17 images, so
  cap 32 under default MB would hit between the 8 and 32 figures.

## 2. Why replay can be wrong (one question, two directions)

- **The key's inventory.** al-runner keys a login on every input it lists (`login_start/outside.rs`): by content or
  digest, gated, engine-level, untouched, or read only after the login.
  - The key holds the clock's day: `RunClock` begins per serve request at that UTC day's fixed time.
  - A replay can differ from a real login only if an input is missing from the key, or wrongly classed. The inventory
    test checks that every static is LISTED, not that its class is right.
- **R1223 (kills) and R1226 (survivors)** are that same question in two directions.
  - **(B1) But their stakes differ.** A false kill is the class this project exists to prevent (principle 1). An
    under-reported survivor errs in the safe direction.
  - So the two directions get DIFFERENT closures.

## 3. The closures

- **R1223: keep Form A, in its shared-daemon variant (B1).**
  - One `=0` confirm lane per run, with no replay. Every R1223 D5 route goes there:
    - `batchKillPairs` and `sendKillPairOn` (with its `activate` paths);
    - the pair-skipped catch;
    - `pairFallbacks1` and `pairFallbacks2`;
    - `takeStoredPair` refusals;
    - the `noneVerdict` mapping;
    - the carry walk and the coverage windows (PR-447 r3).
  - A kill stands only on real-login evidence, so its soundness does NOT depend on the key.
  - If the lane cannot serve, the kill is withheld; it never falls back to `=1`.
  - R1223 sized this at about 11,100 s of serial pair work against c5's 19,758 s mutants phase. It runs inside the
    lanes' budget and needs no extra daemon per lane.
  - R1223's D2 (NONE confirms after warm-up are never checked) and D6 (the "R1223 built" constant) stay as they are.
- **R1226: a sampled check with a stated limit (survivor direction).** al-runner checks a sample of replayed sessions
  on EVERY replay-on daemon: it thaws a start into a twin and compares it with a real login.
  - This is an al-runner ask: a sampling rate per request, or check the first replay of every key.
  - It ALWAYS checks the first replay of every key that is not NONE-equivalent (5.5% of entries).
  - Until al-runner has it, the confirm lane's own CHECK (below) is the only check, and its limit is stated.
- **The confirm lane runs `=0` WITH `ALRUNNER_LOGIN_REPLAY_CHECK=1`.** Check mode logs in for real, so Form A still
  holds, and it adds a check sample at no extra daemon.
  - **(S1)** Its memory is measured, not assumed. CHECK costs ≈ +2 GiB (6.04 vs 3.98 GiB at cap 128), because
    `Tally.firsts` is not capped. The lane decision charges the confirm lane by its own peak, never the session's
    highest peak for every lane.
- **(B4) The trip signal: exactly three error counters, read as deltas per engine:**
  - the `login replay check:` exact differ;
  - the round-trip differ (`not comparable` counts as an error);
  - the `login start:` replay-vs-run differ.
  - The across-codeunit counter is NOT an error.
  - An ANSWERED request whose sessions raised the login and printed no line counts as an error.
  - An UNANSWERED request (timeout, kill, SIGTERM, budget end) counts as UNCHECKED: reported, never "fine", and never
    a trip.
  - A leg-C contract case pins the line format.
  - Every respawn of the confirm lane is asserted, at spawn, to carry the CHECK env.
- **(B3) After a trip:**
  - The trip is stored as a fact on (project, al-runner build). Every later run and resume on that pair runs
    replay-off.
  - This uses the INTERNAL replay-off spawn path, the same one the confirm lane uses. It is not a user toggle, so not
    a dual path (principle 16).
  - Carried rows whose origin run had replay on are invalidated at read time when the carrying run trips.
  - The window is the whole run: `afterMutantId` = the run's first id − 1, and `afterSnapshotId` = the run's start.
  - Against PR-454's "first window wins", the EARLIEST start wins.
  - A replay-on run's fingerprint marks it, so a run without the confirm lane is never carried or lent.

## 4. The shape (principle 16)

- **C plus replay is the single v3 mutation path.** The internal replay-off path exists only for:
  - the confirm lane;
  - after a trip;
  - (S5) a build whose `login-replay` fact or cap setting is missing.
  - All of these are decided by facts, never by user config.
  - A config that still names `loginReplay` is refused by name (no back-compat before release).
- **(S3) The cap is set with `MAX_MB`** = cap × the measured largest image, plus a margin. Heavy-slot presets are
  based on MB. Default cap 32, pending the measurements in §5.

## 5. Go / no-go: NO-GO now

**The arithmetic, corrected (S2):**
- the canary's share is 1/5 (c5 ran 5 lanes), not 1/8;
- the CHECK lane's +23% wall, measured on the same life;
- Form A's serial pair work runs on one lane;
- the modelled saving at cap 32 nets ≤ ≈ 15k lane-s (≈ 15% of c5's mutants phase), before any lost lane from the
  CHECK lane's memory;
- the direct life walls do not confirm even that.

**Conditions for a GO, each measured, nothing built:**
1. **A full DO run with CHECK on every lane** (fewer lanes if memory needs it), covering the 3 lives' login-path keys:
   0 errors on the three counters.
2. **An interleaved A/B of lane time** on the probed life: off against on at cap 32 with `MAX_MB` set, at least
   A, B, A, B on the same cores, with outside load named. On must beat off by more than the C selector's cost.
3. **alrunner's sampled check** on replay-on daemons (the R1226 ask), or the orchestrator accepts the confirm lane's
   CHECK as R1226's only sample, with its limit stated.

If 1 and 2 hold, the build is: C, the confirm lane, the trip fact and the three-counter signal, with the flag retired.

## 6. Owner principles weighed

- 1 (correct first) decides B1: Form A stays.
- 4 and 6 (measure; label): §1's NOT-covered list and the confounded walls.
- 5 (unknown is not no): unanswered = unchecked, never fine.
- 13 (right-sized): no per-lane CHECK daemon; one confirm lane.
- 16 (clean cutover): one path, with an internal replay-off route decided by facts.
