codeunit 50014 "P13 Else Tail"
{
    procedure Apply(Legacy: Boolean; var Total: Integer; var Extra: Integer)
    begin
#if not P13SYM
        if Legacy then begin
            Total := 1;
            Extra := 1;
        end else begin
#endif
            Total := 2;
            Extra := 2;
#if not P13SYM
        end;
#endif
    end;
}
