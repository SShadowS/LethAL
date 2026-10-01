codeunit 50003 "R306 Probe"
{
    procedure Compute(X: Integer): Integer
    var
        R: Integer;
    begin
        R := X;
#if not SYM
        R := R + 1;
#endif
        R := R * 2;
        exit(R);
    end;
}
