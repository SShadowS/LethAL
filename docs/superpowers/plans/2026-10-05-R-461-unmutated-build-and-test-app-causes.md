# R-461 plan r3 (R461 + R462). Evidence: survey.md beside this file.

## R461: report the observed fact, not a diagnosis
- New `UnmutatedBuildFailedError` (artifact.ts, extends Error directly, `.name` set). Message:
  "the target fails to compile with NO LethAL changes, using this alc and package cache", then
  alc's stdout AND stderr verbatim, each labelled. No "your source is broken" remedy and no
  "environment" blame: the user reads alc's own diagnostics. No parser, no path mapping.
- Both streams: `alcToContentAddressed` keeps `stderr || stdout` today (artifact.ts:218-221), so
  a stderr warning can hide a stdout error. Change that one line to keep both (labelled) for
  every `AlcCompileError`. Bisection's guards read only the class, never the text.
- When the plain build COMPILES: today's path continues unchanged (bisection, notes, rows).
- `compilePlainCheck?(dir)`: new optional method beside `compileCheck` (backend.ts:295), bcdev
  only. Steps: `rm -rf` then `mkdir -p` the scratch dir (`prepareBatchProject` does not create
  it, and a reused dir could hold generated files); `prepareBatchProject(projectDir, scratch,
  projectManifest, appVersion, sourceSnapshot, excludeOutputs)` (orchestrator.ts:8932) WITHOUT
  `writeInstrumentedProject`, so no selector, install/upgrade codeunits or guards;
  `compiler.compileProject` (artifact.ts:186), same package cache and /define, no
  `stageForCompile` (no Control dependency), no publish; delete the output .app and scratch in
  `finally`. Prep failures (fs, spawn: `ArtifactPrepareError`) propagate unchanged, never via
  `BisectPrepareError`'s note path.
- Ordering: one promise per session in `runSession`, created lazily at the first
  `AlcCompileError` on the SEQUENTIAL deploy path (orchestrator.ts:5728), before
  `bisectAndNote`. It caches both outcomes: success (later failures go straight to bisection)
  and failure (every later awaiter gets the same error, no second compile).
- Scope, stated honestly: sequential path only. Workers are not covered: bcdev, the only
  backend with the method, refuses `workers > 1`, and al-runner has no plain check (its deploy
  copies files, it compiles per test). A future backend with both would need the call at 6213.
- Guarantee (narrower than r1): after the refusal, no bisection and no per-mutant `error` row
  for this batch; the session throws and the run stays unfinished. Rows that may already exist:
  this batch's `known-survivor` rows (5636) and earlier batches' measured verdicts. A later
  refusal does not invalidate them; they stay under resume's existing identity and
  configuration checks. History (`priorSurvivorKeys`) reads finished runs only.

## R462: unchanged from r2
At the refusal (scoreBatch, orchestrator.ts:4443) re-run `testAppHashFor`; compare with
`snapshotKey.testAppHash`.
- CHANGED (both `package:`, different): `TestAppChangedError` (extends Error, `.name` set).
- UNKNOWN (a read null/undefined/throws, `source:` fallback, no pre-hash): `StaleTestAppError`,
  `cause: "identity-unverified"`: may be older OR may have changed.
- EQUAL: `StaleTestAppError`, `cause: "unchanged-endpoints"`; no longer says "never seen", notes
  a replace-and-restore cannot be ruled out; republish "if no other session publishes".
No SessionReport field, event, schema or Caveat moves: all are throws before `buildReport`. CLI
prints `<name>: <message>` on stderr, exit 1 (cli.ts main catch), no JSON report.

## Tests (revert in brackets). Counters `instrumentedCompiles` and `plainCompiles` kept apart.
1. Plain build fails -> UnmutatedBuildFailedError, both streams verbatim; zero `error` rows;
   instrumented 1, plain 1, no bisection. [drop the check -> "not attributable" notes]
2. Plain compiles, selector broken -> bisection as today; staged plain dir has no selector file,
   no Control dependency. [build "plain" with writeInstrumentedProject]
3. stdout error + stderr warning -> both in the message. [restore `stderr || stdout`]
4. Plain prep fails (unwritable scratch) -> that error class, no rows. [wrap in BisectPrepareError]
5. Stale scratch with a leftover generated file -> absent from the plain build. [skip the rm]
6. Two failing batches, plain compiles -> plain counter 1. [no caching]
7. Concurrent awaiters after a plain failure -> plain counter 1, same error. [cache success only]
8. Healthy run -> plain counter 0. [run it up front]
9. Two-run resume: run 1 batch 0 measures, batch 1 refuses; run 2 `--resume` carries batch 0,
   retries batch 1, refuses again, no batch-1 verdict rows. [record batch-1 `error` rows
   before throwing]
10. A later run's `priorSurvivorKeys` excludes the refused run. [finishRun on the refusal path]
11. A->B -> TestAppChangedError. [drop the re-read]
12. A->A -> cause unchanged-endpoints. [always "changed"]
13. A->null, A->throw, source fallback, no pre-hash -> identity-unverified. [map a failed read
    to unchanged, then to changed: both red]
14. Each new class: instanceof Error, not AlcCompileError/StaleTestAppError, exact `.name`;
    CLI stderr shows the name, exit 1. [remove `.name`]

## Changes since r2
1. Parser dropped; `UnmutatedBuildFailedError` states the observed fact, no remedy, no
   "environment" blame.
2. Both alc streams kept verbatim (one line in artifact.ts); no path mapping or fixtures.
3. Worker scope stated as a restriction; narrower guarantee spelled out.
4. Real two-run resume test (9) and a separate history-exclusion test (10).
5. `compilePlainCheck` lifecycle: clear+create scratch, same cache/symbols, no injection or
   publish, output removed, prep failures propagate (tests 4, 5).
6. Promise caches success and failure (6, 7); separate instrumented/plain counters.

## Changes since r3 (sol r3, /coord/reviews/R-461-plan/sol-plan-r3.md: no redesign)
- Wording: `UnmutatedBuildFailedError` says "alc rejected LethAL's staged copy of the unmutated target, using this compiler
  and package cache". This claims neither broken source nor pristine build inputs: staging stamps app.json, flattens paths and
  rebases resources.
- Both streams: the text ripple is accepted and stated. The no-repro / not-attributable / preparation-aborted notes and
  `TestAppError.detail` get longer, and exact-message assertions and snapshots are updated deliberately. Content-addressed keys are
  unchanged (sha of the .app bytes). `parseVersionConflict(messageOf(deployErr))` keeps working on its labelled
  substring, so pin with a test that stdout text alone cannot trigger a version-conflict retry.
- Plain-check cleanup never masks the original failure.
- Tests added:
  - a real `ArtifactCompiler` formatter -> note/wrapper test (not hand-built errors);
  - a plain compiler crash or missing-package rejection pinned as an observed unmutated-build failure, with no source-broken remedy.
