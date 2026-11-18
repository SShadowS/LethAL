# PR-180 design and pre-commitment: bcdev starts every test with the client's default WorkDate (R1127)

Coord PR-180 (lethal-code, 2026-11-18). Roadmap: R1127. Evidence so far: PR-161 (`/coord/handoff/PR-161/result.md`, cell
`Session.WorkDateAgainstToday`; sizing in `workdate/`).

## 1. The problem
- **A user's own BC test runner runs in a client session.** At company open, Base Application's `LogInManagement.CompanyOpen`
  calls `LogInStart` when `GuiAllowed` holds and the client is not `Background`. `LogInStart` then sets
  `WorkDate := GetDefaultWorkDate()`.
- **`GetDefaultWorkDate`** (codeunit 40, public, read in BC.History w1-28.6.55443.0):
  - in a demo company (`Company Information."Demo Company"`), it returns the posting date of the last G/L entry by
    `"Posting Date"`, through `NormalDate`, with security filtering ignored;
  - otherwise it returns `WorkDate()`, the session's own default, which is Today.
- **al-runner v3 does the same** (upstream #5743, [[R771]]).
- **LethAL's bcdev path runs tests in an `ODataV4` session**, where `GuiAllowed` is false. `CompanyOpen` then sets WorkDate to
  the current date in the user's time zone. So bcdev starts a test on Today, while a client and v3 start it on the last G/L
  date (measured on bc3, PR-161).
- **The cost (R1127, by parse):** 699 tests read the default WorkDate without setting it, and 602 kills rest on them. On DO it is
  101 tests and 206 kills.

## 2. The change
1. **What the control app does.** It computes the client's default WorkDate once per call, then sets it before every test
   method it runs.
   - `LC Run Many.RunAll` computes it after the suite resolves and before the loop. In the loop it calls
     `WorkDate(<it>)` immediately before `Mgt.RunTests`, so after `NoteTestMethodRun` and before the run.
   - `LC Run Method.RunOneMethod` does the same before `Mgt.RunAllTests`. This is the path of `RunMutant` and
     `RunMutantWithCoverage`.
   - **The computation:** `WorkDate(Today())`, then `WorkDate(LogInManagement.GetDefaultWorkDate())`.
     - The first step makes the non-demo branch return Today, not a date that an earlier call's test left in a reused
       session (the session-freshness counter, R206, shows that sessions are reused).
     - Then the result is BaseApp's own answer.
2. **Why per method, not once per call.**
   - bcdev's baseline runs each method in its own call, so the baseline never sees a WorkDate that an earlier test set.
   - A mutant's `RunMutantMany` call runs several covering tests in one session. There, a WorkDate one test sets reaches the
     next test today, under the mutant only. That is a baseline/mutant asymmetry (a false-kill shape).
   - Setting the default before each method removes it. Each method then starts as it does at the baseline.
   - **This deliberately does not copy BC's standard runner,** which keeps a set WorkDate across the whole run (one session, R857
     on v3). bcdev already gives every method fresh globals and SingleInstance state (PR-161). The WorkDate now follows the same
     per-method model.
3. **The dependency.** The control app gains a dependency on Microsoft's Base Application (minimum 28.0.0.0, which BC 29
   satisfies) and calls codeunit 40 directly.
   - **Owner principles weighed:**
     - 1, 2 and 19 (correct first; one home for a fact). Copying the rule through RecordRef would make a second home that
       drifts from BC's.
     - 14 (no new dependencies). It is aimed at outside packages; Base Application is the platform every test app already
       depends on.
     - 20 (no change to platform objects): nothing in Base Application changes. Calling the function changes only codeunit 40's
       `LogInWorkDate` global, which only `LogInEnd` reads, and only in client sessions.
   - **Rejected alternative:** the client computes the date and passes it as a parameter. That moves BC's rule into TypeScript,
     and it needs a G/L read over the API.
4. **Version and the client.**
   - LethAL Control becomes 1.0.0.27, and `MIN_CONTROL_VERSION` becomes 1.0.0.27. A clean cutover with no toggle (principle 16;
     owner: no back-compat before release).
   - The 1.0.0.27 build is pinned in `bc-linux-setup.ts` (`CONTROL_APP`, `CONTROL_SHA256`).
   - `docs/gates/README.md` names the feature against the version.
   - No report field: the rule is fixed by the version, and every run records the control app's version.
