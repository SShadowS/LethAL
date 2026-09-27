namespace NstRepro03;

// Exposed as OData V4 web service "NstRepro03":
// POST <base>/ODataV4/NstRepro03_<Procedure>?company=...&tenant=...
codeunit 91632 "NST Repro03 API"
{
    // Records this session's id, commits, then runs the looping test through the platform test
    // runner. Returns only if the loop ends on its own (Finished is then set).
    procedure StartLoop(RunId: Text; MaxMs: Integer) Answer: Text
    var
        Run: Record "NST Repro03 Run";
        Runner: Codeunit "NST Repro03 Runner";
        Ok: Boolean;
    begin
        if not Run.Get(1) then begin
            Run.Init();
            Run."Key" := 1;
            Run.Insert();
        end;
        Run.RunId := CopyStr(RunId, 1, MaxStrLen(Run.RunId));
        Run."Session ID" := SessionId();
        Run.MaxMs := MaxMs;
        Run.Started := CurrentDateTime();
        Run.Finished := 0DT;
        Run.Modify();
        Commit();

        Runner.SetTestMethod('LoopUntilBound');
        Ok := Runner.Run();

        Run.Get(1);
        Run.Finished := CurrentDateTime();
        Run.Modify();
        Commit();
        Answer := StrSubstNo('{"finishedUnstopped":true,"runOk":%1,"sessionId":%2}', Format(Ok, 0, 9), SessionId());
    end;

    // Reads the run row. Separate call so the client never guesses a session id.
    procedure LoopState() Answer: Text
    var
        Run: Record "NST Repro03 Run";
    begin
        SelectLatestVersion();
        if not Run.Get(1) then
            exit('{}');
        Answer := StrSubstNo('{"runId":"%1","sessionId":%2,"maxMs":%3,"finished":%4,"mySession":%5}',
            Run.RunId, Run."Session ID", Run.MaxMs, Format(Run.Finished <> 0DT, 0, 9), SessionId());
    end;

    // The stop, from a second session, as LethAL's StopHungRunAt does it. StopSession raises no
    // error for a session id that does not exist, so its return says nothing; the evidence is the
    // held StartLoop request ending with HTTP 408, and Finished staying unset.
    procedure StopLoop(TargetSessionId: Integer) Answer: Text
    var
        Threw: Boolean;
    begin
        if TargetSessionId <= 0 then
            exit('{"stopped":false,"reason":"no session id"}');
        Threw := not TryStop(TargetSessionId);
        Answer := StrSubstNo('{"stopCalled":true,"threw":%1,"error":"%2","mySession":%3}',
            Format(Threw, 0, 9), GetLastErrorText().Replace('"', ''''), SessionId());
    end;

    procedure Ping(): Text
    begin
        exit(StrSubstNo('pong session=%1', SessionId()));
    end;

    [TryFunction]
    local procedure TryStop(TargetSessionId: Integer)
    begin
        StopSession(TargetSessionId, 'NST repro 03 stop');
    end;
}
