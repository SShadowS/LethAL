codeunit 50021 "T1 Return Type"
{
#if RSYM
    procedure Pick(X: Integer): Integer
#else
    procedure Pick(X: Text): Text
#endif
    begin
        exit(X);
    end;
}
