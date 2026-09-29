codeunit 79600 "Symbol Logic"
{
    procedure Rate(X: Integer): Integer
    var
        ForA: Integer;
        ForB: Integer;
        ForNone: Integer;
    begin
        ForA := 10;
        ForB := 100;
        ForNone := 1;
#if LETHALA
        exit(X + ForA);
#elif LETHALB
        exit(X + ForB);
#else
        exit(X + ForNone);
#endif
    end;
}
