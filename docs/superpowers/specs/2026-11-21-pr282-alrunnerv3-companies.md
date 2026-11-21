# PR-282 pre-commitment: `alRunnerV3.companies`, al-runner's `--companies` from LethAL's config (R1160's config gap)

Lane lethal-bugs, coord PR-282, 2026-11-21. Committed before any code.

## What was found (offline)
- **Which refusal:** PR-275's rank 5 is al-runner's `NotRun: out-of-scope: FindSet on the Company table: the database may hold
  companies this runtime does not know; name them with --companies NAME[,NAME...] (serve: the `companies` field); \`all\` needs test
  data (ADR-046 decision 4a)`.
  - It is 58 error mutants in PR-275's census. In perf10c's store (/coord/handoff/PR-217/doperf10c.sqlite), the text and its
    codeunit cascade are on 504 rows over 183 mutants.
  - Almost all are codeunit 68986's `Derivation_Explicit_*` tests, plus a few tests of 69003, 68992 and 68903.
  - The tests pass in the baseline. A MUTANT reaches a loop over the Company table, and al-runner refuses, because it does not know
    which companies the database holds.
- **The tests name no company.** The refusal comes from not knowing the database's company list, not from a missing named company.
- **The fix cannot be DO's command line alone.**
  - al-runner takes the list as `--companies NAMES` (CLI) or the per-request `companies` field (serve, upstream issue 7775).
  - LethAL passes neither, and its v3 config has no pass-through: KEYS in al-runner-v3-config.ts has no such key.
  - So no DO run can declare the companies today.

## The change (the R956 `license` pattern)
1. **A new optional config field** `alRunnerV3.companies`: a non-empty string in al-runner's own syntax (names, comma separated, the
   session company first, or `all`).
   - Validated as a non-empty string; anything else is refused by name, as the other keys are.
   - **No default.** Absent, nothing is passed, and al-runner keeps refusing. The refusal is the correct answer while the database's
     companies are unknown (unknown is not no; a guessed list would give wrong verdicts).
2. **Passed through:** `--companies <value>` on every al-runner call that runs tests, one-shot and serve (the server flag), exactly
   where `--license` goes.
3. **It enters the run's fingerprint and the report's al-runner settings**, as `license` does:
   - the company list changes results, so a stored baseline, a `--resume` or a reuse under another list must not match;
   - the report records the value.
4. **A pointer on the refusal:** a NotRun row whose message holds `FindSet on the Company table` gets
   ` [set alRunnerV3.companies to the database's companies (PR-282)]`, as `licensePointer` does for R956.
5. **Docs:** the config comment block, and docs/using-lethal-from-an-agent.md next to the license paragraph.

## Unchanged
- A run without the field: the same events, report and fingerprint as today. The default is absent and passes nothing.
- al-runner's own refusal text and verdict rules.

## Predictions
- **The v3 gate:** PASS, unchanged. No gate config sets the field, and no leg's refusal set holds this text. If one did, its notes
  would move, and that is a BLOCK.
- **The value for DO:** not LethAL's to choose. It must be the companies of the database DO's tests are meant to run against.
  - It goes to preproc for the next DO run's pre-commitment (R1160).
  - `all` needs restored test data, so it applies only if DO's runs restore demo data.

## Tests (red both ways)
- Config:
  - absent → undefined;
  - a string → kept;
  - an empty string, or a non-string → refused by name.
- The call args:
  - the value → `--companies <value>` on the one-shot call and on the serve daemon's command line;
  - absent → no `--companies` (the control).
- The fingerprint differs between two values and between a value and absent. Absent equals today's fingerprint.
- The pointer: appended to a Company-table NotRun message, and not to another refusal (the control).
