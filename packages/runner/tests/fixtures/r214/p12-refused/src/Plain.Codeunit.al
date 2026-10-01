codeunit 50013 "P12 Plain"
{
    procedure Run(X: Integer)
    begin
#if R12SYM
        Helper(X);
#else
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
