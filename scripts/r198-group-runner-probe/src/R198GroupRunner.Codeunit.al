namespace R198.Probe;

using System.TestTools.TestRunner;

/// <summary>
/// A copy of Microsoft's "Test Runner - Isol. Codeunit" (130450) with THREE changes, each one a
/// question the probe measures:
///   1. TestIsolation = Function, so each method is rolled back on its own inside ONE run;
///   2. progress is written to "R198 Progress" and Commit()ed from the triggers (mode chosen by
///      the API: none | before | after | both), so a second session can read it;
///   3. after the first failing method, OnBeforeTestRun returns false for every later method
///      when the API asked for it (stop at first failure).
/// Everything Microsoft's runner does (results into "Test Method Line", the Commit after every
/// method in PlatformAfterTestRun) is kept by delegating to "Test Runner - Mgt" exactly as the
/// stock runner does, so the ONLY differences from today's single-method runs are the three above.
/// </summary>
codeunit 71542 "R198 Group Runner"
{
    Subtype = TestRunner;
    TableNo = "Test Method Line";
    TestIsolation = Function;
    Permissions = tabledata "AL Test Suite" = rimd,
                  tabledata "Test Method Line" = rimd,
                  tabledata "R198 Progress" = rimd;

    trigger OnRun()
    begin
        ALTestSuite.Get(Rec."Test Suite");
        CurrentTestMethodLine.Copy(Rec);
        ReadConfig();
        TestRunnerMgt.RunTests(Rec);
        Note('END', 'idle');
    end;

    var
        ALTestSuite: Record "AL Test Suite";
        CurrentTestMethodLine: Record "Test Method Line";
        TestRunnerMgt: Codeunit "Test Runner - Mgt";
        ProgressMode: Text;
        StopOnFirstFailure: Boolean;
        MethodIndex: Integer;
        FailuresSeen: Integer;
        Trace: Text;

    trigger OnBeforeTestRun(CodeunitID: Integer; CodeunitName: Text; FunctionName: Text; FunctionTestPermissions: TestPermissions): Boolean
    begin
        if (FunctionName = '') or (FunctionName = 'OnRun') then
            exit(TestRunnerMgt.PlatformBeforeTestRun(CodeunitID, CopyStr(CodeunitName, 1, 30), CopyStr(FunctionName, 1, 128), FunctionTestPermissions, ALTestSuite.Name, CurrentTestMethodLine.GetFilter("Line No.")));

        MethodIndex += 1;
        if StopOnFirstFailure and (FailuresSeen > 0) then begin
            Note('S' + Format(MethodIndex), 'skipped');
            exit(false);
        end;

        Note('B' + Format(MethodIndex), 'before');
        if ProgressMode in ['before', 'both'] then
            WriteProgress(FunctionName, 'before');

        exit(TestRunnerMgt.PlatformBeforeTestRun(CodeunitID, CopyStr(CodeunitName, 1, 30), CopyStr(FunctionName, 1, 128), FunctionTestPermissions, ALTestSuite.Name, CurrentTestMethodLine.GetFilter("Line No.")));
    end;

    trigger OnAfterTestRun(CodeunitID: Integer; CodeunitName: Text; FunctionName: Text; FunctionTestPermissions: TestPermissions; IsSuccess: Boolean)
    begin
        if not ((FunctionName = '') or (FunctionName = 'OnRun')) then begin
            if not IsSuccess then
                FailuresSeen += 1;
            if IsSuccess then
                Note('A' + Format(MethodIndex) + 'ok', 'after')
            else
                Note('A' + Format(MethodIndex) + 'FAIL', 'after');
            if ProgressMode in ['after', 'both'] then
                WriteProgress(FunctionName, 'after');
        end;

        TestRunnerMgt.PlatformAfterTestRun(CodeunitID, CopyStr(CodeunitName, 1, 30), CopyStr(FunctionName, 1, 128), FunctionTestPermissions, IsSuccess, ALTestSuite.Name, CurrentTestMethodLine.GetFilter("Line No."));
    end;

    local procedure ReadConfig()
    var
        Progress: Record "R198 Progress";
    begin
        Progress.Get('CURRENT');
        ProgressMode := Progress."Progress Mode";
        StopOnFirstFailure := Progress."Stop On First Failure";
        Trace := '';
        MethodIndex := 0;
        FailuresSeen := 0;
    end;

    /// <summary>The instance's own trace, kept in a global so the final row shows whether the
    /// platform kept ONE runner instance across the group (a fresh instance per method would
    /// restart it at every trigger).</summary>
    local procedure Note(Token: Text; Phase: Text)
    begin
        Trace += Token + ' ';
        if (Phase = 'idle') and (ProgressMode <> 'none') then
            WriteProgress('', 'idle');
    end;

    local procedure WriteProgress(FunctionName: Text; Phase: Text)
    var
        Progress: Record "R198 Progress";
    begin
        Progress.Get('CURRENT');
        Progress."Method Index" := MethodIndex;
        Progress."Method Name" := CopyStr(FunctionName, 1, 128);
        Progress.Phase := CopyStr(Phase, 1, 20);
        Progress."Session Id" := SessionId();
        Progress.Stamp := CurrentDateTime();
        Progress."Failures Seen" := FailuresSeen;
        Progress.Trace := CopyStr(Trace, 1, 2048);
        Progress.Modify();
        Commit();
    end;
}
