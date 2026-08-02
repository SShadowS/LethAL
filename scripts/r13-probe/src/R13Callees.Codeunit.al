// R13 arm A8's three callees. Identical work, one variable: the `Permissions` property.
//
// The table is `Item` (Microsoft, 27) rather than a probe-owned table, deliberately. The mode
// under test is the one Continia Document Output's own tests use — `TestPermissions = Disabled`
// plus `LibraryLowerPermissions.SetO365Basic()` — and in that mode the session holds whatever
// rights O365 Basic carries on MICROSOFT tables. A table this probe invented would be outside
// every stock permission set, so all three arms would be refused for a reason that has nothing to
// do with the variable.

// The unmutated form: grants exactly what the write needs.
codeunit 71500 "R13 Grant Callee"
{
    Permissions = tabledata Item = rm;

    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r13-grant';
        Itm.Modify(false);
    end;
}
