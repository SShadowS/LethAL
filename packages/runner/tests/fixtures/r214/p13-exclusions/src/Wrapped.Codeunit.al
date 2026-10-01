#if not P13SYM
codeunit 50016 "P13 Wrapped"
{
    procedure AIf(A: Integer; B: Integer): Integer
    begin
        exit(A + B);
    end;
}
#endif
