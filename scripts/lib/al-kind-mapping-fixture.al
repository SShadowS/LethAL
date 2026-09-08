codeunit 50000 "Mapping Fixture"
{
    procedure Exercise(A: Integer; B: Integer; F: Boolean; G: Boolean): Integer
    var
        Cust: Record Customer;
        R: Integer;
    begin
        // comparison: 6
        if A > B then R := 1;
        if A < B then R := 2;
        if A >= B then R := 3;
        if A <= B then R := 4;
        if A = B then R := 5;
        if A <> B then R := 6;

        // additive: 2
        R := A + B;
        R := A - B;

        // multiplicative: 4
        R := A * B;
        R := A / B;
        R := A DIV B;
        R := A MOD B;

        // logical: 2
        if F and G then R := 7;
        if F or G then R := 8;

        // unary: 2
        if not F then R := 9;
        R := -A;

        // call: 2
        Helper();
        Cust.Get();

        exit(R);
    end;

    procedure Helper()
    begin
    end;
}
