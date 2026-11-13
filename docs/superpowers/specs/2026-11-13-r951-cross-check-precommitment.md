# R-951 pre-commitment: the daemon-baseline cross-check compares exit-7/8 answers and replaces only truly missing samples

Committed before any gate ran on the change, 2026-11-13. Coord task R-951 (R961 follow-up). Build: lethal/r-951 at 053a903b (R1 3be8f56f,
R2-R6 c11de5bf, review fixes 3ed6604d, master merged). Gate on the gated `current`, al-runner edge-c8fe56e05.

**Why.** R-949's full Continia DO baseline dropped the daemon baseline with "the cross-check of codeunit 68903 got no clean one-shot
answer". R1 named the branch: `exit-7`. The cross-check's one-shot path accepted only exit 0/1, while a plain one-shot of 68903 exits 7
(6 of 42 tests refused, "FindSet on the Company table") and decodes cleanly (`/coord/handoff/R-951/68903.*`). Design and its
spec-adversary revision: `/coord/handoff/R-951/design.md`.

**The change.** The cross-check's one-shot answer is accepted with exit 0/1/7/8 and decodable rows, passes the live path's row check
(exactly one row per wanted test), and is compared (status, notRun, refusal/fail text, exact coverage): a refused test refused on both
sides is equal; refused on one side, or a missing or duplicated row, is a real difference and drops the session. A sample is skipped and
replaced ONLY for a spawn error or a wall timeout (the memory gate becomes a stop); a skipped last sample is replaced backward;
replacements are counted only when reached; the daemon baseline needs `min(4, planned)` clean compared samples per fill, else it drops by
name. After a drop, fresh one-shot answers already obtained are served instead of re-run (cleared at every deploy); no daemon answer is
ever served after a drop. A codeunit whose sample was skipped is served one-shot for the rest of the session. Serving an exit-8 answer
raises the same `al-runner-v3-dotnet-helper-missing` notice as a live call.

**Gate predictions** (legs selected: bcdev, lease, tables, chunked, alrunner-v3):
- **v3 legs DB, DBI, K:** unchanged when no sample is skipped: the same per-mutant tables (22 mutants, 3 / 14 / 5), the same warning
  sets (DB and K `["al-runner-v3-memory-guard"]`, DBI `["al-runner-v3-isolate-tests", "al-runner-v3-memory-guard",
  "al-runner-v3-serve-flagged-unknown"]`), `replaced` 0, the judge's sums equal with `replaced` 0, `dropped` undefined. Their fixture has
  ONE test codeunit, so the sample size is 1: a spawn error or wall timeout of that one sample would now DROP the daemon baseline (before:
  a note), and `dropped === undefined` would then fail. That is the rule working, not a regression to hide; such a run is re-run once
  and reported.
- **Every other v3 leg and the four BC legs:** unchanged; any per-mutant difference is a BLOCK.

**Live expectation (DO's full baseline, R-951 build, al-runner edge-2bd87774f per R-942's config):** codeunit 68903 is compared (exit 7 on
both sides) instead of dropping the session; the daemon baseline is kept unless a sample really differs, in which case the drop names the
field. Measured, not predicted: tests decided within the budget, time, and any drop.
