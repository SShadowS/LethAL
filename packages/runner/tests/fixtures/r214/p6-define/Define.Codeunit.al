#define LOCALSYM
#undef DROPSYM
codeunit 50006 "P6 Define"
{
    procedure Run(X: Integer)
    begin
#if LOCALSYM
        Helper(X);
#endif
#if DROPSYM
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
