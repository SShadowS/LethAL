# Pre-commitment: re-gate current main-bf3a3e863 at a LethAL commit with PR-342, to record the `stop-groups` fact

lethal-bugs, 2026-11-22, on the orchestrator's word (queued after PR-357's c3 and c3off). Written before the run.

## Why
- `current` = main-bf3a3e863 (`al-runner 3.0.0-alpha.15+main.20261122 (bf3a3e863)`, sha256 b3e1d255…) was gated at 12:42Z
  at lethalCommit 6e567baa4.
- That was before PR-342 (merge a0c38f5d2) added leg C's `stop-groups` capability fact. So its `.gated` carries no such fact.
- PR-359 (stop groups on DO) and PR-256 (`alRunnerV3.stopGroups`) need it on current before their flag-on arms can run.

## The run
- `bun scripts/al-runner-v3-update.ts --regate <commit>`: the update gate's own path for gating the CURRENT build at a new
  LethAL commit. On a pass, `.gated` takes the commit.
- `<commit>` is origin/master at the time of the run. It must contain a0c38f5d2 (PR-342) and 12d3fdfd6 (checked by
  `git merge-base --is-ancestor`).
- CPUs 12-21 by `taskset`, with nothing timed on the box, after PR-357 ends.

## Prediction
- **The new fact:** leg C reads `stop-groups: matches` (preproc measured it twice on this build, at cc3882125 and 80afd41f8), and
  `batch-sequential-carry` still matches. Leg C has 38 facts.
- **Nothing else moves:** every leg passes, as at 12:42Z. A masked diff of the new gate.log against the 12:42Z gate.log of
  main-bf3a3e863 differs only in the new `stop-groups` fact line, plus whatever the commits since 6e567baa4 added to leg output
  that their own pre-commitments named.
- **current does not change** (the same build). The gated-builds row and `.gated` take the new lethalCommit.
- **Anything else** (a failed or held leg, a moved reading not named above): BLOCK. Nothing is recorded, and it is reported.

## Amendment 1 (2026-11-23, before the run; lethal-code's request for PR-359)
- **The commit is pinned:** `--regate 5b3f27102` (contains a0c38f5d2 and 12d3fdfd6, checked by ancestry), not "origin/master at
  the time of the run".
- **Why:** code's PR-363 adds leg C `serve-keep-reasons` cases that can move that warnFact's reading (today "diverged").
  PR-359's arm-B driver stops unless the re-gated `.gated` equals c3's record plus `stop-groups: matches`, with the warnFacts
  unchanged (`/coord/handoff/PR-359/gated-check.jq`).
- **The prediction tightens:** the warnFacts are unchanged, `serve-keep-reasons` included.
