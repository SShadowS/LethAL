codeunit 79600 "R402 Shape"
{
    procedure Loop()
    var
        A: Integer;
        B: Integer;
        C: Integer;
        Arr: array[20] of Integer;
    begin
        if (A < 10)
#if LETHALX
            or false
#endif
        then
            Foo(A);
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;

    local procedure Foo(P: Integer)
    begin
    end;
}
