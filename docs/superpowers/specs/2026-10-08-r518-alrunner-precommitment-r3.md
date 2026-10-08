# R-518 pre-commitment r3: the evidence run (Part B) re-stated after a BLOCKED run

Written 2026-10-08 BEFORE the re-run. It amends Part B of
`docs/superpowers/specs/2026-10-08-r518-alrunner-precommitment.md` (r2, 03f47631) and nothing else.
Part A (itest:alrunner) stands as written in r2.

## Run 1 of Part B: BLOCKED (recorded, not re-read)

- **When and where:** 2026-10-08, local, al-runner `v2.12.0-main.43f76177`, branch lethal/r518 with
  master a46a697a merged. No BC, no lease.
- **Log:** `/coord/handoff/R-518/live-partA-partB.log`.
- **Why BLOCKED:** r2 said, under "For each of the five", "exactly ONE unmutated cold confirm ... so 5
  cold confirms in all". The script counted cold confirms across the whole session and found **29**.
  The orchestrator cold-confirms EVERY position-1 kill, not only timeouts, and on al-runner one-shot
  every kill is at position 1. So 29 = 24 ordinary position-1 kills + the 5 hangs, each confirmed
  exactly once. The check as committed failed; under the rule that a pre-committed check is never
  re-read after the data, the run is a BLOCK.
- **The final build review predicted this failure before the log was read**
  (`/coord/handoff/R-518/review-final-opus-build.md`, I1).

Run 1's other results are kept as supporting evidence:

- **The session:** it COMPLETED in 610 s, with no abort, `baselineGreen` true, `groupedCalls` 0,
  `warmKills` 0, 5 `timeout-killed`, 0 `timeout-unconfirmed` and 0 `error` verdicts.
- **The five hangs** (lines 37, 43, 44, 73, 145): each was `timeout-killed` at killPosition 1. Each
  timeout row matched `RUNNER_TIMEOUT_MESSAGE`, with a reported stop of 32 000 ms (lines 37, 43, 44)
  or 20 000 ms (lines 73, 145), both at least 20 000. Each had exactly 1 mutated spawn of the hung
  test, and the next spawn was exactly one unmutated confirm of the killing test.
- **The other 33 rows** (observations): all 38 verdicts equal `hang.itest.ts` `EXPECTED_ON`
  (24 killed / 9 survived / 5 timeout-killed), so no finding was filed.

## Part B, re-stated (r3)

Run exactly as r2 describes (`scripts/r518-probe/run.ts`, local, no config read, one-shot, static
selector, `mutantTimeoutMs` 20 000, `countingSpawn`). The script prints "R518 probe r3" first.

### The five structural hangs (unchanged from r2)

| line | operator | verdict | killPosition |
|---|---|---|---|
| 37 | `lethal.void-method-call` | `timeout-killed` | 1 |
| 43 | `lethal.empty-block` | `timeout-killed` | 1 |
| 44 | `lethal.remove-assignment` | `timeout-killed` | 1 |
| 73 | `lethal.remove-assignment` | `timeout-killed` | 1 |
| 145 | `lethal.void-method-call` | `timeout-killed` | 1 |

For each of the five:

- its killing test's mutated row has outcome `timeout`;
- its message matches `RUNNER_TIMEOUT_MESSAGE`;
- `parseReportedStopMs(message) >= 20000`;
- exactly ONE mutated spawn of the hung test for that mutant;
- the next spawn is exactly ONE unmutated cold confirm of the killing test.

### The confirm counts (r3, both pre-committed)

- (a) **Exactly one cold confirm directly after each of the 5 hang mutants' mutated spawns: 5 in
  all.**
- (b) **The session-wide count of cold confirms is exactly 29.** It counts every unmutated spawn that
  directly follows a mutated spawn of the same test: 24 ordinary position-1 kills plus the 5 hangs,
  each confirmed once.

### The session (unchanged from r2)

It COMPLETES (no rejection, no session abort), with `baselineGreen` true, `groupedCalls` 0,
`warmKills` 0, exactly 5 `timeout-killed` and zero `timeout-unconfirmed`.

**Any of these failing blocks R518's close.**

### The other 33 rows

These are now pre-committed too, because run 1 measured them. All 38 verdicts equal `hang.itest.ts`
`EXPECTED_ON`: 24 killed / 9 survived / 5 timeout-killed, per mutant. A non-hang difference is a
FINDING to file as a roadmap item. It does not block R518. That is unchanged from r2: those rows test
al-runner semantics, not R518.
