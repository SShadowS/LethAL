# R-272b plan: explain lists a gap's covering tests with file:line, ranked by reach then duration

Base: master `2b80cab7`, worktree `/work/lethal-wt/r272b`. Roadmap R272. No new live cost: both facts
are already measured or parsed in every run; they are only not carried to the report.

## Where each fact comes from (measured, file:symbol)
- **Line.** `discoverTests` (discovery.ts) already parses every test file once per session. The tree
  path (`treeTests`) has the procedure node (`n.startPosition.row + 1`); the regex path
  (`regexTests`) has the offset into the source it holds (count `\n` before it). Both build the
  `TestMethodRef` (with `file`), which flows into `tests-discovered`.
- **Duration.** The baseline runs ONE backend call per test (`scoreBatch` -> `dispatchUnmutated`
  -> `runOnce`), and `TestVerdict.durationMs` is stored per test already (`test_results.duration_ms`)
  and feeds the mutant timeout (`budgetOf`: 2 x baseline). Per backend:
  - bcdev, hub (`runOnHub`) and fenced (`RunMutantTransport.run`): the call's own wall clock, per
    test. Real.
  - al-runner one-shot (`AlRunnerBackend.run`): the call's wall clock, per test, but it INCLUDES the
    per-call compile. Real, and stated as such.
  - al-runner `--server` (`runViaServer`): every test gets `suite.wallMs`, one shared value. NOT a
    per-test measurement: carried as ABSENT, never as that value.
  - A synthetic verdict that did not run (`testPageRefusedVerdict`, duration 0) and any non-`pass`
    outcome: absent (only green baseline tests can cover a mutant anyway).
  The runner's own in-VM per-test figures (BC's `r.durationMs`, al-runner's `durationMs?`) are NOT
  used: today's code deliberately uses wall clock, and two clocks in one field would not compare.

## Design
1. **Discovery:** `TestMethodRef.line?` (1-based line of the `procedure` keyword) set at both
   construction sites. Optional, like `file`; no execution path reads it.
2. **Verdict:** `TestVerdict.durationShared?: true`, set ONLY by al-runner's server path. The
   orchestrator drops the duration where it is set.
3. **Event:** `baseline-batch-finished.verdicts[]` gains optional `durationMs` (only `pass`, run,
   not shared). Optional on the wire, so an older stream folds.
4. **Report: one new optional root field `testMethods`**: `[{ name, file?, line?,
   baselineDurationMs? }]`, one per discovered test, sorted by `compareCodeUnits(name)`.
   `baselineDurationMs` is the SMALLEST measured value across batches (each batch re-runs the
   baseline; the smallest is the least compile/warm-up noise and is itself a measurement), absent
   where no batch measured it. Full ripple: events, report-fold (from `tests-discovered` plus every
   `baseline-batch-finished`), report.ts type/builder, generated schemas, schemas.test, the
   report-equality snapshot. **Samples:** the field is optional, so the committed samples stay valid
   and are NOT regenerated (if schemas.test demands otherwise, stop and report).
