# PR-458 (R1182): measuring PR-453 r3 §5's GO conditions 1-4 — pre-commitment

lethal-code, 2026-11-26. Written BEFORE any measurement. Condition 5 (a gated build carrying the fact and the cap)
waits on upstream #9165.

## Common setup (nothing built in LethAL)

- **Build:** alrunner's fork 221d1f631 (`login-replay-limits`), privately gated in PR-453: every leg passed.
  - `ALRUNNER_LOGIN_REPLAY_MAX_IMAGES` and `ALRUNNER_LOGIN_REPLAY_MAX_MB` are set explicitly in every arm.
  - The start check in f38843d49 changes nothing measured here, so the build is not rebuilt.
- **Apps:**
  - a fresh full-run staging of DO's instrumented app (`stage.sh`), with today's selector: arm "A" and every replay-off
    reference;
  - the same staging turned into PR-447 r3's C prototype (`mkapp.ts`: range buckets K = 64, `Format(…, 0, 9)`, the spec
    names): arm "B".
- **Lives:** PR-453's capture (`/coord/handoff/PR-453/capture/st`), replayed request by request (`lifeprobe.ts`), with
  each entry's resources rewritten for the arm.
  - **Login-path lives:** 1787006 (4,528 entries, 550 of them for the 139 login ids) and 1905189 (6,714, 330).
  - **The NONE-equivalent life:** 1747706 (9,198, none).
- **Load:** every probe goes through heavy-slot (serve) on cores 12-21, LethAL-free.
  - Outside load (load1, and other lanes' jobs) is logged per arm. The probes drive the daemon directly, so there is
    no LethAL pid.
  - Each daemon is stopped by the probe's own close.

## Condition 1: per-key CHECK coverage of the login-path keys

- **How:** lives 1787006 and 1905189 run on ONE `=1` + `_CHECK=1` daemon on the C app, with cap 128 and MAX_MB 1024.
  - After the lives, one extra request repeats each login-path entry that appeared ONCE on that daemon, so every
    login-path key has at least two sessions, and the second is compared.
  - The probe records, per key (codeunit, mutant), how many sessions it sent.
- **PASS:**
  - every one of the login-path mutants present in these lives has ≥ 1 compared session (sent ≥ 2 times on the
    daemon);
  - all three error counters read 0: the exact differ, round trip (including `not comparable`) and replay-vs-run;
  - the request was answered in full (no unanswered request).
- **FAIL:** any error counter > 0, which is a BLOCK on replay and reported to alrunner as counts.
- **NOT MEASURED:** a login-path mutant with < 2 sessions, or an unanswered request. It is never rounded to a pass.
- **Coverage stated:** how many of the 42 mutants these lives contain. If fewer than 42, the missing ones are named by
  id and condition 1 is PARTIAL.

## Condition 2: an interleaved A/B against today's selector

- **Arms:**
  - A = today's selector, replay OFF (`=0`);
  - B = C, replay ON at cap 32, MAX_MB 512 (cap × the largest image × 4, never binding).
- **Order:** A, B, A, B on life 1905189 (login-path), then A, B on life 1747706 (NONE-equivalent).
- **Measured per arm:** per-request row md5s, wall time, daemon CPU, and user instructions (perf), with load1 at start
  and end.
- **PASS (correctness):** every request's rows are EQUAL between A and B, in every pair.
  - A and B run DIFFERENT selectors, so equality also proves C gives today's answers on real traffic.
  - Any difference is a BLOCK, with the differing rows' count and kinds (counts only).
- **PASS (value):** the median over pairs of (A − B) wall time is > 0 by more than the confirm lane's sized cost
  (condition 4), as a share of the life's wall time.
  - It is reported with the instruction counts, which do not move with load.
  - If wall and instructions disagree, the result is reported as INCONCLUSIVE on value, never rounded.

## Condition 3: the survivor direction (R1226's door)

- **How:** within condition 2's runs, every entry whose rows are all `pass` under A (a survivor entry: the mutant's
  covering tests stayed green) must have the SAME rows under B, and the reverse.
  - Life 1747706 is ENTIRELY NONE-equivalent keys, which is where R1226's door is. A replayed login there that
    turned a kill into a survivor would show as A-fail / B-pass.
- **PASS:** 0 entries that fail under A and pass under B, in both lives, in both pairs.
- Also reported: the count of entries that pass under A and fail under B (the opposite direction).
- **Limit stated:** a sample of 2 lives, not the whole run.

## Condition 4: the confirm lane's memory under Form A

- **How:** every kill-pair request of the capture (8,436 pair entries over 28 lives, the `#` groups), in capture order,
  on ONE `=0` + `_CHECK=1` daemon (the confirm lane's setting) on the C app.
- **Measured:** peak RSS (VmHWM) and the request count.
- **PASS:** peak RSS ≤ 6.5 GiB (the measured `=1` + CHECK at cap 128 was 6.04 GiB on a 9,198-entry life).
  - The confirm lane is then charged that figure in the lane decision.
- **FAIL:** above 6.5 GiB. The confirm lane then costs more than one regular lane, and the net in §GO is recomputed
  with a lost lane.
- **The serial cost.** Its total wall time is the confirm lane's serial work, compared with R1223's sizing of
  ≈ 11,100 s, pro-rata to the 9,000 s capture.

## GO / NO-GO (as PR-453 r3 §5)

- **GO for 1-4 only if** condition 1 passes, condition 2 passes on correctness AND value, condition 3 passes, and
  condition 4 passes.
- Otherwise NO-GO, naming the failing condition.
- **The net on DO is reported as measured parts:**
  - the A − B lane-time saving per life, scaled to c5's mutants phase by entries;
  - minus the confirm lane's serial work and memory charge.
- No model is used where a measurement exists.
