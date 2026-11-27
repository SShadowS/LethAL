# PR-494: can LethAL lift al-runner #8002's refusals by itself? Measured on DOTests' Email area

**Status:** measured, 2026-11-27 (lethal-code). **Waiting for the orchestrator's ruling.** Changing DOTests' v3
config is a pin change for lethal-bugs. Evidence is in `/coord/handoff/PR-494/`, which is PRIVATE because it
holds DO data; only counts and test names appear here.

## The question
- #8002 is DO's largest al-runner cost (R1239):
  - 95 of the Email area's 108 baseline-refused tests;
  - 198 tests across the whole project;
  - 152 BC kills lost on file 1 alone, and 193 on files 1 and 3.
- Under `--isolation test`, al-runner refuses a test when an earlier test of the same codeunit changed a number
  sequence that existed before it. What the per-test rollback leaves of such a sequence is unmeasured.
- The question: can a setting on LethAL's side recover those tests without moving any verdict?

## What creates the sequence
- **All 95 refusals** name ONE sequence, a GUID name.
- **DO's own code** never calls `NumberSequence`.
- **The name comes from Business Foundation's** `No. Series - Sequence Impl.` (`CreateNewSequence`:
  `"Sequence Name" := Format(CreateGuid(), 0, 4)`, then `NumberSequence.Insert`). So it is a No. Series line
  that allows gaps, from the demo data. It exists before any test.
- **About ten different earlier tests** advance it: tests that post, print or create a document that takes a number.
- **Policy, not a bug:** the refusal is al-runner's deliberate "not measured". Upstream (#8002, 2026-11-27) is
  writing a probe for the runner-codeunit `TestIsolation = Function` path. The shape and counts were sent to
  alrunner (kraken q-20261127T183700-fd509e96).

## The levers
- **Codeunit order or grouping:** no lever. The refusal is within one codeunit, and its tests' order is fixed by
  the AL.
- **The demo-data cache:** no lever. The sequence comes with CRONUS's No. Series data, so every cache has it, and
  removing it would change what the tests measure.
- **Isolation mode:** the only lever.
  - `"test"` is DOTests' current setting: one codeunit per call, with a rollback per test.
  - `"method"` runs every test alone, a fresh codeunit per test.
  - `"auto"` (R896) chooses `"method"` per codeunit only where its baseline passes strictly more.

## The baseline: 667 tests, Email area, the same build (e5176a9fd) and config apart from `isolation`

| isolation | #8002 refusals | passing | moves against `test` | baseline time |
|---|---|---|---|---|
| test | 95 | 559 | (control) | 7.7 min |
| method | 0 | 646 | **1** | 33 min |
| auto | 0 | 646 | **0** | 27 min |

- **Of the 95 refused tests,** `method` and `auto` pass 88, and 85 of those also pass on BC.
  - The other 3 are red at BC's own baseline, for environment reasons: a Linux font shaper, a CLR NotSupported
    error, and a UI handler.
  - The 7 left are refused by other families: a .NET ZipArchive write (5) and a placeholder Pdf (2).
- **`method`'s one move:** `CDO Variant Setup UI Tests.U_CopyCriteriaFromLine_TakesTheCriteriaOfThePickedLine`
  goes from pass to fail.
  - Its message handler reads codeunit globals that only earlier tests set.
  - BC's runner keeps a test codeunit's globals between tests, as `test` mode does. `method` resets them.
  - **This is why `method` cannot be a default.**
- **`auto` kept `test` for that codeunit** (35 passing under test, 34 under method) and chose `method` for the
  other 13.

## Per mutant: file 1 under `auto`, against `test` (PR-427) and BC (lethal-bugs' two halves)
- **The run:** capped at 4 h. It finished 747 of 1,703 mutants, and only those are compared (the
  coverage-differential rule: an unfinished mutant is "not measured", never "moved").
- **The join:** file, line, operator, AST hash and identity ordinal (the store has no start or end index). A
  repeated key is refused; there were none.
- **Result:**
  - 739 of the 747 have the same verdict on all three sides: 396 no-coverage, 135 killed, 208 survived.
  - Of the 4 where `test` agreed with BC and `auto` does not, **none is a wrong verdict**:
    - 2 kills (line 508, `condition-true` and `negate-guard`) by
      `CDO Email Send Tests.SendQueue_MockSenderFailsThenWorks_RetrySendsOnce`. That is a #8002-refused test
      that `auto` recovered, and BC fails it at its own baseline (the Linux font shaper), so BC cannot confirm or
      deny the kill. A baseline difference.
    - 2 errors (lines 449 and 594): refusals from OTHER families (unpinned `Report.SaveAs` shapes) in tests that
      `test` mode never ran. The fail-safe direction: not scored.
  - 4 more differ on every side or match `test`: 2 errors under both v3 modes where BC killed; 2 kills by both
    v3 modes where BC survived (lines 296 and 311, `remove-setrange`, already a v3-versus-BC difference under
    `test`).
- **What is NOT measured: the recovery itself.** Only 2 of the 152 lost kills are in the finished 747. Both stay
  `error` under `auto`, refused by another family (RecordRef not open).
  - Whether `auto` turns the 152 lost kills back into kills that match BC needs a run of those keys.
  - They sit on 96 lines of file 1: about 3 h at `auto`'s cost.

## The cost
- **Per covered mutant:** 37.6 s under `auto` (351 scored with coverage), against 3.2 s and 3.0 s in PR-427's
  two `test` runs. **About 12 times slower.**
- **The mutation rate:** about 21 mutants a minute until 19:22, then about 1 a minute once the mutants covered
  by `method`-chosen codeunits came up.
- **The baseline:** 27 min against 7.7 (3.5 times).
- **For DO's full project** (43,511 mutants), `auto` as it is would multiply the mutation phase by an order of
  magnitude.

## Recommendation (for the ruling)
1. **Do not set `auto` in DOTests' v3 config now.**
   - Its baseline is clean (0 moves, 88 tests recovered).
   - But it is about 12 times slower per covered mutant.
   - Its recovery of the 152 lost kills is unmeasured.
2. **If the recovery is worth measuring:** a targeted run of the 96 lines under `auto`, about 3 h, joined
   per key with BC. It answers whether the kills come back and match BC.
3. **Leave the real fix upstream:** #8002's runner-codeunit probe, which alrunner says is next. Once it lands,
   `test` mode runs these tests at `test` mode's cost.
