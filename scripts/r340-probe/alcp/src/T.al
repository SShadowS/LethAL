table 92800 "PT"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Z; Text[30])
        {
            trigger OnValidate()
            var
                Q, Z: Integer;
            begin
                TakeInts(Q, Z); // POS table field trigger
                Message('%1', Z + Z);
            end;
        }
    }
    keys { key(PK; "No.") { Clustered = true; } }
    var
        GQ, GZ: Integer;
    trigger OnInsert()
    var
        Q, Z: Integer;
    begin
        TakeInts(Q, Z); // POS table trigger
        Message('%1', Z + Z);
    end;
    procedure TakeInts(A: Integer; B: Integer) begin end;
}
