namespace R53.Probe;

using System.Environment;

/// <summary>
/// R53's real topology, reproduced: a WEB-SERVICE session busy in an AL loop, and a second
/// web-service session trying to end it. `StartSession` was the obvious way to get two sessions
/// and is unavailable — the platform test runner refuses it unless TestIsolation is Disabled — but
/// it would also have measured the wrong thing: LethAL's hung session is an OData session, and
/// whether OData sessions can be stopped is the actual question.
/// </summary>
codeunit 71503 "R53 Probe API"
{
    /// <summary>Busy-loops for `Ms`, recording its own session id FIRST so a watchdog can find it.
    /// Bounded: if the stop does not work, this ends on its own rather than wedging the container.</summary>
    [ServiceEnabled]
    procedure HangFor(Ms: Integer) Result: Text
    var
        Log: Record "R53 Probe Log";
        T0: DateTime;
        Spin: Integer;
    begin
        Log.Reset();
        Log.DeleteAll();
        Log.Init();
        Log."Entry No." := 1;
        Log.Marker := 'hanging';
        Log.SessionId := SessionId();
        Log.Stamp := CurrentDateTime();
        Log.Insert();
        Commit();

        T0 := CurrentDateTime();
        while CurrentDateTime() - T0 < Ms do
            Spin += 1;

        // Reached ONLY if nothing stopped this session — the negative result.
        Log.Init();
        Log."Entry No." := 2;
        Log.Marker := 'finished-unstopped';
        Log.SessionId := SessionId();
        Log.Stamp := CurrentDateTime();
        Log.Insert();
        Commit();
        Result := 'finished-unstopped';
    end;

    /// <summary>Reads back what the hung session recorded. Separate call so the watchdog never has
    /// to guess a session id.</summary>
    [ServiceEnabled]
    procedure ReadLog() Result: Text
    var
        Log: Record "R53 Probe Log";
        Session: Record "Active Session";
        Parts: Text;
        Alive: Boolean;
    begin
        Log.Reset();
        SelectLatestVersion();
        if Log.FindSet() then
            repeat
                Parts += StrSubstNo('%1=%2@%3;', Log."Entry No.", Log.Marker, Log.SessionId);
            until Log.Next() = 0;
        if Log.Get(1) then begin
            Session.Reset();
            Session.SetRange("Session ID", Log.SessionId);
            Alive := not Session.IsEmpty();
        end;
        Result := StrSubstNo('rows:%1 hungSessionAlive:%2 mySession:%3', Parts, Alive, SessionId());
    end;

    /// <summary>The measurement: can AL, from a web-service session, end ANOTHER busy session?</summary>
    [ServiceEnabled]
    procedure StopOther(TargetSessionId: Integer) Result: Text
    var
        Session: Record "Active Session";
        VisibleBefore: Boolean;
        Threw: Boolean;
    begin
        Session.Reset();
        Session.SetRange("Session ID", TargetSessionId);
        VisibleBefore := not Session.IsEmpty();

        Threw := not TryStop(TargetSessionId);

        Result := StrSubstNo('visibleBefore:%1 stopThrew:%2 error:%3 mySession:%4',
            VisibleBefore, Threw, GetLastErrorText(), SessionId());
    end;

    /// <summary>Can a web-service session enumerate sessions AT ALL? The first run measured
    /// `visibleBefore:No` for a session that StopSession then successfully killed — so either the
    /// table is not readable here, or it does not list OData sessions. Which one decides whether a
    /// watchdog can VERIFY its own stop, or only issue it.</summary>
    [ServiceEnabled]
    procedure SessionCensus() Result: Text
    var
        Session: Record "Active Session";
        Total: Integer;
        SelfVisible: Boolean;
        Kinds: Text;
    begin
        Session.Reset();
        Total := Session.Count();
        if Session.FindSet() then
            repeat
                Kinds += StrSubstNo('%1/%2;', Session."Session ID", Session."Client Type");
            until (Session.Next() = 0) or (StrLen(Kinds) > 400);
        Session.Reset();
        Session.SetRange("Session ID", SessionId());
        SelfVisible := not Session.IsEmpty();
        Result := StrSubstNo('total:%1 selfVisible:%2 mySession:%3 rows:%4', Total, SelfVisible, SessionId(), Kinds);
    end;

    [TryFunction]
    local procedure TryStop(TargetSessionId: Integer)
    begin
        StopSession(TargetSessionId, 'R53 probe watchdog');
    end;
}
