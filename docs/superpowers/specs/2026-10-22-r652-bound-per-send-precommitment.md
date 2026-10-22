# R-652 pre-commitment: the bound check per send (Rule A), live legs (nothing run yet)

Source: plan r3 (`/coord/reviews/R-652-plan/plan.r3.md`, on r2 and r1), the build (`/coord/handoff/R-652/build.md`),
build review r1 (APPROVE, `/coord/reviews/R-652-build/review-r1.md`). It reuses R-635's commands, leg runner and
STOP rules (`docs/superpowers/specs/2026-10-22-r635-entries-precommitment.md` and its addenda 1-6). Everything there
that is not restated here stands.

Committed to master by lethal-code on 2026-10-22, before any leg below ran.

## 0. What is under test

- **Code:** `lethal/r652` at **ad2d3269**. If master moves before the run, the final head is lethal/r652 after
  merging master. The committed version names that sha, and every leg checks it (the final-head rule).
- **Worktree:** `/work/lethal-wt/r652`. Before each leg, `git status --porcelain --untracked-files=all` must be
  empty. The only exception is R-635 addendum 1's `coverage.cobertura.xml`, which is moved to `live/artifacts/<leg>`
  after each leg. `git rev-parse HEAD` must equal the head sha. The native parser must not be stale.
- **Binary:** the same edge build as R-635 run3/run5 and R-651 run2:
  - path `/work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner`
  - sha256 `0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720`
  - version `al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)`
  - run under `LETHAL_ALRUNNER_V3_CANDIDATE=1`.
  - Before each leg, its sha256 is checked, and the itest's first line must print it.
- **What changed, and so what is claimed:**
  - R-652 moves `assertBound` from each `run()` to just before each send. That covers one-shot spawns too, so the
    one-shot CONTROL legs are also under test.
  - **The claim:** no verdict, killing test or request count moves in any leg. Only `boundChecks`, and therefore
    the time, change.

## 1. Legs, in run order (R-635's §2 commands, outputs under `/coord/handoff/R-652/live/`)

The common environment:

```
cd /work/lethal-wt/r652
test "$(git rev-parse HEAD)" = <final head sha>
test -z "$(git status --porcelain --untracked-files=all)"
test "$(sha256sum /work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner | cut -c1-64)" = 0642f9b27f0e55912d434fe231543b1bedcf98a14fc38a8b7f08788b11ac8720
export LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ALRUNNER_V3_CANDIDATE=1 \
  LETHAL_ALRUNNER_V3_PATH=/work/tools/al-runner-v3/edge-3.0.0-alpha.4-57f1e4f98/al-runner
C=/coord/handoff/R-652/live/control; E=/coord/handoff/R-652/live/entries; P=/coord/handoff/R-635/live/run5
```

