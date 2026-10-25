codeunit 93890 "R689 Throwing Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    trigger OnRun()
    begin
        Error('R689 onrun boom 93890');
    end;

    [Test]
    procedure TestIncThrowing()
    var
        Logic: Codeunit "R689 Logic";
    begin
        if Logic.Inc(1) <> 2 then
            Error('inc');
    end;
}
