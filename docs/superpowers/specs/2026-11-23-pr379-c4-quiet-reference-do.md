# PR-379 pre-commitment: c4, the next full-DO reference run, and the QUIET speed reference

Coord PR-379 (lethal-bugs, 2026-11-23), on the orchestrator's word. Written and committed before the run. The kit is in
`/coord/handoff/PR-379/`: `arm.sh`, `v4.json`, `cut1504.txt`, `compare.py`, and `selftest-c3.txt` (the compare run on c3 itself).

## The run
- **When:** in the box queue after PR-359's A+B. The orchestrator starts it, and holds merges and lane VERIFYs for its duration.
- **The settings are c3's** (PR-357's `arm.sh`):
  - al-runner main-bf3a3e863, sha256 `b3e1d255…`, version `al-runner 3.0.0-alpha.15+main.20261122 (bf3a3e863)`, checked before and
    after and by the run's version line;
  - `ciSessionKind` client and `--ci-session-kind client`, companies CRONUS International Ltd., 5 of 8 lanes, CPUs 0-11;
  - `LETHAL_V3_PACK_ENTRIES=256`, every other `LETHAL_*` unset;
  - the triage baseline first, a fresh store and a fresh `cacheDir`.
  - `v4.json` is c3's `v3.json` with only `cacheDir` changed.
- **New against c3:**
  - every serve daemon's `/proc/<pid>/exe` is recorded (`exe.tsv`) and must be the pinned binary;
  - `box.tsv` carries each of CPUs 12-21's own busy share beside their sum;
  - the `/proc` reads no longer print "No such file" for a process that has just exited. PR-357's line put `2>/dev/null` after
    the `<`, which bash opens first; the read is now wrapped.
- **The head:** origin/master of the moment, recorded in `HEAD.txt`. It **must contain PR-365's merge** (the three
  `Field.RelationFieldNo` keep rows, R1187), or the run does not start. The run log says whether PR-347's merge (the
  `refusedCutTail` default flip), PR-370's (the recheck phase) and PR-359's are in it.

## What changed since c3 (head ec78cff18), and each change's claim
- **PR-344** (packing a tail alone): acts only with `refusedCutTail` on. 0 moves while it is off.
- **PR-354** (keep after the SaveAs-with-layout refusal family): its hard claim is verdicts and `killingTest` equal per mutant.
- **PR-360** (the login replay pinned off): 0 moves.
- **PR-363** (gate cases only): 0 moves.
- **PR-365:** R1187's claims below.
- **PR-370**, if in: a phase and its events only, 0 verdict moves.
- **PR-347**, if in: its flip moves verdicts. **An amendment naming its predicted moves by site key is committed before the run
  starts**; `compare.py --allowed-moves` reads it. Without that amendment, its moves are BLOCKs like any other.

## Predictions against c3, by name (joined on the full site key)
1. **V:** no verdict or `killingTest` moves outside c3's 1,504 RelationFieldNo-cut mutants (`cut1504.txt`, PR-365's overlap.tsv).
   Any other move is a BLOCK to analyse, listed by mutant.
2. **R1187, the 1,504:** every one leaves `error`, except at most the 11 with refusals of their own under the mutant:
   M16951, M16952, M16953, M19800, M19805, M27287, M27296, M27304, M28602, M28604, M28606.
   - So at least 1,493 leave `error`.
   - Three of the 1,504 (M12658, M12661, M12671) are already `killed` in c3; they are PR-357's BC-confirmed recheck kills.
   - PR-365's spec says "exactly 1,492 outside the 12", counted on t1. t1's rows (`/coord/handoff/PR-365/overlap.tsv`) show 14
     with a reason of their own: these 11, and the 3 cascades above, which c3's recheck already killed. Where the spec's 12 comes
     from is not reconstructed, so the name list here is the binding one.
   - No remaining `error` names PR-250's cut for these texts.
