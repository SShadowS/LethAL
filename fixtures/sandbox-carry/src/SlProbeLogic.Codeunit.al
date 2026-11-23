codeunit 71761 "SL Probe Logic"
{
    // The flag changes the answer: doubled while the mode is on.
    procedure Compute(X: Integer): Integer
    var
        State: Codeunit "SL Probe State";
    begin
        if State.IsSet() then
            exit(X * 2);
        exit(X);
    end;
}
