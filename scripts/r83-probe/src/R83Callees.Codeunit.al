// R83's four callees, each writing the SAME row through the SAME statement. Only the permission
// properties differ, so any difference in outcome is the properties.
//
// The question R83 asks is whether `InherentPermissions` can REFUSE an operation that would
// otherwise be allowed. R13 measured that `Permissions` cannot: it is purely ADDITIVE, granting
// indirect rights to code executing in the object (arm A5: BC's demand moves from `Insert` to
// `IndirectInsert`). `InherentPermissions` is a DIFFERENT property and R13's decision explicitly
// does not cover it, so nothing here may be inferred from that result.
//
// The mode is the one R13 found `Permissions` load-bearing in: `TestPermissions = Disabled` plus
// `LibraryLowerPermissions.SetO365Basic()`, which is what Continia Document Output's own tests do.
// Under SUPER every arm would succeed and the probe would measure nothing.

// C1 — the GRANT control, identical to R13's A8-grant. Reproduced here rather than cited so the
// comparison arms below sit in the same run, on the same container, in the same session.
codeunit 71520 "R83 Grant Callee"
{
    Permissions = tabledata Item = rm;

    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r83-grant';
        Itm.Modify(false);
    end;
}
