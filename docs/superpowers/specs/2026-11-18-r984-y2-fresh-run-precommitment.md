# R-984 y2 pre-commitment: a fresh end-to-end DO run on master 196afaf7 (PR-151, PR-139, PR-159 in), compared with y1

Lane lethal-bugs, 2026-11-18, coord PR-163. Committed before the run.

**Head: master 196afaf7.** That is y1's code head 8ff134f1 plus these code changes:
- PR-151, a barrier-free unit handout;
- PR-139, the NUL-run Evaluate widths kept;
- PR-159, y1's two sibling texts kept;
- PR-144, an opt-in recheck, default off, so not used here;
- PR-157, a report note.

The commits since then are docs only. **al-runner:** edge-4ebfe7913 (`current`). If `current` moves before the run, this file is
void and an amendment comes first. **Dry run on 196afaf7** (`/coord/handoff/R-984/t6prep/dry-y2.txt`): 469 files, 45,014 sites,
**43,511 deployed**, the same as y1.

**Shape, as y1** (`run-y1.sh` with its own folder): a NEW store `/coord/handoff/PR-163/doy2.sqlite`, triage first, config
`v3.do-serve-xb.json`, `--workers 3`, `heavy-slot.sh --peak 18 baseapp`, watchdog at a 20 GiB tree or under 4 GiB of headroom,
`--time-budget 54000` as a safety stop, events kept.

## Basis: y1 (`/coord/handoff/R-984/y1/result.md`, head 742fec3d, the same build)
- 27,150.2 s; 1.63 s per covered mutant (TIMING 1.58 s); 88.1% under 1 s by `durationMs`.
- Baseline 652.7 s.
- TIMING's lane line: 29 waits at window boundaries, 8,221.2 lane-seconds.
- 94 daemon restarts: 71 refusal, 23 timeout.
- Counts: killed 6,033, survived 9,885, timeout-killed 7, error 757, no-coverage 26,829.

## Predictions
1. **Mutation set:** 43,511 deployed; the numbering digest equals y1's.
2. **Barrier (PR-151 P3, with y1 as arm A):** y1's waits are 8,221 s, over the 300 s floor, so the check is conclusive.
   - **y2's summed "waiting at window boundaries" is at most 4,110 s** (half of y1's), read from TIMING's lane line (PR-150).
   - Not about 0: PR-151's look-ahead is one window.
3. **Time (PR-151 P4):** the session wall is shorter than y1's 27,150 s, central 24,500 s. Seconds per covered mutant are at most
   1.63, central 1.47. The share under 1 s by `durationMs` is at least 85%.
4. **Refusal restarts:**
   - at most 82 daemon restarts (y1's 94 less the 12 that PR-159's P2 attributes to the newly kept texts);
   - **0 closes on a kept text** (PR-139 P3: NUL-run widths in PR56_SLOTS.NULS; PR-159 P3: `GetTable of Integer 12345` and
     `WriteStartObject` at `message.body.toRecipients[0].emailAddress`);
   - every close on an unkept sibling is named.
5. **Kept refusals are safe (PR-139 P4, PR-159 P4):**
   - M28736 stays `error` with the same set of refused tests as x3 and y1;
   - M10951, M36459 and M36460 keep y1's verdicts (killed, error, error) and refused-test sets;
   - each newly kept text is seen at least once and is followed by no close;
   - every mutant scored on a lane after a kept refusal, up to that lane's next close, keeps its y1 verdict;
   - every `serve-drift-after-kept-refusal` event is named.
   - A difference here is re-run on a fresh daemon before y2 is accepted.
6. **Per mutant vs y1** (all 43,511 by the full site key: file, start, end, operator, mutated text):
   - 0 verdict differences;
   - killing-test-only rows (D) are allowed and named. PR-151 P2 expects none on its slice, but a fresh session's covering order
     can differ with lane timing.
   - Anything else is (C): a BLOCK.
7. **Baseline:** fresh and batched; phase at most 1,100 s (y1 652.7 s); 1,979 outcomes equal y1's, test by test.
8. **Lanes and memory:** 3 of 3 lanes; 0 lane-memory holds; tree at most 18 GiB; no watchdog stop; no budget stop (rc 0).
9. TIMING is quoted in full; lane figures come from TIMING's union, not gaps.ts (y1's ruling); events are kept.
