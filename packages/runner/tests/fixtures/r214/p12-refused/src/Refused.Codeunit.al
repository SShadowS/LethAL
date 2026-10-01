codeunit 50012 "P12 Refused"
{
    procedure Run(X: Integer)
    begin
/*
#if R12SYM
*/
        Helper(X + 1);
/*
#endif
*/
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
