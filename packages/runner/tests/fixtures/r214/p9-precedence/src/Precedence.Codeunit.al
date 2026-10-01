codeunit 50009 "P9 Precedence"
{
    procedure Run(X: Integer)
    begin
#if not UA and UB
        Helper(X);
#else
        Helper(X + 1);
#endif
#if UA or UB and UC
        Helper(X + 2);
#endif
#if TRUE
        Helper(X + 3);
#else
        Helper(X + 4);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
