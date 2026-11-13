# R-949 pre-commitment: the daemon-baseline cross-check stops comparing `flagged`; leg DBI gains one notice

Committed before any gate ran on the change, 2026-11-13. Coord task R-949 (R961 follow-up). Build: lethal/r-949 at 5be22dc7 (on master
c518c271 plus the drop-detail commits b9569a66 and 9bacfc9c). al-runner: the gated `current`, edge-2bd87774f.

**Why.** R-948's in-session cross-check dropped the daemon baseline on Continia DO in every run. The drop detail names the field:
`flagged` (R907) only — six passes are "pass, flagged" one-shot and "pass" from the daemon; status, notRun, fail text and coverage are
equal. Measured on invented apps (`/coord/handoff/R-949/flag-probe/result.md`): al-runner's serve rows never carry `flagged`, while
`test --output-json` does (upstream https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/7954). Verified by reading the code:
`flagged` feeds no verdict (`baselineReachOf`, R-917/R926, treats a flagged pass as a pass); its one consumer is the report's
`testMethods[].baselineFlagged`.

**The change.** The cross-check no longer compares `flagged` (status, notRun, fail text and the exact coverage sets still compared). A
pass the daemon answered has its flagged state UNKNOWN: `testMethods[].baselineFlaggedUnknown: true`, never shown as unflagged; a known
`flagged` (one-shot, including the cross-check sample) wins. One notice per session that served a daemon answer:
`al-runner-v3-serve-flagged-unknown`, citing #7954.

**Gate predictions** (from the last full gate on lethal/r948 e3fb49ae, `/coord/handoff/R-948/v3gate2.log`, which printed each leg's
`served`):
- **DBI** served 1 daemon answer, so its warning set gains exactly `al-runner-v3-serve-flagged-unknown`:
  `["al-runner-v3-isolate-tests", "al-runner-v3-memory-guard", "al-runner-v3-serve-flagged-unknown"]`. Everything else DBI checks
  unchanged (22 mutants, 3 / 14 / 5, per mutant equal to `bcdev.baseline.json`, the daemon report figures).
- **DB** served 0 (its one test codeunit is its own cross-check sample): unchanged, `["al-runner-v3-memory-guard"]`.
- **K** (builds through `cli.ts`, same fixture and one test codeunit): served 0, unchanged, `["al-runner-v3-memory-guard"]`,
  `serveSpawns` 2, `oneShotTestCalls` 1.
- Every other leg: unchanged. Any per-mutant difference anywhere is a BLOCK.

**Live expectation (DO, measured after the gates):** on the 38-test slice the daemon baseline is no longer dropped for `flagged`; if it
is dropped, the detail names another field and that is reported, not hidden.
