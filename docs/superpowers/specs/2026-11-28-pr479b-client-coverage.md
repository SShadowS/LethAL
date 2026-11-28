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

## Amendment 1 (2026-11-28, the spec-adversary's r1 review and the orchestrator's F1 ruling, before any measurement)
Evidence: `/coord/handoff/PR-479/adversary-479b-r1.md` and `/coord/handoff/PR-479/m4/result.md`. Amendment 1 overrides the
text above where they differ.

1. **No truncation inside a codeunit (F1; ruling, overturning B1's prefix for client mode).**
   - Coverage chooses the covering CODEUNITS and the `no-coverage` mutants. Each covering codeunit then runs its FULL
     declared run, in its own fresh session (479a's run).
   - **The reason:** a test codeunit's methods share one instance and one isolation. With the common `Initialize()`
     pattern, only method 1 runs the setup, so per-test coverage credits the setup to method 1 alone, while later methods
     observe its data. Truncating to "the last covering method" would switch off the methods that see a mutant in the setup:
     a false survivor.
   - Section 2 items 3 and 5 (the prefix filter) and M7 are WITHDRAWN.
   - Truncation returns only with a pre-committed probe shown both ways on an Initialize-style fixture.
2. **A measured Initialize case** (ruling), outside the repo, with invented identifiers: `/coord/handoff/PR-479/initfix/`.
   - **The target app:** one setup procedure (it writes a setup record with a computed value) and one checking procedure
     (it reads the value).
   - **The test codeunit:** method 1 calls `Initialize()` (`if IsInitialized then exit; <setup through the target>;
     IsInitialized := true`) and asserts only that the record exists. Method 2 calls `Initialize()` too (a no-op by then)
     and asserts the computed value through the checking procedure.
   - **The mutant:** one, in the setup's computation.
   - **Pre-committed:**
     - per-test coverage credits the setup procedure to method 1 ONLY;
     - the mutant is `killed` by method 2 on bcdev-client with coverage on;
     - the no-mutant confirmation passes;
     - the reproduction fails method 2 again.
   - **Negative control:** a scratch run that DOES truncate to method 1 scores it `survived`, which shows the case can
     fail. That run is a measurement only, never a code path.
3. **Per-codeunit coverage, if M1 finds no per-test setting (F2):**
   - the merged coverage chooses codeunits;
   - the attribution is a new `codeunit` value (with its `ATTRIBUTION_INTERPRETATIONS` entry), never `exact`;
   - a mutant whose covering codeunit holds a baseline-red or unscored method is declined to `error` with R140's note, never
     scored `survived`;
   - `no-coverage` is taken across ALL methods (red ones included), and only on a download shown complete (item 5).
   - The per-test index is not fed merged rows.
4. **Coverage outside any per-test window (F3):**
   - a scratch test app plants target code reached only from the test codeunit's `OnRun`, and code reached only from an
     `OnBeforeTestMethodRun` subscriber in the test app;
   - pre-committed: each appears in the coverage, and where;
   - if one appears nowhere, coverage on this backend is refused.
5. **No silent emptiness (F4, F5).**
   - **What the mapping really does:** in `buildFencedCoverageMap` a naming gap is a warning plus `unplaceable`, and rows
     whose object type does not map are skipped. So `client-fenced` adds real refusals:
     - (a) a per-test WITNESS: each baseline-green test's rows must include lines inside that test method's own body in
       the test codeunit, else `client-coverage-no-witness`;
     - (b) zero declared rows while some test is green is `client-coverage-empty`.
   - **Completeness:** every chunk ends in a line terminator, and every row has the exact column count. Completeness is a
     COUNT: `CCInfo`'s count if it has one, otherwise two downloads that must be equal. A forced leg cuts the text mid-row
     and expects a refusal.
6. **M4, sharpened (F6).**
   - **The probe:** `probe-r58-differential.ts`'s per-test layer is fixed to read per-test sets from the same baseline
     verdicts `buildCoverageIndex` reads. Today it records them from `run()` only, so OverBudgetDetected's set reads empty.
   - **Compared per mutant:**
     - the covering-test SET;
     - `coverageAttribution`;
     - `unplaceable`.
   - **Compared per test:**
     - the member set, where the reference is non-empty (an empty reference is "not measured", never "equal"; an empty
       CLIENT set for a green test is a refusal, through item 5's witness);
     - the RAW hit rows `(objectType, objectId, lineNo)` in declared objects. Headless from `dumpFencedCoverage`, client from
       the parser; they must be equal, since both come from the same instrumented artifact. This replaces M3's naming-gap
       check.
   - **Fixtures:** sandbox-app, sandbox-data, and initfix (item 2).
   - **The sandbox-data difference allowed:** PageActionComputesNonZero's own coverage only (headless refuses that test).
7. **The sandbox-data table (F7), replacing section 3 item 2's expected-difference rule.**
   - The GetValue mutants (the `Data Value Source` GetValue sites, which are `no-coverage` headless, R78) are pre-committed
     BY KEY: under the client they are `killed` by `PageActionComputesNonZero`.
   - Any OTHER mutant whose client killer is `PageActionComputesNonZero` is a BLOCK.
   - Every other mutant's verdict and killer must be equal.
   - The circular count from a coverage-off run is withdrawn.
8. **Two caveats, not one (F8):**
   - `client-no-coverage` now means coverage only, on a coverage-off run;
   - a new, always-on `client-mode-risks` carries 479a's open-risks list on EVERY bcdev-client report (with the CLAUDE.md
     caveat ripple).
9. **Coverage must not change the baseline (F9):**
   - set `CCTrackAllSessions` = false, and read it back;
   - `ClearCodeCoverage` before each baseline codeunit, then a download that must be empty and complete (a stale-row
     control);
   - M5 also runs on sandbox-data (which writes data);
   - M6 also times one mutant session after a coverage-on baseline against one after a coverage-off baseline.
10. **What "per test" means (F10):**
    - per-test rows must CARRY their codeunit and method (or come from `CCMapCSVText` per test), never "the download that
      followed a call", because one RunNextTest runs a whole codeunit;
    - positive control: sandbox-tests' two methods have disjoint, non-empty sets;
    - if attribution comes from the map CSV, the parser of section 2 item 2 is amended before the build.
11. **The stored mode (F11).**
    - **Kept:** `client-fenced`.
    - **The cost, named:** an OLDER client reading such a store row throws "corrupt coverage mode" (`parseCoverageMode`)
      through its unfiltered queries. That is loud, never wrong.
    - **To update:** explain's `KNOWN_COVERAGE_MODES`, and the store's parser.
12. **Wiring (F12):**
    - the line map and object filter are built for `client-fenced` as for `fenced`;
    - the coverage download happens before page 130455 closes, within the 540 s op deadline;
    - the `declared` list passed to `checkClientRun` is always the TypeScript side's list from the manifest, never the
      page's read-back (with a red test).
