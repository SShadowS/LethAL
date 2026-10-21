# R594 reports: the R546 CDO slice measured live on bc3

**Builds.**
- **Server.** bc3: BC 28.4 on Linux, W1, company `CRONUS International Ltd.`.
- **Microsoft apps.** All 11 of R546's packagesDir are at 28.4.53241.56646: Any, Application Test Library, Application, Base Application, Business Foundation, Library Assert, Permissions Mock, System Application Test Library, System Application, Test Runner and Tests-TestLibraries. `System` is 28.0.54946.56477.
- **Continia apps.** These are the sha256-pinned R396 addendum 2 files, published in **Dev** scope over the dev endpoint: System Application 28.5.0.336834, Core 28.5.0.336883, Connector App 28.5.0.336834, Delivery Network 28.5.0.336910 and Core Internal Activation 28.0.0.218906. R546's Cronus28 had the same versions in **Global** scope.
- **LethAL Control.** Resident on bc3 as measured 2026-10-21: 1.0.0.22.
- **LethAL.** `ef0e54ea` (branch `lethal/r586`), identity scheme 40. alc is 18.0.43.1464.
- **CDO.** `5f2a71d`, corpus fingerprint `aa47c61c1fcbb7e3`. The CDO target (28.4.0.0) and the test app (28.4.0.0) were published uninstrumented first. The test app's 104 `.al` files equal the local `Test` sources by sha256.
- **Compile symbols.** bc3's own Microsoft packages, plus the 5 pinned Continia packages (`scripts/r594/cdo-publish.ts`).

Pre-commitment: `docs/superpowers/specs/2026-10-21-r594-bc3-cdo-oracle-precommitment.md` (2fa33241). Roadmap: `docs/roadmap/R594.md`.

| File | Leg | bcdev `coverageMode` | Result | Compared with |
|---|---|---|---|---|
| `bc3-A.report.json` | A | `none` | 51 killed / 12 survived | `../r546/bc-A.report.json`: 63 of 63 equal on verdict and killing test |
| `bc3-B.report.json` | B | `fenced` | 51 killed / 8 survived / 4 no-coverage | `../r546/bc-B.report.json`: 63 of 63 equal on verdict, killing test and covering tests |

Both legs: baseline 21 of 21 green with the same 21 names as the oracle, 63 mutants (the dry run's deployed count), normal exit, no quarantine. Compared with `scripts/r594/compare.ts` (R546's `bucket`) and `scripts/report-diff.ts` (IDENTICAL, 0 differences). Every key joined, even though the identity scheme moved from 36 to 40.

**Redacted.** This is Continia Document Output, whose source is not public. Every field that held verbatim AL source was replaced by `scripts/redact-campaign-report.ts`'s marker, and both files pass its `--check`. Under the 2026-08-09 ruling, file paths, procedure names, test names and `killingTestFailure` are kept.
