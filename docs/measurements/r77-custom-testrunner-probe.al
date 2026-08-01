// R77 FEASIBILITY PROBE — can LethAL supply its OWN test runner?
//
// NOT part of the shipped app. Kept as the record behind ROADMAP R77, the way
// r58-coverage-feasibility-probe.al is kept for R58.
//
// QUESTION: LethAL's `LC Run Method` calls `Test Suite Mgt.RunAllTests`, which drives Microsoft's
// DEFAULT runner. Mutant activation therefore has to happen OUTSIDE the test session, which is why
// the bcdev hub cannot carry a verdict at all (`runOnHub` never activates, so every mutant would
// run unmutated code and every result would be a silent false survivor) and why attestation —
// SingleInstance, session-local — cannot be read back across a pooled OData call.
//
// A custom `Subtype = TestRunner` codeunit runs INSIDE the test session, so it could activate in
// OnBeforeTestRun and read attestation in OnAfterTestRun, in the same session as the test, on ANY
// transport.
//
// MEASURED 2026-08-01, offline alc against LethAL Control's EXISTING symbols (sole dependency:
// Microsoft `Test Runner`) — COMPILES CLEAN, so the extension point is reachable with no new
// dependency:
//   * `Subtype = TestRunner` with OnBeforeTestRun/OnAfterTestRun — accepted.
//   * `Record "AL Test Suite"."Test Runner Id"` — settable. (The guessed name
//     "Test Runner Codeunit ID" does NOT exist; alc rejected it. The real field was found in the
//     Test Runner symbol package, which also exposes `Test Suite Mgt.ChangeTestRunner`,
//     `GetDefaultTestRunner`, `GetCodeIsolationTestRunner`, `GetIsolationDisabledTestRunner`.)
//
// WHAT THIS DOES **NOT** ESTABLISH — all unmeasured, and each can still kill the idea:
//   1. Whether `bcdev_test_run` runs a suite LethAL controls, or builds its own — if the hub never
//      uses our suite, our runner never loads and none of this reaches the hub.
//   2. Whether OnBeforeTestRun runs INSIDE the platform's per-test isolation, and what that does to
//      a write. (In-memory SingleInstance state is not transactional and should survive; a table
//      write may roll back. The activation LethAL needs is the in-memory half, so this is probably
//      fine — "probably" is not measured.)
//   3. Whether replacing the runner changes isolation semantics, which would move verdicts.
//   4. Whether a custom runner survives `TestPermissions` and the fenced session's own limits.
//
// Do not cite this as "the hub can run mutants". It establishes exactly one thing: the runner
// extension point compiles and the suite field is settable.

namespace LethAL.Control;
using System.TestTools.TestRunner;

codeunit 71098 "LC Runner Probe"
{
    Subtype = TestRunner;

    trigger OnBeforeTestRun(CodeunitID: Integer; CodeunitName: Text; FunctionName: Text; FunctionTestPermissions: TestPermissions): Boolean
    begin
        exit(true);
    end;

    trigger OnAfterTestRun(CodeunitID: Integer; CodeunitName: Text; FunctionName: Text; FunctionTestPermissions: TestPermissions; IsSuccess: Boolean)
    begin
    end;
}

codeunit 71099 "LC Suite Runner Probe"
{
    procedure SetRunner(SuiteName: Code[10]; RunnerId: Integer)
    var
        ALTestSuite: Record "AL Test Suite";
    begin
        ALTestSuite.Get(SuiteName);
        ALTestSuite."Test Runner Id" := RunnerId;
        ALTestSuite.Modify(true);
    end;
}
