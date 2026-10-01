codeunit 50004 "R306b Probe"
{
    procedure Compute(X: Integer): Integer
    var
        R: Integer;
    begin
        R := X;
#if not SYM
        Helper(R);
        R := R + 1;
#else
        R := R + 2;
#endif
        R := R * 2;
        exit(R);
    end;

    local procedure Helper(A: Integer)
    begin
    end;
}
