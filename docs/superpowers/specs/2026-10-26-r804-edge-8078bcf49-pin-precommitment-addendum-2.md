# R804 pre-commitment, addendum 2 (2026-10-26): the release al-runner 3.0.0-alpha.6 shares the same readings

Adds to `2026-10-26-r804-edge-8078bcf49-pin-precommitment.md` (d1b7ac8a) and its addendum 1 (f1822947). Written by
lethal-bugs BEFORE any gate run of the release binary. The owner's ruling (via the orchestrator): make the RELEASE
3.0.0-alpha.6 `current` through the normal release path.

## The build
- Release: `al-runner 3.0.0-alpha.6 (db0296678)`, sha256 `92effe64d64dddcae98f80cc0e2e17a6429f977781ffe7b6b0f5eea6a231778d`.
  Asset `al-runner-3.0.0-alpha.6-x86_64-unknown-linux-musl.tar.xz`, published 2026-10-26 10:36:50Z.
- It is the same commit as edge `al-runner 3.0.0-alpha.6+edge.20261026 (db0296678)` (sha256 `4f959651…07db`), but a
  different build: a different binary and sha256.
- Its readings are NOT yet measured. The release-path run after the pin's merge is the measurement.

## The pin `alpha.6-db0296678` (lethal-spare, lethal/rdb02-pin)
The release's own version line and sha256, with the SAME shared readings (`READINGS_8078BCF49`): legC's 8 gone facts,
legT's 48 rows and counts, xb, `serveRowFields`, `o1.cdoWorkDate`. Tests pin its key and that it shares the same objects.
There is no judge or code change.

## Predicted: the release-path update gate (`al-runner-v3-update.ts`, no `--edge`) at the pin's merge commit
- The release is judged as a candidate (`current`'s gated alpha is alpha.5).
- Its readings are identical to edge-db0296678's prediction (addendum 1) and to 8078bcf49's rejudge at 2136daf0, and only
  these may differ:
  1. the version line;
  2. `timeout-is-cpu`'s measured text (core and CPU figures; it must still read `matches`).
- That is:
  - C: 8 `pinned:` lines; `codeunit-runs-whole` defect-present; `serve-keep-reasons` diverged as a warn line;
  - N1E: completed 36/0/0;
  - O1: pass on both sets, with the CDO WorkDate pinned 2026-08-01 and the commit kind judged "runs" (9 requests);
  - X: (b) 3/0/0, (d) "Sleep rule RETIRED";
  - T: "T: pinned 48 rows (pin alpha.6-db0296678, #5603, #5607)", 318/70/18 over 406, 0 refused tests;
  - D1 and D1c: 0 differences;
  - K: skipped as a candidate;
  - every other leg passes.
- Update gate `pass`, so `current` moves to the release.
- The regate of `current` (edge-8078bcf49) at the merge commit, which runs first, is unchanged.
- The edge db0296678 rejudge is skipped. Its pin stays as a record.

## Judgement
Any other reading is a BLOCK until explained, in a dated addendum, never an edit of this file.
