namespace R198.Probe;

using System.TestTools.TestRunner;

/// <summary>
/// Web-service surface of the probe, driven from PowerShell over OData exactly as LethAL's
/// runner drives the control app. Builds a throwaway suite the way RunMethod.Codeunit.al does,
/// but with N methods marked Run=true and the suite's "Test Runner Id" pointed at the probe's own
/// runner (or at Microsoft's 130450 as the control).
/// </summary>
codeunit 71544 "R198 Probe API"
{
    /// <summary>Stores the run configuration where the runner (instantiated by the platform,
    /// so unable to take parameters) reads it. Resets the progress fields.</summary>
    [ServiceEnabled]
    procedure Configure(ProgressMode: Text; StopOnFirstFailure: Boolean; RunnerId: Integer) Result: Text
    var
        Progress: Record "R198 Progress";
    begin
        if not Progress.Get('CURRENT') then begin
            Progress.Init();
            Progress."Key" := 'CURRENT';
            Progress.Insert();
        end;
        Progress."Progress Mode" := CopyStr(ProgressMode, 1, 10);
        Progress."Stop On First Failure" := StopOnFirstFailure;
        Progress."Runner Id" := RunnerId;
        Progress."Method Index" := 0;
        Progress."Method Name" := '';
        Progress.Phase := 'configured';
        Progress."Session Id" := 0;
        Progress.Stamp := CurrentDateTime();
        Progress."Failures Seen" := 0;
        Progress.Trace := '';
        Progress.Modify();
        Commit();
        Result := 'configured mode=' + ProgressMode + ' stop=' + Format(StopOnFirstFailure) + ' runner=' + Format(RunnerId);
    end;

    /// <summary>Runs the comma-separated methods of "R198 Probe Tests" in ONE suite run and
    /// returns the platform's per-method results plus what the probe can see afterwards.</summary>
    [ServiceEnabled]
    procedure RunGroup(Methods: Text) Result: Text
    var
        ALTestSuite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        CodeunitLine: Record "Test Method Line";
        Row: Record "R198 Probe Row";
        Progress: Record "R198 Progress";
        Mgt: Codeunit "Test Suite Mgt.";
        Out: JsonObject;
        ResultsJson: JsonObject;
        ResultsText: Text;
        Wanted: List of [Text];
        Name: Text;
        SuiteName: Code[10];
        T0: DateTime;
        Selected: Integer;
    begin
        Progress.Get('CURRENT');
        SuiteName := 'R198';
        if ALTestSuite.Get(SuiteName) then
            ALTestSuite.Delete(true);
        Mgt.CreateTestSuite(SuiteName);
        ALTestSuite.Get(SuiteName);
        if Progress."Runner Id" <> 0 then begin
            ALTestSuite."Test Runner Id" := Progress."Runner Id";
            ALTestSuite.Modify();
        end;
        Mgt.SelectTestMethodsByRange(ALTestSuite, Format(Codeunit::"R198 Probe Tests"));

        Line.SetRange("Test Suite", 'R198');
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then
            repeat
                Line.Validate(Run, false);
                Line.Modify(true);
            until Line.Next() = 0;

        Wanted := Methods.Split(',');
        foreach Name in Wanted do begin
            Line.Reset();
            Line.SetRange("Test Suite", 'R198');
            Line.SetRange("Line Type", Line."Line Type"::"Function");
            Line.SetRange(Name, Name.Trim());
            if Line.FindFirst() then begin
                Line.Validate(Run, true);
                Line.Modify(true);
                Selected += 1;
            end;
        end;
        Commit();

        T0 := CurrentDateTime();
        Line.Reset();
        Line.SetRange("Test Suite", 'R198');
        Line.FindFirst();
        Mgt.RunAllTests(Line);

        CodeunitLine.SetRange("Test Suite", 'R198');
        CodeunitLine.SetRange("Line Type", CodeunitLine."Line Type"::Codeunit);
        CodeunitLine.FindFirst();
        ResultsText := Mgt.TestResultsToJSON(CodeunitLine);
        ResultsJson.ReadFrom(ResultsText);

        SelectLatestVersion();
        Out.Add('selected', Selected);
        Out.Add('elapsedMs', CurrentDateTime() - T0);
        Out.Add('runnerId', ALTestSuite."Test Runner Id");
        Out.Add('k1VisibleAfterRun', Row.Get('K1'));
        Out.Add('apiSession', SessionId());
        Out.Add('results', ResultsJson);
        Out.Add('progress', ProgressJson());
        Out.WriteTo(Result);
    end;

    /// <summary>Mode B: ONE call, but today's exact one-method suite run repeated N times in
    /// request order, with progress written and Commit()ed by this loop BETWEEN runs (never
    /// inside a test transaction) and an early exit at the first failure when configured. Each
    /// method gets its own CODEUNIT.Run of the test codeunit, so isolation is today's by
    /// construction; what this mode buys is the round trip and the fence, and what it costs is
    /// the suite rebuild per method, which elapsedMs per method measures.</summary>
    [ServiceEnabled]
    procedure RunLoop(Methods: Text) Result: Text
    var
        Row: Record "R198 Probe Row";
        Progress: Record "R198 Progress";
        Out: JsonObject;
        PerMethod: JsonArray;
        One: JsonObject;
        ResultsJson: JsonObject;
        ResultsText: Text;
        Wanted: List of [Text];
        Name: Text;
        T0: DateTime;
        TStart: DateTime;
        Index: Integer;
        Failures: Integer;
        Failed: Boolean;
    begin
        Progress.Get('CURRENT');
        T0 := CurrentDateTime();
        Wanted := Methods.Split(',');
        foreach Name in Wanted do begin
            Index += 1;
            if Progress."Stop On First Failure" and (Failures > 0) then begin
                Clear(One);
                One.Add('method', Name.Trim());
                One.Add('skipped', true);
                PerMethod.Add(One);
            end else begin
                LoopProgress(Index, Name.Trim(), 'before', Failures);
                TStart := CurrentDateTime();
                ResultsText := RunOneInOwnSuite(Name.Trim(), Progress."Runner Id");
                Clear(One);
                One.Add('method', Name.Trim());
                One.Add('elapsedMs', CurrentDateTime() - TStart);
                Clear(ResultsJson);
                if ResultsJson.ReadFrom(ResultsText) then
                    One.Add('results', ResultsJson)
                else
                    One.Add('raw', ResultsText);
                Failed := ResultsText.Contains('"result":1');
                if Failed then
                    Failures += 1;
                LoopProgress(Index, Name.Trim(), 'after', Failures);
                PerMethod.Add(One);
            end;
        end;
        LoopProgress(Index, '', 'idle', Failures);

        SelectLatestVersion();
        Out.Add('mode', 'loop');
        Out.Add('elapsedMs', CurrentDateTime() - T0);
        Out.Add('k1VisibleAfterRun', Row.Get('K1'));
        Out.Add('apiSession', SessionId());
        Out.Add('perMethod', PerMethod);
        Out.Add('progress', ProgressJson());
        Out.WriteTo(Result);
    end;

    /// <summary>RunMethod.Codeunit.al's RunOneMethod, verbatim in shape, plus the runner choice.</summary>
    local procedure RunOneInOwnSuite(RunTestMethod: Text; RunnerId: Integer): Text
    var
        ALTestSuite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        CodeunitLine: Record "Test Method Line";
        Mgt: Codeunit "Test Suite Mgt.";
        SuiteName: Code[10];
    begin
        SuiteName := 'R198L';
        if ALTestSuite.Get(SuiteName) then
            ALTestSuite.Delete(true);
        Mgt.CreateTestSuite(SuiteName);
        ALTestSuite.Get(SuiteName);
        if RunnerId <> 0 then begin
            ALTestSuite."Test Runner Id" := RunnerId;
            ALTestSuite.Modify();
        end;
        Mgt.SelectTestMethodsByRange(ALTestSuite, Format(Codeunit::"R198 Probe Tests"));

        Line.SetRange("Test Suite", 'R198L');
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then
            repeat
                Line.Validate(Run, false);
                Line.Modify(true);
            until Line.Next() = 0;

        Line.Reset();
        Line.SetRange("Test Suite", 'R198L');
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        Line.SetRange(Name, RunTestMethod);
        if not Line.FindFirst() then
            exit('{"error":"no such method ' + RunTestMethod + '"}');
        Line.Validate(Run, true);
        Line.Modify(true);

        Line.Reset();
        Line.SetRange("Test Suite", 'R198L');
        Line.FindFirst();
        Mgt.RunAllTests(Line);

        CodeunitLine.SetRange("Test Suite", 'R198L');
        CodeunitLine.SetRange("Line Type", CodeunitLine."Line Type"::Codeunit);
        CodeunitLine.FindFirst();
        exit(Mgt.TestResultsToJSON(CodeunitLine));
    end;

    local procedure LoopProgress(Index: Integer; MethodName: Text; Phase: Text; Failures: Integer)
    var
        Progress: Record "R198 Progress";
    begin
        Progress.Get('CURRENT');
        Progress."Method Index" := Index;
        Progress."Method Name" := CopyStr(MethodName, 1, 128);
        Progress.Phase := CopyStr(Phase, 1, 20);
        Progress."Session Id" := SessionId();
        Progress.Stamp := CurrentDateTime();
        Progress."Failures Seen" := Failures;
        Progress.Trace := CopyStr(Progress.Trace + Phase[1] + Format(Index) + ' ', 1, 2048);
        Progress.Modify();
        Commit();
    end;

    /// <summary>What a SECOND session sees of the progress row while a group runs.</summary>
    [ServiceEnabled]
    procedure ReadProgress() Result: Text
    var
        Out: JsonObject;
    begin
        SelectLatestVersion();
        Out := ProgressJson();
        Out.Add('readerSession', SessionId());
        Out.WriteTo(Result);
    end;

    /// <summary>Deletes leftover probe rows and reports how many there were: a non-zero count
    /// is a leak across CALLS, which would already be visible in today's one-method runs.</summary>
    [ServiceEnabled]
    procedure CleanRows() Result: Text
    var
        Row: Record "R198 Probe Row";
        N: Integer;
    begin
        SelectLatestVersion();
        N := Row.Count();
        Row.DeleteAll();
        Commit();
        Result := 'deleted ' + Format(N);
    end;

    /// <summary>The per-method tombstone in miniature: stop the runner's session ONLY if the
    /// progress row says it is inside the named method right now; refuse otherwise.</summary>
    [ServiceEnabled]
    procedure StopIfAt(MethodName: Text) Result: Text
    var
        Progress: Record "R198 Progress";
    begin
        SelectLatestVersion();
        Progress.Get('CURRENT');
        if (Progress."Method Name" <> MethodName) or (Progress.Phase <> 'before') then begin
            Result := 'refused: runner is at ' + Progress."Method Name" + '/' + Progress.Phase + ' (index ' + Format(Progress."Method Index") + ')';
            exit;
        end;
        if Progress."Session Id" <= 0 then begin
            Result := 'refused: no session recorded';
            exit;
        end;
        StopSession(Progress."Session Id", 'R198 probe: group stopped inside ' + MethodName);
        Result := 'stopped session ' + Format(Progress."Session Id") + ' inside ' + MethodName;
    end;

    /// <summary>F4 probe. Reads the progress row without a lock, holds it for HoldMs while the
    /// driver commits a change from ANOTHER session (Configure), then Modify()s the stale copy
    /// through a catchable boundary. Reports raise-or-overwrite and which value won.</summary>
    [ServiceEnabled]
    procedure StaleModify(HoldMs: Integer) Result: Text
    var
        Progress: Record "R198 Progress";
        Writer: Codeunit "R198 Stale Writer";
        Before: Text;
        Outcome: Text;
    begin
        Progress.Get('CURRENT');
        Before := Progress."Method Name";
        Writer.SetRecord(Progress);
        Sleep(HoldMs);
        if Writer.Run() then
            Outcome := 'modify-succeeded'
        else
            Outcome := 'modify-raised: ' + GetLastErrorText();
        Commit();
        SelectLatestVersion();
        Progress.Get('CURRENT');
        Result := Outcome + ' | read-before=' + Before + ' | now=' + Progress."Method Name" + ' phase=' + Progress.Phase + ' mode=' + Progress."Progress Mode";
    end;

    local procedure ProgressJson() Out: JsonObject
    var
        Progress: Record "R198 Progress";
    begin
        if not Progress.Get('CURRENT') then begin
            Out.Add('missing', true);
            exit;
        end;
        Out.Add('mode', Progress."Progress Mode");
        Out.Add('stopOnFirstFailure', Progress."Stop On First Failure");
        Out.Add('runnerId', Progress."Runner Id");
        Out.Add('methodIndex', Progress."Method Index");
        Out.Add('methodName', Progress."Method Name");
        Out.Add('phase', Progress.Phase);
        Out.Add('sessionId', Progress."Session Id");
        Out.Add('stamp', Progress.Stamp);
        Out.Add('failuresSeen', Progress."Failures Seen");
        Out.Add('trace', Progress.Trace);
    end;
}
