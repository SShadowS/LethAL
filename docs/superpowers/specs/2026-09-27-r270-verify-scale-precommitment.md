# R270 `itest:verify-scale`: pre-committed predictions

Committed ALONE, before the first live run of
`LETHAL_ITEST_VERIFY_SCALE=1 bun run itest:verify-scale`. This spec fixes the workload, the block
conditions, the timing predictions and the noise policy before either session runs. A BLOCK
condition failing stops the task and goes to the owner with the per-mutant diff. A timing
prediction landing outside its range is a finding: recorded, not a gate failure, except where the
noise policy below says otherwise.

Target: `Cronus28`. Fixture: `fixtures/sandbox-data` (the target project) and
`fixtures/sandbox-data-tests` (the committed test suite). Driver:
`packages/runner/itest/verify-scale.itest.ts`, committed at `074708f`. Control app on Cronus28:
`LethAL Control` `1.0.0.19`, installed and checked 2026-09-27 via `Get-BcContainerAppInfo`, equal to
`MIN_CONTROL_VERSION` (`packages/runner/src/harness.ts`). Baseline file: `tables.baseline.json`
(`packages/runner/itest/`), read only, never written by this gate.

Plan: `.superpowers/sdd/2026-09-27-R-270-verify-wall-time-at-scale/task-4-brief.md`. Task 1's offline
probe files: `.superpowers/sdd/2026-09-27-R-270-verify-wall-time-at-scale/task-1-probe-sandbox-*.json`.

## Corrections to the plan

These three corrections come from the controller and were made before this spec was written. They
replace the plan's numbers everywhere below. Any correction found AFTER this commit is appended in a
new, dated section at the end of this file. Nothing above such a section is ever edited in place.

1. **Test counts.** The committed suite `fixtures/sandbox-data-tests` discovers 68 tests, not 69.
   One `[Test]` string sits inside R79's deliberate comment at `DataTests.Codeunit.al:460`, and test
   discovery correctly skips it (it is a comment, not a real test). The scratch suite used by this
   gate is the 68 committed tests plus 5 no-op tests, so 73 tests, not 74. This spec uses 68 and 73
   everywhere the plan said 69 and 74. The 63-survivor count is unaffected: 63 counts mutants, not
   tests, and stays 63 everywhere, including the phrase "63-method baseline" in the timing
   derivations below.

2. **Task 1's offline probe numbers.** Read with no server, from `bun scripts/probe-verify-prepare.ts`,
   confirmed against the raw JSON files:

   | Project | AL files | Bytes | Tests | `hashTargetSource` runs (ms) | median | `discoverTests` runs (ms) | median |
   |---|---|---|---|---|---|---|---|
   | `sandbox-app` | 2 | 990 | 2 | 2, 1, 1, 1, 1 | 1 | 1, 0, 0, 0, 0 | 0 |
   | `sandbox-harden` | 2 | 1846 | 6 | 2, 2, 1, 1, 2 | 2 | 1, 1, 0, 0, 0 | 0 |
   | `sandbox-data` | 32 | 105159 | 68 | 6, 4, 4, 4, 4 | 4 | 2, 2, 3, 1, 2 | 2 |

   `hashTargetSource` is at most 4 ms median (on `sandbox-data`) and `discoverTests` is at most 2 ms
   median on all three projects. Both are pre-lease reads: work `runVerify` does before it opens the
   lease. Against any plausible value of B (predicted at 100 to 400 s below), a few milliseconds is
   negligible. Task 5a's trigger condition 3, a pre-lease read that is not negligible against B,
   therefore cannot fire on this fixture.

3. **Driver and control version.** The driver is `packages/runner/itest/verify-scale.itest.ts`,
   committed at `074708f`. The installed control app on Cronus28 is `1.0.0.19`, checked 2026-09-27 via
   `Get-BcContainerAppInfo`, which equals `MIN_CONTROL_VERSION`.

## Workload (fixed)

`lethal verify` over all 63 survivors of `fixtures/sandbox-data`'s frozen baseline, plus five no-op
new tests, driven through `verifyFromCli`. The line to beat is strictly under 0.20. The smaller-`k`
points (`k` in `[1, 5, 16]`) are scaling data only: they are never gated.

## BLOCK if missed

Each of A, B1 and B2 must have:

- zero `verdictDiffs` against `tables.baseline.json`;
- exactly the one expected baseline failure (`Data Tests.PageActionComputesNonZero`);
- one batch and 63 survivors.

