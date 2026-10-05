namespace R472.Probe;

// No OnInsert on purpose: the only thing an Insert can trip on here is the platform itself.
table 91720 "R472 Probe Row"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Integer) { DataClassification = CustomerContent; }
        field(2; Tag; Text[30]) { DataClassification = CustomerContent; }
    }
    keys { key(PK; "No.") { Clustered = true; } }
}
