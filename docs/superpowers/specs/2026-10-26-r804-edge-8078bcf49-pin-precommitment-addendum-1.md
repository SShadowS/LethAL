# R804 pre-commitment, addendum 1 (2026-10-26): edge db0296678 shares 8078bcf49's readings

Adds to `2026-10-26-r804-edge-8078bcf49-pin-precommitment.md` (d1b7ac8a). Written by lethal-bugs before the pin
`edge-db0296678` is built or merged. Lethal-spare builds it and runs the merge, regate, rejudge, K and timing sequence.

Build: `al-runner 3.0.0-alpha.6+edge.20261026 (db0296678)` (a new alpha), sha256
`4f9596510ececcfa5e5b235350e2b2658264abceb2d54d5fa01131e8ffab07db`. It read GATE-FAIL at `.gated` 242d770b
(receipt `/work/tools/al-runner-v3/failed/edge-db0296678@242d770bf28bdae9ef67a93c40836ec31968f16e/`).

## The check (lethal-bugs, against lethal-spare's diff)
- Compared db0296678's gate log with 8078bcf49's regate log at the SAME `.gated` commit
  (`/work/tools/al-runner-v3/regate/242d770bf28bdae9ef67a93c40836ec31968f16e.gate.log`), with durations, temp paths and
  hashes masked.
- Every difference is either one of the three named below, or the expected effect of db0296678 having no pin yet:
  - C: the 8 facts read `held` (defect-present -> gone) where 8078bcf49 reads `pinned` with the same measured texts.
  - N1E: held on the Dot.Step line (the row has `codeunit` and `method`).
  - O1: the CDO WorkDate 2026-08-01 is unpinned, and the commit kind is judged "refused" because the pin does not record
    it, so the Commit passes count as unexpected.
  - X (d): "Sleep rule applies", with the extra coverage windows in D1, D1c and X (e)/(f).
  - T: the 48 rows held.
  - K: skipped as a candidate.
- The T rows held on db0296678 are exactly the 48 keys of 8078bcf49's pin (`/coord/handoff/lethal-spare-edge/t-rows-8078.ts.txt`).
- T's counts are identical, 318 / 70 / 18 over 406, with 0 refused tests.
- D1 and D1c compare per mutant identically (0 differences) on both builds.
- The three genuine differences:
  1. the version line;
  2. `timeout-is-cpu`'s measured text (another core and CPU figures; it still reads `matches`);
  3. O1 sends 9 requests: R804's commit kind, now at `.gated`.
     Not a build difference: 8078bcf49's regate at 242d770b sends 9 too.

## The pin `edge-db0296678`
- 8078bcf49's pinned readings (legC's 8 gone facts, legT's 48 rows and counts, xb, `serveRowFields`, `o1.cdoWorkDate`)
  move into one shared constant.
- `edge-db0296678` adds its own version and sha256 only.
- There is no judge or code change. `o1CommitRuns` reads the shared legC, so the commit kind is judged "runs" on db0296678 too.

## Predicted: the rejudge of db0296678 at the pin's merge commit
- Exactly 8078bcf49's rejudge lines at 2136daf0, plus O1 "commit kind judged as runs", 9 requests, pass, on both sets.
- In detail:
  - C: 8 `pinned:` lines; `codeunit-runs-whole` defect-present; `serve-keep-reasons` as a warn line;
  - N1E: completed 36/0/0;
  - O1: pass, with the CDO WorkDate pinned 2026-08-01;
  - X: (b) 3/0/0, (d) "Sleep rule RETIRED";
  - T: "T: pinned 48 rows (pin edge-db0296678, #5603, #5607)", 318/70/18;
  - D1 and D1c: 0 differences;
  - every other leg passes.
- Update gate `pass`, so `current` moves to edge-db0296678.
- The regate of 8078bcf49 (current until then) is unchanged by the refactor.

## Judgement
Any reading beyond the three genuine differences above (orchestrator's condition) is a BLOCK until explained, in a
dated addendum, never an edit of this file.
