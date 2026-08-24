table 90201 "Credit Ledger Entry"
{
    Caption = 'Credit Ledger Entry';
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer)
        {
            Caption = 'Entry No.';
            AutoIncrement = true;
        }
        field(2; "Customer No."; Code[20])
        {
            Caption = 'Customer No.';
        }
        field(3; Amount; Decimal)
        {
            Caption = 'Amount';
        }
        field(4; "Posting Date"; Date)
        {
            Caption = 'Posting Date';
        }
    }

    keys
    {
        key(PK; "Entry No.")
        {
            Clustered = true;
        }
        key(Customer; "Customer No.")
        {
            SumIndexFields = Amount;
        }
    }
}
