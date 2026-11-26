# PR-458 (R1182): measuring PR-453 r3 §5's GO conditions 1-4 — pre-commitment r2

lethal-code, 2026-11-26. Written BEFORE any measurement.
- **r1** was 82d782d25.
- **r2** answers its spec-adversary: B1-B5, S1-S4 and the NITs, marked "(B1)" and so on.
- Condition 5 (a gated build carrying the fact and the cap) waits on upstream #9165.

## Common setup (nothing built in LethAL)

- **Build:** alrunner's fork 221d1f631, privately gated in PR-453 (every leg passed).
  - `ALRUNNER_LOGIN_REPLAY_MAX_IMAGES` and `_MAX_MB` are named in every arm.
- **Apps:** today's staging of DO's instrumented app, `PR-458/stage`, built at 2eeec7c0c.
  - **(S3) Identity checked:** 43,486 mutants, as in the capture's build (cb7fe19a8) and the census's (c5f057b3d). The
    census ids name the same procedures in all three, and no commit between them touched id assignment or the
    operators. So the capture's mutant ids are this build's.
  - Arm "A" is that app with today's selector. Arm "B" is the same app turned into PR-447 r3's C prototype
    (`PR-458/app-C`, 680 buckets).
- **(S1) Request fidelity.** The probe passes every captured top-level field through unchanged: `runSelectedOnly`,
  `testIsolation`, `strictOrder` and the rest.
  - Arm A sends the captured `resources` UNCHANGED. Only arm B rewrites them into C's form.
  - PR-453's life probe dropped `runSelectedOnly`, so its life figures included the excluded tails. That is recorded
    as a correction in PR-453's findings.
- **Lives** (PR-453's capture; the login-path entries are those keyed apart from NONE under the census bucket rule,
  K = 64):

  | life | entries | login-path entries | login-path mutants | note |
  |---|---|---|---|---|
  | 1787006 | 4,528 | 1,320 | 12 | each key once |
  | 1905189 | 6,714 | 1,100 | 10 | each key once |
  | 1747701 | — | 50 | 20 | 5 mutants repeat as prefetch, then `#m` pair: R1223's door |
  | 1747706 | 9,198 | 0 | 0 | NONE-equivalent only |

- **(B1) The capture holds 42 login-path mutants.** A FULL run holds up to about 512: the 139 census ids sit in 8
  buckets of 64. Coverage is reported against both. PARTIAL is never a pass.
- **Load:** every probe on cores 12-21 through heavy-slot, with a declared `--peak` matching its measured peak.
  load1, heavy-peaks and other lanes' jobs are logged per arm.

## Condition 1: per-key CHECK coverage (B1, B2, B3)

- **Population:** every login-path key of lives 1787006, 1905189 AND 1747701.
- **(B2) Split:**
  - each daemon gets at most 150 distinct keys (CHECK keeps about 19 MB per new key in `Tally.firsts`, which is not
    capped);
  - `--peak 8` per daemon;
  - cap 128, MAX_MB 1024 (so starts are kept).
- **(B3) Order within a daemon.** Its keys' captured entries are sent in capture order, in requests of at most 100
  keys and 256 entries.
  - Each such request is followed AT ONCE by a repeat request with the same entries, so each key's image is still
    kept and the replay-vs-run counter has a start to compare.
  - In 1747701 the real repeats are kept as captured.
- **What is read: al-runner's own counters, as DELTAS over each repeat request.** E is that request's entries.
  - Δsessions = E;
  - Δkeys = 0 (no repeat made a new key);
  - Δcompared = E;
  - Δ replay-vs-run checked = E.
  - A missing `login replay check:` line is an ERROR, never 0.
- **PASS, for every login-path key:**
  - those deltas hold;
  - exact differ 0, round trip 0 (including `not comparable`), replay vs run 0;
  - every request answered.
- **FAIL:** any error counter above 0, which is a BLOCK, reported to alrunner as counts.
- **NOT MEASURED:** a delta that does not hold (the key split for a reason the line names, such as `clock`), or an
  unanswered request. The cause is named.
