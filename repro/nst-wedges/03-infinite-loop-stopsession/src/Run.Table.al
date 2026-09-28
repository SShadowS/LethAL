namespace NstRepro03;

// One row (key 1) describing the latest loop run. Written and committed by StartLoop BEFORE the
// test starts, so a second session can find the looping session's id. Finished is written only if
// the loop ran out its own time bound, i.e. nothing stopped it.
table 91630 "NST Repro03 Run"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Key"; Integer) { }
        field(2; RunId; Text[50]) { }
        field(3; "Session ID"; Integer) { }
        field(4; MaxMs; Integer) { }
        field(5; Started; DateTime) { }
        field(6; Finished; DateTime) { }
    }

    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}
