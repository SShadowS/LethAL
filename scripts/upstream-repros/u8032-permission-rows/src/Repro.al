// Upstream #8032 (PR-16): a read of the Permission table under a set that grants it Read. Invented, no corpus source
// text. al-runner refuses it because Permissions Mock's 'All Objects' set grants `table * = X`, a whole object type it
// does not list row by row (the Metadata Permission shape #8032 names, met here through Permission). On BC the read
// returns, so the test is expected to pass.
table 51420 "U8032 Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

permissionset 51420 "U8032 Grant Perm"
{
    Assignable = true;
    Permissions = tabledata "U8032 Row" = R,
                  tabledata Permission = R;
}

codeunit 51421 "U8032 Read Permission"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record Permission;
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        PermissionsMock.Set('U8032 Grant Perm');
        if R.FindFirst() then;
    end;
}
