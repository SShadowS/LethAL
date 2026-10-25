codeunit 93891 "R689 Plain Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure TestIncPlain()
    var
        Logic: Codeunit "R689 Logic";
    begin
        if Logic.Inc(2) <> 3 then
            Error('inc');
    end;
}
