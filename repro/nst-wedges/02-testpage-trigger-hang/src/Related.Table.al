namespace NstRepro02;

// No triggers. Written by the page extension's OnOpenPage; the source of the FlowField; and the
// source table of the code-free control page.
table 91611 "NST Repro02 Related"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Entry No."; Integer) { AutoIncrement = true; }
        field(2; "Main No."; Code[20]) { }
        field(3; Amount; Decimal) { }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
