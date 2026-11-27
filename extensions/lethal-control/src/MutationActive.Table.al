namespace LethAL.Control;

/// <summary>The single active-mutant tuple. DataPerCompany=false: one row, keyed by a
/// constant primary key. Owned by LethAL Control so a target republish cannot reset it.</summary>
table 91000 "LC Mutation Active"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // The OData runner session runs under the calling user (5C-A spike finding). Inherent data
    // permissions let the control state read/write this table regardless of assigned permission sets.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Primary Key"; Code[10]) { }
        field(2; "Target App Id"; Text[40]) { }
        field(3; "Artifact Id"; Text[32]) { }
        field(4; "Mutant Id"; Text[64]) { }
        // 1.0.0.30 (R1170, PR-462; measured by PR-314's probe): bumped by every write of the tuple, so a session
        // that cached it can tell the row moved without reading the whole tuple each time.
        field(5; Generation; BigInteger) { }
    }

    keys
    {
        key(PK; "Primary Key") { Clustered = true; }
    }
}
