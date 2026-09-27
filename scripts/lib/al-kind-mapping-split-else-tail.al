codeunit 50009 "Split Else Tail Probe"
{
    procedure Apply(Legacy: Boolean; var Total: Integer; var Extra: Integer)
    begin
#if not RETIRED
        if Legacy then begin
            Total := 1;
            Extra := 1;
        end else begin
#endif
            Total := 2;
            Extra := 2;
#if not RETIRED
        end;
#endif
    end;
}