5. **Explain: `gaps[].coveringTests?`**, present when the report has `testMethods`:
   `[{ name, file?, line?, reachedMembers?, baselineDurationMs? }]`, the union of the gap's
   SURVIVED members' `coveringTests`. `reachedMembers` = how many of the gap's members list the test
   in `reachedBy`; present only when at least one member has `reachedBy` (a measured reach). Order:
   `reachedMembers` descending (absent counts as unmeasured, after any number), then
   `baselineDurationMs` ascending (absent last), then `compareCodeUnits(name)` (R-481's key). A
   covering test missing from `testMethods` throws (a report inconsistency), never a silent row
   without a location. Every value is verbatim or a count: no judgement, so the admissibility rules
   hold; the leaf pin gains the paths.
6. **Schemas:** report schema regenerated (optional root field, report schema version unchanged by
   the same rule as `sourceSha256`). Explain v13 gains optional `gaps[].coveringTests`: optional
   additive, no bump.
7. **Docs:** agent guide's gap section, CHANGELOG, R272 done.

## Tests (each red in its own direction)
- discovery: `line` on both paths, a CRLF file and a test after a multi-line attribute (red: off by
  one, or the attribute's line).
- al-runner server verdicts carry `durationShared`, one-shot verdicts do not (red: either).
- the event carries durations only for run, passing, unshared tests (red: shared value carried; a
  TestPage refusal's 0 carried).
- fold: smallest across two batches (red: last or first).
- explain: ranking by reachedMembers, then duration (absent last), then compareCodeUnits; a test
  missing from testMethods throws; a report without testMethods gives no coveringTests and the gap
  is otherwise unchanged (red: emits `[]`).
- end to end through `runSession` with a fake backend that returns distinct durations: the report's
  `testMethods` and explain's order.

## Changes since r1 (review r1, opus spec-adversary; `/coord/handoff/R-272b/review-r1.md`). OVERRIDE.
- **B1, durations only from THIS session's measurements.** A `--resume` reuses the baseline snapshot
  (R192), whose verdicts may hold al-runner `--server`'s shared `suite.wallMs` from before this
  change. The event carries `durationMs` only for verdicts `dispatchUnmutated` ran in this session;
  a reused batch carries none.
- **B2, `testMethods` keyed by qualified name.** On bcdev without compiled evidence, both `#if`
  arms of a test (or two arms declaring the same codeunit) are discovered under one name. One row
  per name; `line` present only when every discovered ref of that name agrees (else absent, and a
  `lineAmbiguous: true` flag), so a reader is never sent to a compiled-out arm. Test: `#if/#else`
  same-name pair.
- **Durations, sources:** al-runner uses its OWN per-test `durationMs` (`ServerTestLine.durationMs`,
  `AlRunnerRawTest.durationMs`), on both transports, which leaves the compile out and replaces the
  `durationShared` special case; bcdev keeps the per-call wall clock (fenced RunMutant has no
  per-test in-BC figure). Excluded: reused verdicts (B1), a recovered reply (`replyRecovered`,
  whose duration is time-to-declared-lost), synthetic/non-run, non-pass. `budgetOf` and
  `recordTestResult` are untouched (they keep today's values).
- **Regex-path line** from a capture group with the `d` flag on `procedure`, never `lastIndexOf`.
- **`reachedMembers` with its denominator:** the gap also carries `reachMeasuredMembers` (members
  with `reachedBy`); `reachedMembers` is absent when that is 0.
- **`assertExplainableReport` validates `testMethods`** (types, unique names), loudly.
- **Doc:** absent `coveringTests` means "the report has no `testMethods`", never "no covering
  tests"; the order is a stated heuristic, not a measurement; on object/all-green/none coverage a
  gap's list can be the whole suite.
- **B3, OPEN: duration as a ranking key.** R197 already tried baseline duration as a test-order key
  and the tables gate refused it (ten `killingTest` values differed between two consecutive runs:
  durations are not stable run to run), and the hub's wall clock is mostly call overhead (seconds
  vs tens of ms of test body), with a first-test bias (the hub's first call pays the MCP spawn;
  probably the first al-runner call per batch pays a compile). Options:
  (a) carry `baselineDurationMs` as a displayed value and order by reach, then `compareCodeUnits`
      name, filing a roadmap item to make duration a key once measured stable (RECOMMENDED: lands
      everything measurable now, invents no ordering);
  (b) measure first: rank stability and first-test bias from two runs' `test_results.duration_ms`
      (needs two live runs of one fixture), then decide.

## Open questions for the reviewer (answered in r1: Q1 smallest, this session only; Q2 count with
denominator; Q3 one-shot wall clock unfit, use al-runner's own figure)
Q1. Smallest across batches vs first batch vs per-batch list?
Q2. Rank on `reachedMembers` (a count over the gap's members) or on a per-test reached/not flag?
Q3. Anything that makes the al-runner one-shot wall clock (compile included) unfit to rank by?
