# R1008 (coord R-999): a serve run resumed — pre-commitment

Written and committed before any run below. Project: Service Declaration from BC.History (`/coord/handoff/R-975/sweep-src/sd`, tests
`/coord/handoff/R-882/src/sd-test`, config `/coord/handoff/R-975/sweep/v3.1.json`), `--only src/Processing/GetServiceDeclarationLines.Codeunit.al`,
al-runner `current` (read and named at the run), LethAL branch `lethal/r999` at the commit that holds this file. Default transport (serve-entries);
every run in its own fresh store under `/coord/handoff/R-999/`.

**Runs.**
- A: one uninterrupted run.
- B1: the same command with `--time-budget` set so the run stops in the mutant phase (chosen from A's baseline time).
- B2: the same command as B1 with `--resume` (store of B1) and no budget, so it finishes.

**Predictions.**
1. B1 stops on its budget (exit 7) with some mutants scored and some not.
2. B2 finds B1's run (no "found no unfinished run" refusal), prints no `al-runner-v3-serve-default-fallback` warning, runs its baseline
   (no `resume-baseline-reused` warning), and finishes (exit 0, or 7 only if it is not finished).
3. B2's report equals A's per mutant by `bun scripts/report-diff.ts` (IDENTICAL: verdict and killing test per mutant). A difference
   is a finding to explain before submit, never "close enough".

**Before this fix** (master 4b756f79), B2 stops at once: one-shot by the resume reason, then "found no unfinished run" (R1008).
