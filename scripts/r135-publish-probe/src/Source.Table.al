table 71540 "R135 Source"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer) { DataClassification = CustomerContent; }
        field(2; "Main No."; Code[20]) { DataClassification = CustomerContent; }
        field(3; "Category"; Code[10]) { DataClassification = CustomerContent; }
        field(4; "Amount"; Decimal) { DataClassification = CustomerContent; }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
