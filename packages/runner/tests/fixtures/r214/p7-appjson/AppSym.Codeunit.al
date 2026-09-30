codeunit 50007 "P7 AppSym"
{
    procedure Run(X: Integer)
    begin
#if APPSYM
        Helper(X);
#else
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
