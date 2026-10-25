# R-741 pre-commitment, addendum 1 (2026-10-24): run 2, the live proof of R749 on the built head

Committed before run 2. Base: the pre-commitment (master c501c223) and run 1's measurement
(`/coord/handoff/R-741/measure.md`: BC named the extensions' ids 93860 and 93861; the page member's sentence carried
"Function ID -935096164", which the old anchor did not read, so the refusal named only TestTableAnswer).

**What changed.** The built head of lethal/r741 reads a signed function id ([[R749]], `STALE_MEMBER`: `Function ID -?\d+`).
The probe is unchanged except for id set 2, which the pre-commitment named for a re-run. bc2 keeps set 1's records
until a restart. **Do not rebuild after this commit.**

| build | app id (set 2) | sha256 |
|---|---|---|
| B | 28c577b9-5e6a-4735-add0-bd6c3f451ea6 | 569e244d4f48e06aae8f36706b7f9d64a8f25acc71a3d6d7e62d9245914e9bb3 |
| T1 | 15fda437-a323-4426-8a43-1e24acfb18b2 | d2ea7e1d5d8bbcaca7893b9192220cfbb61c7f732b8dd1adaeadf72bb096fac6 |
| TS | the same app, the run's source | 51e6e2a4b8bdad5f14a870764fe83168e44a4ece02258da231b0f68fea6aacee |
| Q | 87ce8474-9f15-4641-bbed-b8d6ae3c0103 | 194fa5c658e4ebe1a85bb99f92576dc00a33e9a16ed35c1d66be820af89cf7d6 |

Steps, the symbol cache and the run config are as the pre-commitment's, with these ids.

## Predictions
- **F1:** E1 and E2 hold again (published, installed, the run's altool publish accepted).
- **F2:** the first lines name 93860 (table) and 93861 (page) again. The function ids are the same as run 1's:
  1933812373 for `Answer` and **-935096164** for `PageAnswer`. They look like a hash of the member: `Answer()` gave
  1933812373 in R738's probe too.
- **F3 (the proof):** the run refuses with `StaleTargetMemberError`, exit 1, naming BOTH TestTableAnswer and
  TestPageAnswer, and "93860, 93861". No report is written and no mutant is scored.

## Readings, decided now
- **The page member's id is positive** (F2's id missed): the proof does NOT count. Report it to the orchestrator and
  do not re-roll ids (orchestrator's ruling). The unit tests carry the negative case.
- **F3 holds with a negative page id:** R749 is proved live.
- **F3 fails with a negative page id** (only one test named, or R740's error): the fix did not reach the run, a BLOCK.
  Find the cause before anything else.
- **A void run** (a cause unrelated to the probe apps, before the baseline): report it. A re-run needs a further id
  set and a further addendum.