3. **Gained kills, the false-kill direction:** every one of the 1,504 that reads `killed` where y3 (PR-204) read `survived` is
   listed with its killing test.
   - A killing test after a refused test of the same codeunit is a BLOCK, unless explained one by one.
   - Under PR-365's amendment 1: "y3 ran on `RelationFieldNo = 1`" (BC gives 0, PR-367) explains a kill only when the killing
     test's failure follows from that value, named from its code path.
4. **Lost kills:** of y3's 182 kills among the 1,504, at least 150 read `killed` again. Each that does not is listed with
   whether it rests on the value.
5. **The error count**, on both bases:
   - **Store:** at most 618 (the spec's: c3's 2,110 main-pass errors minus 1,492).
   - **Report:** at most 254. c3's report reads 1,744, after the withheld-kill recheck's kills; 1,501 of the 1,504 are errors
     there, and at most 11 stay.
6. **PR-365's ruling's 10 Plan C differences:**
   - M13065 reads `error`, withheld after the refused test as in c3 (upstream ADR-064).
   - M12482, M12483, M12484 and M12504 are not killed by `U_ChainThroughTwoCompositeKeys_…`, which is red at baseline.
7. **The daemon:** 0 `serve-daemon-closed` events on the RelationFieldNo texts (c3 had 3).
8. **The binary:** every daemon's exe is the pinned binary.

## Speed: the QUIET reference
- **The run is void as a speed reference if CPUs 12-21's mean busy share over the run is above 0.10** (`box.tsv`). The
  per-core shares say which cores were busy if it is.
- If it is valid, the TIMING total, the phases (and PR-370's recheck phase, if in), the entries, the lanes started and the
  mutant phase's ms per test are reported. They become the reference for the next speed A/Bs. They are not judged against c3,
  which was not quiet.
- c3's figures are given only for context.

## What it becomes
If 1-8 hold, c4 is the verdict reference after PR-365, and R1187's predictions close. If the quiet rule also holds, it is the
first quiet speed reference. Otherwise the BLOCKs are the finding, and the orchestrator decides.

## The compare's self-test (done before this commit)
- c3 against itself: 0 moves, and every R1187 claim blocks (c3 lacks the rows).
- c3 with one planted verdict outside the 1,504: exactly one move-BLOCK, naming the planted mutant.

## Amendment 1 (2026-11-23, before the run): survivors a refused test covers are not confirmed; c4 is held
- **Why (the orchestrator):** preproc found on bc4 that in codeunit 68874, 9 of 47 v3 survivors are FALSE survivors. Their BC
  killer is a test v3 refuses at baseline. PR-365's keep rows have the same shape in 68975 and 68984: the refused tests stay unrun,
  and the other tests of the codeunit now run. The owner is asked how such survivors are scored.
- **Held:** c4 does not start until the owner's answer is in, and this spec is amended for it.
- **In the compare:** a survivor of the 1,504 that a refused test covers is counted as UNCONFIRMED, not as a recovered survivor.
  The refused tests leave no coverage in c3 or c4, so it is read from y3's report, where they ran (PR-365's reach). The rows go
  to `unconfirmed-survivors.tsv`.
  - Kills are unaffected (the gained- and lost-kill checks stand).
  - R1187's "at least 1,493 leave `error`" still holds as a count. Its survivors are reported as confirmed or unconfirmed, and only
    the confirmed ones count as recovered.
- **Positive control:** with every cut mutant forced to `survived` on c3's report, 808 count as unconfirmed. That is exactly
  PR-365's `reach.tsv`, where 775 are covered by a refused test and a later one, and 33 by a refused test and others.

## Amendment 2 (2026-11-23, before the run): PR-381's interface, and the headline check
- **Why (the orchestrator):** the owner's ruling is in, and PR-381 implements it: a survivor whose only possible killer is a
  test that did not run at baseline is unknown. The interim form is an app-level caveat with the count, shown wherever a
  survivor count or score is shown. No verdict changes. The owner's condition is that the headline carries it. The interface
  is PR-381's spec with its amendments 1-3 (ae6f7d607 and after) and PR-387's spec:
  - the report field `notRunAtBaseline` (qualified test names);
  - the caveat `survivors-beside-unrun-tests`, with `survivorsBesideUnrunTests` = `{ survivors, notRunTests,
    sharingACodeunit }`;
  - the sentence `notRunSentence` prints on the line after `score:`, in the error-range line and in the withheld-kills line.
  - PR-386 closed with no gain, so the caveat stays app-level. PR-387 changes only bcdev's wording; c4 is al-runner-v3.
