codeunit 50008 "P8 Slot"
{
    procedure Run(X: Integer)
    begin
        if X > 0 then
#if SLOTSYM
            Helper(X)
#else
            Helper(X + 1)
#endif
        ;
        Helper(X + 2);
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
