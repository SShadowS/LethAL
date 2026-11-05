# R-815 pre-commitment (2026-11-05): `current` moves to edge d72d3197d, on alpha.12's readings

Written by lethal-bugs before the pin is built or merged. Owner's ruling (via the orchestrator): `current` follows edge; a
release only joins a shipped manifest.

## The build
`al-runner 3.0.0-alpha.13+edge.20261105 (d72d3197d)`, sha256 `3e19dbec34826e2d057304d9e85859c04e87d69a5846bb738fe9567a00c22be4`.
GATE-FAIL at `.gated` a7ac7f50, for lack of a pin: receipt
`/work/tools/al-runner-v3/failed/edge-d72d3197d@a7ac7f500c1e5fcf9e9c049f2a3324105ad62ed8/`.

## The check
Masked diff (durations, paths, hashes, wall, CPU and core figures, timing lines, version, seed values) against alpha.12's own
unpinned log (`failed/v3.0.0-alpha.12@10f9f63a…`): 7 lines. None comes from the build: 5 are the identity-scheme notes of master's
later commits, and the rest a stack-trace path.
- T: the same reading, 318 / 70 / 18 over 406, 48 rows held, gate-fail only on "0 refused tests, pre-committed 3".
- D1 and D1c: 0 differences.
- C: the 8 facts held, `serve-keep-reasons` diverged (the unpinned reading, R808).
- O1 stops at 18 package apps, as alpha.12 did unpinned. **So O1's CDO requests and its seed sub-check are not yet measured on
  this build.** The rejudge under the pin is that measurement.

## The pin `edge-d72d3197d`
Its own version line and sha256, on the shared `READINGS_8078BCF49`, with `o1.cdoApps` 18, as `alpha.12-d4bc8d3a5`. No judge or
code change.

## Predicted: `--edge-rejudge d72d3197d` at the pin's merge commit
Identical to alpha.12's reading at a7ac7f50, except the version line and `timeout-is-cpu`'s figures:
- C: 8 `pinned:` lines; `codeunit-runs-whole` defect-present; `serve-keep-reasons` `matches`.
- N1E: completed 36/0/0.
- O1: pass on both sets; 18 apps; CDO WorkDate 2026-08-01; commit kind "runs"; seed sub-check pass (seed 1 / `env`, identical when
  pinned, differing with no variable).
- X: (b) 3/0/0, (d) "Sleep rule RETIRED".
- T: "T: pinned 48 rows (pin edge-d72d3197d, #5603, #5607)", 318/70/18, 0 refused tests.
- D1 and D1c: 0 differences. K skipped as a candidate.
- Update gate `pass`, so `current` moves to the edge build.
The K run on the new `current` then shows every leg passing with the pin applied. The regate of alpha.12 at the merge, which runs first, is unchanged.

## Judgement
Any verdict moving away from BC is a BLOCK. Any other reading off this file is a BLOCK until explained, in a dated addendum,
never an edit of this file.
