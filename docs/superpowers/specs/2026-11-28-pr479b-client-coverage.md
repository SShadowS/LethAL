# PR-479 (479b) pre-commitment: client-session coverage through page 130455, then B1's prefix and TestPage scoring

Coord PR-479 (lethal-preproc, 2026-11-28). Spec only: nothing is built until section 1's measurements are in and this file
is amended with them.
- **Builds on 479a:** `2026-11-28-pr479a-bcdev-client-driver.md`, amendments 1-4. bcdev-client is experimental, coverage
  off, every mutant runs every test codeunit's full declared run, and every report carries `client-no-coverage`.
- **Design:** `2026-11-22-pr325-client-session-harness.md`:
  - A4: coverage is measured in a client session before client mode scores anything, never assumed from headless;
  - B1: the declared prefix up to the last covering method;
  - B5: TestPage tests are scored once the page-part probe passes, which it did (R1170, PR-478).

## Why
- 479a's survivors include mutants no test reached, because coverage is off. 479b gives client mode its own coverage:
  - a mutant no test reaches becomes `no-coverage`, as on headless;
  - each mutant runs only the codeunits that cover it, and in each only the declared prefix up to its last covering method;
  - `client-no-coverage` is no longer needed on a run with coverage on.
- **Page 130455 has the controls** (BC 28.4, dumped on bcwin in PR-478): `CCTrackingType`, `CCMap`, `CCTrackAllSessions`,
  `CCExporterID`, `CCResultsCSVText`, `CCMapCSVText`, `CCInfo`, and the actions `GetCodeCoverage`, `GetCodeCoverageMap`,
  `ClearCodeCoverage`.

## 1. Measure first, on bcwin (each pre-committed; nothing is built on a guess)
Fixture: `sandbox-app` (instrumented and registered by a real LethAL run) and `sandbox-tests` (codeunit 79100, methods
OverBudgetDetected and ClampPercentRuns), driven by the repo client driver (479a).

- **M1. The settings that give PER-TEST coverage.** Try `CCTrackingType` values and `CCMap` values. Record:
  - which pair yields coverage rows attributable to ONE test method;
  - when the rows are available (after each `RunNextTest`, or only after the codeunit);
  - whether `ClearCodeCoverage` between methods is needed.
  - **Prediction:** a per-test setting exists, and its rows arrive per `RunNextTest`.
  - **If no setting gives per-test rows,** coverage is per CODEUNIT only, and section 2's prefix rule falls back to "every
    method of a codeunit that covers the mutant". That is still B1-safe: the whole declared run.
- **M2. The text format and its completeness.**
  - Record `CCResultsCSVText`'s columns, how a large result is split across several `GetCodeCoverage` calls, and what
    `CCInfo` says when the download is complete.
  - **Prediction:** each row carries an object type, object id, line number and hit count.
  - A result that cannot be shown complete (no end marker) is a refusal, never a partial index.
- **M3. The line frame.**
  - Confirm the rows' line numbers are in the INSTRUMENTED source's frame (the file LethAL emitted and published), as
    headless fenced coverage's are.
  - The check: map every row through the line map (as below), and assert that every row inside a target object lands in
    a known procedure. `namingGaps` must be empty for the fixture.
- **M4. Equality with headless, on the fixture.**
  - **Prediction:** for sandbox-app, each test's covering member set (object, procedure, overload) from client coverage
    EQUALS the same test's set from headless fenced coverage. The comparison is `scripts/probe-r58-differential.ts`
    `--mode fenced` on bc2, joined by test and member.
  - **Allowed differences, each named:** a branch reachable only with `GuiAllowed` true. The fixture has none, so on the
    fixture any difference is a BLOCK until explained.
- **M5. No interference.** With coverage on, the attestation rows and the page results for both methods equal 479a's
  coverage-off run, field for field except the ids and times.
- **M6. Cost.** Record per codeunit run: the time with coverage on against off, and the size of the result text. Measured,
  not claimed.

