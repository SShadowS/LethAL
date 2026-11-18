# PR-160: stop a mutant's walk at its first hang (WALK_HANG_CAP 3 -> 1): pre-commitment

Status: r1, committed to master before any build (coord PR-160, lethal-preproc, 2026-11-18). The orchestrator's ruling of
2026-11-18: build (d) with the cap at 1, and skip (a). Evidence: `/coord/handoff/PR-160/` (`result.md`, `cuts.ts`,
`after-hang.ts` / `after-hang.txt`, `held-fallback.ts`) and `/coord/handoff/PR-159/timeouts-notes.md`.

## 0. Amendment 1 (before any build, 2026-11-18)
- **The window length was wrong in §1.** y1's session ran 27,150 s (`session-finished`), with a 26,434 s mutant phase;
  12,600 s was x3's time budget.
  - So y1's hangs cost about 2,650 s, about 10% of its mutant phase.
  - The 1,015 s of after-timeout restarts is about 4% of the session.
- **itest:hang's BASELINE file does not change, and R332's re-record does not apply.**
  - `hang.single.baseline.json` holds per-mutant entries (verdict and killing test) only, which P2 predicts unchanged.
  - The call counts that move are constants: `HANG_FIGURES.heldSecondHangs` and `HANG_FIGURES.stoppedCallsOn`, in
    `packages/runner/itest/gate-expected.ts`, with the gate page's `gate-figures` block that
    `packages/runner/tests/gate-pages.test.ts` pins.
  - They change in the build branch: `heldSecondHangs` 2 -> 0, `stoppedCallsOn` 8 -> 6. `groupedCalls` is derived from
    them and the counts.
  - If the live run shows any per-mutant entry moving, P2 has failed: no re-record, and the build is reconsidered.
- **The upstream ask (e)** is posted as #8334, linking #8180.

## 1. The measurement
- **The cost in y1:** 8 mutants that loop forever caused 23 cut requests (1,635 s) and 23 daemon restarts (1,015 s),
  about 2,650 s of a 27,150 s session (26,434 s of mutants; amendment 1 corrects the 12,600 s first written here).
- **Why one mutant hangs more than once:** PR-108 (R1057) lets a mutant's walk go on past a hang, up to
  `WALK_HANG_CAP = 3` (`orchestrator.ts`), so a later covering test may still kill it normally.
  - PR-51 holds the FIRST timeout and replays it after the walk. A later timeout is only noted, and is scored only if
    every timeout before it fails to reproduce.
  - In y1, the 17 timeout rows belong to 8 mutants: 9 hangs beyond each mutant's first.
- **What continuing past a hang has bought, in every DO store** (dos3 runs 2-15, dos4 runs 1-4, y1; 18 runs):
  - every mutant that met a hang ended `timeout-killed`;
  - the one `killed` (M10447, 3 runs) was killed by its FIRST covering test, before its hang;
  - **0 walks went on past a hang and found a normal kill.**
  - **52 timeout-killed mutants had 2 or more hangs, and all 52 are scored from their FIRST hang.** PR-51's fallback to
    a later noted hang was never used.

## 2. The trade-off, in R1057's terms
- R1057: a timeout-killed verdict depends on which covering test LethAL meets first. With a second, killing test, one
  window scores `timeout-killed` and another `killed`.
  - Cap 3 lets a walk reach a killing test after up to two hangs. Cap 1 stops at the first hang.
- **What can move with cap 1:**
  - a mutant that hangs on test A, and would be killed normally by a later test B, reads `timeout-killed` (by A), not
    `killed` (by B);
  - a mutant whose first hang fails to reproduce on its replay, and whose later hang would have been scored, reads as
    the walk's other end (the held step's replay outcome) where cap 3 would have scored the later hang.
- **What cannot move:**
  - `mutationScore`: `timeout-killed` and `killed` both count as kills.
  - The stop evidence rule: a timeout still becomes `timeout-killed` only through the held step's replay with its stop
    evidence (PR-51, R582), exactly as today. Cap 1 only ends the walk earlier.
  - A walk with no hang is unchanged in every step.
- **Measured exposure:** 0 of the stored cases, per §1.

## 3. The change
1. `WALK_HANG_CAP` = 1 in `orchestrator.ts`. The note and the `held-walk-capped` warning keep their wording, with the cap
   read from the constant (they print "after 1 timeouts" as "after 1 timeout").
2. Nothing else: no change to the held-step replay, confirm, reproduce or stop-evidence code. It applies to every
   backend that runs this walk (bcdev and al-runner-v3).
3. **Tests:**
   - `pr108-walk-cap.test.ts` follows the new cap: the 1st hang ends the walk, its note counts the covering tests after
     it, and the held step is replayed and scored with its stop evidence.
   - Kept: the replay-failed path (a held hang that does not reproduce) gives the same outcome as a walk that ended
     there.
   - New: **a walk with no hang is unchanged** (every covering test sent, the same verdict), against a counter fake.
4. **Red checks both ways:**
   - cap set back to 3: the "1st hang ends the walk" test goes red;
   - the walk ended without a hang (e.g. `hangs >= 0`): the "no hang, walk unchanged" test goes red.

## 4. Predictions
- **P1, the al-runner-v3 gate:** every leg's frozen figures unchanged. No v3 gate fixture has a mutant with two hanging
  covering tests (leg X's timeout row is one hang).
- **P2, `itest:hang` (bcdev, a gate server), its frozen figures:**
  - `HANG_FIGURES.heldSecondHangs` 2 -> 0, `HANG_FIGURES.stoppedCallsOn` 8 -> 6, and `groupedCalls` 2 lower. M0008 and
    M0009's second hanging test (`SpinUntilReachesTheTarget` after `CountUpToReachesTheLimit`, or the reverse) is no
    longer sent.
  - **The baseline `hang.single.baseline.json` is unchanged:** 24 killed, 9 survived, 5 timeout-killed, with every
    killing test equal.
  - The gate page's figure block and its PR-51 paragraph are updated with the change.
  - The live run needs a gate server. Who runs it is decided by the orchestrator (this lane runs no BC work).
- **P3, the next DO window on a head with this change:**
  - no mutant has more than 1 timeout row in its walk, or 1 + a prefetch row (prefetch cuts are separate requests,
    unchanged);
  - every y1 timeout-killed mutant met there is still `timeout-killed`, with the same killing test (its first hang's);
  - after-timeout warm-ups fall by about the 9 repeats (about 1,000 s against y1), named in that window's report.
