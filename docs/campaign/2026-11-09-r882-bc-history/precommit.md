# R-882 pre-commitment: the same three BC.History apps on BC (bc5), compared with v3

Committed before any run, 2026-11-09. Coord task R-882. Evidence goes to `/coord/handoff/R-882/`. No source text from BC.History is
committed here or anywhere: file, object, procedure and test names only.

## Setup

- **Server:** `bc5`, a throwaway BC 28.4 W1 (28.4.53241.57822, System 28.0.54946.57596) on server1, CRONUS International Ltd.,
  WITHOUT Microsoft's Bank Deposits, Payment Practices and Service Declaration apps (kraken removed them; Bank Deposits' tables are
  left over, and LethAL publishes with ForceSync). No coord lease: by owner ruling, bc5 is outside the pool and used for R-882 only.
  `bun scripts/bc-linux-setup.ts --server bc5` published LethAL Control (the version `extensions/lethal-control/app.json` names) and the fixtures, and `doctor` was ok on all four
  fixture configs.
- **Corpus:** `/work/src/BC.History` w1-28.6.55443.0, read-only. Scratch copies in `/coord/handoff/R-882/src/`, copied from R-881's
  and R-887's (the AL is byte-identical to the corpus; only `app.json` differs, as in R-881). Two more `app.json`-only changes, so no
  extra app has to be published: Payment Practices Test Library's one codeunit is folded into the Payment Practices tests app (its
  dependency dropped, its id 134196 added to the tests app's range), and the tests app is added to Payment Practices'
  `internalsVisibleTo`. No AL line changes; the mutant set is unchanged.
- **Packages:** 14 Microsoft packages downloaded read-only from bc5 (`fetch-bc5.ts`), all dependencies followed. So 28.6 source
  runs against 28.4 packages, as in R-881, but at bc5's 28.4 build (57822), not bc3's (56646).
- **Preflight (done):** `compile-only` compiles all three instrumented apps against these packages; `--dry-run` gives the same
  per-file counts as R-881.
- **LethAL:** branch `lethal/r882` (master plus bc5 in the setup script; no runner change). The report names the sha.
- **Command:** `lethal run --backend bcdev --allow-large-run`, default coverage mode (`fenced`), default timeouts, selector ids as
  R-881 (BankDeposits 10148-10150, PaymentPractices 696-698, ServiceDeclaration 5257-5259). `timeout` of 4 hours per run.

## Stages, in this order

| stage | what | mutants (deployed, exact) |
|---|---|---|
| S1 | BankDeposits, `--lines src/codeunits/BankDepositPost.Codeunit.al:46-164` (R-890's sample) | 100 |
| S2 | PaymentPractices, full | 880 |
| S3 | ServiceDeclaration, full | 1044 |
| S4 | BankDeposits, full | 2080 |

S4 runs only if S1 ran without a wedge (below). A stage that stops does not stop the next one unless the server is unhealthy.

## Anchors (checked against each report)

1. **Cardinality, exact:** the numbers in the table. Any other number is a finding before anything else is read.
2. **No crash:** the run ends with a report.
3. **Every mutant has a verdict** of the report's own kinds.

## Expectations, stated before seeing anything

- **`TestPage` tests are refused on BC, by name** (R69: the fenced session cannot open a test page). That covers tests in all 3 of
  BankDeposits' test files, 1 of 2 of PaymentPractices', 2 of 6 of ServiceDeclaration's. al-runner v3 runs such tests, so a mutant
  killed on v3 only by a `TestPage` test and `survived` or `no-coverage` on BC is this known class, not a new finding. Each one is
  still listed.
- **A wedge is possible.** R69 measured that a page with table triggers can hang the fenced session at baseline. If a baseline
  stalls, the run's timeout ends it; that is recorded as a finding with the test name, not retried.
- **Baselines:** apart from `TestPage` refusals, I expect BC's baselines to be green: no demo-data or sidecar refusals exist on BC.
  Every other red baseline test is a finding (28.6-on-28.4 gap, or LethAL).
- **S1 and R890.** R-890 measured the sample on v3 twice: `isolation test` (default) and `method`. On BC, 7d4d525f… (`void-method-call`
  in `Bank Deposit-Post.OnRun`) was killed only by `PostedBankDepositPageShowsCorrectRecordAfterPosting`, under `method`. That
  test uses a test page, so I predict BC **does not** kill it with that test, and the sample cannot settle R890 for page tests. For
  the non-page tests, BC's verdict is the reference for which of v3's two isolations is right.
- **Verdicts:** no kill rate is predicted. Each mutant is compared with the v3 run of the same app. The primary comparison is R-887's
  round 3 (demo data, sidecar, no install mutants) where it finished; otherwise R-881's best run (`pp1`, round 2). Every verdict
  difference outside the `TestPage` class is a finding, and its cause is named: LethAL, al-runner, or the 28.4/28.6 gap.

## What is not claimed

bc5 is not a gate server and is in no proof table: nothing here is a gate figure. BC's verdict is the authority for this comparison,
but only for this setup (28.6 source on 28.4.57822).