- **When:** c4 starts only after PR-381 lands, and on the orchestrator's word. `arm.sh` now stops unless PR-381's merge is in
  the head, and it logs whether PR-387's merge is.
- **The compare stays verdict-based.** `compare.py` and claims 1-8 are unchanged. Amendment 1's confirmed/unconfirmed split is
  a reported view. PR-381's caveat is a reported figure, checked by a new script that runs after the compare:
  `/coord/handoff/PR-379/amend2/headline-check.ts` (rc 0 OK, 1 BLOCK).
- **c3's figures, under PR-381's final classifier** (`isNotRunBaselineRow`, round 3; `amend2/c3-notrun.ts`, read from c3's
  `baseline-batch-finished` events; c3 predates the field):
  - 237 tests not run at baseline: 209 cascades after an earlier refusal (198 of them after a number-sequence refusal),
    20 other refusals, 7 `Field.RelationFieldNo` refusals and 1 cascade after one. None is a timeout, stop, deadline or
    transport failure.
  - The caveat: survivors 8618, notRunTests 237, sharingACodeunit 4886. These equal PR-381's own c3 prediction.
- **Predictions for c4, by name:**
  9. **The not-run list** is c3's 237 minus `CDO Variant Setup UI Tests.U_ChainThroughTwoCompositeKeys_AsksOnceAndFillsTheSameKindOfValue`:
     **236 tests** (`amend2/c4-notrun-predicted.txt`). Under PR-365's keep rows that test runs and fails its own assertion at
     baseline (PR-365's result, rows 11-15: "red on both"), so it is no longer counted. The 7 RelationFieldNo tests stay refused.
     No other change since c3 touches the baseline: PR-354's claim is verdicts equal, and the SaveAs texts in c3's two
     second-order cascades are reach notes after a number-sequence refusal.
     - Any extra or missing name is a BLOCK, explained by name.
     - If PR-347 is in the head, its amendment states its effect on this list first.
  10. **The caveat:** `validity.caveats` holds `survivors-beside-unrun-tests`. `survivorsBesideUnrunTests` equals the head's
      `notRunSurvivors` recomputed on c4's report, with:
      - `notRunTests` **236**;
      - `survivors` **8618 + S**, where S is the number of the 1,504 that read `survived` or `known-survivor` in c4. c3 has none
        among them, and claim 1 leaves no other move. It must also equal c4's survivor rows.
      - `sharingACodeunit`: 4886 plus the tagged survivors among the S. It is a hint, so a different figure is reported, not a BLOCK.
  11. **The headline carries it (the owner's condition):** in `stdout.txt` (renderConsole):
      - the line right after `score:` is exactly `notRunSentence(caveat)` + ` (validity.caveats "survivors-beside-unrun-tests", R1197)`;
      - the error-range line holds ` Its survivors: <sentence>.` (c3 has `some-errors`), and the withheld-kills line holds
        ` The score's survivors: <sentence>.` when there are withheld kills;
      - the sentence opens literally with `<survivors> survivors, all in a run with 236 tests v3 did not run at baseline`, so
        a wording change or an empty value cannot pass.
- **The check's self-test** (`amend2/selftest.ts` on c3, built with PR-381's own `notRunSurvivors` and `renderConsole` at its
  round-3 head 9420617d2; `amend2/selftest.txt`): the good case passes. Each planted fault blocks: the headline line removed,
  an extra test, the field absent.
- **What it becomes:** the c4 result reports the caveat's figures and the not-run list beside the verdict claims. A survivor
  count or score quoted from c4 always carries the sentence.
