codeunit 79600 "R402 Shape"
{
    procedure Loop()
    var
        A: Integer;
        B: Integer;
        C: Integer;
        Arr: array[20] of Integer;
    begin
        while A in [1, 2
#if LETHALX
            , B
#endif
            ]
        do begin
            A := A + 1;
            B := B + 1;
            C := C + 1;
        end;
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;

    local procedure Foo(P: Integer)
    begin
    end;
}
