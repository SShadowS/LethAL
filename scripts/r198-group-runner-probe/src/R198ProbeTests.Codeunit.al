namespace R198.Probe;

/// <summary>Seven methods, run in DECLARATION order by the platform whatever subset is selected.
/// Results travel out through Error() where a passing test would say nothing (al-probe rule).</summary>
codeunit 71543 "R198 Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    /// <summary>Writes a row under a fixed key and asserts NOTHING. Arm K's shape.</summary>
    [Test]
    procedure T1_InsertFixedKey()
    var
        Row: Record "R198 Probe Row";
    begin
        Row.Init();
        Row."Key" := 'K1';
        Row."Written By" := 'T1_InsertFixedKey';
        Row."Session Id" := SessionId();
        Row.Insert();
    end;

    /// <summary>Fails if T1's row is still visible: isolation did not roll it back.</summary>
    [Test]
    procedure T2_AssertAbsent()
    var
        Row: Record "R198 Probe Row";
    begin
        if Row.Get('K1') then
            Error('LEAK: K1 written by %1 in session %2 is visible in the next method (this session %3)', Row."Written By", Row."Session Id", SessionId());
    end;

    /// <summary>Holds the group for 6 s so a second session can read the progress row meanwhile.</summary>
    [Test]
    procedure T3_Sleep()
    begin
        Sleep(6000);
    end;

    [Test]
    procedure T4_Fail()
    begin
        Error('deliberate failure in T4_Fail');
    end;

    /// <summary>Passes. Must be SKIPPED when the runner stops at the first failure.</summary>
    [Test]
    procedure T5_AfterFail()
    begin
    end;

    /// <summary>Reports what a test method itself sees of the progress row (the user's question:
    /// can the runner set something the tests then read?). Always "fails", to carry the data.</summary>
    [Test]
    procedure T6_ReadProgress()
    var
        Progress: Record "R198 Progress";
    begin
        if not Progress.Get('CURRENT') then
            Error('MEASURED inside-test: no progress row');
        Error('MEASURED inside-test: index=%1 name=%2 phase=%3 runnerSession=%4 thisSession=%5 trace=[%6]', Progress."Method Index", Progress."Method Name", Progress.Phase, Progress."Session Id", SessionId(), Progress.Trace);
    end;

    /// <summary>A bounded hang (45 s) for the stop experiment: long enough that only a stop ends
    /// it early, short enough that a failed stop cannot wedge the container.</summary>
    [Test]
    procedure T7_Hang()
    var
        T0: DateTime;
        Spin: Integer;
    begin
        T0 := CurrentDateTime();
        while CurrentDateTime() - T0 < 45000 do
            Spin += 1;
        Error('T7_Hang finished UNSTOPPED after 45 s');
    end;
}
