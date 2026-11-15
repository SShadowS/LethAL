// Upstream #8158 (PR-31). Invented repro, no corpus source text. A read of the Session table (2000000009) under a Permissions Mock set that
// grants it Read, in a session without a client (run with --no-client). Measured on BC 28.4 W1 (2026-11-15) in a web-service
// session (LethAL's bcdev path, test runner 130454 over OData): IsEmpty and FindFirst both FAIL with "The Active Session does
// not exist. Identification fields and values: Server Instance ID=...,Session ID=...", granted or not. So under asserterror
// each test is expected to pass. Not measured: the same read without Permissions Mock, or in a client session.
permissionset 51630 "Session Grant Read"
{
    Assignable = true;
    Permissions = tabledata "Session" = R;
}

codeunit 51631 "Session IsEmpty Granted"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Session";
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        PermissionsMock.Set('Session Grant Read');
        asserterror if R.IsEmpty() then;
    end;
}

codeunit 51632 "Session FindFirst Granted"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Session";
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        PermissionsMock.Set('Session Grant Read');
        asserterror if R.FindFirst() then;
    end;
}
