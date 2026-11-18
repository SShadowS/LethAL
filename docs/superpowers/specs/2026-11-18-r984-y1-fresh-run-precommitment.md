# R-984 y1 pre-commitment: one fresh end-to-end DO run on edge-4ebfe7913, every lever since t14 in, 3 lanes

Lane lethal-bugs, 2026-11-18. Coord PR-154. Committed before the run.

**Head: master 8ff134f1.** This head is x4's 7b315e73 plus:
- PR-140 (idle-lane close, R1120);
- PR-150 (TIMING per-lane line, R1119);
- PR-145 (the drift check skips baseline-red rows, R1115);
- PR-143 (RDLC-stub kills listed, never moved);
- PR-146, PR-147 and PR-148;
- the roadmap and spec commits since.

The later commits up to this file's commit are docs only. **al-runner:** edge-4ebfe7913
(`current`). If `current` has moved by run time, this pre-commitment is void and an amendment comes first (a cross-build run has
other classes). **Store:** a NEW store `/coord/handoff/R-984/y1/doy1.sqlite`; no `--resume`; dos3 and dos4 are only read.
**Command shape:** as `run-xb.sh` (same config `v3.do-serve-xb.json`), triage first, then the run: `--workers 3`, declared
`heavy-slot.sh --peak 18 baseapp`, watchdog SIGTERM at a 20 GiB tree or under 4 GiB of headroom, `--time-budget 54000` (a safety
stop, not an expected end; the outer `timeout` is raised to 56,700 s to match), events kept. **Dry run on 8ff134f1**
(`/coord/handoff/R-984/t6prep/dry-y1.txt`): 469 files, 45,014 sites, **43,511 deployed**, the same as x1-x4.

## What the owner asked for

- **Total wall time** (session start to `session-finished`, plus triage, quoted separately).
- **Seconds per covered mutant** = session wall / 16,682 covered.
- **Share of covered mutants scored in under 1 s** = covered `mutant-scored` events with `durationMs < 1000`, over all covered
  `mutant-scored` events. Read with care: `durationMs` is the time after prefetch, so a mutant whose tests ran in a prefetch request
  reads near 0. The same share over x1-x4: 87.9%, 91.2%, 89.8%, 87.6%. The honest speed figure is seconds per covered mutant.

## Basis

- dos4 (x1-x4, the same build, heads c996629b..7b315e73): 43,511 deployed, 16,682 covered, 26,829 no-coverage. Final: killed 6,033,
  survived 9,885, timeout-killed 7, error 757 (all runner-refused). Four sessions: 3 budget stops at 12,600 s plus x4's 8,806 s, about
  44,500 s of mutant phase for 17,735 covered scorings (errors are re-scored each window).
- Per covered mutant: x1 1.74 s, x2 3.28 s, x3 4.25 s (one lane for 85% of its phase: the lane hold, R1120), x4 1.80 s (3 lanes,
  0 holds at `--peak 18`). x2 and x3 carried the heavy mutants (covering set 103 tests on average in x3, 21.5 in x2).
- x1's fresh baseline, unbatched: 1,697.7 s (110 serve requests 1,075.0 s, 542.1 s of it coverage; 12 one-shots 574.5 s).

## Predictions

1. **Wall and speed.** Session wall at most 47,000 s, central 34,500 s (9.6 h); the covered set completes (rc 0, no budget stop).
   Seconds per covered mutant at most 2.8, central 2.0. Share under 1 s by `durationMs`: at least 85%, central 88%. The owner's
   target of under 1 s per covered mutant on average is NOT predicted to be met: the window barriers (R1092, x4: about 1,128 s of
   barrier-free saving) and the heavy units stay.
2. **Mutation set (R1104 P4, PR-109).** 43,511 deployed; PR-109's 7 refused sites absent, checked by file:line:operator; no timeout
   close from them. (Already held in x1, the first window on a head with PR-109; repeated here on a fresh store.)
