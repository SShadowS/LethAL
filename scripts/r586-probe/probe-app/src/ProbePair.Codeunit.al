// Two objects in one file (the R383 / R407 shape): line numbers of the SECOND object are what
// the coverage probe checks.
codeunit 50601 "Probe Pair A"
{
    procedure First(X: Integer): Integer
    begin
        if X > 0 then
            exit(1);
        exit(0);
    end;
}

codeunit 50602 "Probe Pair B"
{
    procedure Second(X: Integer): Integer
    var
        Y: Integer;
    begin
        Y := X * 2;
        if Y > 10 then
            exit(2);
        exit(3);
    end;
}
