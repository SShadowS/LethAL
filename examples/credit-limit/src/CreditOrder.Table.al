table 90202 "Credit Order"
{
    Caption = 'Credit Order';
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
        }
        field(3; Amount; Decimal)
        {
            Caption = 'Amount';
        }
        field(4; Status; Enum "Credit Order Status")
        {
            Caption = 'Status';
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
        key(Customer; "Customer No.", Status)
        {
            SumIndexFields = Amount;
        }
    }
}
