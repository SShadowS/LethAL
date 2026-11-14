permissionset 50410 "REPRO WILDCARD"
{
    Assignable = true;
    Permissions = table * = X;
}

codeunit 50411 "Wildcard Permission Tests"
{
    Subtype = Test;

    [Test]
    procedure ReadOwnWildcardSet()
    var
        MetadataPermission: Record "Metadata Permission";
    begin
        MetadataPermission.SetRange("Role ID", 'REPRO WILDCARD');
        if MetadataPermission.IsEmpty() then
            Error('no Metadata Permission rows for the set');
    end;

    [Test]
    procedure ReadAllRows()
    var
        MetadataPermission: Record "Metadata Permission";
        N: Integer;
    begin
        // no filter: every set's rows, the platform's own sets included
        if MetadataPermission.FindSet() then
            repeat
                N += 1;
            until MetadataPermission.Next() = 0;
        if N = 0 then
            Error('no Metadata Permission rows at all');
    end;
}
