namespace R198.Probe;

/// <summary>ONE row ('CURRENT'): what the group runner is doing right now, written from the
/// runner's triggers and Commit()ed so a SECOND session can read it while the group runs.
/// Also carries the run's configuration, because the platform instantiates the runner itself
/// (Codeunit.Run(TestRunnerId, Line)) and nothing can pass it parameters.</summary>
table 71541 "R198 Progress"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Key"; Code[20]) { }
        // configuration, written by the API before the run
        field(10; "Progress Mode"; Text[10]) { } // none | before | after | both
        field(11; "Stop On First Failure"; Boolean) { }
        field(12; "Runner Id"; Integer) { }
        // progress, written by the runner
        field(20; "Method Index"; Integer) { }
        field(21; "Method Name"; Text[128]) { }
        field(22; "Phase"; Text[20]) { } // before | after | idle
        field(23; "Session Id"; Integer) { }
        field(24; "Stamp"; DateTime) { }
        field(25; "Failures Seen"; Integer) { }
        field(26; "Trace"; Text[2048]) { } // appended per trigger call: 'B1 A1 B2 A2 ...'
    }

    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}
