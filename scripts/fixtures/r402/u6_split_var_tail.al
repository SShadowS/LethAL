codeunit 79600 "R402 Shape"
{
    var
        G: Integer;
#if LETHALX
        H: Integer;

    procedure Extra()
    begin
        H := 1;
    end;
#endif

    procedure Loop()
    var
        A: Integer;
        B: Integer;
        C: Integer;
        Arr: array[20] of Integer;
    begin
        while A < 10 do begin
            A := A + 1;
            B := B + 1;
            C := C + 1;
            G := G + 1;
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
