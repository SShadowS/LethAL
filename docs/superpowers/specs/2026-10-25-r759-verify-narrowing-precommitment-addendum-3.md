# R759 pre-commitment, addendum 3 (lane bugs, R-759b, 2026-10-25): the live result; P9 not tested (harness)

Written after the re-run. The pre-commitment (master d550809b) and addenda 1-2 are not edited. Run: bc1, head 5151f1fa,
control 1.0.0.24, lease 16:23:14Z-16:23:36Z, the original bc1 probe build (shas as pre-committed). Evidence:
`/coord/handoff/R-759b/proof/` (driver.log, probe.jsonl, report.json, run-store.sqlite, v1.json, v0.json).

## Result per prediction
- P1-P7 PASS: step 1 read back only 1.0.0.1 rows of set 1; L2 accepted; the run left out exactly `R740 Tests.TestLib`
  (`excludedTests` reason `exclude-test`); `unsupportedTests` = {TestFails}; caveats = `baseline-red`, `tests-narrowed`,
  `session-warm`, `kills-without-assertion` (R745 addendum 1's corrected set); Scale's 2 mutants no-coverage, Plus's 3
  killed by TestPlus; score 100%.
- P7b PASS: `runs.test_narrowing` = `{"testsOnly":[],"excludeTests":["93840::TestLib"]}`.
- P8 PASS (V1, the R759 build): exit 6; `refused.reason` = `no-tests-to-run`, detail naming 0/M0001 and 0/M0002;
  `excludedTests` = `[{"test":"R740 Tests.TestLib","reason":"exclude-test"}]`; `newTests` []; `results` []; counts 0;
  no verify run id, nothing compiled or published; stderr: "run 1 left out 1 test(s) (its --tests-only /
  --exclude-test), so they are not new and not run: R740 Tests.TestLib."
- **P9 NOT TESTED (harness).** V0 (the R745 build) was run from the R745 worktree, so the source run's relative project
  path resolved to that worktree's own copy of the probe, which carries id set 2; V0 refused with `source-changed`
  (exit 6) before planning, so the predicted `test-app-compile-failed` contrast was never reached. The contrast is not
  the claim: R759's behaviour is fully shown by P8. Re-testing P9 needs a fresh id set, not worth a new run.
- P10 PASS: step 4's read-back unchanged by verify; cleanup `allAbsent: true`; no quarantine record.
