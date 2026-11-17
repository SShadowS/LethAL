# PR-124 (R1092): where a fresh DO baseline's coverage seconds go: pre-commitment

Status: committed to master before any measured run (coord PR-124, lethal-preproc, 2026-11-17). Measure only. Evidence goes
to `/coord/handoff/PR-124/`.

## What is already read (stored events, no new run)
al-runner's own per-request `timings.coverageMs` in `serve-request-timed` events, fitted as `coverageMs = a + b x tests`
(`coverage-fit.ts`):

| run | baseline requests | coverage | a (per request) | b (per test) | r |
|---|---|---|---|---|---|
| x1 (R-984 window, full DO, 30,130 mutants, unbatched) | 110 | 542.1 s | 4,544 ms | 21.3 ms | 0.35 |
| PR-119 DO 735fb42 arm (same app, 98 mutants, unbatched) | 75 | 19.7 s | 236 ms | 1.6 ms | 0.27 |
| PR-119 BaseApp x 12 FA test codeunits (15,372 mutants) | 12 | 55.0 s | 4,398 ms | 11.3 ms | 0.40 |

- **Reading:** the cost is mostly per request. On x1 the intercept times the request count is 499.9 of the 542.1 s.
- It is not per test. The same app costs about 19 times more per request when the instrumented mutant set is about 300
  times larger.
- **The open question:** what the per-request part scales with: the instrumented sites (the guards schemata adds), or the
  app. And whether batching, now on for `current` after the R1109 regate, already divides it.

## Runs
- **Setup:**
  - LethAL master 8025f5ce or later, al-runner `current` (edge-4ebfe7913);
  - DO cloned from `/work/src/do-lethal` at 735fb42 into `/coord/handoff/PR-124/do-git`;
  - config PR-67's `v3.json`, `--workers 1`;
  - baseline only (one SIGTERM at `baseline-batch-finished`), except A, which runs whole;
  - one heavy slot, `--peak 10 baseapp`; never beside a DO window.
- **The runs:**
  - **A-on / A-off:** the 735fb42 arm (`--changed-since 735fb42^`). Coverage on (the config as is), then
    `"coverage": "none"`.
  - **B-on / B-off:** the whole DO project, with no `--changed-since`. On, then off.
- The first line of each run's log names the head, the build and whether batching was on (the PR-115 line).

## Predictions (each one is judged; a miss is reported as a miss)
1. **Per request.** In every coverage-on run, the fitted intercept times the request count is at least 80% of the coverage
   seconds.
2. **Coverage off removes it, and nothing moves elsewhere.** Each off run's baseline requests report `coverageMs` 0. Its
   baseline serve wall is shorter than the on run's by at least 80% of the on run's coverage seconds.
3. **Scale.** B-on's per-request intercept is at least 10 times A-on's (same app, more instrumented sites).
4. **Batching divides it.** With batching on, B-on's baseline requests number at most a third of x1's 110 per the same
   tests, and B-on's coverage seconds are at most half of x1's 542.1 s.
   - If batching is off in B-on, 4 is reported "not exercised", with the PR-115 line's reason.
5. **No verdict claim.** A-off scores mutants without coverage attribution, so its verdicts may differ from A-on's. They
   are reported, not judged.

## What the result will name
- The lever (LethAL side: batching, fewer or cheaper requests; or upstream: coverage collection cost per request in
  al-runner) and its size in seconds on x1's scale.
- If it points upstream: draft issue text with an invented repro, for the orchestrator. No DO source in it.
