// Upstream #7854 (PR-16): a read of a system table under a permission set that does not grant it. Invented, no corpus
// source text. Under asserterror the error's text does not matter, only that the read is denied: BC denies a FindFirst
// without Read permission even when it finds no row (measured upstream on an ordinary table; inferred here for a system
// table), so each test is expected to pass.
table 51400 "U7854 Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

permissionset 51400 "U7854 No Grant"
{
    Assignable = true;
    Permissions = tabledata "U7854 Row" = R;
}

codeunit 51401 "U7854 Denied User"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record User;
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        PermissionsMock.Set('U7854 No Grant');
        asserterror if R.FindFirst() then;
    end;
}

codeunit 51402 "U7854 Denied Tenant Media"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Tenant Media";
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        PermissionsMock.Set('U7854 No Grant');
        asserterror if R.FindFirst() then;
    end;
}