| # | Id | Command (after the common env; `tee /coord/handoff/R-652/live/<Id>.log`) | Compared with |
|---|---|---|---|
| 1 | E0-S | `LETHAL_ITEST_V3_LEGS=S1 LETHAL_ITEST_V3_REPORT_DIR=$C bun run itest:alrunner-v3` | `bcdev.baseline.json`; then `bun scripts/report-diff.ts $P/control/S1.report.json $C/S1.report.json` |
| 2 | E1 | `LETHAL_ITEST_V3_LEGS=S1 LETHAL_ITEST_V3_TRANSPORT=serve-entries LETHAL_ITEST_V3_REPORT_DIR=$E LETHAL_ITEST_V3_CONTROL_DIR=$C bun run itest:alrunner-v3` | `$C/S1.report.json`, then `bcdev.baseline.json` |
| 3 | E0-T | `LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_LEGS=T LETHAL_ITEST_V3_REPORT_DIR=$C bun run itest:alrunner-v3` | the v3 tables record (leg T's `judgeLegT`); then `report-diff` against `$P/control/T.report.json` |
| 4 | E2 | `LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_LEGS=T LETHAL_ITEST_V3_TRANSPORT=serve-entries LETHAL_ITEST_V3_REPORT_DIR=$E LETHAL_ITEST_V3_CONTROL_DIR=$C bun run itest:alrunner-v3` | `$C/T.report.json`, then the tables record |
| 5 | E0-D | `LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396 LETHAL_ITEST_V3_LEGS=D1 LETHAL_ITEST_V3_REPORT_DIR=$C bun run itest:alrunner-v3` | `docs/measurements/r594/bc3-A.report.json`; then `report-diff` against `$P/control/D1.report.json` |
| 6 | E3a | as E0-D, plus `LETHAL_ITEST_V3_TRANSPORT=serve-entries LETHAL_ITEST_V3_REPORT_DIR=$E LETHAL_ITEST_V3_CONTROL_DIR=$C` | `$C/D1.report.json`, then bc3-A |
| 7 | E3b | as E3a, plus `LETHAL_ITEST_V3_SECOND_ECHO=0` and `LETHAL_ITEST_V3_REPORT_DIR=$E/b` | `$C/D1.report.json`, then bc3-A |
| 8 | V2 | `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner -- --parallel=3` | its frozen baselines (`docs/gates/alrunner.md`) |

- The `report-diff` rows are new to R-652. A one-shot control is compared with R-635 run5's control of the same
  leg, on the same binary. This proves that moving the check on the one-shot path moved no verdict. It must exit 0
  (IDENTICAL).
- The CDO pin is unchanged: `/work/lethal-wt/cdo-r396` at 5f2a71d, clean, fingerprint `aa47c61c1fcbb7e3`,
  `CDO_SLICE_SHA256`, `CDO_ALPACKAGES`, coverage `none`, Sleep index 3 + 0.

## 2. Pre-committed figures (any miss is a STOP)

These are R-635's figures (run3 and run5) and R-651 run2's. None of them moves.

| Figure | E0-S | E1 | E0-T | E2 | E0-D | E3a | E3b |
|---|---|---|---|---|---|---|---|
| killed / survived / no-coverage over N | 3/12/4 over 19 | 3/12/4 | 290/50/59 over 406, errors 7 | = E0-T | 51/12/0 over 63 | 51/12/0 | 51/12/0 |
| per-mutant differences against its comparisons (§1) | 0 | 0 | 0 beyond the 7 pre-named | 0 (406, text verified) | 0 | 0 (63, text verified) | 0 |
| `report-diff` against the run5 control | IDENTICAL | - | IDENTICAL | - | IDENTICAL | - | - |
| daemons / cachedFalse | - | 1 / 1 | - | 8 / 8 (1 + 7 R612 cuts) | - | 1 / 1 | 1 / 1 |
| warm-ups / prefetch / live / coverage / echo | - | 1 / 1 / 6 / 0 / 0 | - | 8 / 4 / 595 / 0 / 0 | - | 1 / 1 / 102 / 37 / 74 | 1 / 1 / 102 / 37 / 37 |
| entriesSent | - | 44 | - | 1932 | - | 332 | 332 |
| echo / second-echo mismatches, prefetch drops | - | 0 / 0 / 0 | - | 0 / 0 / 0 | - | 0 / 0 / 0 | 0 / - / 0 |
| **`boundChecks`** = warm-ups + prefetch + live + coverage | - | **8** | - | **607** | - | **141** | **141** |

- **E0-T and E2 end "HELD"**, exit 1, through `judgeLegT`, on exactly the 7 pre-named rows. These are
  M0157-M0159 and M0161-M0164: survived -> error/runner-refused, an edge #5623/R641 refusal. That is R-635
  addendum 2's edge-binary difference, unchanged, and not a STOP. Any other held row is a STOP.
- **The `boundChecks` identity is checked from each entries leg's own `entries` line.** It must hold exactly, and
  the number must equal the table. The E2 figure was confirmed safe to pre-commit: R-635 run3's E2 had no failed
  daemon start (8 daemons = 8 warm-ups, 0 transport failures; `build.md`). Since R-652 the counters count at the
  check, so the identity holds even when a start fails.
- **No verdict text from a window changes on these legs.** R-652's `WINDOW_BOUND_CAVEAT` is only on window
  errors, and these legs have no window error: E3a and E3b had echo mismatches 0 and no disagreements.
- **V2:** PASS. Every leg's per-mutant verdicts must equal its frozen baselines and the one-shot leg's. R-652 does
  not touch v2's code, so any difference is a BLOCK on the head.

## 3. The CDO E3a split: the gain (a prediction; it decides the speed claim, not the correctness gate)

Read from E3a's `split ms:` line, against R-651 run2 (e1cd0cd8): bound 86 284 ms over 527 checks, loop 139 167 ms,
leg 169 s.

| Figure | Predicted | Range that CONFIRMS the gain |
|---|---|---|
| `boundChecks` | **141** | exactly 141 (a STOP otherwise, §2) |
| `bound` | **about 23 s** (141 × about 164 ms) | 15 to 35 s |
| mutant loop | **about 78 s** (139.2 − 86.3 + 23.1 = 76, plus noise) | 60 to 95 s, i.e. at least 44 s (70% of the predicted 63 s) faster than run2 |
| `other` (unnamed loop time) | under 2 s | under 5 s |
| leg wall | about 103 to 108 s | recorded; not judged (deploy and the CDO checks vary with load) |
| baseline | about 3 s less than run2's 5.9 s (21 checks become 1) | recorded; not judged |

- **Same for E3b:** `boundChecks` 141, bound 15 to 35 s. Its loop is recorded but not judged, since its echo count
  differs.
- **If a figure falls outside its range**, while `boundChecks` = 141 and every verdict is equal: the gain is
  NOT CONFIRMED. That is recorded with the measured split and the load (`ps`, `free -g`) at the time. It is not a
  correctness STOP, but R652 cannot be closed claiming the gain. E3a may be re-run ONCE, alone, with no other heavy
  job, and both runs are reported. A second miss means the gain is investigated, not claimed.
- **Timing conditions:** E3a and E3b run with no other heavy job in the container (check `ps` before each), so
  their split is comparable with run2's, which also had none.

## 4. STOP rules (R-635's §5, restated for this head; each is recorded, never retried into a pass)

- Any per-mutant difference between an entries leg and its control, or between a one-shot control and its run5
  control (`report-diff` not IDENTICAL).
- Any per-mutant difference from an authoritative baseline beyond E0-T's 7 pre-named rows.
- Any figure in §2 that moves, including `boundChecks` and the identity.
- A named refusal in an entries leg: `-warmup-dirty`, `-warmup-disagrees`, `-batch-refused`, `-no-baseline-rows`,
  `AlRunnerV3ServeStopUnsetError`, `-itest-control-missing`, an encoder throw, or `al-runner-v3-entries-prefetch-dropped`.
- **New for R-652:** any `AlRunnerV3UnprovenBatchError` in any leg. Nothing touches the tree during a leg, so a
  refusal means a check reads something else than at deploy.
- A binary sha mismatch, a wrong HEAD, a dirty worktree (beyond addendum 1's file), or a stale native parser.
- A leg that ends by a signal or a timeout is recorded as such and never TaskStopped mid-leg.
- **NOT a stop:** E0-T/E2's 7 pre-named held rows; a timing figure outside §3's range (that is "gain not
  confirmed").

## 5. Heavy jobs and order

- Each leg is one local heavy job: at most 2 others container-wide, `free -g` showing at least 10 GB. No BC server
  and no lease are needed.
- Run strictly one at a time, in §1's order. E0-D, E3a and E3b share one ALRUNNER_CACHE and one CDO checkout, and
  E3a's split is the timing evidence. V2 (`--parallel=3`) runs last, alone.
- Results go to `/coord/handoff/R-652/live/results.md`: each leg's verdict line, its `entries` line, its `split ms:`
  line, and the §3 table filled in.
