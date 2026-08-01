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
        field(6; "Artifact Id"; Text[64]) { }
        field(7; Nonce; Text[64]) { }
        // R69 Task 0a: the target artifact's own idRanges expression (e.g. "79000..79199"), the
        // same mandatory-not-optional filter RunMutantWithCoverage's own doc comment requires —
        // unfiltered, the Code Coverage table's FindSet does not return within 300s even for a
        // three-line fixture test, because it holds every line the whole Test Runner + Base App
        // machinery executed, not just the target.
        field(8; "Coverage Filter"; Text[250]) { }
    }

    keys
    {
        key(PK; "Line No.") { Clustered = true; }
    }
}
