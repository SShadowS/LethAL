codeunit 79600 "R402 Shape"
{
    var
        Counter: Integer;

#if LETHALX
    procedure Step(): Integer
    begin
        Counter := Counter + 2;
        Bump();
        exit(Counter);
    end;
#else
    procedure Step(): Integer
    begin
        Counter := Counter + 1;
        Bump();
        exit(Counter);
    end;
#endif

    local procedure Bump()
    begin
        Counter := Counter + 10;
    end;
}
