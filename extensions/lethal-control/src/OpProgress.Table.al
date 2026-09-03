namespace LethAL.Control;

/// <summary>R198: where a run is INSIDE its op, written by the session running it and readable by
/// any other session (the R53 watchdog's status poll and stop hook run on a second connection,
/// and a SingleInstance variable is per session, MEASURED in `scripts/r198-group-runner-probe/`).
/// One row per op, keyed by the op's (attemptId, opSeq); never on the "LC Lease" row, whose
/// writers hold the lease lock and whose whole-record Modify from a stale copy RAISES (E10 of the
/// same probe). Written only through "LC Control State"'s Progress* procedures, each a fresh Get
/// or Insert, each ending in its own Commit, and each between test runs, which E3/E7 measured
/// carry nothing of a test's own writes.
///
/// "State" is what the per-method stop keys on: `TryStopHungRunAt` refuses unless the row reads
/// running for exactly the (index, token) the watchdog decided on, so a stop decided for method k
/// can never land on k+1. "Last Completed Index" is written the instant `RunAllTests` returns
/// (PROGRESS_BETWEEN_FIRST), which is what lets the client refuse a `timeout` for a method whose
/// completion was recorded before the session died (R204's narrowing).</summary>
table 91011 "LC Op Progress"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same reasoning as "LC Lease": the OData runner session runs as the calling user.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Attempt Id"; Text[64]) { }
        field(2; "Op Seq"; BigInteger) { }
        field(3; "Method Index"; Integer) { }
        field(4; "Method Codeunit Id"; Integer) { }
        field(5; "Method Name"; Text[128]) { }
        /// <summary>A fresh GUID per method, so a stop names one execution of one method and not
        /// merely an index that a retried op would reuse.</summary>
        field(6; "Method Token"; Text[40]) { }
        field(7; "Started At"; DateTime) { }
        field(8; "Last Completed Index"; Integer) { }
        field(9; "Session Id"; Integer) { }
        field(10; State; Option)
        {
            OptionMembers = running,between,done;
        }
    }

    keys
    {
        key(PK; "Attempt Id", "Op Seq") { Clustered = true; }
    }
}
