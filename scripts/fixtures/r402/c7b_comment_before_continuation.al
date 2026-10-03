codeunit 79600 "R402 Shape"
{
    procedure Loop()
    var
        A: Integer;
        B: Integer;
        C: Integer;
        Arr: array[20] of Integer;
    begin
        repeat
            A := A + 1;
            B := B + 1;
        until (A > 10) // tail follows
#if LETHALX
            or (B > 5)
#endif
        ;
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;

    local procedure Foo(P: Integer)
    begin
    end;
}
