# PR-466 (b) (R1228): the per-test SELF-REFERENCED ratio — pre-commitment (evaluated later, on new data only)

lethal-code, 2026-11-27. Pre-committed BEFORE any computation of this form on any store. The orchestrator ruled that it
is evaluated only on runs recorded from 2026-11-27 on. Part 1's stores are spent.

## Why

- Part 1's ratio (a passing row against the same test's BASELINE) separated by only 10% at STOP: the healthy max
  block was 3.64 against 4.0. Two reasons:
  - test-mix plateaus: a block is a handful of tests whose mutant runs are systematically about 3× their baseline;
  - a cold baseline: healthy ratios are typically 0.3-0.9.
- Comparing each test with ITSELF earlier in the same chain should cancel both.

## The form

- **The rows:** passing mutant rows with an own duration, as part 2 uses.
- **The reference** for a row of test t is the median own duration of t's FIRST k = 5 passing mutant rows in the run
  chain (this run, plus, on a resume, the prior run's rows, one level).
  - A row of t before t has 5 earlier rows does not feed (counted).
  - A reference below 50 ms does not feed (counted).
- r = own duration / reference. Blocks of 50 in recording order, no overlap.
- **STOP_b:** 3 consecutive blocks with medians ≥ 3.0.

## The data, labelled before computing

- **Degraded:** a run, or a span of one, that lethal-bugs (or a doctor/timing probe) names as degraded with an onset
  time, from evidence other than this ratio.
- **Healthy:**
  - bcdev gate runs and probe runs of ≤ 3 h recorded from 2026-11-27 on, whose stores are kept (the lanes are asked to
    keep them);
  - plus the first 2 h of every new long run before any named onset.
- **Unlabelled:** everything else, reported.
- The list is fixed in the output before any ratio is read.

## Rule: (b) replaces (a) in a later task only if ALL hold, on the same new data

1. No healthy run reaches STOP_b.
2. **(b)'s margin is larger than (a)'s:**
   - (3.0 / (b)'s healthy max block) > (4.0 / (a)'s healthy max block), both computed on the same healthy runs;
   - and (b)'s healthy max block ≤ 2.0.
3. **Every degraded run that (a) stops, (b) stops too,** and no more than 30 min later. Each degraded run's stop time
   is set against its named onset.
4. At least 2 degraded runs and 10 healthy runs are in the data. Below that: "not enough data", and both forms are
   reported.

- If any rule fails, (a) stays. The thresholds are NOT tuned on that data.
