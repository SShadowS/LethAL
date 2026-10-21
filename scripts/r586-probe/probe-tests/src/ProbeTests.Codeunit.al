codeunit 50650 "Probe Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Probe Logic";
        Counter: Integer;

    [Test]
    procedure Passes()
    begin
        if Logic.Add(2, 3) <> 5 then
            Error('2+3 must be 5');
    end;

    [Test]
    procedure PassesToo()
    begin
        if Logic.Add(1, 1) <> 2 then
            Error('1+1 must be 2');
    end;

    [Test]
    procedure Fails()
    begin
        Error('boom %1', 5);
    end;

    [Test]
    procedure "Space Step"()
    begin
    end;

    [Test]
    procedure "Dot.Name"()
    begin
    end;

    [Test]
    procedure "1Leading"()
    begin
    end;

    [Test]
    procedure "Default"()
    begin
    end;

    [Test]
    procedure "Blåbær Step"()
    begin
    end;

    [Test]
    procedure PersistA()
    begin
        Logic.InsertRow('P1', 1);
        Counter += 1;
    end;

    [Test]
    procedure PersistB()
    begin
        // Runs after PersistA in declaration order. Reports what it sees.
        Error('rows=%1 counter=%2', Logic.RowCount(), Counter);
    end;

    [Test]
    procedure ArmIs()
    begin
        Error('arm=%1', Logic.ArmName());
    end;

    [Test]
    procedure ResourceIs()
    begin
        Error('res=%1', Logic.ActiveResource());
    end;

    [Test]
    procedure AssertErrorWorks()
    begin
        asserterror Error('expected %1', 7);
        if GetLastErrorText() <> 'expected 7' then
            Error('last error was %1', GetLastErrorText());
    end;

    [Test]
    procedure NestedFail()
    begin
        Helper(3);
    end;

    local procedure Helper(N: Integer)
    begin
        if N = 0 then
            Error('bottom reached');
        Helper(N - 1);
    end;
}
