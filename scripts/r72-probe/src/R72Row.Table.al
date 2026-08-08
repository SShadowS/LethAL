// The probe's own write target. Owned by the probe so no arm can be confused by another app's
// triggers, and so the write is unambiguously a write on a table this session can lock.
table 71540 "R72 Row"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer) { DataClassification = CustomerContent; }
        field(2; Flagged; Boolean) { DataClassification = CustomerContent; }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
