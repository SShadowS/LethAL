namespace LethAL.Control;

using System.TestTools.TestRunner;

/// <summary>
/// PHASE 2 of the two-phase RunMutant fence (design §5): the catchable boundary around the
/// single-method test invocation. The caller sets the request, then invokes this codeunit through
/// <c>if not Runner.Run() then</c>, so a server-known terminal error (a test-framework or AL
/// exception) is CAUGHT instead of unwinding the OData action — which would skip phase 3 and strand
/// the op marker, producing a false 'container-needs-recycle'.
///
/// WHY Codeunit.Run AND NOT [TryFunction]. A [TryFunction] forbids Commit anywhere in its call tree
/// at runtime, and this call tree commits: <c>Test Suite Mgt.RunAllTests</c> drives the platform test
/// runner, whose per-test isolation and result persistence commit between methods, and RunOneMethod
/// itself calls <c>ALTestSuite.Delete(true)</c> / <c>Line.Modify(true)</c> ahead of it. Wrapping that
/// in a [TryFunction] would convert every ordinary run into a runtime failure. Codeunit.Run has no
/// such restriction and gives a clean rollback boundary. Phase 1 has already committed before this
/// runs, so the rollback of a caught phase-2 error can never undo the claim (that ordering is exactly
/// why design §5 puts a Commit at the end of phase 1).
///
/// Parameters travel on THIS instance, not on the SingleInstance "LC Control State": Run() invoked on
/// a codeunit VARIABLE executes that variable's own instance, so globals set by SetRequest are visible
/// in OnRun, and Results() is read only on the success path (where nothing rolled back).
/// </summary>
codeunit 91007 "LC Run Method"
{
    var
        SuiteName: Code[10];
        TestCodeunitId: Integer;
        TestMethod: Text;
        ResultsJson: Text;
        FenceAttemptId: Text;
        FenceOpSeq: BigInteger;
        FenceIndex: Integer;
        MethodToken: Text;

    trigger OnRun()
    var
        State: Codeunit "LC Control State";
    begin
        // R198: the progress row's `running` write sits INSIDE this boundary, never in the gap
        // between phase 1's Commit and Run(): a raise there would unwind past phase 3 and strand the
        // marker. Fence-less callers (the permission canary) write no progress.
        if FenceAttemptId <> '' then
            MethodToken := State.ProgressBegin(FenceAttemptId, FenceOpSeq, FenceIndex, TestCodeunitId, TestMethod);
        ResultsJson := RunOneMethod(SuiteName, TestCodeunitId, TestMethod);
    end;

    /// <summary>Sets the one method to run. Clears any previous result so a Results() read can never
    /// return a stale prior run's JSON. Also clears the fence coordinates: a caller that wants
    /// progress written must SetFence AFTER SetRequest, every time.</summary>
    procedure SetRequest(NewSuiteName: Code[10]; NewTestCodeunitId: Integer; NewTestMethod: Text)
    begin
        SuiteName := NewSuiteName;
        TestCodeunitId := NewTestCodeunitId;
        TestMethod := NewTestMethod;
        ResultsJson := '';
        FenceAttemptId := '';
        FenceOpSeq := 0;
        FenceIndex := 0;
        MethodToken := '';
    end;

    /// <summary>R198: names the op this method runs inside and its 1-based index within it, so
    /// OnRun writes the progress row's `running` state before the method and RunOneMethod its
    /// `between` state the instant RunAllTests returns. Index 1 for a single-method op.</summary>
    procedure SetFence(AttemptId: Text; OpSeq: BigInteger; Index: Integer)
    begin
        FenceAttemptId := AttemptId;
        FenceOpSeq := OpSeq;
        FenceIndex := Index;
    end;

    /// <summary>The token ProgressBegin minted for this method, or blank without a fence.</summary>
    procedure Token(): Text
    begin
        exit(MethodToken);
    end;

    /// <summary>The codeunit's per-method result JSON from the last successful Run(). Meaningful only
    /// when Run() returned true — on a caught error the caller reports GetLastErrorText instead.</summary>
    procedure Results(): Text
    begin
        exit(ResultsJson);
    end;

    /// <summary>Build a fresh suite, run EXACTLY the one named method (Run flags, since RunAllTests
    /// resets input filters), return the codeunit's per-method result JSON. Fail closed unless exactly
    /// one method matches.</summary>
    local procedure RunOneMethod(RunSuiteName: Code[10]; RunTestCodeunitId: Integer; RunTestMethod: Text): Text
    var
        ALTestSuite: Record "AL Test Suite";
        State: Codeunit "LC Control State";
        Line: Record "Test Method Line";
        CodeunitLine: Record "Test Method Line";
        Mgt: Codeunit "Test Suite Mgt.";
        ErrObj: JsonObject;
        ErrJson: Text;
        MatchCount: Integer;
    begin
        if ALTestSuite.Get(RunSuiteName) then
            ALTestSuite.Delete(true);
        Mgt.CreateTestSuite(RunSuiteName);
        ALTestSuite.Get(RunSuiteName);
        Mgt.SelectTestMethodsByRange(ALTestSuite, Format(RunTestCodeunitId));

        Line.SetRange("Test Suite", RunSuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then
            repeat
                Line.Validate(Run, false);
                Line.Modify(true);
            until Line.Next() = 0;

        Line.Reset();
        Line.SetRange("Test Suite", RunSuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        Line.SetRange(Name, RunTestMethod);
        MatchCount := Line.Count();
        if MatchCount <> 1 then begin
            ErrObj.Add('error', StrSubstNo('expected exactly one method %1, found %2', RunTestMethod, MatchCount));
            ErrObj.WriteTo(ErrJson);
            exit(ErrJson);
        end;
        Line.FindFirst();
        Line.Validate(Run, true);
        Line.Modify(true);

        Line.Reset();
        Line.SetRange("Test Suite", RunSuiteName);
        Line.FindFirst();
        // R206 §2.1: the session-freshness counter, immediately before the run (one of two sites).
        State.NoteTestMethodRun();
        Mgt.RunAllTests(Line);
        // PROGRESS_BETWEEN_FIRST (R198): the very next statement after RunAllTests returns, before
        // TestResultsToJSON or anything else. This is the smallest window AL can offer between a
        // method's completion and the row saying so; the per-method stop's refusal and R204's
        // narrowing both rest on it. Pinned by a source test.
        if FenceAttemptId <> '' then
            State.ProgressBetween(FenceAttemptId, FenceOpSeq, FenceIndex);

        CodeunitLine.SetRange("Test Suite", RunSuiteName);
        CodeunitLine.SetRange("Line Type", CodeunitLine."Line Type"::Codeunit);
        CodeunitLine.FindFirst();
        exit(Mgt.TestResultsToJSON(CodeunitLine));
    end;
}
