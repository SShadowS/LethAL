codeunit 79600 "R402 Shape"
{
    var
        Total: Integer;
#if not LETHALX
        Extra: Integer;
#else
        Extra: Decimal;
#endif

    procedure Q(): Integer
    begin
        Extra := 0;
        while Extra < 5 do
            Extra := Extra + 1;
        exit(Total);
    end;
}
