codeunit 50023 "T3 Dup Member"
{
#if RSYM
    procedure Sum(A: Integer; B: Integer): Integer
    begin
        exit(A + B);
    end;
#else
    procedure Sum(A: Text; B: Text): Text
    begin
        exit(A + B);
    end;
#endif
}
