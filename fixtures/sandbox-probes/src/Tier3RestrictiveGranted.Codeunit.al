// R13 arm A7, and a refinement of R1 rather than a Tier-3 question.
//
// R1 concluded: "a test codeunit that does not declare `TestPermissions = Disabled` cannot write,
// on any runner." That was measured on a test codeunit declaring no `Permissions` either. This arm
// declares the permissions the write needs, ON THE TEST CODEUNIT, and still omits
// `TestPermissions`. If it writes, R1's rule is really "…cannot write unless it declares the
// permissions", which is a materially different thing to tell a user whose suite is refused.
codeunit 79226 "Tier3 Restrictive Granted"
{
    Subtype = Test;
    Permissions = tabledata 79201 = rimd;

    [Test]
    procedure GrantedRestrictiveTestWrites()
    var
        Probe: Record "Rec XRec Probe";
    begin
        Probe.Init();
        Probe."No." := 'T3G';
        Probe.Amount := 1;
        Probe.Insert(false);
        Error('MEASURED arm=A7-restrictive-test-with-own-permissions inserted=Yes');
    end;
}
