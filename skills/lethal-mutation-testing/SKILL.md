---
name: lethal-mutation-testing
description: Run LethAL mutation testing against a Business Central AL project and read the result. Use when asked whether an AL test suite actually catches bugs, to find weak or missing tests, or to check a suite before trusting a coverage number. Publishes a changed build to a BC server, so it needs a sandbox or dev container and is user-invoked.
disable-model-invocation: true
---

# LethAL mutation testing

LethAL breaks AL code on purpose, one small change at a time, and runs the test suite against each
break. A change the tests catch is **killed**; one they miss is a **survivor**; one no test executes
is **no-coverage**. It answers what coverage cannot: not "did this line run" but "would anyone
notice if it were wrong".

Full reference: `docs/using-lethal-from-an-agent.md` in the LethAL repository.

## Safety, before anything else

- **Sandbox or dev container only. Never a production tenant.** The changed build stays published
  until the user republishes their own app.
- The user's source tree is never modified; LethAL mutates a copy in a scratch directory.
- `--stop-hung-sessions` lets LethAL end a BC session on the user's server, so it needs their yes.
  Ask for it ONCE, up front, and recommend it on a sandbox: a mutant that turns a loop into an
  infinite one is ordinary on real code (`remove-assignment` on a loop's exit flag did it twice in
  one run), and without the flag each one costs the whole budget, a quarantine, and a full
  redeploy-and-baseline on `--resume`, roughly ten minutes on a hosted sandbox. With it the same
  mutant is stopped and scored `timeout-killed`, and the run continues.
- A report contains the project's source code. Do not paste one into anything public.

## 1. Check the setup

```bash
lethal doctor --config lethal.config.json --json
```

Read-only, seconds, reports every pre-flight problem at once. Exit `0` = all checks passed, `1` =
at least one failed; branch on `checks[].name`. When it passes, read `notChecked` — the publish
ceiling and baseline test health are NOT covered by a green report.

Fix what it names before running. It is much cheaper than discovering the same problem mid-run.

## 2. Size the job

```bash
lethal run --project <app-dir> --dry-run
```

Executes nothing. Reports how many mutation sites exist and how many would deploy. An unscoped run
on a real project is refused by default above 1,000 sites, because it costs days and usually cannot
publish at all. Expect to scope.

## 3. Run a slice

```bash
lethal run --project <app-dir> \
           --tests   <test-app-dir> \
           --backend bcdev \
           --config  lethal.config.json \
           --only       "src/Posting/**" \
           --tests-only "src/Posting/**" \
           --out        report.json \
           --progress-out events.ndjson
```

- `--backend bcdev` is authoritative. `al-runner` is offline and under-reports kills; never quote a
  score from it.
- `--only` and `--operator` choose which mutants run and cannot change a verdict. `--tests-only`
  chooses which tests run and CAN — excluding a killing test reports its mutant as survived.
- Runs take minutes to hours. Do not poll `events.ndjson` in a tight loop; read it when the run
  ends, or tail it if the user wants progress. A mutant's covering tests run in ONE server call
  (LethAL Control 1.0.0.17 or newer; older is refused up front), so survivors are no longer the
  expensive half. Leave `--max-methods-per-call`, `--request-ceiling-ms` and `--no-group-runs`
  alone unless the run warns `group-runs-inert`.

**Exit codes: `0` completed, `1` error, `3` quarantined, `4` nothing scored.** `4` means every
mutant errored and the run measured nothing: no score, no survivors, read the failure notes and
fix the cause (there is nothing to resume). `3` means the run refused to vouch for
its own verdicts — not that the tests failed. Do not report verdicts from a quarantined run;
`--resume` continues it once the cause is fixed.

## 4. Read the result

```bash
lethal explain report.json --top 15
```

Prints JSON. Reads only that file: no server, no database, no config.

- **`survivorSelection` first.** `{ total, shown, omitted, rankedBy }` — always present. If
  `omitted` is above zero, the survivor list is a ranked prefix, not the whole set.
- **`score`** carries `mutationScore` with `reliability` and `scoreDescribes`. Quote the number only
  with those. Also read `caveats`: a narrowed run's score describes the slice, not the project, and
  a red baseline means some mutants could not be scored at all.
- **`survivors[]`**: `executionProven` decides what a row is worth. `true` means a test is measured
  to have executed the mutated procedure. `false` means some test touched the object and nothing
  proves the mutated code ran, so it may be no finding at all. `reach: "covered-but-unreached"`
  means a test enters the procedure and never reaches the statement, which calls for a new case
  rather than a stronger assertion.
- Structure is contractual; the prose in `meaning` is not. Never regex it — every machine-usable
  fact is already a field.

For the full record rather than the interpretation, read `report.json` itself
(`schemaVersion: 2`), and read its `validity` block before quoting anything.

## Rules that stop a wrong conclusion

1. Read `validity` before quoting `mutationScore`.
2. A survivor is a lead, not a proven test-suite gap. Some survivors cannot be killed by any test.
   Check `executionProven` first.
3. In `events.ndjson`, every verdict line is PROVISIONAL until a `session-finished` event appears —
   a later `batch-invalidated` can retract one.
4. Exit `3` means the verdicts are not vouched for. Do not report them.
5. Exit `4` means the run measured nothing. There is no result to report, only a cause to fix.

## What it cannot measure

Do not read these absences as findings:

- Every verdict describes the non-GUI branch (`GuiAllowed=No`, `ClientType=ODataV4`).
- A test that opens a `TestPage` cannot be scored, and one can hang a whole run.
- A mutant that never terminates is recorded as an unmeasured error, not scored.
- Coverage is procedure-level, and object-level for extension objects.
