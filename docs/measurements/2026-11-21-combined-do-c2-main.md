# The combined DO run c2 (2026-11-21): LethAL's levers at 5 lanes on main-ccd0f823d, against perf10c

lethal-preproc. Pre-commitment: `docs/superpowers/specs/2026-11-21-combined-do-run.md`, amendment 1 (5ce080dce).
Evidence and scripts: `/coord/handoff/combined-do/` (`run.log`, `c2.run.*`, `c2.box.tsv`, `c2-verdicts.py/.txt`,
`c2-reconcile.py/.txt`, `c2-coverage.py/.txt`, `c2-classA.py/.txt`, `c2-speed.py/.txt`, `c2-differences.tsv`,
`c2-unexplained.tsv`, `c2-classA-named.tsv`). Numbers and names only.

## What ran
- **The pre-committed build, checked:** the config's binary `/work/tools/al-runner-v3/main-ccd0f823d/al-runner`, sha256
  `bc3595c4…ad7c`, and the stderr version line `al-runner 3.0.0-alpha.14+main.20261120 (ccd0f823d)`.
- LethAL master 5ce080dce, `--profile slim`, `LETHAL_V3_PACK_ENTRIES=256`, `companies` = `CRONUS International Ltd.`,
  CPUs 0-11, `--peak 22`.
- Start 15:52:55Z, end 19:37:25Z, rc 0. No `run-suspended` notice, no watchdog stop.
- **5 lanes, not the predicted 6.** The lane gate sampled 3.3 GiB per lane on this build (more than c1's 3.1 on edge
  and PR-274's 2.06 per daemon on a slice). Six lanes plus LethAL's 4.0 GiB need 23.6 GiB, over the declared 22.
  8 lanes would need about 30.4 GiB.

## Hard claims
| # | Claim | Reading | |
|---|---|---|---|
| 1 | 0 unexplained verdict moves | 1,711 differences from the prediction; 1,682 explained by a rule, **29 not** (below) | **MISSED** |
| 2 | ≥ 90% of serve requests `kept` or `cache` | 4,759 of 4,760 (99.98%: kept 4,586, cache 173, ran 1) | pass |
| 3 | prefetch requests < 4,000 | 887 | pass |
| 4 | total `boundMs` < 2,381 s | 1,022 s over 4,679 checks (218 ms each) | pass |
| 5 | mutant phase < 17,000 s | 11,885 s | pass |

## Verdicts: why the prediction missed
- All 43,511 mutants join on the full site key; 0 mutantCode mismatches.
- Predicted: surv 9,095 / killed 6,413 / error 1,167 / t-killed 7 / no-cov 26,829.
- **c2: surv 8,536 / killed 6,500 / error 1,793 / t-killed 6 / no-cov 26,676.**
- The two named sets mostly held: RelationFieldNo 1,157 of 1,332 as predicted, Company 163 of 174.
- Every difference, in exactly one class (`c2-reconcile.py`):
  - **A. 728, PR-250's cut, under-predicted by preproc.** `relationfield.py` moved only mutants that a REFUSED test
    covers. But PR-250 cuts the whole entry at the refused test, so a mutant covered only by LATER tests of that
    codeunit is cut too.
    - The cuts: codeunits 68975 (584) and 68984 (520), RelationFieldNo; 68906 (96), a new `Format` refusal; 68874 (9).
      A mutant can sit behind more than one.
    - The moves: survived -> error 568, killed -> error 159, timeout-killed -> error 1.
    - `c2-classA.py` checks the rule per mutant. In every case the cut test is refused in c2's baseline. For 710, the
      rule holds: every covering test sits at or after the cut, or perf10c's killer does.
    - 18 are named: in 17, perf10c's killer is in another codeunit; in 1 (it is UNEXPLAINED), the killer runs before
      the cut.
  - **B. 955: the covering set changed, explained by the two baselines.** c2's baseline has 63 tests green that perf10c's
    was not (20 fail, 43 error there), and 9 not green that were. Every lost test and every gained test is one of these.
    - The moves: no-cov -> survived 299, survived -> killed 162, no-cov -> killed 143, survived -> no-cov 114, killed ->
      no-cov 88, plus smaller groups.
  - **C. 21: the covering set changed with NO baseline reason** (attribution on the new build). All are named:
    - M30439-M30446 (8): perf10c had them covered by all 1,680 green tests; c2 by 2 or by none. Error -> survived 5,
      error -> no-cov 3.
    - M6778, M6781, M6782, M6785, M6786, M6789, M6790, M6793 (8): one covering test lost, 25 gained that are green in both runs. Survived -> killed.
    - M19606-M19610 (5): 2 tests gained. No-cov -> killed.
  - **D. 7: same covering set, no cut.**
    - M38616, M38617, M40473: error -> survived. perf10c's refusal "the test result of an error whose text is not
      pinned" does not fire on main.
    - M10857, M35546: killed -> error. perf10c's kill was flagged `v3-codeunit-state-possible`; c2 refuses.
    - M41138: survived -> killed, flagged `v3-codeunit-state-possible` in c2.
    - M39635: killed -> survived, no note. Unexplained.
- **For the BC check (lethal-bugs):** the 18 A names, the 21 C and the 7 D, 46 mutants in all.

## Speed
| | c2 (5 lanes) | prediction (6 lanes) |
|---|---|---|
| mutant phase | 11,885 s | 12,750 s (9,800-16,800); about 15,300 scaled to 5 lanes |
| per covered mutant | 0.71 s (16,835 covered) | 0.76 s |
| busy lane-s | 57,578 (lanes 96.1-98.4% busy) | 74,200 (57,000-98,000) |
| per test (prefetch + live) | 18.4 ms over 2,564,358 tests | 28 ms (21-38) |
- Against y3 and c1, per covered mutant: −50% against y3 (1.43 s) and −40% against c1 (1.19 s).
- **Requests:** warm-up 521 (7,784 s wall), prefetch 887 (41,716 s), live 3,271 (8,077 s); 168 daemon restarts, 146
  for a refusal (SaveAs-of-report family 89).
- **Box load (410 samples, 30 s apart):** load1 median 13, p10 9, p90 94. CPU `some` avg10 median 3%. The heavy load
  from outside the container (up to 213) covered only part of the run. The speed is reported as measured.
- **Normalised view (a view, not a claim):** at the prediction's central 28 ms per test, the same tests would cost 71,802
  lane-s instead of 47,258. The wall would then be about 16,800 s at 5 lanes. The run beat the prediction on per-test
  time, not on lanes.

## What follows
- Claim 1 is missed, as pre-committed (a BLOCK). The verdict pre-commitment needs a corrected cut rule, and the 46
  named mutants need a BC check before c2's verdicts are accepted as main's.
- Claims 2-5 pass on the pre-committed build.
