namespace LethAL.Control;

/// <summary>1.0.0.31 (PR-478, B3): one row per test method a CLIENT session ran inside a `client-run` op,
/// written by "LC Client Subscribers" from Test Runner - Mgt's OnAfterTestMethodRun and read by the client. It
/// attests what the session LOADED (never what the tuple table holds now), so a stale artifact or a missed
/// activation shows. DataPerCompany=false: the OData reader and the client session may run in different
/// companies. Keyed by the op (attempt id, op seq) and the method.</summary>
table 91014 "LC Client Attestation"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same reasoning as "LC Lease": the sessions run as the calling user.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Attempt Id"; Text[64]) { }
        field(2; "Op Seq"; BigInteger) { }
        field(3; "Codeunit Id"; Integer) { }
        field(4; Method; Text[128]) { }
        /// <summary>False when the session never loaded the tuple (no guard was reached since the session began).
        /// Accepted only when nothing was observed.</summary>
        field(5; Loaded; Boolean) { }
        /// <summary>The "LC Mutation Active" Generation the session had cached.</summary>
        field(6; "Loaded Generation"; BigInteger) { }
        /// <summary>The mutant id the session had cached.</summary>
        field(7; "Loaded Mutant Id"; Text[64]) { }
        field(8; "Observed Any"; Boolean) { }
        field(9; "Observed Identity Mismatch"; Boolean) { }
        field(10; "Observed Active"; Boolean) { }
        /// <summary>The method's own IsSuccess, as Test Runner - Mgt reported it.</summary>
        field(11; Success; Boolean) { }
        field(12; "Test Method Runs"; Integer) { }
        field(13; "Session Id"; Integer) { }
        /// <summary>The lease's Server Generation and Database Id at write time: Generation restarts at 0 on a
        /// reset in-memory database, so the pair tells a new database from an old one (R969).</summary>
        field(14; "Server Generation"; Text[32]) { }
        field(15; "Database Id"; Text[32]) { }
    }

    keys
    {
        key(PK; "Attempt Id", "Op Seq", "Codeunit Id", Method) { Clustered = true; }
    }
}
