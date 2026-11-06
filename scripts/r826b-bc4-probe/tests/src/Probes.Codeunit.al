// R826B. One shape per codeunit; the driver runs each in its own control-app call. Every hang ends by
// itself 120 s after it starts on BC's own clock (the natural-end control: 25 s). Nothing is written that
// outlasts a test (the test runner rolls everything back, Commit included, which the first run showed).
// To tell from outside whether a stopped session is gone, the Reader test lists "Active Session" ids and
// the driver looks for the session id that StopHungRun named.

codeunit 91510 "R826B Control Sleep 100"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // The normal run, and the clean "next test" after every hang. Ends far inside any budget.
    [Test]
    procedure Sleep100()
    begin
        Sleep(100);
    end;
}

codeunit 91511 "R826B Busy Loop"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // Shape (a): a busy loop, no Sleep, no database call. 120 s.
    [Test]
    procedure BusyLoop()
    var
        Started: DateTime;
        Spins: BigInteger;
    begin
        Started := CurrentDateTime();
        repeat
            Spins += 1;
        until CurrentDateTime() - Started >= 120000;
    end;
}

codeunit 91512 "R826B Sleep Loop"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // Shape (b): Sleep(200) in a loop. 120 s.
    [Test]
    procedure SleepLoop()
    var
        Started: DateTime;
    begin
        Started := CurrentDateTime();
        repeat
            Sleep(200);
        until CurrentDateTime() - Started >= 120000;
    end;
}

codeunit 91513 "R826B DB Loop"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // Shape (c): reads (Count, Get) and writes (Insert, Modify, Delete of a scratch row) on every pass.
    // The test runner rolls the writes back. 120 s.
    [Test]
    procedure DbLoop()
    var
        Cat: Record "Job Queue Category";
        Scratch: Record "Job Queue Category";
        Started: DateTime;
        Seen: Integer;
    begin
        Started := CurrentDateTime();
        repeat
            Seen := Cat.Count();
            Scratch.Init();
            Scratch.Code := 'R826BX';
            Scratch.Description := Format(Seen);
            Scratch.Insert();
            Scratch.Description := 'x';
            Scratch.Modify();
            if Scratch.Get('R826BX') then
                Scratch.Delete();
        until CurrentDateTime() - Started >= 120000;
    end;
}

codeunit 91515 "R826B Busy 25s"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // The no-stop control: a busy loop that ends by itself after 25 s, run with a 90 s budget.
    [Test]
    procedure Busy25s()
    var
        Started: DateTime;
        Spins: BigInteger;
    begin
        Started := CurrentDateTime();
        repeat
            Spins += 1;
        until CurrentDateTime() - Started >= 25000;
    end;
}

codeunit 91514 "R826B Reader"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // Run AFTER a stop. Lists the ids in "Active Session" and its own id. The answer travels as the
    // test's own Error text: "MEASURED own=<id> ownListed=<bool> count=<n> ids=<id,id,...>".
    [Test]
    procedure ReadSessions()
    var
        Sess: Record "Active Session";
        Ids: Text;
        Count: Integer;
        OwnListed: Boolean;
    begin
        if Sess.FindSet() then
            repeat
                Count += 1;
                if Sess."Session ID" = SessionId() then
                    OwnListed := true;
                if StrLen(Ids) < 600 then
                    Ids += Format(Sess."Session ID") + ',';
            until Sess.Next() = 0;
        Error('MEASURED own=%1 ownListed=%2 count=%3 ids=%4', SessionId(), OwnListed, Count, Ids);
    end;
}
