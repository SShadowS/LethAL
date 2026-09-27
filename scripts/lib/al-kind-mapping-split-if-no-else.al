codeunit 50008 "Split If No Else Probe"
{
    procedure Apply(Legacy: Boolean; Total: Integer)
    begin
#if not RETIRED
        if Legacy then
#endif
            Notify(Total);
    end;

    local procedure Notify(Value: Integer)
    begin
    end;
}
