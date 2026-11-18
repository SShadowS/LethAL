# R-984 cross-build window x4 pre-commitment: resume dos4 on edge-4ebfe7913, head 7b315e73, --peak 18 (3 lanes kept), class F

Lane lethal-bugs, 2026-11-18, committed before the window starts. Fourth window of `dos4.sqlite` (x1 4ac7a4a2 + 2fc7612b, x2 ed96cd23,
x3 8c97a22a + 7ad9be34). Head: master 7b315e73 (x3's c7316cf7 + PR-127 docs, PR-130, PR-131, PR-132, PR-133 two refusal families kept,
PR-134, PR-135, PR-136, PR-67, roadmap R1119/R1120). al-runner edge-4ebfe7913 (`v3.do-serve-xb.json`). `run-xb.sh 4`: `--resume`,
`--workers 3`, **declared `--peak 18 baseapp`** (orchestrator, after R1120: x1-x3 held lane 1 at 15.3 / 15.8 / 16.2 GiB charged against
15 declared), **watchdog at a 20 GiB tree** or under 4 GiB of headroom, `--time-budget 12600`. Events kept.

## Basis: x3 (`/coord/handoff/R-984/result.md`, accepted by the orchestrator after the re-run check)
2,926 covered at 4.25 s; lanes 1-2 idle 85% of the mutant phase after the lane-memory hold; vs x2 34 (E) and 24 covering-order rows
(re-run: 24/24 killed by the same test, 23 with the held refusal shown, M17961 on its twin's walk). 4,362 covered mutants remain.

## Measured before the window (`t6prep/dry-x4.txt` on 7b315e73)
Identical to x3's: 43,511 deployed.

## Classes (vs x3, the same build; vs x1/x2 likewise; vs t1-t14 as in x1-x3)
- (A) freed, (B) newly refused (named, upstream if new), (D) killing-test-only: as in x1's pre-commitment and amendment 1.
- (E) PR-81 walk-on (x3 amendment 1): earlier `error` from a refusal row -> `killed`; the stored note reads "the error of H was not
  scored: K failed under the mutant"; K in another codeunit than H.
- **(F) covering order (orchestrator ruling on x3, 2026-11-18), all five conditions:** (1) the earlier window's row is an `error`
  from a refusal row and x4 reads `killed`; (2) x4's walk met no refusal before the killer (no held-error note); (3) the kill reproduced;
  (4) the killer is in the earlier window's covering set and that walk stopped at its refusal before reaching it; (5) confirmed
  order-independent by a re-run of that mutant in its own fresh session (`x3-recheck/recheck.sh` method): killed by the same test.
- (C) anything else, including `error -> survived` and `error -> timeout-killed`: a BLOCK.

## Predictions
1. **vs x3: 0 differ outside (E) and (F)**; each (F) row re-run before x4 is accepted. vs t1-t14: (C) = 0.
2. **Mutation set:** 43,511 deployed.
3. **Baseline:** reused from x1's snapshot, named; the L5 re-check batched (its "re-check batching (PR-123)" line); phase <= 120 s.
4. **Lanes stay at 3: 0 `al-runner-v3-lane-memory-hold` lines**; 3 of 3 lanes started; PR-121's `gaps.ts` over x4's events shows no
   lane idle after its last request for more than 15% of the mutant phase.
5. **Speed:** at most 3.5 s per covered mutant (x3 4.25 s on one lane for 85% of its phase); the remaining 4,362 covered mutants
   complete within the budget (the window ends with none left: rc not a budget stop).
6. **PR-133:** 0 closes on its two newly kept refusal families; refusal closes counted by family (x3: 27).
7. **Closes:** 0 GoToKey and 0 SetFilter-1030 refusal closes; every timeout kill `v3-cpu-stop`; capped walks counted if any.
8. **Memory:** tree <= 18 GiB (x3 12.59); no watchdog stop; no budget overrun beyond one request.
9. TIMING quoted; PR-116's withheld-kills caveat counted.
