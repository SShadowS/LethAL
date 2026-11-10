# R-907 pre-commitment: al-runner v3 without a client, and --skip-after-timeout on one-shot

Committed before any of these runs, 2026-11-10. Coord task R-907. Evidence goes to `/coord/handoff/R-907/`. No BC.History source
text is committed: file, object, procedure and test names only. al-runner v3 is not authoritative (R586); BC's figures below are
R-882's, measured on `bc5`.

**Build:** al-runner `current` = edge-3138effad (3.0.0-alpha.14+edge.20261110, sha256 `5bd40387…`), gated today with
`--no-client` (#7564) and `--skip-after-timeout` (#7517). **LethAL:** branch lethal/r907 at a4f2bad2 or later. It adds
`alRunnerV3.noClient` (default OFF until the owner rules) and the report fields `executionContexts[].noClient` and
`testMethods[].baselineFlagged`.

## Already measured, before this pre-commitment (direct al-runner, not LethAL)

On each app's own test app, with versus without `--no-client` (`/coord/handoff/R-907/noclient/`): Statistical Accounts' green tests
went from 5 to 1, and VAT Group Management's from 27 to 18. The lost tests are refused by al-runner as not pinned without a client
(CurrentClientType, Page.Run with a record, Notification.Recall, a request page with a handler). That is reported to the owner. The
default is not flipped by this pre-commitment.

## 1. PaymentPractices, `PaymentPracticeHeader.Table.al` only (R895's case)

Two LethAL runs on the same scope, serve-entries, R-881's sources and packages, R-902's demo data cache:
`--only src/Tables/PaymentPracticeHeader.Table.al`. Run A with `noClient: false`, run B with `noClient: true`.

**Anchor:** each report holds exactly **97** mutants (dry run on a4f2bad2, `dry-pp.txt`), the same 97 that R-882's BC run
(`/coord/handoff/R-882/S2.report.json`) has for this file: BC 6 killed, 77 survived, 14 error.

**Predicted, per mutant and per test:**
- B's baseline: `ConfirmToCleanUpOnTypeValidation`, `ConfirmToCleanUpOnAggrValidation_Yes` and `ConfirmToCleanUpOnAggrValidation_No`
  are NOT green, as on BC: without a client, `GetResponseOrDefault` returns its default and asks nothing, so the confirm handler is
  never called. A's baseline has `ConfirmToCleanUpOnTypeValidation` green, as R-881 measured.
- The 7 mutants M0776, M0779, M0780, M0781, M0782, M0783, M0785 (`OnValidate` lines 56-63): **killed in A**, by
  `ConfirmToCleanUpOnTypeValidation`; **survived in B**, as on BC (BC covers them with `PaymentPracticeHeader_ValidDates` and
  `ReportingSchemeAutoDetectionOnInsert`).
- The other 90: not predicted. Every A-to-B difference is listed by mutant with its cause, and B is compared with BC per mutant
  (agreements counted, each disagreement named). A difference between A and B that is not explained by the client is a finding.

## 2. `--skip-after-timeout` on one-shot (R897)

On R-895's invented hang fixture (`/coord/handoff/R-895/fixture/`, 17 mutants), LethAL one-shot with `--skip-after-timeout` against
serve-entries (whose own cut is R897's):

**Predicted:** the same verdict for each of the 17 mutants on both transports, and the same killing test where one kills. One-shot
with the flag is no slower than without it on the hanging mutants. If any verdict differs, the flag is not adopted, and the
difference is reported upstream if it is al-runner's.

## 3. The v3 gate

With the default left off, no gate figure may move: the full v3 gate must pass on the final head. If the owner rules the default on,
the gate is first run with `noClient` on as a measurement, the moved figures are pre-committed per mutant in an amendment here, and
only then are baselines re-recorded (R332).

## Amendment 1 (2026-11-10, after §1 and §2's first run, before §2's second)

**§1 held as predicted** (`/coord/handoff/R-907/pp-result.md`).

**§2 on R-895's first fixture says nothing.** It now deploys 16 mutants, not 17: its one hang-capable site has been refused since R896
landed. No mutant timed out, so `--skip-after-timeout` never acted. The three legs agreed on all 16 (serve, one-shot with the flag,
one-shot without it: 26, 37 and 38 s). The anchor of 17 is not met, for that reason, and the run is kept as evidence only.

**§2 again, on R-895's second fixture** (`/coord/handoff/R-895/fixture2/`, 10 mutants, 4 of them `timeout-killed` there). The same
three legs. **Predicted:** 10 mutants (dry run on b11d2804; 1 more site hang-refused); the same verdict and killing test for each mutant on serve and on
one-shot with the flag; one-shot with the flag no slower than without it. If a verdict differs, the flag is not adopted.
