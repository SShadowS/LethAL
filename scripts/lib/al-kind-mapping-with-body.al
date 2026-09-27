codeunit 50003 "With Body Probe"
{
    procedure Tag(var Bin: Record "Integer")
    begin
        with Bin do
            Stamp(Number);
        if Bin.Number > 0 then
            with Bin do
                Stamp(Number);
    end;

    local procedure Stamp(Value: Integer)
    begin
    end;
}
