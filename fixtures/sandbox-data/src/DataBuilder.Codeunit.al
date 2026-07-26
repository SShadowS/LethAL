// A user-defined `SetRange` on a NON-RECORD receiver, with TWO arguments (spec §6).
//
// `Builder.SetRange('A', 'Z')` in `Data Ops` passes `RemoveSetRange`'s own `hasValueArguments`
// guard — two arguments, statement position, matching name. The ONLY thing standing between it
// and a wrong claim is rule 2 (receiver resolves to a codeunit, not a record). That is why the
// no-value `SetRange(F)` negative is not sufficient on its own.
codeunit 79306 "Data Builder"
{
    var
        Width: Integer;

    procedure SetRange(FromCode: Code[10]; ToCode: Code[10])
    begin
        Width := StrLen(FromCode + ToCode);
    end;

    procedure RangeWidth(): Integer
    begin
        exit(Width);
    end;
}
