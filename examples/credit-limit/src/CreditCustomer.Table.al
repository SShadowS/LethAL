table 90200 "Credit Customer"
{
    Caption = 'Credit Customer';
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20])
        {
            Caption = 'No.';
        }
        field(2; "Credit Limit"; Decimal)
        {
            Caption = 'Credit Limit';
        }
        field(3; Balance; Decimal)
        {
            Caption = 'Balance';
            FieldClass = FlowField;
            CalcFormula = sum("Credit Ledger Entry".Amount where("Customer No." = field("No.")));
            Editable = false;
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
    }

    trigger OnInsert()
    begin
        TestField("No.");
    end;
}