5. **Tests.** `packages/runner/tests/control-app-source.test.ts` pins, by source:
   - in `RunAll` and `RunOneMethod`, a `WorkDate(` set is the statement immediately before `RunTests` / `RunAllTests` (after
     `NoteTestMethodRun`);
   - the default is computed by `GetDefaultWorkDate` after `WorkDate(Today())`.

   Each pin gets red checks both ways.

## 3. What could go wrong (to measure, not assume)
- **Permissions:** the OData user's permission set must let codeunit 40 read `Company Information` and `G/L Entry`. Codeunit 40
  declares `Company Information` read itself. M1 measures the G/L read.
- **A BC test library that resets WorkDate at codeunit start:** that is not changed, because the set happens before the runner
  starts the method.
- **Time zones:** for a non-demo company, the OData session's default was the date in the user's time zone. After the change it is
  the server's `Today()`. These differ only around midnight. Recorded; not measured.

## 4. Measurements and predictions (bc4, BC 29 W1, CRONUS, a demo company; under lethal-code's lease)
The owner's yes for the branch-build publish: q-20261118T211907-da722689. Nothing live runs before it.

- **M1, an invented probe pair** (scratch ids 76100-76149, checked free on bc4 first).
  - **The cell:** one test that `Error`s
    `MEASURED wd=%1 today=%2 lastgl=%3 demo=%4 set2001=%5`, where:
    - `lastgl` is the G/L entry's last posting date, through NormalDate;
    - `set2001` is a second test, run after a first test that sets WorkDate to 1 January 2001 in the same codeunit.
  - **Runs:**
    - (a) bcdev baseline through `lethal run --backend bcdev`, under 1.0.0.26;
    - (b) the same under 1.0.0.27;
    - (c) BC's dev-endpoint test runner (a client session), as the reference.
  - **P1:** (a) gives `wd` = `today`.
  - **P2:** (b) gives `wd` = `lastgl` = (c)'s `wd`, and `demo` = Yes.
  - **P3:** in (b), the read in the second test of the same call is `lastgl`, not 1 January 2001. That shows the per-method set.
    It runs as a mutant call: a mutant covered by both tests, with the first test passing, so both run in one `RunMutantMany`.
  - Afterwards both probe apps are uninstalled and unpublished.
- **M2, DO's WorkDate tests.**
  - **The set:** the DO rows of PR-161's `workdate/tests.tsv` (101 tests), restricted to the test codeunits on bc4's DO Test
    30.0.0.1.
  - **Runs:**
    - a bcdev baseline under 1.0.0.26, through `--tests-only` on their files;
    - the same under 1.0.0.27;
    - compared per test with x3's stored v3 baseline (`/coord/handoff/R-984/x3.run.report.json`).
  - **P4:** the number of these tests whose bcdev outcome equals v3's is at least as high under 1.0.0.27 as under 1.0.0.26.
  - **P5:** every test whose bcdev outcome changes between the two runs changes to v3's outcome. Any change away from v3 is named
    and read before anything lands.
  - **Each is a normal bcdev run narrowed to ONE `--lines` site,** with `--tests-only` on the WorkDate tests' files and
    `--stop-hung-sessions`.
    - Its baseline is the measurement. The few mutant rows are recorded, not counted.
    - A baseline-only run needs a SIGTERM after the baseline (`--time-budget 1` skips the baseline, R955), and a live BC run
      is not signalled.
    - The same site is used in both runs, chosen so that it has the fewest covering tests, with a v3 hang check first.
  - DO is instrumented, so it is restored afterwards, above the instrumented version, as in PR-155 and PR-170.
- **M3, the frozen gates.**
  - No fixture of a bcdev gate reads the default WorkDate. By grep, the only WorkDate fixtures are `sandbox-dates` and
    `sandbox-order`, both v3-only, and their tests set it.
  - **P6:** every gate in bc4's proof table passes under 1.0.0.27 on the final head, with no frozen figure moved.
  - A moved figure is a BLOCK, read before anything else.
  - The gift-card campaign stage (bc-demo, parked) reads WorkDate. It is not re-run; its next re-freeze must expect a possible
    move.
- **The control-app rule:** an `alc` compile, and the hang gate on bc4 under 1.0.0.27.

## 5. What stays on bc4
- 1.0.0.27 stays installed after the measurement. A dev-endpoint republish of 1.0.0.26 would be refused as a downgrade.
- The 1.0.0.26 client accepts 1.0.0.27 (it is a minimum).
- If the change is rejected, lethal-code asks the owner for the unpublish and the republish of 1.0.0.26.
- The other servers get 1.0.0.27 through the setup script after the merge, as every control bump does.
