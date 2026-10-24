codeunit 93840 "R740 Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    var
        Lib: Codeunit "R740 Lib";
        Logic: Codeunit "R740 Logic";

    [Test]
    procedure TestLib()
    var
        X: Integer;
    begin
        X := Lib.Helper();
        if Logic.Scale(X) <> 4 then
            Error('scale');
    end;

    [Test]
    procedure TestPlus()
    begin
        if Logic.Plus(1) <> 2 then
            Error('plus');
    end;

    [Test]
    procedure TestFails()
    begin
        Error('genuine failure');
    end;
}
