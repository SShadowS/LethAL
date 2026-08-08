// C2 — the REAL site shape from the census, on its own.
//
// Continia Document Output's two `InherentPermissions` occurrences are both on codeunits and both
// read `InherentPermissions = X;`, with no table clause. That is not a stylistic choice: measured
// 2026-08-08, `alc` REFUSES a table clause on this property outright —
// `error AL0776: The identifier 'tabledata' is not a valid permission value` — so
// `InherentPermissions` cannot say anything about a table at all. It takes bare permission letters
// about the object ITSELF.
//
// This arm is therefore the whole of what a `PermissionReduce` mutant could touch at a real site:
// `X` (execute) and nothing else, with no `Permissions` beside it.
codeunit 71521 "R83 Inherent Only Callee"
{
    InherentPermissions = X;

    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r83-inherent-only';
        Itm.Modify(false);
    end;
}
