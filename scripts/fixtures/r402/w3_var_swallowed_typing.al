codeunit 79600 "R402 Shape"
{
    var
        X: Integer;
        Y: Integer;

#if not LETHALX
    procedure Pick(X: Integer; Y: Text)
    begin
        Show(X, Y);
    end;

    procedure Foo(T: Text): Text
    begin
        exit(T);
    end;
#endif

    procedure Foo(N: Integer): Integer
    begin
        exit(N);
    end;

    procedure Show(A: Integer; B: Text)
    begin
        X := A;
    end;

    procedure UseFoo(): Text
    begin
#if not LETHALX
        exit(Foo('x') + Foo('y'));
#else
        exit(Format(X + Y));
#endif
    end;
}
