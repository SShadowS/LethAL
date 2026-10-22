// R649. One case per codeunit; the driver runs each in its own control-app call, in id order.
// A Sleep test fails only if BC's own clock shows it did not wait: its error carries the elapsed
// time as data. Nothing reads a table, calls out or loops.

codeunit 92930 "R649 Sleep 100"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure Sleep100()
    var
        Started: DateTime;
        Elapsed: Duration;
    begin
        Started := CurrentDateTime();
        Sleep(100);
        Elapsed := CurrentDateTime() - Started;
        if Elapsed < 100 then
            Error('MEASURED elapsed %1 ms after Sleep(100)', Elapsed);
    end;
}

codeunit 92931 "R649 Sleep 5000"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure Sleep5000()
    var
        Started: DateTime;
        Elapsed: Duration;
    begin
        Started := CurrentDateTime();
        Sleep(5000);
        Elapsed := CurrentDateTime() - Started;
        if Elapsed < 5000 then
            Error('MEASURED elapsed %1 ms after Sleep(5000)', Elapsed);
    end;
}

codeunit 92932 "R649 Sleep 600000"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // 50660's LongSleepThenAssert, under a new id.
    [Test]
    procedure LongSleepThenAssert()
    var
        Started: DateTime;
        Elapsed: Duration;
    begin
        Started := CurrentDateTime();
        Sleep(600000);
        Elapsed := CurrentDateTime() - Started;
        if Elapsed < 600000 then
            Error('after sleep %1', Elapsed);
    end;
}

codeunit 92933 "R649 Sleeper Doubles"
{
    Subtype = Test;
    TestPermissions = Disabled;

    var
        Sleeper: Codeunit "R649 Probe Sleeper";

    // 50660's SleeperDoubles, word for word, against the 50605 shape in the target.
    [Test]
    procedure SleeperDoubles()
    begin
        if Sleeper.WaitThenDouble(21) <> 42 then
            Error('WaitThenDouble(21) must be 42');
    end;
}
