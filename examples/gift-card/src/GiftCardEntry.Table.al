table 90101 "Gift Card Entry"
{
    Caption = 'Gift Card Entry';
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer)
        {
            Caption = 'Entry No.';
            AutoIncrement = true;
        }
        field(2; "Gift Card No."; Code[20])
        {
            Caption = 'Gift Card No.';
        }
        field(3; "Customer No."; Code[20])
        {
            Caption = 'Customer No.';
        }
        field(4; "Entry Type"; Enum "Gift Card Entry Type")
        {
            Caption = 'Entry Type';
        }
        field(5; Amount; Decimal)
        {
            Caption = 'Amount';
        }
        field(6; "Posting Date"; Date)
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
        key(Card; "Gift Card No.")
        {
            SumIndexFields = Amount;
        }
    }
}
