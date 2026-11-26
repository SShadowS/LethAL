# PR-456 (R1229): carry decided verdicts across a BC restart that lost the database — design r1 (no build)

lethal-code, 2026-11-26.
- The orchestrator's condition: earlier verdicts carry only if the re-setup uses the same app hashes AND the fresh
  baseline equals the stored one per test; degraded-window verdicts never carry.
- Prior rulings: R959 (re-verifying the apps cannot see company data, so refuse) and R969 (a database id survives a
  lease reset).
- Cost today: three bc4 restarts voided about 2,800 verdicts in one day.

## Today

- `assertSameServerGeneration` (orchestrator.ts) runs for `--resume` and `--resume-run`:
  - the same generation → go on;
  - a changed generation with the same non-empty database id → carry, with a warning (R969, a lease reset on a
    surviving database);
  - otherwise it throws `ServerGenerationChangedError`.
- **Every Linux BC restart lands in "otherwise",** because the database is in memory, so it gets a new database id
  and a new generation.

## The new branch: a CONDITIONAL carry

When the generation AND the database id both changed (or the id is missing on either side), the resume no longer
throws at once. It enters a conditional carry. Every resume check that exists today still applies; this adds to them
and removes none.

1. **The apps must be the same (checked before anything runs).** Read from the server and compared with what the prior
   run recorded:
   - the target app: id, version and the sha256 of the build LethAL publishes;
   - the test app: `testAppHash`, the closed-world identity, R247 / R495 / R601 as today;
   - every dependency app the run declared or resolved: id, version, and the sha256 where the prior run recorded one;
   - LethAL Control: its version;
   - the BC platform build.
   - **A difference refuses at once, naming what differs.** That is today's error with the reason added, for example
     "server generation changed and the test app differs", so nothing changes for that case.
   - The prior run must have RECORDED all of these. A run recorded before this item lacks the dependency hashes and
     refuses (no back-compat before the release).
2. **The baseline must be the same, per batch.** The resume re-deploys and runs its fresh baseline as usual. Before
   carrying ANY verdict of batch b, it compares the fresh baseline of b with the prior run's stored snapshot for b:
   - the same batch hash and the same test app hash;
   - the same set of test methods;
   - the same verdict per test method (pass, fail, error, skip);
   - the same start WorkDate (R1131). A snapshot without a date refuses the carry.
   - Under fenced coverage, the same covering set per test method. A test that now reaches a different member means
     the code or data differ under it.
   - **The carry is all-or-nothing per batch.** One difference and none of b's verdicts carry. They are re-run, with
     the warning `resume-restart-baseline-differs`, naming the batch and the count of differing tests (names in the
     report, not the warning).
   - Batches are independent: a batch whose baseline matches carries.
3. **What never carries,** whatever matches: rows inside a degraded window (R1227/PR-454), rows of a lost batch
   (R508/R513), stranded or in-flight rows, rows of an unattested batch (R512), and errors. All are re-run, as today.
4. **The warning** `resume-across-restart` names:
   - the prior run, both generations and both database ids;
   - for each batch, `carried N` or `re-run (baseline differs: k tests)`;
   - that verdicts carried across a lost database rest on the apps and the baseline being equal, and that company data
     the baseline does not observe is NOT checked (the limit below).
   - The report records the carry per batch as data, not only in the warning.
5. **Ordering:**
   - the carry decision for batch b is made after b's fresh baseline and before any of b's mutants is scheduled;
   - a carried row is copied into the new run as today (`carried = 1`);
   - nothing of b is scored before the decision.

## The limit, stated (R959's objection, answered only in part)

- The baseline sees company data only through what the tests' outcomes and coverage show. A mutant whose kill
  depended on data the unmutated tests are indifferent to could be killed before the restart and survive after it, or
  the reverse.
- **Mitigations:**
  - **(a) The servers' setup is deterministic** (`bc-linux-setup.ts`: the same backup, company and fixture apps).
    LethAL cannot see that, so it is not claimed.
  - **(b) A data fingerprint (optional, needs a control-app bump):** LethAL Control reports a digest of each table's
    row count and key range in the company, compared like the baseline. That is R969's pattern, and it is left as a
    follow-up here.
- **The ruling asked of the orchestrator:** does the baseline check without (b) meet R959's objection? Or is (b)
  required before any carry across a lost database? Owner principle 1: correct first.

## Red tests (for the later build)

Both directions of each guard:
- **Generation + database id changed:**
  - same apps and same baseline → carried;
  - one test's verdict differs → that batch is re-run and the other batches are carried;
  - an app hash differs → refused, by name;
  - the prior run lacks the dependency hashes → refused.
- **WorkDate:** a WorkDate differs, or the snapshot has none → that batch is re-run.
- **Fenced coverage:** one covering set differs → re-run.
- **Never carried:** degraded-window, lost-batch, stranded and error rows are re-run even when everything matches.
- **No scheduling before the decision:** nothing of a batch is scheduled before its decision (a call counter on the
  fake backend).
- **R969's branch unchanged:** the same database id still carries without the baseline compare.

## Gates (for the build)

- legs.ts for orchestrator.ts and store.ts.
- **A live leg is needed:** `itest:lend` or a new one restarts a bc server mid-run (`bc-linux-setup.ts` re-setup),
  then `--resume-run`. The verdicts are compared per mutant against an uninterrupted run, and the per-batch carry is
  as predicted. R1012's negative leg (refuse) becomes: refuse if the apps differ, carry if everything matches.
