# R639: BC's own reading on bc1 (2026-10-22)

`bc1-probe.json` holds two runs of `scripts/r639-bc-probe/drive.ts` on `bc1`. Both ran on BC 28.4
(Base and System Application 28.4.53241.56590), measured with LethAL Control 1.0.0.23, under lane
bugs' lease. The plan is `/coord/handoff/R-639/plan.md`, section r3.2.

| Run | Lease | What it ran | Harness |
|---|---|---|---|
| 1 | 09:17:14Z to 09:17:42Z | all six codeunits, 92910-92915 | `drive.ts@a166f32f` |
| 2 | 09:21:27Z to 09:21:32Z | 92912-92915 only, now with `TestPermissions = Disabled` | `drive.ts@a76acc4a` (`R639_RUN=2`) |

The file's `results` are the current readings:
- 92910 and 92911 come from run 1;
- 92912 to 92915 come from run 2. Run 1's readings for them are kept under `history`.

Each run's header (lease, app hashes, removal, registry reads) is under `runs`.

## What ran

- **Two throwaway apps.** Their sources are in `scripts/r639-bc-probe/`. Both were compiled
  offline with alc 18.0.43.1464, against bc1's symbol cache and the LethAL Control build measured
  there on 2026-10-22, 1.0.0.23.
  - **The target, "LethAL R639 BC Probe"** (`d371a89d-…`), ids 92900-92909.
    - It holds `table 92900 "Probe Row"`, with exactly `ROW_AL`'s fields and key.
    - It also holds Install codeunit 92901, which registers artifact `d1618dd6…` with the control
      app. `RunMutant` refuses a target with no registered artifact (`artifact-mismatch`).
    - So the target depends on LethAL Control.
  - **The tests, "LethAL R639 BC Probe Tests"** (`a9639c9f-…`), ids 92910-92919.
    - It holds codeunits 92910-92915, as plan r3 lists them.
    - There is no `TestHttpRequestPolicy` anywhere.
    - There is no example.com case (dropped by ruling).
- **One control-app call per codeunit**, run as a baseline (`mutantId ""`) under a control-app
  lease.
  - The one-test codeunits ran through `RunMutant`. That is the call `BcDevMcpBackend` makes for a
    baseline test.
  - 92912 has two tests, so it ran through `RunMutantMany`: both methods in one call, with
    `stopAtFirstFailure` false.
- **The runner** is `Test Runner - Isol. Codeunit` (130450), on every callstack.
- **Tests that report `MEASURED …` fail on purpose.** That is how the data travels.

## Id check (before publish)

- No `app.json` in the repo claims 92900-92919.
- No `.al` file in the repo, or in `/coord/handoff/R-629/probe/`, uses a 929xx id.
- On bc1, both app ids read back absent (0 rows) before each run's publish.

## Results (current)

| Codeunit | Test | Run | Outcome | First line |
|---|---|---|---|---|
| 92910 | `HttpGet` | 1 | fail | The request was blocked by the runtime to prevent accidental use of production services. |
| 92911 | `HttpGetRaw` | 1 | fail | `raw` = the same text, `rawCode` = `HttpRequest` |
| 92912 | `DuplicateNamedKey` | 2 | fail | The record in table Probe Row already exists. Identification fields and values: Key='K1' |
| 92912 | `AfterDupSentinel` | 2 | fail | MEASURED sentinel rows=0 |
| 92913 | `DuplicateNamedKey` | 2 | fail | the same duplicate-key text |
| 92914 | `DuplicateNamedKeyThenRead` | 2 | fail | the same duplicate-key text |
| 92915 | `DuplicateNamedKeyThenReadRaw` | 2 | fail | `raw` = the same duplicate-key text, `rawCode` = `DB:RecordExists` |

**Where the duplicate-key error is raised.** 92912 and 92913 end the test on the second `Insert`.
- Their callstacks start at `Test Runner - Mgt(CodeUnit 130454).RunTests line 26`, not in the test
  method.
- So BC raised the error after the test body had returned. It deferred the error, then failed the
  test at its end; it did not discard it.
- 92914 reads the table after the `Insert`. Its error is raised in the test method, at the
  `Count()` (`DuplicateNamedKeyThenRead line 11`).

## What it settles

- **HTTP: `BC_HTTP_INTERNAL_TEXT`.** BC fails `HttpGet`, and its first line equals 92911's `raw`.
  So `BC_HTTP_INTERNAL_TEXT` = "The request was blocked by the runtime to prevent accidental use
  of production services."
- **Duplicate key: branch F.**
  - 92912's `DuplicateNamedKey` and 92913 both read `fail`, with the same first line.
  - So plan r3's table selects branch F, with `BC_END_OF_TEST_TEXT` = "The record in table Probe
    Row already exists. Identification fields and values: Key='K1'".
  - Branch P is not selected, because 92913 does not pass.
  - 92914's first line also equals 92915's `raw`, which is the same text.
- **The sentinel (92912's `AfterDupSentinel`).**
  - LethAL's BC harness runs each method in its own `RunTests`. That holds for `RunMutant`, and also
    for `RunMutantMany`'s loop.
  - So a sibling test never shares a codeunit run with the test before it. The sentinel was
    measured that way, and it read `rows=0`.
  - This means the I1 case, "the next test sees the error", cannot arise in LethAL's own BC runs.
  - No harness call was built to force a shared run.

## History: run 1's duplicate-key readings (superseded)

In run 1, the codeunits had no `TestPermissions`, so BC's default applied.
- 92912-92915 each failed on the FIRST `Insert`, with "Sorry, the current permissions prevented the
  action. (TableData 92900 Probe Row Insert: LethAL R639 BC Probe Tests)". 92915's `rawCode` was
  `DB:ClientInsertDenied`.
- No duplicate key was inserted, so those rows measured nothing about #5603.
- The fixture `sandbox-data-tests` sets `TestPermissions = Disabled` for this reason.
- Run 2 changed only that property, on those four codeunits. The ids and the table set stayed the
  same.

## Removal, and what stays on bc1

**Both runs removed both apps, the tests app first.** For each app:
- uninstall gave HTTP 204;
- `Microsoft.NAV.unpublish` gave HTTP 204;
- each id then read back absent (0 rows).

**Two things stay on bc1:**
- **The table's schema** may stay behind as a ghost (the al-probe skill's landmine 2).
- **One row in LethAL Control's artifact registry**, keyed by target `d371a89d-…`.
  - Run 2 read it BEFORE its publish, and it still held `d1618dd6…` from run 1.
  - `RegisterArtifact` updates an existing row and never adds a second one. So there is one row for
    this target, not one per run.
  - No API removes it, and no other app uses that key.
