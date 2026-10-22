codeunit 50654 "Probe Permissions"
{
    Subtype = Test;
    TestPermissions = Restricted;

    [Test]
    procedure RestrictedInsert()
    var
        Logic: Codeunit "Probe Logic";
    begin
        Logic.InsertRow('R1', 1);
    end;
}
