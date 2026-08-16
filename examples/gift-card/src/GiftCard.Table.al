table 90100 "Gift Card"
{
    Caption = 'Gift Card';
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20])
        {
            Caption = 'No.';
        }
        field(2; "Customer No."; Code[20])
        {
            Caption = 'Customer No.';

            trigger OnValidate()
            begin
                if "Customer No." = '' then
                    Error(CustomerRequiredErr);
            end;
        }
        field(3; "Initial Amount"; Decimal)
        {
            Caption = 'Initial Amount';
        }
        field(4; "Remaining Amount"; Decimal)
        {
            Caption = 'Remaining Amount';
        }
        field(5; Blocked; Boolean)
        {
            Caption = 'Blocked';
        }
        field(6; "Expiry Date"; Date)
        {
            Caption = 'Expiry Date';
        }
        field(7; "Issued Date"; Date)
        {
            Caption = 'Issued Date';
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
    }

    var
        CustomerRequiredErr: Label 'A gift card must belong to a customer.';

    trigger OnInsert()
    begin
        TestField("No.");
        "Issued Date" := WorkDate();
    end;
}