Every verify call (V1, V2, V3, and the scaling points) must exit 5, report 63 (or `k`) `survived`
rows and five `stable` new tests. The restore's read-back hash must match the compiled hash.

Any one of these failing is a BLOCK: it stops the task and goes to the owner with the per-mutant
diff.

## Findings if missed (recorded, not blocking)

- `killingTest` of B equals the baseline's.
- Every timing range below: if a measured value falls outside its stated range, that is a finding,
  written up, not a BLOCK.

## Timing predictions, with derivations

- **B warm outer time: 100 to 400 s** (73-test scratch suite; the five no-op tests add five baseline
  runs and no mutant runs). Derivation: gift-card's warm run
  (`docs/campaign/2026-08-16-gift-card/rehearsal.report.json`) is 25.4 s for about 50 scored mutants
  (deploy 5.1 s, mutants 15.2 s, per-mutant median 204 ms, mean 310 ms). `sandbox-data` scores 362,
  so mutants cost 70 to 150 s at 200 to 400 ms each. Deploy of 377 guards costs 10 to 40 s. Baseline
  of 68 tests costs 2 to 10 s. Add about 5 to 20 s of backend start and lease. Cross-check:
  `itest:chunked` takes about 95 s for two legs over one 26-mutant file, so per-run overhead runs to
  tens of seconds.
- **Verify fixed cost F (the intercept of the four `k` points, not `k = 1`, which includes one
  survivor): 4 to 12 s outer.** Derivation: `sandbox-harden`'s `runVerify` total was 5.7 to 5.8 s
  with four survivors (`compileMs` about 1 s, `publishMs` about 0.9 s). The CLI adds backend start,
  1 to 4 s.
- **Verify over 63: 25 to 150 s outer.** Derivation: survivors are 63 of 362 scored (17%). A
  survivor runs every covering test, so it costs 1.5 to 3 times a mean mutant, which is 26% to 51%
  of the mutant phase, plus the 63-method baseline and F.
