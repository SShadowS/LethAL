# R1015 pre-commitment (coord PR-08): R954's mutant stop from each green test's OWN time

Committed before any code change, gate run or DO window, 2026-11-15. Evidence: `/coord/handoff/PR-08/` (`measure.ts`,
`corpus.ts` and their `.out.txt`). Names and counts only.

## The finding

R954's stop is meant as `max(60 s, 20 x the largest GREEN baseline TEST + 5 s)`. al-runner's `--test-timeout` stops each
test by its own time. But `applyV3MutantStop` reads `baselineDuration`, each green test's `durationMs`, which on v3 is the
CALL's wall clock (R963: the codeunit's whole run on serve, or a whole daemon request; never the test's own time).

So on DO the "largest test" is 87.8 s of call time, while DO's slowest green test takes 1.3 s of its own time
(`own_duration_ms`). Every test therefore gets a 1,762 s stop, and each hang costs that. R-998's window had 4 hangs
(`serve-daemon-closed` reason `timeout`), about 2 h. R-984 t1 had none.

## What changes

`applyV3MutantStop` reads `measuredDuration`, R914's map of each green test's own time (`measuredDurationMs`, falling
back to `durationMs` where no own time was measured, the safe direction). The stop's rule, floor, factor and pad are
unchanged, and so is the per-mutant call budget (`budgetOf`: `max(2 x the call's baseline durationMs, floor)`). The
stderr line names the largest green test's own time.

## Evidence that no verdict moves

`corpus.ts` read every v3 run under `/coord/handoff` whose mutant test rows carry an own time: 303 runs, 289,273 test
rows under a mutant.
- For each run it compares today's stop (from the largest green call) with the stop from own times.
- A verdict can move only for a row whose own time is over the own-time stop and inside today's stop.
- Of 289,273 rows, 6 are in that range, and all 6 are already `timeout` rows (R-958 saft M1263, R-975 email M1896,
  PR-05 triage M0036). **0 verdicts move.**
- The slowest own time under a mutant is 243.7 s (R-947 password, a timeout today too).

DO (`measure.ts`): the slowest own time under a mutant is 3.1 s (t1) and 2.6 s (R-998 window). No row is near 60 s.

## Predictions

- `itest:alrunner-v3` on `current` passes every leg, and no pinned verdict, killing test or figure moves.
  - The sessions whose stop was above 60 s (legs D1 and D1c: 129.06 s and 81.8 s, from whole-call times of 6.2 s and
    3.8 s) get the stop from their largest own time, at least 60 s.
  - Every other session's stop is 60 s today and stays 60 s.
- On DO (R-984's config), the printed stop is 60 s instead of 1,761.82 s, so one hang costs about 60 s instead of
  about 29 min.
- Unit tests that pin a stop from `durationMs` move to the own time. Where a fake gives no own time, the fallback keeps
  today's value.
