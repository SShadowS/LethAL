# PR-145: R1115 (the drift check skips baseline-red rows in mutant entries) and R1111 (closed by ruling: the coverage is read)

Coord PR-145 (lethal-code, 2026-11-18).

## R1115: the kept-refusal drift check and tests red at baseline
- **What is wrong:**
  - `keptRefusalDrift` compares a row with its baseline row when the mutant "cannot reach" the test: any row of a NONE entry, or,
    in a mutant entry, a test before the first test covering the mutant.
  - A test red at baseline is in no plan, so it always counts as unreachable, even when it runs the mutant's site.
  - A mutant that makes it pass (DO's M17235, PR-134) reads as drift. The daemon is closed for nothing: one false restart, 43.7 s
    in x2.
- **The change:** in a MUTANT entry, a test whose baseline row is not `pass` is not compared.
  - NONE entries keep comparing every row, red ones included. With no mutant active, a changed row there can only come from state
    carried over (contamination), which is what the check is for.
  - Green-at-baseline tests keep the check in mutant entries too: coverage says a green test outside the plan never reaches the
    site, so its row cannot change.
- **What is lost:** a red-to-pass flip of a test before the covering one, in a mutant entry, after a kept refusal. PR-134 measured
  that flip coming from the mutant, not from contamination. It is a cost direction only: a missed drift keeps a daemon that may be
  dirty for one request. The NONE check still catches carried-over state on the next NONE entry.
- **Tests (red both ways):**
  1. **The fix:** a mutant entry whose row for a baseline-`fail` test (before the covering test) is `pass` gives no drift. Red with
     the new skip removed.
  2. **The kept part:** a NONE entry with the same red-to-pass row still gives drift. Red if the skip ignores the entry kind.
  3. **The unchanged part:** a mutant entry whose baseline-`pass` test (before the covering test) now fails still gives drift.

## R1111: `"coverage": "none"` still asks for coverage at baseline. Closed by ruling: the coverage is read.
The task said to stop asking only where nothing reads the baseline's coverage. Three things read it whatever the session's coverage
mode (`al-runner-v3-backend.ts`):
1. **The daemon baseline's cross-check** (R948, adversary item 1; R951). `fillDaemonBaseline` runs the first, the last and every
   `BASELINE_SAMPLE_EVERY`th codeunit one-shot as well, and compares them test by test, including the exact coverage set. That
   equality is the evidence the daemon's state is clean. Dropping coverage under `"none"` would weaken the check that lets the
   baseline run on a daemon at all.
2. **The reused-baseline re-check** (PR-126, its review 2). A sampled codeunit with a passing test must compare at least one
   coverage map, or the check passes with nothing compared (empty vs empty). A baseline stored without coverage would fail that
   re-check, or need a weaker one.
3. **Baseline batching** (PR-115, `batchingOn(coverage)`). Batching is on only when coverage is asked. Without coverage the fill
   would run one request per codeunit, which costs more than the 4.2 s (arm) to 53.1 s (whole project) of `coverageMs` measured
   in PR-124.

The cost is small and only for a user who sets `"none"`, whose mutant phase costs far more (PR-124: 2,253 s against 44 s). So the
coverage stays. R1111 is closed with these three readers named.
