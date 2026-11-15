# R-984 DO window t6 pre-commitment: t5's head + PR-29 (stale buffer) + PR-37 (R1050)

Lane lethal-bugs, 2026-11-15, committed before the window starts. Head: master dfa4be2a or later (contains e63fb976: PR-29 and
PR-37), named in `/coord/handoff/R-984/run.log`. Config as t1-t5: `/coord/handoff/R-984/v3.do-serve.json` (edge-847b1fa5a),
`--resume dos3.sqlite`, `--time-budget 12600` under `timeout --foreground -k 900 15300`, triage first (R-994), run.sh's watchdog
with t5's headroom fix (inactive file cache counted as free).

## Basis: t5, honestly (`/coord/handoff/R-984/result.md`; pre-commitment 2026-11-15-r984-t5-window-precommitment.md)

t5 (b0fcb731) held its BLOCK line (0 differ vs t1/t2b/t3/t4) and its zero-close line for the caption, ZipArchive.Dispose and
FormatRegion families, and L4's line. It missed the other four:
- baseline 1,998 s against <= 300 s: L5 did not reuse, because run 4's snapshot predated PR-21 (named by LethAL);
- 44 refusal closes plus 19 timeouts against <= 25 refusal closes: the families left after L1/R1043 are many and small;
- warm-up wall 3,352 s against <= 1,800 s: L2 cut a warm-up to ~32 s (t4 ~88 s), but there were 105 of them;
- 8.3 s per new covered mutant against <= 7 s (1,261 new, t4: 893 at 12.2 s).

## What changes in t6, measured before the window

A `--dry-run` of DO at b0fcb731 and at dfa4be2a (`/coord/handoff/R-984/t6prep/dry-*.txt`): PR-37 removes 57 deployed mutants
(43,583 -> 43,526; 45,086 -> 45,029 sites), the new hang refusals of R1050. So t6's instrumented tree differs from t5's,
`snapshotApplies` (batch hash) is false, and **L5 cannot reuse t5's baseline in t6**. L5's first real measurement moves to the
first window whose head does not change DO's mutation set again (t7 if nothing lands in between). PR-29 changes no instrumentation.

## Predictions

1. **Verdicts (BLOCK line):** every mutant t6 scores that t1, t2b, t3, t4 or t5 also scored has the same verdict and killing test
   (0 differ). Mutants PR-37 removed are absent, not different. Any difference is a BLOCK.
2. **Mutation set:** the run deploys 43,526 mutants (the dry run's figure).
3. **Baseline:** not reused, and LethAL names why (`resume-baseline-not-reused`, the batch differs). Baseline 1,600-2,400 s.
4. **Closes in the mutant phase:** 0 by the stale-buffer family (R1009, PR-29's first figure; t1 had 7), 0 by caption,
   ZipArchive.Dispose and FormatRegion. Refusal closes <= 55 (t5: 44); timeout closes are not predicted (t5: 19, under study).
5. **Warm-ups:** about 32 s each (25-45 s); warm-up wall <= 4,500 s.
6. **Rate:** 7-10 s per new covered mutant over the mutant phase (t5: 8.3 s), 1,000-1,600 new covered mutants. L4's line:
   widened 0, order broken 0.
