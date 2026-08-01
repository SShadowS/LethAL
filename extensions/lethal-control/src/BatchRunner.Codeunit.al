namespace LethAL.Control;

/// <summary>R69: the in-session batch loop, invoked as ONE page action over the client-services
/// WebSocket. Reuses "LC Run Method" (the single-method fence primitive) per queue item so the AL
/// runs in the capable client-services session — the one that CAN CreateNavTestService — rather than
/// the fenced ODataV4 session that refuses it. Commits after every result row: each RunMethod drives
/// the platform test runner whose per-method isolation ROLLS BACK, and an uncommitted result row would
/// be rolled back with it (the project's empty-vs-empty signature bug).</summary>
codeunit 71013 "LC Batch Runner"
{
    procedure RunBatch()
    var
        Queue: Record "LC Batch Queue";
        Res: Record "LC Batch Result";
        Runner: Codeunit "LC Run Method";
        State: Codeunit "LC Control State";
        Ok: Boolean;
        Json: Text;
        ErrText: Text;
    begin
        Res.DeleteAll(true);
        Commit();
        if not Queue.FindSet() then
            exit;
        repeat
            Runner.SetRequest(State.NextSuiteName(), Queue."Codeunit ID", Queue.Method);
            Ok := Runner.Run();
            if Ok then begin
                Json := Runner.Results();
                ErrText := '';
            end else begin
                Json := '';
                ErrText := CopyStr(GetLastErrorText(), 1, 2048);
            end;
            Res.Init();
            Res."Line No." := Queue."Line No.";
            Res."Codeunit ID" := Queue."Codeunit ID";
            Res.Method := Queue.Method;
            Res.Ok := Ok;
            Res.Attested := State.AttestationObservedAny();
            Res."Error Text" := ErrText;
            Res.SetResultJson(Json);
            Res.Insert(true);
            Commit();
        until Queue.Next() = 0;
    end;
}
