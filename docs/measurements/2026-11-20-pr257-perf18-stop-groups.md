# PERF-18: per-mutant stop groups on DO's multi-mutant request layout (coord PR-257, 2026-11-20)

lethal-preproc, for the alrunner tentacle and PR-256 (R1146). Numbers and names only. Raw serve requests, no LethAL run;
driver, outputs and scoring: `/coord/handoff/PR-257/` (`drive257.ts`, `before.ndjson`, `after.ndjson`, `score257.py`,
`score257.txt`).

## What ran
- **Before:** upstream main 9835579c6 (`al-runner 3.0.0-alpha.14+main.20261120`, lethal-bugs' PR-255 build), no stop field.
- **After:** perf-18-stop-groups 55054f8bb (built here), `stopAfterFirstFailure: true`, each mutant's codeunit entry
  `stopGroup` = the mutant id, and each echo entry its OWN group (`<mutant>|echo`).
- **Sample:** PR-223's 90 DO mutants (each covered by one all-green codeunit of at most 25 tests; y2: 39 killed, 51
  survived), 5 mutants per request, 18 requests per variant.
- **LethAL's real layout:** each mutant a group `[echo, its codeunit]`; the echo (`LethAL Selector Echo`) FAILS on purpose
  (it reports what it read), and carries the mutant's resources.
- One serve daemon per variant; PR-223's build and flags (the full instrumented DO build, packages, BC 28.4, saas,
  license, edge-4ebfe7913's sidecar, `--test-timeout 60`, `testIsolation` test); pinned to CPUs 12-21, heavy slot `--peak 6`;
  durations on the monotonic clock; wall-minus-monotonic drift 0.0 s in both runs (no suspend).

## Verdicts (first): 0 moved
- Before and after: **39 killed, 51 survived**; each equal to y2 for all 90 mutants. **Moved: 0.**

## The stop's rows (after)
- 79 rows `notRun` (`NotRun: out-of-scope: the test … failed before it, and stopAfterFirstFailure … runs no test …`),
  ALL inside killed mutants' own groups: 37 stopped entries, every one passing PR-256's acceptance rule (the named failure
  is a test of the entry's own codeunit, and every row before it is real).
- **No stop triggered by an echo, none crossing into another mutant's group, none on a survivor.** The echo's planned failure
  stops only its own group, as alrunner designed.

## Speed (warm requests: the first, which holds the daemon's cold compile, excluded)
| variant | warm requests | wall | tests | setup | rows | notRun |
|---|---|---|---|---|---|---|
| before | 17 | 69.4 s | 42.4 s | 25.7 s | 569 | 0 |
| after | 17 | 64.1 s | 37.1 s | 25.8 s | 569 | 79 |
- **After vs before: wall −7.6%, tests −12.5%.** PR-223 (the fork's per-group stop, no echo entries) saw −23% and −20% on
  the same mutants: the same 79 rows are skipped, but LethAL's echo entries add test time to every request, so the same
  saving is a smaller share. The saving is a lower bound for DO overall (57.5% of y2's killed mutants have larger covering
  sets; PR-223).

## So
- Per-mutant stop groups with the echo in its own group are verdict-neutral on this sample and stop exactly where PR-256's
  acceptance rule allows. PR-256's held build can proceed on a `stopGroup` build, prefetch included.
