table 79601 "R402 Tab"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal) { }
        field(3; N; Integer) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    var
        Counter: Integer;

#if not LETHALX
    trigger OnModify()
    begin
        Counter := 0;
        "No." := 'Z';
    end;

    procedure Validate(A: Integer; B: Integer)
    begin
        Counter := A + B;
    end;

    procedure SetIt(V: Decimal; Amount: Decimal)
    begin
        Validate(Amount, V);
        Rec.Validate(Amount, V);
        SetRange("No.", 'A');
        Modify(true);
        Counter := Counter + 1;
    end;
#endif

    procedure SetDirect(V: Decimal)
    begin
        Rec.Validate(Amount, V);
        Modify(true);
    end;
}

codeunit 79602 "R402 Shape"
{
    procedure Pick()
    var
        R: Record "R402 Tab";
        X: Integer;
    begin
        X := 1;
        R.Validate(N, 5);
#if not LETHALX
        R.Validate(X, 5);
#endif
        R.Modify(true);
        R.Modify();
        R.SetRange("No.", 'A');
    end;
}
