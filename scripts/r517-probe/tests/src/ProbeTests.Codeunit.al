codeunit 79620 "R517 Probe Tests"
{
    Subtype = Test;

    [Test]
    procedure ShortA()
    var
        Logic: Codeunit "R517 Probe Logic";
    begin
        if Logic.Twice(21) <> 42 then
            Error('Twice(21) should be 42');
    end;

    [Test]
    procedure LongSpin()
    var
        Logic: Codeunit "R517 Probe Logic";
    begin
        // A body of about 70 s: past al-runner's 60 s default, inside any LethAL budget >= 140 s.
        if Logic.SpinFor(70000) < 70000 then
            Error('SpinFor returned early');
    end;

    [Test]
    procedure ShortB()
    var
        Logic: Codeunit "R517 Probe Logic";
    begin
        if Logic.Twice(5) <> 10 then
            Error('Twice(5) should be 10');
    end;
}
