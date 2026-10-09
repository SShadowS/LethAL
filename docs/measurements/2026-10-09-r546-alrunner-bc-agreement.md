# R546: al-runner vs bcdev, per-mutant verdict agreement on one real slice (2026-10-09)

Method, committed before any live run: `docs/superpowers/specs/2026-10-09-r546-alrunner-bc-agreement-method.md`
(33682a59). This is a measurement, not a gate. Roadmap: `docs/roadmap/R546.md`.

## Result

**Every verdict agrees, on both legs.** 63 of 63 mutants have the same verdict on al-runner and on
bcdev in leg A and in leg B, and the same killing test and the same covering tests. `scripts/r546-bucket.ts`
(the method's verdict-pair table) and `scripts/report-diff.ts` (the gate view) both report no
verdict difference.

| Leg | bcdev | al-runner | Agree (rate 1) | Rate 2 (both scored) | Flips (kill vs survive) | Verdict vs no-coverage | Error/timeout | One side only |
|---|---|---|---|---|---|---|---|---|
| A, coverage off on both | 51 killed / 12 survived | 51 / 12 | 63/63 | 63/63 | 0 | 0 | 0 | 0 |
| B, coverage on (`fenced` / `al-runner`) | 51 / 8 / 4 no-coverage | 51 / 8 / 4 | 63/63 | 59/59 | 0 | 0 | 0 | 0 |

- **Agree sub-counts.** `killingTest` differs in 0 kills in both legs. Both no-coverage: 4 in leg B. These are the 4 mutants of `ShowRecipientsSetup`, which no test in the slice reaches.
- **Classification and re-runs.** With no verdict difference there was nothing to classify under the method's table, and no re-run: the flaky screen runs only on a leg with a non-agree row.
- **`killPosition` is not compared.** It differs on 25 of 51 kills in each leg. That is structural, not a disagreement: bcdev runs a mutant's covering tests grouped and records warm kills at positions 2–20, each confirmed by replay, while the al-runner kill path always reports position 1.

## A backend difference outside the verdicts: the assertion screen

The verdicts agree, but the report's advisory **assertion screen** does not:
- **bcdev:** 3 of 51 kills flagged, `discrimination: "partial"`.
- **al-runner:** 51 of 51 flagged, `discrimination: "vacuous"`.

These are the same 51 kills by the same killing tests. On al-runner every kill's failure text begins with an exception type (`NavNCLDialogException: `, once `NavCSideDuplicateKeyException: `), so the rule never sees an assertion. The al-runner report then says the vacuity is "a property of the suite's assertion style". That diagnosis is wrong, because the same suite separates kills on bcdev.

No verdict moves. This closes the case [[R121]] recorded as unmeasured, and it is filed as [[R553]] (a LethAL limitation, not an al-runner defect).

## What this bounds

- **One codeunit:** `CDO Recipient Mgt.`, 63 mutants, 21 tests, of one project. The result says the two backends agree on THIS slice. It is not an agreement rate for al-runner in general, and it does not explain the owner's report of differences on other code.
- **No UI coverage.** The slice's one UI call, a `Page.Run` in `ShowRecipientsSetup`, is reached by no test. Its agreement (survived on both sides in leg A, no-coverage on both in leg B) says nothing about UI behaviour.
- **What is absent:** reports, `TestPage`s, multi-object files ([[R383]]) and `#if`-wrapped objects ([[R497]]). Code with those shapes is where differences are expected.

## Builds and setup

- **Slice.** Continia Document Output `5f2a71d`:
  - `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`
  - `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`
  - selector ids 6175460/6175459/6175458

  Corpus fingerprint `aa47c61c1fcbb7e3` (540 `.al` files) at every leg.
- **LethAL.** al-runner legs at `564b8e22`, bcdev legs at `c5825f38`; see Deviations.
- **al-runner.** `v2.12.0-main.43f76177`, copied once from `/work/tools/al-runner/current` and used for every run, with `--server` and the resource selector.
  - A verbose probe with the same copied build and packagesDir (one test, one-shot, run after the legs) shows every Microsoft app resolved at **28.5.54151.55132** from al-runner's own platform-apps and test-apps. That includes Base Application, System Application, Application, Business Foundation, the test libraries and Test Runner. `System` resolved at 28.0.54946.0.
  - So the pinned 28.4 Microsoft packages in the packagesDir were NOT the ones al-runner used. The Continia apps resolved at the pinned versions.
  - The probe also logged `EMIT-EXCLUDED` for 2 objects of Tests-TestLibraries.
  - The leg runs themselves print no BC build line. That this resolution also held for them is inferred from the same build and folder, not read from the legs.
- **bcdev.** Cronus28 (BC 28.4), lease attempt 054, control app 1.0.0.20, `--stop-hung-sessions`. Prerequisites, all checked per app id (`/coord/handoff/R-546/prereqs.md`):
  - the 5 Continia and 11 Microsoft extensions are installed at exactly the pinned versions (so 28.4 on this side);
  - the published test app 28.4.0.7's 104 `.al` files equal the local `Test` sources by sha256;
  - the 21 tests are green under `bcdev_test_run`;
  - `lethal doctor` passes every check.
- **Apps published to Cronus28.** Only LethAL's own instrumented publishes of the CDO target (`f4b69b55`):
  - resident before: 28.4.20697.40267 (an earlier instrumented build);
  - 28.4.20735.22285 by leg A;
  - 28.4.20735.22335 by leg B, which stays resident.

  Nothing was restored. The container holds the instrumented build, as it did before.
- **Leg validity held on every leg:**
  - baseline 21 of 21 green, with the same 21 names on both sides;
  - 63 mutants, which is the dry run's deployed count and equal on both backends (65 sites, 63 deployed);
  - 0 errors and 0 timeout-killed, normal exit, no quarantine;
  - in leg B, coverage modes `fenced` and `al-runner`.
- **Wall time:** al-runner 3803 s (A) and 3830 s (B); bcdev 80 s (A) and 53 s (B).
- **Informational cross-check:** al-runner leg A against R396's `run-ii-new` (c39ad5de). Every verdict is equal; 2 mutants name a different killing test (ordering, R197).

## Deviations from the method

- **The offline `alc` compile of `Cloud` did not succeed.** Its only error was `AL1001` on the app's backslash logo path, which is [[R422]]'s Linux shape and is handled by LethAL's own compile, not by a raw `alc` call. The cache was instead proven by both bcdev legs compiling and deploying all 63 mutants against it.
- **LethAL writes `lethal-control.app` into the bcdev `packageCachePath`.** The method points that path at the al-runner packagesDir (I1), so bcdev leg A added an 18th file there, and the slice gate refused leg B.
  - The file was removed before leg B and again after it. So the folder held exactly the 17 pinned packages for every al-runner run and every gate, and the 17 hashes never changed.
  - Filed as [[R552]]. A future run of this method should give bcdev a separate cache holding the same 17 packages.
- **Two LethAL commits instead of one.** No file under `packages/` differs between `564b8e22` and `c5825f38`; the later commit adds only `scripts/r546-bucket.ts` and its test.
- **P3 also strips a leading UTF-8 BOM** before hashing, one normalisation beyond the method's "CRLF→LF".
- **P3 fetched the test app through `dev/packages` with a script.** bc-dev MCP's `bcdev_package_download` was refused on authentication, while its app list worked. The script read the credentials from the config inside the process and printed only the HTTP status and size.
- **The bucketing script does not import `normalizeForComparison`.** It keys by `keyOf` and compares the verdict, killing test and the five same-mutant fields itself.

## Files

`docs/measurements/r546/{bc-A,bc-B,ar-A,ar-B}.report.json` (see that directory's README). Each is redacted with `scripts/redact-campaign-report.ts` and passes `--check`. As the 2026-08-09 ruling allows, the redacted reports keep `killingTestFailure`; this write-up quotes none of it.
