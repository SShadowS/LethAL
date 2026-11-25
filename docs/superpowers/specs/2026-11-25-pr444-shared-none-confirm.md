# PR-444 pre-commitment (R1221 C1): one NONE confirm per (call id, `through`) per pair batch, behind PR-442's facts

Status: pre-commitment (coord PR-444, lethal-code, 2026-11-25), before the build. Sources: R1221 (C1 and PR-441's
spec-adversary conditions), PR-441 (`/coord/handoff/PR-441/`: `findings.md`, `candidates.md` and the review), PR-442's
facts (master 62795fcc2) and PR-256 (`stopGroups`, the opt-in pattern followed here). C2 (dropping echoes) is out.

## Why
- Every cold kill gets a kill pair (R653/R778): a NONE entry and an M entry, each with its echo, cut after `through`.
- On c5 (PR-422): 6,178 pairs, 6,013 batched; 6,185 main-pass kills from only 873 killing tests. Within a window of
  ~20 kills (R778's batch size), one NONE per killer needs ~1,680 NONE entries instead of 6,185.
- Bound (PR-441, with the review's corrected base): **~3.8% of the mutants phase**, from the batched pairs only.

## The change (opt-in, off by default)
1. **The config flag** `alRunnerV3.sharedNoneConfirm` (boolean, absent = off), parsed like `stopGroups`. A non-boolean
   is refused by name (`al-runner-v3-config-refused`). Off: `batchKillPairs` is byte-for-byte today's.
2. **The gate.** With the flag on, `status()` refuses unless the build's gate record reads EVERY one of PR-442's 14
   `entry-no-cross-*` keys as `matches`. An absent key means refused. The refusal:
   `al-runner-v3-shared-none-unsupported: "alRunnerV3.sharedNoneConfirm" is on, but this build's gate record (lethalCommit
   ...) does not read <keys> as matches (PR-442, R1221)`.
   - The same check runs at the point of use, in `batchKillPairs`, so a rig that skips `status()` still cannot share.
     It throws `AlRunnerV3SharedNoneError`, which extends `Error` directly.
   - It is rethrown wherever `AlRunnerV3StopGroupsError` is: never absorbed as a skipped batch, never a quiet fallback.
3. **The exact group key** (PR-441 review, SERIOUS 1).
   - Kills are grouped by `(callId, through)`: the call id is the codeunit's, or under `--isolate-tests` the test's
     (`pairTag`), and `through` is PR-102's cut, the LAST failing covering test in baseline order.
   - One group sends ONE NONE entry (key `NONE#<callId>|<through>`, `through` set), then each kill's M entry
     (`<tag>#m`, the same `through`).
   - The order per kill stays kill (prefetch) → NONE → M: the NONE comes before every M of its group, in one
     request.
4. **The same-request assertion.** A stored pair's `none` and `m` come from the same `out.seq`, and both cuts equal the
   group's `through`. A violation throws by name (`al-runner-v3-shared-none-mismatch`); it is never stored.
5. **The L4 drop-pair guard** (PR-441 review; today unreachable, PR-441's answer). In `run`, before the L4 live call: if
   `lane.lastActivated === null` and `lane.pair?.next === "mutant"`, drop the pair. The reproduction is then re-sent
   live after that live NONE, so a stored M can never precede a live NONE. With the flag off nothing reaches it, as
   today.
6. **Chunking and re-sends** (review MINOR 4).
   - A group is never split across chunks. A group too big for one chunk is split into parts, and each part carries its
     own NONE.
   - `groupsThatFit` is fed the real group shape (one NONE plus k M groups), not "2 groups per kill".
   - After an R612 cut, the Ms that did not stand are re-sent once on a fresh daemon WITH a fresh NONE in the same
     request, never paired with the earlier request's NONE.
   - A group whose NONE did not stand is re-sent whole.
7. **The fingerprint and the lending tag** carry the flag when on (as `v3StopGroups`). `--resume` and lending refuse
   across a flip.
8. **A notice line**, printed once per session when on and allowed:
   `[lethal] al-runner-v3 shared NONE confirm ON: one NONE per (call, through) per pair batch (R1221 C1)`.

## Why the guarantee stays whole
- **The flip-over-time argument holds per mutant:** the kill (prefetch) comes before NONE (passes) before M (fails), all
  after the prefetch.
- **What changes:** M_2 now runs right after M_1, without a NONE between them. That can only matter if state crosses
  entries of one request. PR-442's 14 facts measure exactly that, in LethAL's request shapes, on the mutant daemon's
  environment. So the flag needs every one to read `matches`.
- **A failing shared NONE** makes every mutant of its group `unstable` instead of one (review MINOR 5). That is the safe
  direction, and k times the cost of a flaky NONE: counted and reported.

## Predictions (any difference is a BLOCK until explained)
- **Off by default, so no figure moves on any gate:** v3 (every leg), carry, and the BC legs if `selectLegs` names them.
  0 verdict, killing-test, note, refusal or warning-set moves.
- **Unit tests, red both ways:**
  - **Off:** the pair-batch body is byte-equal to today's.
  - **On, all 14 facts `matches`:**
    - two kills of one (call, through) send exactly one NONE before both Ms;
    - two kills of the same call with different `through` get two NONEs;
    - each stored pair holds the shared NONE's rows and its own M rows.
  - **Refusals:**
    - on with any fact absent or `diverged`: `status()` refuses by name, and `batchKillPairs` throws by name;
    - the same-request assertion throws on a forged mismatch.
  - **The L4 guard:** a stored pair plus a live NONE drops the pair, and the reproduction is sent live.
  - **Cuts and chunks:**
    - after a cut inside a group, the unreached Ms are re-sent with their own NONE;
    - a group never straddles two chunks without its own NONE.
  - **Config and fingerprint:** a non-boolean is refused; the fingerprint and tag carry the flag only when on.
- **On DO (the measurement, once a gate record reads the 14 facts `matches`):**
  - **When:** bugs records them on the next update run (orchestrator, 2026-11-25).
  - **The run:** one scoped DO window, arms interleaved; configs differ only in the flag; plus an OFF-vs-OFF pair in the
    same window.
  - **Equal per mutant** (any ON-vs-OFF difference the OFF-vs-OFF pair does not show is a BLOCK): verdict,
    `killingTest`, timeout-killed, notes, refusal and withheld sets, and the set of scored mutants.
  - **Reported:** NONE entries sent per arm, pair-batch lane-seconds per arm, the shared-NONE `unstable` count, and the
    outside load.
  - **Prediction:** NONE entries in pair batches down ~70% (c5's window-20 estimate), batched-pair lane-seconds down by
    the same share of the NONE half, no verdict move.
