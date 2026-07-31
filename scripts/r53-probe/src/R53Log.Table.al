namespace R53.Probe;

table 71500 "R53 Probe Log"
{
    DataClassification = CustomerContent;
    fields
    {
        field(1; "Entry No."; Integer) { DataClassification = CustomerContent; }
        field(2; Marker; Text[50]) { DataClassification = CustomerContent; }
        field(3; Stamp; DateTime) { DataClassification = CustomerContent; }
        field(4; SessionId; Integer) { DataClassification = CustomerContent; }
    }
    keys { key(PK; "Entry No.") { Clustered = true; } }
}
