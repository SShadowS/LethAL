codeunit 50652 "Probe Coverage"
{
    Subtype = Test;

    [Test]
    procedure CoversPair()
    var
        A: Codeunit "Probe Pair A";
        B: Codeunit "Probe Pair B";
    begin
        if A.First(1) <> 1 then
            Error('First(1)');
        if B.Second(7) <> 2 then
            Error('Second(7)');
    end;

    [Test]
    procedure CoversOnlyA()
    var
        A: Codeunit "Probe Pair A";
    begin
        if A.First(0) <> 0 then
            Error('First(0)');
    end;
}
