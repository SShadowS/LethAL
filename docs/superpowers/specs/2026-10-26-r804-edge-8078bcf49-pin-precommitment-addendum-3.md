# R804 pre-commitment, addendum 3 (2026-10-26): al-runner 3.0.0-alpha.7, release and edge, share the same readings

Adds to `2026-10-26-r804-edge-8078bcf49-pin-precommitment.md` (d1b7ac8a) and addenda 1 (f1822947) and 2 (9110d515).
Written by lethal-bugs BEFORE either alpha.7 pin is built or merged. Owner's ruling (via the orchestrator): adopt
al-runner 3.0.0-alpha.7 if its readings are identical.

## The builds
- Release: `al-runner 3.0.0-alpha.7 (2c63a382e)`, sha256 `af19368ded0c3f809877f6042bba1c40175c70fe418733178cbfb96ac7fcbb2d`.
  Receipt: `/work/tools/al-runner-v3/failed/v3.0.0-alpha.7@68568a19a8a05f418449c11c9d12ad7f664edcd7/`.
- Edge: `al-runner 3.0.0-alpha.7+edge.20261026 (2c63a382e)`, sha256 `31d2cf1fee463515c9bab5ba7a60d24845abacc5bb9709d89bb687b84423bbc6`.
  Receipt: `/work/tools/al-runner-v3/failed/edge-2c63a382e@68568a19a8a05f418449c11c9d12ad7f664edcd7/`.
- Both read GATE-FAIL at `.gated` 68568a19, because no pin exists for them yet.

## The check (lethal-bugs, against lethal-spare's diff)
- I masked durations, temp and binary paths, hashes, wall and CPU times, core numbers, the timing lines and the version
  line. Then I diffed:
  - alpha.7 release's gate.log against edge db0296678's (`edge-db0296678@242d770b…`, unpinned at its judge commit);
  - alpha.7 edge's against alpha.7 release's.
- Both diffs: **0 differing lines**.
- Unmasked, both alpha.7 logs hold:
  - the same 48 held T rows, 318 / 70 / 18 over 406;
  - D1 and D1c with 0 differences against `bc3-A` and `bc3-B`;
  - the same held and unpinned readings as db0296678 (C's 8 facts, N1E, O1's CDO WorkDate and commit kind, X, T).
- The only genuine differences are the version line and `timeout-is-cpu`'s core and CPU figures (still `matches`), the
  orchestrator's condition.

## The pins
`alpha.7-2c63a382e` (release) and `edge-2c63a382e` (edge): each has its own version line and sha256, with the SAME shared
`READINGS_8078BCF49` (legC's 8 gone facts, legT's 48 rows and counts, xb, `serveRowFields`, `o1.cdoWorkDate`). There is no
judge or code change. Lethal-spare builds them.

## Predicted: the release-path update gate for alpha.7 at the pins' merge commit
- Identical to alpha.6's release-path reading (addendum 2), with the version line and `timeout-is-cpu`'s figures as the
  only differences:
  - C: 8 `pinned:` lines; `codeunit-runs-whole` defect-present; `serve-keep-reasons` diverged as a warn line;
  - N1E: completed 36/0/0;
  - O1: pass on both sets, with the CDO WorkDate pinned 2026-08-01 and the commit kind judged "runs" (9 requests);
  - X: (b) 3/0/0, (d) "Sleep rule RETIRED";
  - T: "T: pinned 48 rows (pin alpha.7-2c63a382e, #5603, #5607)", 318/70/18, 0 refused tests;
  - D1 and D1c: 0 differences;
  - K: skipped as a candidate;
  - every other leg passes.
- Update gate `pass`, so `current` moves to the alpha.7 release.
- The K run on the new `current` then shows every leg passing with that pin applied.
- If the edge alpha.7 is judged too, its reading is the same, with its own version and pin name.

## Judgement
Any reading beyond the version line and `timeout-is-cpu`'s figures is a BLOCK until explained, in a dated addendum,
never an edit of this file.
