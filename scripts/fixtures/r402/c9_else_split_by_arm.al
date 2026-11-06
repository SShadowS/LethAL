codeunit 79600 "R402 Shape"
{
    procedure Loop()
    var
        Flag: Boolean;
    begin
        if Flag then
            Bar()
#if LETHALX
        ;
#else
        else
            Foo(1);
#endif
    end;

    local procedure Bar()
    begin
    end;

    local procedure Foo(P: Integer)
    begin
    end;
}
