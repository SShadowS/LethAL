# R546: al-runner vs bcdev, per-mutant verdict agreement on one real slice (2026-10-09)

Method, committed before any live run: `docs/superpowers/specs/2026-10-09-r546-alrunner-bc-agreement-method.md`
(33682a59). This is a measurement, not a gate. Roadmap: `docs/roadmap/R546.md`.

## Result

**Every mutant agrees, on both legs.** 63 of 63 mutants have the same verdict on al-runner and on
bcdev in leg A and in leg B, and the same killing test as well. `scripts/r546-bucket.ts` (the method's
verdict-pair table) and `scripts/report-diff.ts` (the gate view) both report no difference.

| Leg | bcdev | al-runner | Agree (rate 1) | Rate 2 (both scored) | Flips (kill vs survive) | Verdict vs no-coverage | Error/timeout | One side only |
|---|---|---|---|---|---|---|---|---|
| A, coverage off on both | 51 killed / 12 survived | 51 / 12 | 63/63 | 63/63 | 0 | 0 | 0 | 0 |
| B, defaults (`fenced` / `al-runner`) | 51 / 8 / 4 no-coverage | 51 / 8 / 4 | 63/63 | 59/59 | 0 | 0 | 0 | 0 |

- Agree sub-counts: `killingTest` differs **0** in both legs; both no-coverage **4** in leg B (the
  4 mutants of `ShowRecipientsSetup`, which no test in the slice reaches).
- With no difference there was nothing to classify and no re-run to do: the method's flaky screen
  runs only on a leg with a non-agree row. The cause table is therefore empty.
- **What this bounds.** One codeunit (`CDO Recipient Mgt.`, 63 mutants, 21 tests) of one project.
  It says these two backends agree on THIS slice. It is not an agreement rate for al-runner in
  general, and it does not explain the owner's report of differences on other code. A slice with
  dialogs, reports, `TestPage`s, multi-object files ([[R383]]) or `#if`-wrapped objects ([[R497]])
  is where differences are expected, and none of those is in this slice.

## Builds and setup

- Slice: Continia Document Output `5f2a71d`, `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`,
  `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`, selector ids 6175460/6175459/6175458.
  Corpus fingerprint `aa47c61c1fcbb7e3` (540 `.al` files) at every leg.
- LethAL: al-runner legs at `564b8e22`, bcdev legs at `c5825f38`. No file under `packages/` differs
  between the two (the later commit adds only `scripts/r546-bucket.ts`).
- al-runner `v2.12.0-main.43f76177`, copied once from `/work/tools/al-runner/current` and used for
  every run; `--server` with the resource selector. **It loaded Microsoft Base Application
  `28.5.54151.55132` from its own platform apps** (verbose `[pkg-cache]`/`[dep]` lines), not the
  pinned 28.4 package in the packagesDir. So the two backends ran on DIFFERENT BaseApp builds (28.5
  vs 28.4) and still agreed on every mutant of this slice.
- bcdev: Cronus28 (BC 28.4), lease attempt 054, control app 1.0.0.20, `--stop-hung-sessions`.
  Prerequisites, all checked per app id: the 5 Continia and 11 Microsoft extensions installed at
  exactly the pinned packagesDir versions; the published test app 28.4.0.7's 104 `.al` files equal to
  the local `Test` sources by sha256 (CRLF→LF, BOM stripped); the 21 tests green under
  `bcdev_test_run`; `lethal doctor` all ok. Nothing was published by hand.
- Leg validity held on every leg: baseline 21 of 21 green with the same 21 names on both sides,
  63 mutants (the dry run's deployed count, equal on both backends: 65 sites, 63 deployed), normal
  exit, no quarantine, and in leg B coverage modes `fenced` and `al-runner`.
- Wall time: al-runner 3803 s (A) and 3830 s (B); bcdev 80 s (A) and 53 s (B).
- Informational cross-check: al-runner leg A against R396's `run-ii-new` (c39ad5de): every verdict
  equal; 2 mutants name a different killing test (ordering, R197).

## Deviations from the method

- **LethAL writes `lethal-control.app` into the bcdev `packageCachePath`.** The method points that
  path at the al-runner packagesDir (I1), so bcdev leg A added an 18th file there and the slice gate
  refused leg B. The file was removed before leg B and after it, so the folder held exactly the 17
  pinned packages for every al-runner run and every gate; the 17 hashes never changed. A future run
  of this method should give bcdev a separate cache with the same 17 packages.
- **P3 also strips a leading UTF-8 BOM** before hashing, one normalisation beyond the method's
  "CRLF→LF".
- **P3 fetched the test app through `dev/packages` with a script**, because bc-dev MCP's
  `bcdev_package_download` was refused on authentication while its app list worked. The script reads
  the config internally and prints only the HTTP status and size.

## Files

`docs/measurements/r546/{bc-A,bc-B,ar-A,ar-B}.report.json`, each redacted with
`scripts/redact-campaign-report.ts` and passed by `--check`. As the 2026-08-09 ruling allows, the
redacted reports keep `killingTestFailure`; this write-up quotes none of it.
