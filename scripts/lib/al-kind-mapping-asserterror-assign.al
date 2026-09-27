codeunit 50004 "Assert Assign Probe"
{
    procedure Check()
    var
        Outcome: Integer;
    begin
        asserterror Outcome := Compute(7);
        asserterror Compute(8);
        Outcome := Compute(9);
    end;

    local procedure Compute(Seed: Integer): Integer
    begin
        exit(Seed);
    end;
}
