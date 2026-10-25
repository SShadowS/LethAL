codeunit 50762 "R766 Tests B"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure BumpB()
    var
        Counter: Codeunit "R766 Counter";
        n: Integer;
    begin
        n := Counter.Bump();
        if n <> 1 then
            Error('R766 count %1', n);
    end;
}
