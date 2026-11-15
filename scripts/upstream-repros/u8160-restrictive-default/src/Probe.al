// PR-33 (#8160): a test codeunit that does not declare TestPermissions, in an app that depends on Microsoft's Permissions Mock (so the
// mock is installed), writes to its own table before any permission set is applied. On BC the write is refused ("Sorry, the current
// permissions prevented the action. (TableData ... Insert: ...)"): the codeunit runs under its Restrictive default (measured on BC
// 28.4 with this app, 2026-11-15; al-runner 5a58a0f16 passes it). One codeunit per test.
// Invented; no corpus text.
table 51600 "URD Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 51601 "URD Default Insert"
{
    Subtype = Test;

    [Test]
    procedure InsertUnderRestrictiveDefault()
    var
        Row: Record "URD Row";
    begin
        Row.Code := 'A';
        Row.Insert();
    end;
}

codeunit 51602 "URD Disabled Insert"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure InsertWithTestPermissionsDisabled()
    var
        Row: Record "URD Row";
    begin
        // the control: the same write with test permissions disabled
        Row.Code := 'A';
        Row.Insert();
    end;
}
