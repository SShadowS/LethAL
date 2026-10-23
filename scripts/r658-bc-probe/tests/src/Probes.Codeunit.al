// R658. One case per codeunit; the driver runs each in its own control-app call, in the order
// C (92950), L (92952), S (92951), D (92953). Nothing reads or writes a table or calls out. Nothing
// runs past 60 s on BC's own clock: S sleeps 60 s, L's loop ends on its own after 60 s, D sleeps 30 s.

codeunit 92950 "R658 Control Sleep 100"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // C: the control. Ends far inside the 20 s budget, so no stop is sent.
    [Test]
    procedure Sleep100()
    begin
        Sleep(100);
    end;
}

codeunit 92951 "R658 Sleep 60000"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // S: one Sleep of 60 s, then no database call until the test returns.
    [Test]
    procedure Sleep60000()
    var
        Started: DateTime;
        Elapsed: Duration;
    begin
        Started := CurrentDateTime();
        Sleep(60000);
        Elapsed := CurrentDateTime() - Started;
        if Elapsed < 60000 then
            Error('MEASURED elapsed %1 ms after Sleep(60000)', Elapsed);
    end;
}

codeunit 92952 "R658 Busy Loop 60s"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // L: a busy loop with no Sleep and no database call, bounded by BC's own clock to 60 s.
    [Test]
    procedure BusyLoop60s()
    var
        Started: DateTime;
        Spins: BigInteger;
    begin
        Started := CurrentDateTime();
        repeat
            Spins += 1;
        until CurrentDateTime() - Started >= 60000;
        if Spins < 1 then
            Error('MEASURED no spin in 60 s');
    end;
}

codeunit 92953 "R658 Sleep 30000 Abandoned"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // D: run with a 10 s budget and NO stop, so LethAL abandons the request while this sleeps. Does
    // the session still reach phase 3 after the client is gone?
    [Test]
    procedure Sleep30000()
    begin
        Sleep(30000);
    end;
}
