namespace LethAL.Control;

/// <summary>1.0.0.31 (PR-478, amendment 4): the ids of client sessions that have marked their own end
/// (EndClientSession). The bind refuses any caller listed here, because the control app caches the active mutant
/// per session and an ended session must never run under a mutant again. Exact ids, not a "ids only grow" rule.
/// Emptied by TryForceResetLease (its contract requires an NST restart first, and session ids restart with it).</summary>
table 91017 "LC Ended Session"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same reasoning as "LC Client Attestation": the sessions run as the calling user.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Session Id"; Integer) { }
    }

    keys
    {
        key(PK; "Session Id") { Clustered = true; }
    }
}
