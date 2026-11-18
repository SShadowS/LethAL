# PR-180 design and pre-commitment: bcdev starts every test with the client's default WorkDate (R1127)

Coord PR-180 (lethal-code, 2026-11-18). Roadmap: R1127. Evidence so far: PR-161 (`/coord/handoff/PR-161/result.md`, cell
`Session.WorkDateAgainstToday`; sizing in `workdate/`).

**Revised before any build or run** after the spec-adversary review (2026-11-18). The first version is master f29d26a1. It gave a
leak as the reason for a per-method set, but BC's Test Runner already restores WorkDate after each codeunit (R-857). It also
added a `WorkDate(Today())` step that would have moved non-demo companies, claimed a new dependency the app already has, and
gave predictions that could pass without measuring the change.

## 1. The problem
- **A user's own BC test runner runs in a client session.** At company open, Base Application's `LogInManagement.CompanyOpen`
  calls `LogInStart` when `GuiAllowed` holds and the client is not `Background`. `LogInStart` then sets
  `WorkDate := GetDefaultWorkDate()`.
- **`GetDefaultWorkDate`** (codeunit 40, public, read in BC.History w1-28.6.55443.0):
  - in a demo company (`Company Information."Demo Company"`), it returns the posting date of the last G/L entry by
    `"Posting Date"`, through `NormalDate`, with security filtering ignored;
  - otherwise it returns `WorkDate()` unchanged.
