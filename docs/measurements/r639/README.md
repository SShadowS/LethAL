# R639: BC's own reading on bc1 (2026-10-22)

`bc1-probe.json` is one run of `scripts/r639-bc-probe/drive.ts` on `bc1` (BC 28.4, Base and System
Application 28.4.53241.56590, LethAL Control 1.0.0.23), under lane bugs' lease from 09:17:14Z to
09:17:42Z. Plan: `/coord/handoff/R-639/plan.md`, section r3.2.

## What ran

- Two throwaway apps, sources in `scripts/r639-bc-probe/`, compiled offline with alc 18.0.43.1464
  against bc1's symbol cache and the LethAL Control 1.0.0.23 build:
  - target "LethAL R639 BC Probe" (`d371a89d-…`), ids 92900-92909: `table 92900 "Probe Row"`,
    exactly `ROW_AL`'s fields and key. It also holds Install codeunit 92901, which registers
    artifact `d1618dd6…` with the control app, because `RunMutant` refuses a target with no
    registered artifact (`artifact-mismatch`). So the target depends on LethAL Control.
  - tests "LethAL R639 BC Probe Tests" (`a9639c9f-…`), ids 92910-92919: codeunits 92910-92915 as
    plan r3 lists them. No `TestHttpRequestPolicy` anywhere; no example.com case (dropped by ruling).
- Each codeunit ran in its own control-app call as a baseline (`mutantId ""`), under a control-app
  lease. Five codeunits have one test and ran through `RunMutant`, the call `BcDevMcpBackend` makes
  for a baseline test. 92912 has two tests, and `RunMutant` runs one method, so it ran through
  `RunMutantMany` with both methods in one call and `stopAtFirstFailure` false. That loop runs each
  method as its own `RunTests`, so the sentinel does not share a codeunit run with the first test.
- The runner is `Test Runner - Isol. Codeunit` (130450), on every callstack.
- Tests that report `MEASURED …` fail on purpose: that is how the data travels.

## Id check (before publish)

No `app.json` in the repo claims 92900-92919. No `.al` file in the repo, or in
`/coord/handoff/R-629/probe/`, uses a 929xx id. On bc1, both app ids read back absent (0 rows)
before the publish.

## Results

| Codeunit | Test | Outcome | First line |
|---|---|---|---|
| 92910 | `HttpGet` | fail | The request was blocked by the runtime to prevent accidental use of production services. |
| 92911 | `HttpGetRaw` | fail | `raw` = the same text, `rawCode` = `HttpRequest` |
| 92912 | `DuplicateNamedKey` | fail | Sorry, the current permissions prevented the action. (TableData 92900 Probe Row Insert: LethAL R639 BC Probe Tests) |
| 92912 | `AfterDupSentinel` | fail | MEASURED sentinel rows=0 |
| 92913 | `DuplicateNamedKey` | fail | the same permissions text |
| 92914 | `DuplicateNamedKeyThenRead` | fail | the same permissions text |
| 92915 | `DuplicateNamedKeyThenReadRaw` | fail | `raw` = the same permissions text, `rawCode` = `DB:ClientInsertDenied` |

## What it settles, and what it does not

- **HTTP (92910/92911): settled.** BC fails `HttpGet`, and its first line equals 92911's `raw`.
  So by plan r3's table `BC_HTTP_INTERNAL_TEXT` = "The request was blocked by the runtime to
  prevent accidental use of production services."
- **Duplicate key (92912-92915): NOT measured.** Every case failed on the FIRST `Insert` with a
  permission refusal, so no duplicate key was ever inserted. The test codeunits set no
  `TestPermissions`, so BC's default applied; the fixture `sandbox-data-tests` sets
  `TestPermissions = Disabled` for this reason. Read literally, plan r3's table would select
  branch F (92912 and 92913 fail with the same first line), but that line is a permission error,
  not BC's duplicate-key reading. No branch should be taken from this file.
- A re-run needs `TestPermissions = Disabled` (or a permission grant) on 92912-92915. That changes
  the tests app only, not the table set.

## Removal

Both apps were removed, tests app first: uninstall HTTP 204, then `Microsoft.NAV.unpublish` HTTP
204, then each id read back absent (0 rows). Left behind on bc1: the table's schema may stay as a
ghost (the al-probe skill's landmine 2), and LethAL Control's artifact registry keeps one row for
target `d371a89d-…`. Nothing has an API to remove it, and no other app uses that key.
