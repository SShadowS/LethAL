namespace LethAL.Control;

/// <summary>R69: the work-queue for the in-session batch loop (codeunit 71013). Seeded over OData
/// via "LC Control API".SeedBatchItem before the client drives "LC Batch Runner" (page 71014) over
/// the client-services WebSocket. DataPerCompany=false: one shared queue, not per-company state.</summary>
table 71011 "LC Batch Queue"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same rationale as "LC Mutation Active": the OData runner session runs under the calling user
    // (5C-A spike finding), so inherent data permissions let the control state read/write this table
    // regardless of assigned permission sets.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Line No."; Integer) { }
        field(2; "Codeunit ID"; Integer) { }
        field(3; Method; Text[128]) { }
        field(4; "Mutant Id"; Text[64]) { }
        field(5; "Target App Id"; Text[40]) { }
    }

    keys
    {
        key(PK; "Line No.") { Clustered = true; }
    }
}