- **The midnight guard:** a daemon does not start within its expected run length of 00:00 UTC. The keys line must
  show no `clock` field.
- **Coverage:** the login-path mutants compared, out of 42 (the capture) and out of about 512 (a full run's ceiling).
  Condition 1 PASSES only for what it covers. The full-run population stays OPEN, and is stated as such.

## Condition 2: an interleaved A/B on real traffic (B5)

- **Arms:**
  - A: today's selector, replay OFF (`=0`), resources as captured;
  - B: C, replay ON, cap 32, MAX_MB 512.
- **Order:** A, B, A, B on EACH of 1905189, 1747701 and 1747706. The arms interleave within a life, on the same cores.
- **Correctness PASS:** every request's rows are EQUAL between A and B, with a row count ≥ the request's entries (so
  nothing is equal empty). Any difference is a BLOCK.
- **The value formula, written down before measuring:**
  - **the saving per life** = the median over its pairs of (A − B wall time), counted on the requests with NO `#`
    entries only. Pair entries move to the confirm lane in the design, so they are not charged twice. It is scaled to
    c5's mutants phase by those requests' entries / all of c5's non-pair entries;
  - **the cost** = the confirm lane's serial seconds (condition 4), scaled by pair entries to c5's pair entries,
    PLUS its memory charge in lane-seconds. That charge is (its peak − a regular lane's) / a regular lane's peak ×
    c5's mutants-phase lane-seconds / c5's lanes;
  - **value PASSES** when the saving exceeds the cost.
- **Instructions back the wall time:** user instructions per arm (perf) are reported beside it. If the sign of
  (A − B) differs between wall time and instructions on a life, value is INCONCLUSIVE on that life.
- **Not measured, and stated:** the critical-path delay of lanes waiting on the shared confirm lane (r3 N2). A value
  GO is conditional on r3 §7's queue sizing.

## Condition 3: a pre-ship survivor-direction SAMPLE (B4)

- **This is NOT r3 §5.3.** That needs a standing mechanism on every replay-on run (an al-runner sampled check that
  includes NONE-equivalent keys, or a LethAL survivor resample at `=0`). It stays REQUIRED and OPEN.
- **The sample:** within condition 2's runs, entries whose rows fail under A and pass under B (replay hid a kill) must
  number 0.
  - **(B4)** Entries that pass under A and fail under B (a false kill) are an explicit BLOCK too.
  - Life 1747706 is entirely NONE-equivalent keys: R1226's door.
- **Limit:** one project, three lives.

## Condition 4: the confirm lane's memory, PROJECTED (S2, S4)

- **How:** every kill-pair request of the capture (8,436 pair entries, `#` groups), in capture order, on ONE `=0` +
  `_CHECK=1` daemon on the C app, at cap 32 and MAX_MB 512 (the proposed production values).
  - RSS is sampled per request beside al-runner's key count, so the growth per new key is measured.
- **The projection to a full run:** the 110 NONE-equivalent keys plus (the killed login-path mutants × their covering
  codeunits), using the measured growth per key. c5 had 6,178 kill pairs and 5 login-path mutants among the capture's
  pairs, both scaled by pair entries.
- **PASS:** the projected peak ≤ 8 GiB, the serve preset a regular heavy job declares. The confirm lane then needs no
  more than one slot.
- **FAIL:** above 8 GiB. The confirm lane then needs al-runner to cap `Tally.firsts`, or a different design.
- **(S4) The serial seconds** are scaled by pair entries (not by the capture's 9,000 s).

## GO / NO-GO

- **"GO for 1, 2 and 4"** only if:
  - condition 1 passes for everything it covers (with the full-run population stated as open);
  - condition 2 passes on correctness AND value;
  - condition 3's sample shows 0 in both directions;
  - condition 4 passes.
- Condition 3 (r3 §5.3) and condition 5 remain OPEN in any case. So the overall verdict can be at most "GO pending 3
  and 5".
- Otherwise NO-GO, naming the failing condition.
- Every figure comes from a measurement or the stated formula, never from the LRU model.
