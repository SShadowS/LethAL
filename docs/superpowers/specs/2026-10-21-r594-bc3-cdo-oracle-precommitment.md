# R594: bc3 as a new live CDO oracle, pre-commitment

Written 2026-10-21, before any live leg on bc3. To be committed to master by the lane as
`docs/superpowers/specs/2026-10-21-r594-bc3-cdo-oracle-precommitment.md`. Roadmap: `docs/roadmap/R594.md`.
Ruling (orchestrator, 2026-10-21): bc3 becomes a NEW live oracle for the R546 CDO slice under this
pre-commitment. Cronus28 is parked. R546's `docs/measurements/r546/bc-A` and `bc-B` stay as a cross-check.

## Builds

| Item | bc3 (this measurement) | Cronus28 (R546's bc-A / bc-B) |
|---|---|---|
| BC, localization | BC 28.4 on Linux, **W1**, company `CRONUS International Ltd.` | BC 28.4, **DK** |
| Microsoft apps (11, read per app over `dev/packages` on 2026-10-21) | all **28.4.53241.56646**: Any, Application Test Library, Application, Base Application, Business Foundation, Library Assert, Permissions Mock, System Application Test Library, System Application, Test Runner, Tests-TestLibraries | all 28.4.53241.53758 |
| `System` platform package | **28.0.54946.56477** | 28.0.53667.0 |
| Continia apps (to be installed from the sha256-pinned R396 addendum 2 files) | System Application 28.5.0.336834, Core 28.5.0.336883, Connector App 28.5.0.336834, Delivery Network 28.5.0.336910, Core Internal Activation 28.0.0.218906, **Dev scope** (dev endpoint) | same versions, **Global** |
| LethAL Control | **1.0.0.22** (resident) | 1.0.0.20 |
| LethAL | the `lethal/r586` commit recorded in each leg log; `IDENTITY_SCHEME` 40 | `c5825f38`; identity scheme 36 |
| CDO | `5f2a71d`, corpus fingerprint `aa47c61c1fcbb7e3` (540 `.al`), clean | the same |
| Compile symbols | bc3's OWN Microsoft packages (the 11 plus System, downloaded from bc3) plus the 5 pinned Continia packages, in a LethAL-owned gitignored dir (`.kraken-local/r594/bc3-packages`, a per-leg copy as `packageCachePath`, R552). `cdo-r396/Test/.alpackages` is not touched; it stays pinned for al-runner. | the 17 pinned packages |

Before any publish, `scripts/bc-linux-setup.ts --with-continia --accept-build 28.4.53241.56646` re-reads the 11
Microsoft versions and checks every Continia app's declared dependencies (Microsoft minimums, Application,
Platform, Continia minimums) against bc3. If any would be refused, the measurement stops and is reported.

## Slice and legs

Exactly R546's: `--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`, `--tests-only
Src/Recipients/CDORecipientMgtTests.Codeunit.al`, `--selector-id 6175460 --control-id 6175459 --table-id 6175458`,
`--stop-hung-sessions`, default operators, fresh `--db` per leg, never `--resume`. Run by `scripts/r594/run-leg.sh`.

| Leg | bcdev `coverageMode` | Compared with |
|---|---|---|
| A | `none` | `docs/measurements/r546/bc-A.report.json` |
| B | `fenced` | `docs/measurements/r546/bc-B.report.json` |

Prerequisites, inside the bc3 lease: P1 as above; P2 the resident CDO target version before and after; P3 the
published test app's `.al` sources equal the local `Test` sources as a sha256 multiset (LF, no BOM), count > 0;
P4 the 21 tests of codeunit 68933 green (read from leg A's baseline if no separate runner is available, and said
so); P5 `lethal doctor` passes against the bc3 config with `--project Cloud --tests Test`.

Leg validity is R546's: baseline 21 of 21 green with the same 21 names as the oracle, 63 mutants (the dry run's
deployed count), normal exit, no quarantine, and in leg B `coverageMode` `fenced`.

## Hypothesis

Per mutant, joined by `keyOf` (astHash, object, procedure, operator, major, ordinal), the 63 mutants on bc3 EQUAL the
oracle's on **verdict** and **killing test**: leg A 51 killed / 12 survived, leg B 51 killed / 8 survived / 4
no-coverage (the 4 of `ShowRecipientsSetup`). Tools: `scripts/r546-bucket.ts` (the verdict-pair classes) and
`scripts/report-diff.ts` (the gate view). The oracle is redacted, so the text fields compare marker against
marker; identity rests on the key (which carries astHash) and on `file`/`startIndex`/`endIndex`.

Not compared: `killPosition`, `warmKills`, `groupedCalls`, timings and the assertion screen (structural or advisory,
R546 already records them as differing between runs).

## Expected deltas, named in advance

**Differences are FINDINGS, not a block.** No baseline is re-recorded to make them go away. Each differing row is
put in the FIRST category below whose rule it meets.

| # | Category | Rule: a differing row belongs here when |
|---|---|---|
| 0 | LethAL identity drift (scheme 36 to 40) | the row is one-side-only, or its key group has a different size, while a row with the same mutant code, procedure, operator and `startIndex` exists on the other side. It is a join failure, not a BC difference; such rows are then re-joined on that tuple and compared again under 1 to 6. |
| 1 | Flaky | the verdict changes when the whole leg is re-run once on bc3 from a fresh `--db` (done only for a leg with a differing row). |
| 2 | Killing test only (order, R197) | the verdict is equal and only `killingTest` differs, and the bc3 killer is in the oracle's covering set (leg B) or is a test that also kills it when run alone. |
| 3 | W1 against DK localization | the bc3 failure text or callstack names company data, a number series, a country/region, or Customer/Vendor data, or a baseline test fails on bc3 for such a reason. Checked by NAME in advance: the 21 tests and the target codeunit reference only the CDO tables `CDO E-Mail Recipient`, `CDO E-Mail Template Header`, `CDO Template Recipient Setup`, plus `Library Assert` and the test app's `CDO Library - Email Template`. That library also references `Customer` and `Vendor`. No reference to `CompanyName`, `No. Series`, a country/region, `Language` or `WorkDate` was found in the test codeunit or the target. **Predicted: no row in this category.** |
| 4 | Continia Dev against Global scope | the failure text names a permission, a missing or inaccessible Continia object, activation, or licensing, or P4 fails for such a reason. **Predicted: none** (the slice's code touches only CDO's own tables). |
| 5 | Microsoft build (53758 to 56646) | the failure text or callstack names a Microsoft object (System Application, Base Application, Library Assert, the test runner) as where the behaviour differs, and categories 0 to 4 do not apply. **Predicted: none.** |
| 6 | Unexplained | none of the above; counted and reported as "unexplained (suspected <X>)". |

A stopped or invalid leg is not compared. A P1 dependency refusal, a Continia publish refused for licensing or
activation, or a P4 environment failure is a STOP, reported to the orchestrator before anything else is changed.

## Outputs

Reports, logs and event streams go to `/coord/handoff/R594/` as they run. The two bc3 reports are redacted with
`scripts/redact-campaign-report.ts` (then `--check`) and committed under `docs/measurements/r594/` with a README whose
header states the builds above. If the legs are valid, they become R-586's D-leg live oracle, whatever the
comparison shows; a difference is recorded per mutant with its category.
