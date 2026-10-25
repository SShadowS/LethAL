# R745 pre-commitment, addendum 1 (lane bugs, R-745, 2026-10-25): the live proof's result; P6 missed as worded

Written after the run. The pre-commitment (`2026-10-25-r745-exclude-test-precommitment.md`, master 569960e2) is not
edited. Run: bc1, head 01f7b83d, lease 09:19:45Z-09:20:00Z, control 1.0.0.23; evidence `/coord/handoff/R-745/proof/`
(`probe.jsonl`, `report.json`, `events.ndjson`, `run-stdout.txt`).

## Result per prediction
- P1 PASS: L2 accepted through the deployer (`threw: false`); step 1's read-back showed no prior set-2 rows on bc1.
- P2 PASS: exit 0; no `StaleDependencyMemberError`.
- P3 PASS: `tests-discovered` = TestPlus, TestFails; `excludedTests` = `[{test: "R740 Tests.TestLib", file:
  "src/Tests.Codeunit.al", reason: "exclude-test"}]`; one `exclude-test-narrowed-baseline` warning names it; `TestLib`
  appears only in those two events, in no baseline or test event.
- P4 PASS: `unsupportedTests` = {`R740 Tests.TestFails`}; TestPlus passes (it kills).
- P5 PASS in substance: Scale's 2 mutants no-coverage, Plus's 3 killed by TestPlus, identical per mutant to R-740's
  run 1. Wording: the report's `killingTest` reads `TestPlus` (the same form as run 1), not `R740 Tests.TestPlus`.
- **P6 MISSED as worded.** Predicted `validity.caveats` exactly `["tests-narrowed"]`, on the plan's claim that run 1's
  caveats were empty. They were not: run 1 had `["baseline-red", "session-warm", "kills-without-assertion"]` (the
  probe's TestFails fails by design; the other two are the probe's shape). This run has exactly run 1's caveats plus
  `tests-narrowed`; reliability moved from `degraded` to `narrowed-degraded`; the banner has the `TESTS EXCLUDED` line
  naming TestLib; score 100.0%. The miss is in the prediction, not the product: the change added exactly the one
  caveat it should.
- P7 PASS: cleanup read every probe app back absent (`allAbsent: true`); no quarantine record.

## Corrected statement of P6 (for the record, not a new prediction)
`validity.caveats` = run 1's caveats plus `tests-narrowed`; reliability narrowed (narrowed-degraded); banner names the
excluded test; score 100.0%.