## 2. What is built after section 1 is amended with the measurements
1. **Collection.** In the baseline only, the client driver sets the M1 settings, then after each `RunNextTest` (or each
   codeunit, per M1) downloads the full result per M2, and returns it raw. The mutant runs collect nothing.
2. **The join, reusing the headless pipeline unchanged:**
   - parse each row into `FencedCoverageRow {objectType, objectId, lineNo, hits}`, keeping rows with hits > 0 only;
   - per test method, call `BcDevMcpBackend.buildFencedCoverageMap(rows, ref)`. It maps lines through the line map of the
     emitted source, gives `CoverageEntry {objectType, objectId, procedure, line, overloadIndex}`, and reports
     `namingGaps`;
   - then `buildCoverageIndex(baseline)` and `coverageFilter(mutants, index, tests)`, exactly as the fenced mode does.
   - Nothing in the join is new code, except the parser. A naming gap or an unmappable row is the existing named
     refusal.
3. **Scoring with coverage on:**
   - a mutant with no covering test is `no-coverage`;
   - otherwise, per covering codeunit in the fixed order, run the declared prefix from the first method up to and including
     the LAST covering method (B1). A method inside the prefix that does not cover the mutant still runs. Nothing is
     switched off;
   - the no-mutant confirmation and the reproduction (479a, amendment 1 item 2) replay the SAME prefix in fresh sessions;
   - every row check, the reach rule and the killer rule are unchanged from 479a.
4. **The coverage mode recorded** is new: `client-fenced`. It is distinct from every headless mode, so the R354 checks and
   479a's never-mixed refusals keep client and headless coverage apart. A run with coverage on does NOT carry
   `client-no-coverage`; a run with `--coverage none` on this backend still does.
5. **The method filter for a prefix:**
   - the driver sets `TestProcedureRangeFilter` to the prefix's methods;
   - the read-back (479a, amendment 3) must equal the PREFIX in declared order, both ways, all Run = true;
   - that M7 ("a range filter selects exactly the prefix") is measured on bcwin first, with a negative control (a filter
     naming a method not in the codeunit must fail the read-back).
6. **TestPage tests (B5):**
   - scored in client mode, because R1170 (6)'s probe passed: `Data Tests.PageActionComputesNonZero` passes in a `/cs`
     session;
   - they can be killers, and `client-ran-testpage-unscored` is retired on a coverage-on run;
   - headless still refuses them.

## 3. The pre-committed bcwin tables (after section 1)
1. **sandbox-app plus sandbox-tests,** coverage on. The per-mutant verdict, killing test and covering set equal
   `itest:bcdev`'s frozen table, now INCLUDING the six `no-coverage` mutants as `no-coverage`. Any difference is a BLOCK.
2. **sandbox-data plus sandbox-data-tests,** coverage on. The verdicts equal `itest:tables`' frozen table, with ONE expected
   class of difference: mutants whose only killer in the client run is the TestPage test `PageActionComputesNonZero` (which
   headless refuses). For those, the client verdict may be `killed` where headless says `survived`. The receipt lists each
   by name.
   - **Pre-committed count:** measured first in a coverage-OFF 479a run on bcwin (how many mutants that test kills alone),
     then fixed here before the coverage-on run. Any other difference is a BLOCK.
3. **Forced legs:**
   - a coverage download cut short is a refusal, never a partial index;
   - a prefix filter that selects an extra or a missing method fails the read-back (M7's negative control);
   - a row outside every known procedure is the existing naming-gap refusal.

## 4. Proof before submit
- VERIFY.
- **Red tests, both directions,** for:
  - the parser (complete, cut short, malformed);
  - the prefix computation;
  - the coverage-mode separation (`client-fenced` never lends to or compares with a headless mode);
  - the caveat's presence on coverage-off runs and absence on coverage-on runs;
  - TestPage scoring (only on this backend).
- A spec-adversary on this file after section 1 is amended. An Opus build review.
- Headless gates 0 moves on the final head, the v3 gate, CI, and the bcwin tables above.
- bcdev-client stays experimental through 479b. Lifting the flag is its own ruling.