3. **Baseline (PR-115, PR-117, PR-119, PR-123/126).** Fresh, not reused. Batching ON: the "baseline batching" line shows at least 10
   batches kept and 0 discarded or failed. Baseline phase at most 1,100 s, central 750 s (x1 1,697.7 s; PR-124 measured about 480 s
   of coverage saved by batching; PR-119 overlaps the cross-check one-shots). At least 6 of the cross-check one-shots overlapped
   (PR-119's `baseline-one-shot-timed`). Green 1,681 of 1,979, equal test by test to x1's baseline.
4. **Lanes (PR-140, R1120).** 3 of 3 lanes started. **0 permanent holds:** every `al-runner-v3-lane-memory-hold` (expected 0 at
   `--peak 18`, as x4) is followed by a `serve-daemon-closed` with reason `lane-idle`, and the held lane has `serve-request-timed`
   events in the next 600 s slice in which lane 0 has any. PR-121's `gaps.ts`: no lane idle after its last request for more than 15%
   of the mutant phase.
5. **Barriers (R1092).** Inner gaps over 5 s counted per lane by `gaps.ts`; each over 60 s sits on a window boundary (all lanes
   restart within 10 s), held by one heavy procedure unit, as PR-149 found in x4. Inner-gap time at most 25% of lanes 1 and 2's
   phase each (x4 22.8% and 18.2%).
6. **Refusal closes.**
   - **R1103 P3 (PR-105):** 0 closes on PR-105's 12 kept texts; so its refusal closes per 1,000 scored mutants on those families
     fall by at least 63.4% from t12/t13's (to 0). (x1-x4 counted 0 kept-text closes; this is the first fresh store with them.)
   - **PR-133 P3:** 0 closes on its two kept families (SetFilter `C*` not a BigInteger; `RecordRef.GetTable` of Integer), so none of
     the about 165 s of warm-up compile they cost per x2-sized window.
   - 0 GoToKey and 0 SetFilter-1030 refusal closes. Refusal closes counted by text; new texts named separately.
7. **Warm-ups (R1035, L2).** A restarted daemon's warm-up averages at most 60 s (x4: 248 warm-ups, 4,506.6 s, 18.2 s each); counted
   by cause.
8. **Timeouts.** Every timeout kill is `v3-cpu-stop`; capped walks (PR-108) counted (x4: 2).
9. **TIMING per lane (PR-150, R1119; in the head).** TIMING prints a line for each of the 3 lanes, in the form "lane N busy …,
   waiting at window boundaries <count> (<s>), after its last request …". Each figure equals `gaps.ts`'s figure over the same
   events, within 1 s or 0.1%, whichever is larger: busy time; inner gaps over 5 s, count and seconds; and time after the last
   request. TIMING also counts `lane-idle` closes (PR-140), and that count equals the `serve-daemon-closed` events with that reason.
   **Drift (PR-145, R1115):** 0 drift closes on a baseline-red row. In x2-x4, every drift close was on the baseline-red
   `Codeunit68859.CreatePDF_WithValidData_ShouldCreatePDF`.
10. **Memory.** Tree at most 18 GiB (x4 12.76); no watchdog stop.
11. **Agreement with dos4 (x4's final report, every mutant; strict, walk-cap clause on).** 0 differ outside these classes:
    - (D) killing-test-only: expected, since a fresh store restarts R197's covering order;
    - (F) covering order, all five conditions of the x4 pre-commitment; each F row re-run in its own fresh session before y1 is
      accepted (`x3-recheck/recheck.sh`);
    - no (A) or (B) is expected (the same build); any `error -> survived`, `error -> timeout-killed`, `killed -> error`,
      `survived -> killed` or `killed -> survived` is (C): a BLOCK.
12. TIMING quoted in full; PR-116's withheld-kills caveat counted; `serve-request-sized` events kept for R1091.
