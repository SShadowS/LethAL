codeunit 50001 "R214 Probe"
{
#if CLEAN25
    procedure BehindDirective(A: Integer; B: Integer): Integer
    begin
        exit(A * B);
    end;
#else
    procedure BehindDirective(A: Integer; B: Integer): Integer
    begin
        exit(A - B);
    end;
#endif

    procedure StatementLevel(A: Integer)
    begin
#if CLEAN25
        Helper(A);
#else
        Helper(A + 1);
#endif
        Helper(A);
    end;

    local procedure Helper(A: Integer)
    begin
    end;
}
