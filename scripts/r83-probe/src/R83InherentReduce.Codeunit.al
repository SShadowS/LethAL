// C3 — the MUTATED form of C2: the same object with the property deleted.
//
// This arm exists because of a grammar fact measured on the way here, and the fact matters more
// than the arm. On a CODEUNIT, `InherentPermissions` accepts ONLY `X`:
//
//     error AL0195: Invalid permission kind. Expected: 'X'      (on `InherentPermissions = R;`)
//     error AL0776: The identifier 'tabledata' is not a valid permission value
//
// So at a codeunit site there is nothing to WEAKEN — no smaller letter set, no table clause. The
// only edit a `PermissionReduce` operator could make is DELETION, and that is what C1 (for the
// `Permissions`-beside-`X` base) and this arm (for the bare-`X` base) measure.
codeunit 71522 "R83 None Callee"
{
    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r83-none';
        Itm.Modify(false);
    end;
}
