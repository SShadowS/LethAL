codeunit 91903 "R300b M1 P Before"
{
    procedure Hit(): Integer
    var
        X: Integer;
    begin
        X := 9201;
        // gap
        // gap
        // gap
        X += 1;
        // gap
        // gap
        // gap
        exit(X);
    end;
}
#if PROBESYM
codeunit 91904 "R300b M1 Q Wrapped"
{
    procedure QIfHit(): Integer
    var
        X: Integer;
    begin
        X := 9301;
        // gap
        // gap
        // gap
        X += 1;
        // gap
        // gap
        // gap
        exit(X);
    end;

    procedure QIfMiss(): Integer
    begin
        exit(9309);
    end;
}
#else
codeunit 91904 "R300b M1 Q Wrapped"
{
    procedure QElseHit(): Integer
    begin
        exit(9351);
    end;
    // inactive arm: 9 lines
    // (padding)
}
#endif
codeunit 91905 "R300b M1 R After"
{
    procedure Hit(): Integer
    var
        X: Integer;
    begin
        X := 9401;
        // gap
        // gap
        // gap
        X += 1;
        // gap
        // gap
        // gap
        exit(X);
    end;

    procedure Miss(): Integer
    begin
        exit(9409);
    end;
}
