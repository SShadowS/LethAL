codeunit 50015 "P13 Split Block"
{
    procedure P(C: Boolean; var X: Integer)
    begin
#if not P13SYM
        if C then begin
#endif
            X := 1;
            Helper();
#if not P13SYM
        end;
#endif
    end;

    local procedure Helper()
    begin
    end;
}
