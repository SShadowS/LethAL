# PR-65 pre-commitment: what #8154 (and #8157) flipping to BC on edge-4ebfe7913 frees (2026-11-16)

Written before any re-run for this task.

## What flipped
The daily update moved `current` to edge-4ebfe7913. Two regression entries flipped to BC's answer:
- `u8154-noclient-handlers`: under `--no-client`, al-runner now calls a test's bound UI handlers;
- `u8157-xml-asxmlnode`.

## Scope (from R1039, PR-38's impact table and the stored configs)
- `--no-client` changes only runs that set `alRunnerV3.noClient`. Without it, al-runner already called bound handlers (R1039),
  so ConfirmHandler suites run without it (Confirm Management, Guided Experience) do not move. Not re-run.
- The stored configs that set `noClient` cover three apps:
  - Bank Deposits (`R-911/src/bd`: R-911, R-975's sweep config 7, R-986's tail);
  - VAT Group (`R-911/src/vat`: R-911, R-975 8/8s);
  - Payment Practices (`R-881/src/pp`: R-907, R-911).
- PR-38 counted 43 tests in them that bind a Confirm, StrMenu, Message, SendNotification, RecallNotification or Hyperlink
  handler (Bank Deposits 25, VAT Group 12, Payment Practices 3 per run). All 43 were red in their stored baselines.
- #8157 (AsXmlNode on an XmlElement nothing created): the entry's rerun list names no known corpus mutant, and PR-38 found 0
  tests at risk (afs 0, do-test's 4 sites with no test reaching them). Not re-run.

## Method
- **Main comparison:** per mutant, same LethAL head, same config except the binary: al-runner edge-5a58a0f16 (the build
  before the fix) against edge-4ebfe7913 (current), both with `noClient: true` and `environment: onprem`.
- **Pools:** the old ones were cleaned, so: Payment Practices `R-881/pkgs-pp` (R-907's own); Bank Deposits and VAT Group
  `R-982/pool` (R-986's re-run pool for Bank Deposits; VAT Group's own pool is gone, so a run that cannot resolve its symbols
  there is reported as such and not counted).
- Each app whole, `--peak 3` (measured peaks of v3 serve runs are about 1-2 GiB), on serve. Per-mutant diff with
  `scripts/report-diff.ts`.
- **Secondary:** the stored runs (al-runner 3138effa, 2026-11-10) are compared as well, reported but not attributed: a week of
  other upstream changes lies between them.
- **Attribution of a moved mutant:** to #8154 only when its covering set holds one of the handler-binding tests and that test's
  baseline outcome moved between the two builds; anything else is "other change between the builds" and listed.

## Predictions
- Baselines: on 4ebfe7913 some of the 43 handler-binding tests turn green, those whose only refusal was the client callback. R1039
  notes that the same baselines hold other refusals too, so not all 43.
- Verdicts can move both ways:
  - **Towards scored:** mutants whose only covering tests were those red handler tests leave `error`/no-coverage.
  - **Away from a kill:** a test that wrongly PASSED under `--no-client` because al-runner let an unhandled Message or Hyperlink
    pass now fails at baseline, so its kills and survivors move.
- Expected size: most of the movement is in Bank Deposits (25 tests; 2,290 standing sightings of the client-callback text).
- R1039 closes if the regression entry has flipped (it has) and the re-run shows the handler tests run on 4ebfe7913.
- R895/R060's GUI-branch class shrinks only if a handler test that was red now covers a GUI-branch mutant; this is reported
  from the diff, with no number predicted.
- The measured result is commented on #8154.
