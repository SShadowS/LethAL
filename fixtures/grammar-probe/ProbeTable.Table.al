table 50100 "Probe Table"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                TestField("No.");
                if Rec."No." <> xRec."No." then
                    Rec.Amount := 0;
            end;
        }
        field(2; Amount; Decimal) { }
        field(3; Total; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = sum("Probe Line".Amount where("No." = field("No.")));
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    fieldgroups
    {
        fieldgroup(DropDown; "No.", Amount) { }
    }

    var
        ExistingGlobal: Integer;

    trigger OnInsert()
    begin
        Rec.CalcFields(Total);
        Commit();
    end;

    trigger OnModify()
    var
        Other: Record "Probe Table";
    begin
        Other.SetLoadFields(Amount);
        Other.SetRange("No.", Rec."No.");
        if Other.FindSet() then
            Other.Modify(true);
    end;
}
