codeunit 50761 "R766 Tests A"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure BumpA()
    var
        Counter: Codeunit "R766 Counter";
        n: Integer;
    begin
        n := Counter.Bump();
        if n <> 1 then
            Error('R766 count %1', n);
    end;
}