- **al-runner v3 does the same** (upstream #5743, [[R771]]).
- **LethAL's bcdev path runs tests in an `ODataV4` session**, where `GuiAllowed` is false. `CompanyOpen` then sets WorkDate to
  the current date in the user's time zone. So bcdev starts a test on Today, while a client and v3 start it on the last G/L
  date (measured on bc3, PR-161).
- **The cost (R1127, by parse):** 699 tests read the default WorkDate without setting it, and 602 kills rest on them. On DO it is
  101 tests and 206 kills. That is an upper bound.

## 2. The change
1. **What the control app does.**
   - `LC Run Many.RunAll` computes `GetDefaultWorkDate()` once per call, after the suite resolves and before the loop. In the
     loop it calls `WorkDate(<it>)` before each method's run.
   - `LC Run Method.RunOneMethod` computes it and sets it before its run. This is the path of `RunMutant`,
     `RunMutantWithCoverage` and so the baseline.
   - **The place:** after `RunLine.FindFirst()` / `Line.FindFirst()`, and before `State.ResetObservedActive()` /
     `State.NoteTestMethodRun()`.
     - The R206 §2.1 pin requires `NoteTestMethodRun` to be the statement immediately before the run.
     - The GH-24 pin requires nothing between the reset and the note.
     - Both stay as they are. Nothing between the set and the run touches WorkDate.
2. **Why the set is placed before each run.**
   - BC's Test Runner starts every `RunTests` with `ALTestRunnerResetEnvironment.Initialize()` (codeunit 130453, SingleInstance).
     That stores the session's `WorkDate()`. Its `OnAfterCodeunitRun` subscriber puts that stored date back after every test
     codeunit.
   - So whatever is set immediately before the run is the date each method starts from, and the date restored after it.
   - R-857 measured on bc1 that a set WorkDate does not leak from one method to the next, on one-method calls or on grouped
     calls (`/coord/handoff/R-857/plan.md`).
   - So this change fixes the START date only. It does not close a leak: there is none.
   - Setting it before each method, not once per call, also covers a raise that escapes the runner's `CODEUNIT.Run` before
     `OnAfterCodeunitRun` restores the date.
   - **No `WorkDate(Today())` step.**
     - In a non-demo company, `GetDefaultWorkDate` returns the session's current WorkDate. That is OData's own default (the date
       in the user's time zone), or the date the previous call stored and restored, which follows the same rule. So a
       non-demo company keeps today's behaviour exactly.
     - Rejected: forcing `Today()` first would move a non-demo company to the server's UTC date, for hours a day where the
       user's time zone differs.
3. **No new dependency.**
   - `extensions/lethal-control/app.json` already declares `"application": "28.0.0.0"`, and Base Application comes through it.
     Codeunit 40 is callable as it is.
   - **Owner principles weighed:**
     - 1, 2 and 19 (correct first; one home for a fact). The control app calls BaseApp's own function, so each server applies
       its own BC's rule. Copying the rule through RecordRef would make a second home that drifts from BC's.
     - 20 (no change to platform objects): nothing in Base Application changes. Calling the function changes only codeunit 40's
       `LogInWorkDate` global, which only `LogInEnd` reads, and only in client sessions.
   - **Rejected alternative:** the client computes the date and passes it in. That moves BC's rule into TypeScript, and it needs a
     G/L read over the API.
4. **Version and the client.**
   - LethAL Control becomes 1.0.0.27, and `MIN_CONTROL_VERSION` becomes 1.0.0.27. A clean cutover with no toggle (principle 16;
     owner: no back-compat before release).
   - The 1.0.0.27 build is pinned in `bc-linux-setup.ts` (`CONTROL_APP`, `CONTROL_SHA256`).
   - `docs/gates/README.md` names the feature against the version.
5. **Not in this PR, filed as its own roadmap item:** the start date is now a live read, and no record shows its value.
   - In a demo company the start date comes from the last G/L entry, read again on every call. If someone posts in the same
     company during a run (a shared sandbox, an envtool environment, a job queue that commits outside test isolation), later
     calls start on a different date than the baseline.
   - Kill confirmations re-run unmutated under the new date, so such a kill turns `unstable` (an error), not a false kill. But
     kills can be lost silently, and no report shows which date any call used.
   - The fix: each answer returns `workDate`; the client refuses a mutant or confirm answer whose date differs from the
     baseline's, by name; and the report records the baseline's date. That gets its own item, filed with this PR.
6. **Tests.** `packages/runner/tests/control-app-source.test.ts` pins, by source:
   - in `RunAll` and `RunOneMethod`, a `WorkDate(` set of the computed default comes after the `FindFirst` that positions the
     run, and before `ResetObservedActive` / `NoteTestMethodRun`;
   - the default comes from `GetDefaultWorkDate()`, and from nothing else.

   The existing R206 §2.1 and GH-24 pins stay unchanged and green. Each new pin gets a red check in both directions.

## 3. What could go wrong (to measure, not assume)
- **Permissions:** `GetDefaultWorkDate` carries `InherentPermissions` for reading `G/L Entry`, and codeunit 1306 reads
  `Company Information` under its own. Any failure is loud: a raise in the computation becomes a run error, never a kill. M1
  exercises it on bc4.
- **The BC version:** only w1-28.6's source was read. bc1-bc3 run 28.4 and bc4 runs 29.0. Each server applies its own BC's rule,
  which is the intent, but M1 measures 29.0 only. A 28.4 server gets 1.0.0.27 through setup after the merge, with no P2-type
  check. Named as a gap.

## 4. Measurements and predictions (bc4, BC 29 W1, CRONUS, a demo company; under lethal-code's lease)
The owner's yes for the branch-build publish: q-20261118T211907-da722689. Nothing live runs before it.

**Run order.** 1.0.0.26 cannot be republished once 1.0.0.27 is on bc4 (a downgrade), so every 1.0.0.26 leg runs first: M1(a),
then the M2 1.0.0.26 run. Then 1.0.0.27 is published, then M1(b) and M2's 1.0.0.27 run, then M3.

- **M1, an invented probe pair** (`/coord/handoff/PR-180/probe/`, scratch ids 76100-76149, checked free on bc4 first). Target:
  `P180 Target.Two`. Tests in one codeunit:
  - `A_SetsWorkDate` sets 1 January 2001 and calls `Two`;
  - `B_ReadsWorkDate` calls `Two` and fails "LEAK" only if WorkDate is 1 January 2001;
  - `C_Measured` is always red, `MEASURED wd today lastgl demo`. `lastgl` comes from its own `G/L Entry` read (NormalDate of
    the last posting date), never from `GetDefaultWorkDate`.
  - **Runs:**
    - (a) `lethal run --backend bcdev` under 1.0.0.26;
    - (b) the same under 1.0.0.27;
    - (c) BC's dev-endpoint test runner (a client session) as the reference, once.
  - **Precondition (read in (a)):** `lastgl` is not `0D` and not `today`, and `demo` is Yes. Otherwise M1 is void, not passed.
  - **P1:** (a) gives `wd` = `today`.
  - **P2:** (b) gives `wd` = `lastgl` = (c)'s `wd`. This is the change's positive evidence.
  - **P3 (a regression check):** in (a) and (b), every mutant on `Two` (covered by A and B, both green at baseline) is
    `survived`, with A and B run in ONE `RunMutantMany` call. That means `ranCount` 2, read from the `group-call` events. If
    the client split them into two calls, P3 is "not measured", not passed.
  - Afterwards both probe apps are uninstalled and unpublished.
- **M2, DO's WorkDate tests.**
  - **The set:** the DO rows of PR-161's `workdate/tests.tsv` (101 tests), on bc4's DO Test 30.0.0.1.
  - **Runs:** a normal bcdev run under each version, narrowed to ONE `--lines` site, with `--tests-only` on those tests' files and
    `--stop-hung-sessions`.
    - Its baseline is the measurement. The mutant rows are recorded, not counted.
    - The same site is used in both runs: the one with the fewest covering tests, with a v3 hang check first.
    - A baseline-only run would need a SIGTERM after the baseline, and a live BC run is not signalled.
    - DO is restored afterwards, above the instrumented version, as in PR-155 and PR-170.
  - **Compared per test** with x3's stored v3 baseline (`/coord/handoff/R-984/x3.run.report.json`).
  - **P4:** every test whose bcdev outcome changes between the two runs changes to v3's outcome. Any change away from v3 is named
    and read before anything lands.
  - **P5:** at least one of these tests changes toward v3.
    - If none changes, M2 shows no effect on DO. That is recorded, not a block, and P2 alone is the positive evidence.
    - Run-to-run noise is read by name: a changed test whose outcome text does not involve dates is listed apart.
- **M3, the frozen gates (a regression check).**
  - No fixture of a bcdev gate reads the default WorkDate. By grep, only `sandbox-dates` and `sandbox-order` mention it, both
    v3-only, and their tests set it.
  - **P6:** every gate in bc4's proof table passes under 1.0.0.27 on the final head, with no frozen figure moved. A moved figure
    is a BLOCK. P6 checks the publish path and the build; it is not evidence for the WorkDate change.
- **The control-app rule:** an `alc` compile, and the hang gate on bc4 under 1.0.0.27.
- **Frozen campaign stages not re-run here,** whose next re-freeze must expect a possible move:
  - the gift-card stage (bc-demo, parked);
  - the bcdev DO stages under `docs/campaign/2026-08-03-do/` (rung1, rung2).

## 5. What stays on bc4
- 1.0.0.27 stays installed after the measurement. A dev-endpoint republish of 1.0.0.26 would be refused as a downgrade.
- The 1.0.0.26 client accepts 1.0.0.27 (it is a minimum).
- If the change is rejected, lethal-code asks the owner for the unpublish and the republish of 1.0.0.26.
- The other servers get 1.0.0.27 through the setup script after the merge, as every control bump does.
