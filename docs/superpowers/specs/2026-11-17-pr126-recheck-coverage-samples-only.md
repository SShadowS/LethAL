# PR-126 pre-commitment: the batched L5 re-check asks for coverage only on its samples

Coord PR-126 (lethal-code, 2026-11-17), PR-123's follow-up. Spec-adversary r1 is folded in (M1-M3, L1-L4; no false kill and no
wrong reuse found).
- **The problem:** PR-123 batched the re-check (`recheckReusedBaseline`). On PR-94's resumed DO slice it went from 81.7 to 55.2 s
  and missed its ≤ 49.0 s bar.
  - Every batch asks for coverage on every codeunit (coverageMs 1.1 → 8.8 s, baselineMs 2.2 → 6.1 s).
  - The re-check reads coverage only on its 3 samples (the 2nd, the middle and the last stored codeunit).

## The change (the re-check only; the fill is untouched)
1. **The 3 samples leave the batch plan and go singly, WITH coverage.** That is exactly the pre-PR-123 request
   (`baselineRequest(..., coverage: true)`), and its compare is unchanged. The coverage the re-check relies on comes only from
   the samples' own single requests. `exclusionsFor` puts the samples into every batch's `excludeTests`.
2. **The non-sample codeunits are batched WITHOUT coverage.**
   - **The body (L2):** the no-coverage body LEAVES OUT `coverage` and `perTestCoverage`, as `plainInFlight` does for a request
     without coverage. The fill's body (both `true`) is unchanged, and so is the forbidden-field set.
   - **The decode** gains a no-coverage mode, used only by these batches:
     - steps 2-4 (out-of-batch row, duplicate name, an R612 row) and the per-codeunit `hasEveryRow` slice run unchanged;
     - step 5 (coverage present, a coverage entry for a test that is no row, two entries for one test) is skipped;
     - each codeunit's answer carries `coverage: { kind: "unavailable", why: "PR-126 re-check rows only" }` and
       `withCoverage: false` (L1). `batchRequest` today hard-codes `true`; it now passes the mode through.
   - **Non-sample answers are compared on rows only, as today.** No later reader needs coverage on them (review Q4: the
     re-check, `noteBaselineRows` and its consumers, and `judgeWarmup` all read rows).
3. **Everything else is as in PR-123:** the plan over ascending ids, the checks in stored order, one hold and one bound check per
   batch, the budget before it and the signal after it, the latch with its `the re-check: ` prefix and the fallback to singles,
   and the stats line.

## Why a no-coverage batch cannot make a wrong reuse (corrected, review M2)
- **What step 5 caught:**
  - (a) coverage missing: not applicable with coverage off;
  - (b) two entries for one test: a duplicate run also streams a second row, which step 3 catches;
  - (c) an entry for a test that is no row: a HIDDEN run of an excluded codeunit.
- **The danger of (c) is not only "rows that differ".** A hidden run could leave state that makes a failing test PASS, so the rows
  equal the stored ones and the baseline is wrongly reused.
- **What rules that out is that no state crosses test codeunits within one request:** leg C's four facts
  `batch-no-cross-singleinstance`, `batch-no-cross-library-global`, `batch-no-cross-row` and `batch-no-cross-subscriber`, plus
  `batch-onrun-excluded-no-carry`. PR-24's carry probe covers state across requests. PR-115's probe showed that an excluded
  codeunit does not run (`hidden.txt`).
- **These facts are now the ONLY guard against (c) in a no-coverage batch.** Leg C already fails the update gate when any of them
  flips, and since PR-117 batching needs the build's own record of all 8.

## Predictions (pre-committed)
1. **Unit tests, each red when its rule is reverted:**
   - **The fixture (M1):** a rig with at least 2 non-sample codeunits per batch (for example 7 codeunits at batch size 2). Each
     test asserts that at least one batch was sent.
   - **The PR-123 tests whose fixture or expectations change are named here:**
     - the whole `PR-123: the batched re-check` block moves to the larger fixture;
     - "a discarded batch whose rows MATCH the stored ones" is re-triggered by a step 3 fault (a duplicate name), since a ghost
       coverage entry no longer discards a no-coverage batch.
   - the samples are sent singly with `coverage: true`, never inside a batch, and each sample's `Codeunit<id>.` is in every
     batch's `excludeTests`;
   - a non-sample batch's body has neither `coverage` nor `perTestCoverage`, while the fill's body is unchanged (both `true`);
   - the no-coverage decode still discards an out-of-batch row, a duplicate name and an R612 row, and still slices per codeunit;
     it does not discard for missing coverage; its answers carry `withCoverage: false`;
   - **the fill's step 5 still holds at backend level (L3):** a ghost per-test entry in a FILL batch is discarded. Red-checked
     by forcing the no-coverage mode on the fill;
   - the same fake answers give the same outcome as PR-123's batched re-check, both ways (one row differs; all equal);
   - **regression guard (L4):** a sample's coverage difference is still caught (not reused), using PR-123's real coverage-index
     rig. Red-checked by removing the sample compare.
2. **`itest:alrunner-v3`** passes unchanged. It never runs `recheckReusedBaseline` (the resume legs are `itest:lend`'s, on
   bcdev), so it guards only the untouched fill.
3. **The DO resumed slice** (`/coord/handoff/PR-123/resume.sh`, a copy of PR-123's `setup/` store, `--workers 1`,
   `--time-budget 900`; arm `after126/` on the fix):
   - `resume-baseline-reused`;
   - the re-check stats line shows ≥ 1 batch kept and 0 discarded;
   - **the baseline phase ≤ 49.0 s** (the task's bar);
   - `report-diff --by-line --subset` against PR-123's `before/`: 0 differences.
   - **The stated risk (M3):** the review estimates ~45.4 s. The ~4.0 s of `baselineMs` saving assumes a no-coverage batch WITH
     `excludeTests` takes the kept install baseline (`baselineSource: "kept"`). That has never been measured, since every
     no-coverage request so far had no `excludeTests`. If the exclusion list is part of v3's cache key, the estimate is ~49.4 s.
     Batch walls also vary about 10% run to run. The after arm reports each batch's `baselineSource`, so a miss names its cause.