- **Worst ratio at 63, a MODEL ESTIMATE, coupled rather than divided across independent ranges.**
  Write B = M + D (M the mutant phase, 70 to 150 s; D deploy, baseline and overhead, 30 to 70 s) and
  V = f * M + F' (f the survivors' share of M, 0.26 to 0.51; F' verify's fixed cost plus its
  63-method baseline, 4 to 12 s). Low corner: f 0.26, M 70, F' 4, D 70, giving
  (18.2 + 4) / 140 = 0.16. High corner: f 0.51, M 150, F' 12, D 30, giving
  (76.5 + 12) / 180 = 0.49. Midpoints (f 0.38, M 110, F' 8, D 50) give 0.31. **Range 0.16 to 0.49,
  point about 0.31, so "not met" is the prediction.** A result outside the range is a finding, not a
  BLOCK.
- **Scaling:** the ratio rises with `k`; the ratio at `k = 1` is below 0.10.
- **Spread:** `max(V)/min(V)` within a session stays under 1.25.

## Noise policy (fixed)

The session's ratio is `worstRatio([V1, V2, V3], [B1, B2])` on outer times. The line is met only when
that ratio is under 0.20 in BOTH sessions AND each session has `max(V)/min(V) <= 1.5`. A session
above 1.5 is too noisy to decide: its result is "not met" unless a third session, pre-committed by an
appended note before it runs, decides it. Task 7A's gate asserts both conditions.

## Workload limit

The five new tests are no-ops on one fixture. This result says nothing about verify's wall time with
real answer tests, or on a real project. State this limit here and in any R270 closing text.

## Stop rule

Any BLOCK stops the task and goes to the owner with the per-mutant diff.

## Appended 2026-09-27: a quarantined run is no measurement

Written after live session 1 (lease 044), before any rerun. That session's source run A came back
quarantined with no mutants scored; the driver then misread it as "every baseline mutant missing"
(fixed in 9751a39, 2f48b06 and 48df6b0). The likely cause is R236: the TestPage test
`Data Tests.PageActionComputesNonZero` sometimes gets a truncated reply, the session is marked
in-flight-unknown, and the whole run scores nothing.

Policy, fixed before the rerun:

1. A session in which A, B1, B2 or any verify call is quarantined, for any reason, is NO
   MEASUREMENT. It is not "met" and not "not met", and none of its timings enter a ratio, a range
   check or the noise policy. It is not a BLOCK either: a quarantine is not a verdict difference.
2. The driver's restore still runs. After it, the session may be retried under a new lease. A retry
   is the same session, not a third one, and needs no further note.
3. The quarantine reason printed at step 3 or step 7 is recorded in the Results. An in-flight-unknown
   on the baseline's TestPage test is attributed to R236, not to R270.
4. Three quarantined attempts in a row for one session stop the task. It goes to the owner as
   "R270 cannot be measured on sandbox-data while R236 is open", with every reason printed.
5. Session 1 (lease 044) is recorded here as no measurement. It also failed for a second reason:
   GH-24 added 10 sites and `tables.baseline.json` had not been re-recorded, so the rerun waits for
   that re-record and then uses the re-recorded baseline's survivor count in place of 63.

2026-09-28: SURVIVORS set to 68 from the re-recorded tables.baseline.json (f25d647), per the b246d01 note; timing ranges stay model estimates.

## Results (appended 2026-09-28)

Both sessions below ran after the 2026-09-28 rebaseline (SURVIVORS 63 to 68, `ea3e09b`) and after
R-236c's restore guard (`49d0458`). LethAL Control on Cronus28: `1.0.0.20`. Base Application build:
`28.4.53241.53758`.

### The no-measurement attempt

Session 1's first attempt (lease 044, 2026-09-27) is NO MEASUREMENT, under the b246d01 policy above.
Its source run A quarantined with no mutants scored, and at the same time `tables.baseline.json` was
stale (GH-24 had added 10 sites and the owner's re-record had not landed yet), so both the run and the
baseline it would compare against were bad. No number from that attempt appears below.

### Session 1 (lease 059)

- A: 387 mutants, 301 killed / 68 survived / 18 no-coverage, 0 errors. Verdicts equal
  `tables.baseline.json`. Artifact `29b29564fe95a977ac495b40b5a5411d`. totalMs 269241, outer 269543 ms.
- V1: 64415 ms (runVerify totalMs 64389, compileMs 1163, publishMs 1481).
- V2: 64183 ms (runVerify totalMs 64158, compileMs 1229, publishMs 1070).
- V3: 63555 ms (runVerify totalMs 63521, compileMs 1203, publishMs 1004).
- Spread max(V)/min(V) = 64415 / 63555 = 1.014.
- B1: 301/68/18, totalMs 269266, outer 269588 ms.
- B2: 301/68/18, totalMs 241112, outer 241245 ms.
- Worst ratio max(V)/min(B outer) = 64415 / 241245 = **0.2670. NOT under 0.20.**
- Scaling: k=1 7509 ms (ratio 0.0311), k=5 11095 ms (ratio 0.0460), k=16 19247 ms (ratio 0.0798).
- Library `runVerify` timeline for one call against A, labelled library (this is not `lethal verify`'s
  wall time): totalMs 65858, compileMs 1109, publishMs 1100, baselineMs 11591, mutantsMs 51126,
  postMutantsMixedMs 645 (labelled mixed: reruns plus teardown plus return work, not separable by
  event), unattributedMs 287.
- `itest:tables`: the run right after the failed restore (below) is UNPROVEN and is not used here.
  The run after the proven hand restore (`r270-s1b-real-tables.log`) is the real result: PASS,
  301/68/18.

**Restore, session 1.** Step 9 FAILED on its first, automated run: `RESTORE_METHOD` was a hand-built
test reference with no file, and R-236c's `scanTestPageSources` (added by `49d0458`) refuses a
reference without one: `TestPageScanError: Data Tests.InsertDoublesAmountWeak has no file`. The
container was left carrying the scratch test app (`LethAL Sandbox Data Tests` 1.0.0.18, its package
holding both `DataTests.Codeunit.al` and `DataVerifyScaleNoOp.Codeunit.al`, its
`SymbolReference.json` naming codeunit 79396 "Verify Scale"). It was restored by hand, with the
product's own functions (`DeploymentVerifier.verify`, `compileTestApp`, `publishTestApp`) against
B2's artifact. Fresh read-back hash `9fadbcfb3831a09297d7804cc6936492aeeae89be06a69930360937f5ecc34b1`
equals the hash that was published, the source is byte-identical to the committed file, and codeunit
79396 is absent from the fresh package. The driver bug is fixed in `2b76cca` (`discoveredTestRef`,
red-checked): step 9 now takes its restore method from `discoverTests` instead of a hand-built
reference.

### Session 2 (lease 060)

- A: 301/68/18, verdicts equal `tables.baseline.json`. Artifact `f34780ee991d60bc9b119bd66f71514c`.
  totalMs 240192, outer 240382 ms.
- V1: 61314 ms (totalMs 61277, compileMs 1283, publishMs 1146).
- V2: 58485 ms (totalMs 58463, compileMs 1192, publishMs 1276).
- V3: 59671 ms (totalMs 59486, compileMs 1168, publishMs 1086).
- Spread max(V)/min(V) = 61314 / 58485 = 1.048.
- B1: 301/68/18, totalMs 243828, outer 243938 ms.
- B2: 301/68/18, totalMs 240555, outer 240676 ms.
- Worst ratio max(V)/min(B outer) = 61314 / 240676 = **0.2548. NOT under 0.20.**
- Scaling: k=1 7956 ms (ratio 0.0331), k=5 11156 ms (ratio 0.0464), k=16 18189 ms (ratio 0.0756).
- Library `runVerify` timeline: totalMs 61214, compileMs 1222, publishMs 1172, baselineMs 11749,
  mutantsMs 46251, postMutantsMixedMs 544 (mixed), unattributedMs 276.
- `itest:tables`: PASS, 301/68/18.

**Restore, session 2.** Step 9 PASSED on its first run: fresh read-back equal to the compiled hash,
carrier verdict survived, against B2's artifact `c7d41804ef2a1235c130be53f93f2d74`.

### F, verify's fixed cost: least-squares fit

Method: an ordinary least-squares line `V = F + s*k` through four points per session: the three
scaling points `(k, V)` at k = 1, 5, 16, plus the all-survivor point at k = 68, using the MEAN of V1,
V2 and V3 as that point's V (so the fit is not dominated by three nearly-identical k=68 readings). F
is the fitted intercept.

- Session 1: points (1, 7509), (5, 11095), (16, 19247), (68, 64051). Fit: slope 844.71 ms/survivor,
  **F = 6469.5 ms = 6.47 s.**
- Session 2: points (1, 7956), (5, 11156), (16, 18189), (68, 59823.3). Fit: slope 776.62 ms/survivor,
  **F = 6807.1 ms = 6.81 s.**

### Predictions: MATCHED / MISSED

- **B warm outer time, 100 to 400 s: MATCHED.** Session 1: 241.2 to 269.6 s. Session 2: 240.7 to
  243.9 s.
- **Verify fixed cost F, 4 to 12 s outer (intercept of the k points): MATCHED.** Session 1: 6.47 s.
  Session 2: 6.81 s.
- **Verify over all survivors, 25 to 150 s outer: MATCHED.** Session 1: 63.6 to 64.4 s. Session 2:
  58.5 to 61.3 s. (The workload is 68 survivors, not the spec's original 63, after the 2026-09-28
  rebaseline; the range was derived from the same fixture's scaling and still holds.)
- **Worst ratio range 0.16 to 0.49, point about 0.31, predicting "not met": MATCHED**, on the range
  and on the direction. Session 1: 0.2670. Session 2: 0.2548. Both sit below the 0.31 point estimate,
  nearer the low corner of the model (f 0.26, giving 0.16), and both correctly land above 0.20, so
  "not met" is confirmed in both sessions.
- **Scaling rises with k, and the ratio at k=1 is below 0.10: MATCHED.** Session 1: 0.0311 (k=1) <
  0.0460 (k=5) < 0.0798 (k=16) < 0.2670 (k=68). Session 2: 0.0331 < 0.0464 < 0.0756 < 0.2548.
- **Spread max(V)/min(V) under 1.25: MATCHED.** Session 1: 1.014. Session 2: 1.048.
- **BLOCK conditions (zero verdictDiffs, exactly one expected TestPage refusal, one batch and 68
  survivors, exit 5 with the right row and new-test counts, restore's read-back hash matching): all
  MET in both sessions.** In session 1 the restore's read-back match was proven by hand after the
  automated step 9 failed on a driver bug (above), not by the single automated run. No verdict
  difference was found anywhere in either session, so no BLOCK was raised.

`killingTest` of B equal to the baseline's is a finding-only line (never a BLOCK); it is not
separately printed by the driver, so it is not scored here.

### Task 5a: not triggered

Trigger condition 3 (a pre-lease read whose cost, divided by min(B), is larger than the worst ratio
minus 0.20) cannot fire on this fixture: Task 1's offline probe measured `hashTargetSource` and
`discoverTests` at single-digit milliseconds on `sandbox-data` (median 4 ms and 2 ms), against
`min(B outer)` of 241245 ms (session 1) and 240676 ms (session 2). Task 5a is dropped, as the spec
already predicted.

### Workload limit

The five new tests measured here are no-ops on one fixture (`fixtures/sandbox-data`). This result
says nothing about verify's wall time with real answer tests, or on a real project.
