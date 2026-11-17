# PR-123 pre-commitment: batch the L5 re-check of a reused baseline (PR-121 part b)

Coord PR-123 (lethal-code, 2026-11-17).
- **Lever:** [[R1092]]'s PR-120 refresh, item 2. A resumed window re-checks its reused baseline with one plain request per
  codeunit (`recheckReusedBaseline`, PR-21 L5), never batched. In t14 that took 200.1 s.
- **Base:** PR-115's baseline batching (`batchRequest`, `decodeBatchAnswer`, `planBaselineBatches`) and PR-117's own-record switch
  (`batchingOn`).
- **Folded in:** spec-adversary r1 (no false verdict found; M1-M4 and L5-L7).

## Today
For each codeunit, in stored order, the re-check does this:
1. checks the budget, the memory gate and the bound;
2. sends one `baselineRequest`, with coverage only for the 3 sampled codeunits (the 2nd, the middle and the last);
3. checks the signal, and that the answer is usable;
4. checks `hasEveryRow`;
5. compares the rows (masked) with the stored rows;
6. on a sample, compares each passing test's coverage map with the stored one, and requires at least one compare.

Any failure returns the reason, and the caller runs the baseline as today (`resume-baseline-not-reused`). On success it imports
the fresh rows.

## The change
1. **When batching is on,** fetch the answers in batches:
   - batching is on when `batchingOn(coverage)` holds, where `coverage` is the SAME value the session's fill would get (L6;
     the fill batches only with coverage);
   - the batches come from `planBaselineBatches` over the stored ids sorted ASCENDING (L5, as the fill plans), with the same
     source scan and `suiteIds` (a suite codeunit with no stored rows is excluded through it);
   - each batch is ONE `batchRequest`, with ONE memory hold, the bound check and the budget check before it, and the signal check
     after it. A signal after a batch returns the signal reason, and no answer of that batch is compared.
2. **Checks 4 to 6 then run on every codeunit's answer, unchanged, in STORED order.** A batched answer carries per-test
   coverage, so a sample's compare reads it through `coverageOf`, exactly as today.
3. **A batch the decode discards, or a failed batch request,** does three things. It latches batching off (`baselineBatchingSpent`,
   with the reason prefixed `the re-check: `, M4) and counts a discard. Each codeunit of that batch, and every one after it, is
   then sent singly, exactly as today (coverage for samples only). Nothing of the discarded answer is used. The re-check does
   the latch and the count itself, because `batchRequest` does not (the fill's `send` does). A source-scan failure latches the
   same way.
4. **Its own stats line** (M1), printed when the re-check ends:
   `[lethal] al-runner-v3 re-check batching (PR-123): N batch(es) kept, M discarded or failed` or `off (<reason>)`. The fill's
   line is unchanged. On reuse no fill runs, and on not-reused the fill resets its own counts.
5. **Batching off:** the code path is today's, call for call.

## What can differ, and why no verdict can (corrected, review THE question)
The reuse decision CAN differ, in two narrow cases:
- **The budget runs out during the last batch.** Batched, the whole batch was fetched, compares and is reused. Unbatched, the
  rest would have returned "the time budget". Every row was fully obtained, so this is harmless (the fill already does this).
- **A batched row differs from a single-request row** for a codeunit that no sample covers, when the stored rows came from a
  batched fill. Batched compares like with like and reuses; unbatched refuses. The not-reused path's fill would batch the same
  way and give the same row. Behind both, the mutant phase's warm-up compares its NONE rows with the imported rows and fails
  loudly on a difference (`judgeWarmup`, `al-runner-v3-entries-warmup-disagrees`).

So the verdicts equal what a re-run, batched fill gives. Every other path either uses a batched row that the decode accepted
and checks 4 to 6 passed, or runs today's code.

## Predictions (pre-committed)
1. **Unit tests, each red when its rule is reverted:**
   - the same fake answers give the same outcome batched and unbatched:
     - one stored row differs: not reused;
     - all equal: reused;
     - a sample's coverage differs: not reused;
   - batching on: exactly ONE memory-gate hold and ONE `checkBound` per batch (counted); batching off: one per codeunit;
   - **a discarded batch, in the dangerous direction:** the discarded batch's rows MATCH the stored rows, while the single rows
     DIFFER. The outcome is not reused, the re-sends ask for coverage only for samples, and batching is latched off with a
     `the re-check: ` reason;
   - a failed batch request: latched, a discard counted, singles sent;
   - a signal after a batch: the signal reason, and no compare;
   - the budget is checked before each batch;
   - an OnRun codeunit goes singly;
   - a suite codeunit with no stored rows is in every batch's `excludeTests`;
   - batches are planned over ascending ids, and the checks run in stored order;
   - the stats line, both ways;
   - after a batched reuse, a warm-up NONE row that differs from an imported row throws by name.
2. **`itest:alrunner-v3`** passes unchanged. `itest:chunked` does not run this path (bcdev).
3. **A DO resumed slice** (`/coord/handoff/PR-123/resume.sh`: PR-94's e-document slice, `--workers 1`, `--time-budget 900`):
   - **Measured before this commitment, on master:** `setup/` (a fresh run that stores the snapshot) and `before/` (a resume
     with today's unbatched re-check). Their figures are added to this section in a dated note before the after arm runs.
   - **The after arm** (`after/`) is a resume of a copy of the same setup store, on the fix. Predicted:
     - `resume-baseline-reused` in both `before/` and `after/`;
     - the after arm's re-check stats line counts ≥ 1 batch kept and 0 discarded;
     - the re-check (the baseline phase) falls by at least 40% from `before/`'s;
     - `report-diff --by-line --subset` over the mutants both arms scored: 0 differences (verdict and `killingTest`).
   - **If the setup run's own PR-115 line shows a discard,** the slice cannot show batching, and the 40% is reported, not judged.
4. **The next resumed DO window** (bugs): the re-check falls from t14's 200.1 s. It is reported there, not judged here.
