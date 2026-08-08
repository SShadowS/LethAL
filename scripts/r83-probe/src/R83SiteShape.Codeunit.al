// C4 — the shape the CENSUS actually found, measured rather than reasoned about.
//
// Continia Document Output's two `InherentPermissions` sites are both on codeunits and both read
// `InherentPermissions = X;` — no table clause at all. R83 records that footprint and explicitly
// does NOT record what it does. This arm is that site shape, doing the same write as every other
// arm, so "what would a `PermissionReduce` mutant at a REAL site change" has an answer taken from
// the platform instead of from the property's name.
//
// `X` is eXecute. The prediction on record before the run: no effect on a table write either way,
// because the letter names a right on the OBJECT rather than on any table. If that holds, mutating
// a real site cannot change a table operation's outcome, and the operator has nothing to kill at
// the only sites that exist.
codeunit 71523 "R83 Site Shape Callee"
{
    Permissions = tabledata Item = rm;
    InherentPermissions = X;

    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r83-site-shape';
        Itm.Modify(false);
    end;
}
