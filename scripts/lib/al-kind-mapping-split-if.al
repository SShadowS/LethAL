codeunit 50005 "Split If Probe"
{
    procedure Apply(Legacy: Boolean; var Total: Integer)
    begin
#if not RETIRED
        if Legacy then
            Notify(Total)
        else
#endif
            Notify(Total + 1);
#if not RETIRED
        if Legacy then
            Total := 1
        else
#endif
            Total := 2;
    end;

    local procedure Notify(Value: Integer)
    begin
    end;
}
