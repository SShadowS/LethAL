#if not PROBESYM
codeunit 91902 "R300b E1 TwoArm"
{
    procedure AIfHit(): Integer
    begin
        exit(9101);
    end;
    // inactive arm: 9 lines
    // (padding)
}
#else
codeunit 91902 "R300b E1 TwoArm"
{
    procedure AElseHit(): Integer
    var
        X: Integer;
    begin
        X := 9151;
        // gap
        // gap
        // gap
        X += 1;
        // gap
#if PROBESYM
        // inner directive block, active
#endif
        exit(X);
    end;

    procedure AElseMiss(): Integer
    begin
        exit(9159);
    end;
}
#endif
