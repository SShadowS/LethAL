table 79301 "Data No Trigger"
{
    DataClassification = CustomerContent;
    // Needed because a test that INSERTs fails on the fenced RunMutant path with "the current
    // permissions prevented the action" while passing everywhere else. NOT because that session
    // lacks rights — it runs as SUPER. Microsoft's own test framework strips them after the
    // session exists: Test Suite Mgt.RunAllTests -> codeunit 130454's PlatformBeforeTestRun ->
    // StartStopPermissionMock() -> Codeunit.Run(131006), whenever the Permissions Mock app is
    // installed. The dev-service path the frozen baseline uses never touches it. Measured 2026-07-26
    // (ROADMAP R1, scripts/probe-r1-permissions.ts) — a real customer table carries no such
    // declaration, which is why R1 is still open.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                if StrLen("No.") > 10 then
                    Error('No. too long');
            end;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}
