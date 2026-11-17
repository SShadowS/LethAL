# PR-101 pre-commitment (measure only): where al-runner's "tests" time goes, per verdict class

Coord PR-101 (lethal-code, 2026-11-17). PR-100's TIMING on the DO e-document slice (`/coord/handoff/PR-94/pr100/`, 864
mutants, `--workers 1`, c888648f, edge-4ebfe7913): al-runner's `tests` time is 1,749 s of the 1,809 s of serve time (97%).
This task finds out which part of that LethAL can still remove. **No product change.**

## Data
- **The PR-100 slice run** (`/coord/handoff/PR-94/pr100/`): `events.ndjson` (`serve-request-timed`, `mutant-scored`),
  `report.json` (verdict, `coveringTests`, `killingTest`, `killPosition`) and `slice.sqlite`.
- **The baseline's per-test durations** (v3 rows carry `durationMs`), read from the store or from a baseline-only re-run
  (`--time-budget 1`, R955).
- **One small serve drive on the slice's own test codeunits** (local v3, no BC server), with `--timings`. It reads the
  per-entry floor: the same entries with all tests excluded under `runSelectedOnly`, against with their tests. It also reads
  the sidecar lines.
- **t12 and t13 window events,** if they exist when the analysis runs. They are a second sample, not required.

## What is measured, per verdict class (killed / survived / error / no-coverage / timeout-killed)
- **passes** = the mutant's entries (covering codeunits);
- **tests run**, under PR-94's prefix cut;
- **estimated tests seconds**, from the baseline per-test durations. This is checked against the summed `testsMs` of the
  prefetch and live requests: within 10%, or the estimate is reported as unusable and only counts are given;
- **the per-pass floor** (from the drive) x passes.

## The questions, each answered with a number
1. **Does a killed mutant's walk stop at its first failing test?**
   - The tests run after `killPosition` within that entry.
   - The entries of other codeunits run after the killing entry.
   - Both are counted, in seconds.
2. **Are covering codeunits ordered so that kills come early?** From the distribution of `killPosition`, and of the killing
   codeunit's place among the mutant's entries. The seconds a kill-first order would save, from the observed kills.
3. **Survivors.** The unavoidable full walk of every covering test, against avoidable passes: the per-pass floor x passes that
   a merge into fewer entries could save.
4. **The upstream share.** The per-pass floor (#8204) x all passes, in seconds.

## Deliverable
- `/coord/handoff/PR-101/result.md`: the per-class table, and a ranked table of LethAL-side levers in seconds on this slice
  (scaled to a t11-sized window by mutant count, labelled as an estimate), plus the upstream share.
- A comment on aldevtools/BusinessCentral.AL.Runner#8204 with the per-pass numbers only: no project name, no source text.
- Each lever that saves 5% or more of the slice's serve time gets a roadmap item.

## Predictions (pre-committed, so the result can surprise)
- Kills come early: the median `killPosition` is 1.
- Tests after a kill within its entry, and passes after a killing entry, are under 15% of the killed class's tests seconds.
- Survivors (370 of 864) carry most of the tests seconds, over 50%.
- The per-pass floor is under 10% of the tests seconds on this slice. DO's slice may not load a .NET sidecar at all; if
  `--timings` shows none, the #8204 share here is 0 and the comment says so.
