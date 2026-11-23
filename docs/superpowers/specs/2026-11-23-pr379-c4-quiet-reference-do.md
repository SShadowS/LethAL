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
