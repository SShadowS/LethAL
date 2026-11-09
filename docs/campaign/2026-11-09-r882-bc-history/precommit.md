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

## Amendment 1 (2026-11-09, after round 1, before round 2)

**What round 1 showed.** All four stages stopped at the target publish, before any baseline: BC refused the package because its
runtime was 18.0 ("must be set to '17.1' or earlier ... on this server"). The corpus `app.json` files name no `runtime`, so alc 18
built at its own newest. No mutant ran; no verdict exists from round 1.

**Changed for round 2, and nothing else:** `"runtime": "17.0"` in all six scratch `app.json` files (the runtime of LethAL's own
fixtures). `compile-only` passes for all three apps again. Stages, anchors and expectations unchanged.

## Amendment 2 (2026-11-09, after round 2, before round 3)

**What round 2 showed.** No mutant ran. BankDeposits and PaymentPractices: the targets published, then the runs refused because the
test apps were not on the server ("the published test app does not contain ..."): publishing the test app is the user's step on
bcdev. ServiceDeclaration: BC refused the publish, because codeunit 5257 (a selector id) belongs to Contoso Coffee Demo Dataset
on bc5 (filed as R892).

**Changed for round 3, and nothing else:**
- each target, uninstrumented, then its test app, compiled with alc against the bc5 packages and published once to bc5 by hand
  (`publish-plain.ts`), as a user would before a bcdev run;
- ServiceDeclaration's selector ids are 5048, 5049 (codeunits) and 5258 (table): all inside its own ranges, none declared by it,
  and none owned on bc5 (read by key, `owners-sd.ts`). The other two apps keep R-881's ids.

Stages, anchors and expectations unchanged.

## Amendment 3 (2026-11-09, after round 3, before round 4; owner's ruling)

**What round 3 showed.**
- S1: all 100 mutants `error`. LethAL refused all 75 BankDeposits tests before sending them: each reaches a call that may open a
  `TestPage`. That is wider than expected above (the `TestPage` tests alone).
- S2: PaymentPractices stopped after 403 of 880. Mutant M0281 (`swap-find-direction`, `PaymentPracticeBuilders.Codeunit.al:79`)
  makes the walk loop forever (R893). The test was abandoned in flight, and the tier was quarantined.
- S3 and S4: refused on the quarantine. The cardinality anchor failed for S1 and S2.

**BankDeposits is recorded as a result, not run again:** while LethAL refuses `TestPage` tests, BankDeposits cannot be measured on
BC. S1 and S4 are dropped.

**Round 4** runs on bc5 after a reset, with the setup and the plain publishes of amendment 2 done again:

| stage | what | mutants (deployed, exact) |
|---|---|---|
| S2 | PaymentPractices, full, `--exclude-operator lethal.swap-find-direction` | 877 |
| S3 | ServiceDeclaration, full, no exclusion | 1044 |

- **How the R893 sites are excluded:** `--exclude-operator lethal.swap-find-direction` on PaymentPractices only. Its three
  `swap-find-direction` mutants are dropped: the two R893 sites (`PaymentPracticeBuilders.Codeunit.al` lines 41 and 79) and
  `PaymentPeriod.Table.al:82`, which is not a hang. That is one mutant less than leaving out the two lines with `--lines`, which
  would also drop the two safe `void-method-call` mutants there.
- **ServiceDeclaration needs no exclusion.** All 11 of its `swap-find-direction` sites were read: each `FindFirst` is a lookup on a
  record other than the one any loop around it walks. None has the R893 shape.
- The partial round-3 S2 report stays evidence. The round-4 S2 is the result.

Anchors as before, with the new counts. Expectations unchanged.

## Amendment 4 (2026-11-09, after round 4's S3 stopped, before its rerun)

**What happened.** Round 4's S2 (PaymentPractices) finished. S3 (ServiceDeclaration) stopped at the target publish: codeunit 5258
belongs to Contoso Coffee Demo Dataset on bc5. Amendment 2 checked 5258 as a TABLE only, but `tableId` is the "Mutation Upgrade"
codeunit (`id-ranges.ts`), so all three injected ids are codeunits. No mutant ran.

**Changed for the S3 rerun, and nothing else:** ServiceDeclaration's `tableId` is 5047, a codeunit that has no owner on bc5 (read by
key, `owners-sd.ts`) and that the app does not declare. `selectorId` 5048 and `controlId` 5049 are unchanged. S2 is not rerun.
