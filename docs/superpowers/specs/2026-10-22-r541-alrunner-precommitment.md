# R-541 (roadmap R541): pre-commitment for itest:alrunner and itest:alrunner-v3 on the R-541 head (2026-10-22)

Written BEFORE the build and before any live run, from the plan (`/coord/handoff/R-541/plan.md`, plus its r1 from the
deep review) and the measurement (`/coord/handoff/R-541/measure.md`). Any difference is a BLOCK, recorded and not
reinterpreted.

## What changes in the product (al-runner v2 only)
- **The empty folder.** Every v2 al-runner call that runs tests passes `--expectations <a LethAL-owned empty
  folder>`: the one-shot argv, the `--server` daemon start, the probes and the contract canary. The folder is created
  fresh, checked empty on every use, and the session stops if it is not.
- **The new wording.** A row whose message starts exactly with `Unexpected out-of-scope: ` is never a kill. It is
  `runner-refused` when the wrapped original is a runner refusal, and `runner-test-error` otherwise.
- **The backstop.** A one-shot row carrying a non-null `expectation` scores `runner-test-error`.
- **The daemon checks.** The v2 daemon-reuse check and R557's clean-answer check treat such a row as they treated it
  before.
- **v3 is untouched:** no `al-runner-v3-*` file changes, and the v3 `serve` argv stays byte-identical.

## itest:alrunner (v2): every baseline unchanged, per mutant
No fixture has a `tests/expectations` folder above it, no baseline contains `out-of-scope`, and no fixture test
reaches a refusal. So the empty manifest changes no row.

| leg | expected (unchanged) |
|---|---|
| one-shot | 3 / 12 / 4 |
| cli-default | 3 / 12 / 4 |
| LETHALA | 5 / 4 |
| LETHALB | 5 / 4 |
| layout | 7 / 3 |
| multiobject | 6 / 1 / 5 |
| wrapped | 58 / 37 / 3 |
| names | 36 |

- Every leg's per-mutant verdicts equal its committed baseline.
- The cli-default leg's mechanism checks pass with the exact argv: the process's own empty folder, given once.
- stderr gains one `[expectations] loaded 0 entries` line, which no check reads.

## itest:alrunner-v3: unchanged
Leg T is 290 / 57 / 59 over 406, unchanged per mutant. It runs because `verdictFromRunnerTest` is shared.

## How the run is judged
- The gates run one at a time on the final R-541 head, under the container's heavy-job limit.
- The first line of each gate names the al-runner build it ran; it is read before any figure.
- Any moved figure, any differing verdict, or any new mechanism failure is a BLOCK.
