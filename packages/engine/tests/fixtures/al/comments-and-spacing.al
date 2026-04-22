codeunit 50101 "Spacing Test"
{
    // Leading comment on procedure
    procedure Check(Amount:  Decimal): Boolean
    var
        Result: Boolean; // trailing comment
    begin
        // inside-block comment
        Result := Amount > 0;     // align on column
        exit(Result);
    end;
}
