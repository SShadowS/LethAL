# R-984 DO window t5 pre-commitment: L1 + L2 + L4 + L5 + R1043 together

Lane lethal-bugs, 2026-11-15, committed before the window starts. Head: master 50de4829 or later (L1 and R1043 via
lethal/pr-18b, L2 PR-24 d395ac3f, L4 PR-20 6ad3bace, L5 PR-21 ea551c6b). PR-29 (the stale-buffer keep, R1009) is not in it
unless it lands before the start; if it does, the head is named in `/coord/handoff/R-984/run.log` and prediction 3 counts that
family as kept too. Config as t1-t4: `/coord/handoff/R-984/v3.do-serve.json` (edge-847b1fa5a), `--resume dos3.sqlite`,
`--time-budget 12600` under `timeout --foreground -k 900 15300`, triage first (R-994).

Reference: t4 (`/coord/handoff/R-984/result.md`): baseline 1,591 s; mutant phase 10,932 s for 893 new covered mutants (12.2 s
each); 87 daemons, 83 warm-ups (7,322 s); 63 closes by the DataCaption caption refusal (now kept, R1043).

## Predictions

1. **Verdicts (BLOCK line):** every mutant this window scores that t1, t2b, t3 or t4 also scored has the same verdict and
   killing test (0 differ). Any difference is a BLOCK.
2. **Baseline (L5):** the run prints `resume-baseline-reused` and the baseline phase takes at most 300 s (t4: 1,591 s). A named
   fallback to a full baseline counts as a miss of this prediction, not a BLOCK.
3. **Closes (L1, R1043):** 0 daemon closes in the mutant phase by the caption family, ZipArchive.Dispose or FormatRegion; at most
   25 refusal closes in the mutant phase in all (t4: 81).
4. **Warm-ups (L2 + fewer closes):** warm-up wall at most 1,800 s (t4: 7,322 s).
5. **Rate:** mutant-phase wall per new covered mutant at most 7 s (t4: 12.2 s); so at least 1,600 new covered mutants unless
   the covered mutants run out first. L4's line: widened 0, order broken 0.
