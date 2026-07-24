namespace LethAL.Control;

/// <summary>The single machine-global lease row. DataPerCompany=false: one row, keyed by a
/// constant primary key. Owned by LethAL Control so a target republish cannot reset it. Seeded
/// once at install/upgrade with a fresh Server Generation, which recovery logic (later tasks)
/// uses to detect a restarted service instance.</summary>
table 71006 "LC Lease"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // The OData runner session runs under the calling user (5C-A spike finding). Inherent data
    // permissions let the control state read/write this table regardless of assigned permission sets.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Primary Key"; Code[10]) { }
        field(2; Owner; Text[100]) { }
        field(3; "Server Generation"; Text[32]) { }
        field(4; Epoch; Integer) { }
        field(5; Token; Text[32]) { }
        field(6; "Expires At"; DateTime) { }
        field(7; "Client Nonce"; Text[64]) { }
        field(8; "Op Kind"; Option)
        {
            OptionMembers = none,publish,run;
        }
        field(9; "Op Attempt Id"; Text[64]) { }
        field(10; "Op Started At"; DateTime) { }
        field(11; "Op Seq"; BigInteger) { }
        field(12; "Last Completed Op Seq"; BigInteger) { }
    }

    keys
    {
        key(PK; "Primary Key") { Clustered = true; }
    }
}
