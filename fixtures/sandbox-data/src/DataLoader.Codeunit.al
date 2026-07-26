// A user-defined method sharing a builtin's name, TAKING AN ARGUMENT, with an observable side
// effect (spec §6).
//
// `Loader.SetLoadFields(3)` in `Data Ops` must never be claimed by a Tier-2 operator: the receiver
// resolves in source to a `Codeunit`, so rule 2 ("reject a receiver that resolves to a non-record
// in source") refuses it. The zero-argument `DataMain.SetLoadFields()` negative elsewhere does NOT
// cover this case — it would not catch a predicate that matches any same-named call with
// arguments.
codeunit 79304 "Data Loader"
{
    var
        LastFieldNo: Integer;

    procedure SetLoadFields(FieldNo: Integer)
    begin
        LastFieldNo := FieldNo;
    end;

    procedure LoadedFieldNo(): Integer
    begin
        exit(LastFieldNo);
    end;
}
