namespace R198.Probe;

/// <summary>The row a test method inserts under a FIXED key and asserts nothing about. If the
/// next method can still see it, isolation did not roll it back (the tables fixture's arm K
/// shape: a duplicate primary key with nothing asserted becomes a kill).</summary>
table 71540 "R198 Probe Row"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Key"; Code[20]) { }
        field(2; "Written By"; Text[128]) { }
        field(3; "Session Id"; Integer) { }
    }

    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}
