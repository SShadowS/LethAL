namespace LethAL.Control;

/// <summary>The single machine-global lease row. DataPerCompany=false: one row, keyed by a
/// constant primary key. Owned by LethAL Control so a target republish cannot reset it. Seeded
/// once at install/upgrade with a fresh Server Generation, which recovery logic (later tasks)
/// uses to detect a restarted service instance.</summary>
table 91006 "LC Lease"
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
        /// <summary>R53: the BC session id executing the ACTIVE run marker, recorded by phase 1's
        /// fresh claim and committed before phase 2 can hang.
        ///
        /// This exists because a watchdog cannot discover it any other way. MEASURED (Cronus281,
        /// `scripts/r53-probe/`): a web-service session cannot see itself in `Active Session`
        /// (2000000110), and the rows it can see carry ids of the opposite sign — so the session
        /// about to run a mutant has to write its own `SessionId()` down first, and that committed
        /// row survives the kill.
        ///
        /// 0 means NO RECORDED SESSION, and every reader must refuse on `&lt;= 0` rather than pass it
        /// to StopSession. AL Integer defaults to 0, so a marker written before this field existed
        /// is indistinguishable from a recorded 0 — and MEASURED: StopSession(0) returns without
        /// throwing, exactly like a successful stop. A reader that trusted it would be confirming
        /// nothing.</summary>
        field(13; "Op Session Id"; Integer) { }
        /// <summary>R198/R203: which op the LAST successful stop (TryStopHungRun or TryStopHungRunAt)
        /// tombstoned, as the PAIR. Two dedicated fields rather than the residual "Op Attempt Id"/
        /// "Op Seq", because a SUCCESSFUL TryFinishRun and TryRecoverOp leave those residues in a
        /// state byte-identical to a stop's; and the pair rather than either half, because attempt
        /// ids restart at a1 per client process and only (attemptId, opSeq) is never reused. Read
        /// by TryFinishRun to answer `op-stopped` for a run that outran its own stop, so the client
        /// records an error instead of latching a lease loss nobody caused. Cleared by
        /// TryForceResetLease with the other op fields.</summary>
        field(14; "Stopped Op Attempt Id"; Text[64]) { }
        field(15; "Stopped Op Seq"; BigInteger) { }
    }

    keys
    {
        key(PK; "Primary Key") { Clustered = true; }
    }
}
