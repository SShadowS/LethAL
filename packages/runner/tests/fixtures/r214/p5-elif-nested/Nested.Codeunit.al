codeunit 50005 "P5 Nested"
{
    procedure Pick(X: Integer): Integer
    var
        R: Integer;
    begin
        R := X;
#if A
        Helper(R);
#if B
        R := R + 10;
#else
        R := R + 20;
#endif
#elif B
        Helper(R + 1);
#else
        Helper(R + 2);
        R := R * 3;
#endif
        exit(R);
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
