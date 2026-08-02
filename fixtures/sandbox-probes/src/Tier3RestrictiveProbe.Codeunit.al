// R13, the other half of the `PermissionReduce` question: the RESTRICTIVE case.
//
// This codeunit deliberately OMITS `TestPermissions = Disabled`, so it defaults to Restrictive —
// the mode R1 measured as "cannot write, on any runner". The three arms below ask the question R1
// never had to: under Restrictive, does the CALLED OBJECT's own `Permissions` property decide the
// outcome? If the granting object inserts and the reduced one is refused, then a `PermissionReduce`
// mutant IS killable — but only inside a suite that does not declare `TestPermissions = Disabled`,
// which no real suite here does (Continia Document Output: 77 of 77 declare it).
//
// If all three are refused identically, the property is inert in BOTH modes and the operator has
// no kill mechanism anywhere on this path.
codeunit 79225 "Tier3 Restrictive Probe"
{
    Subtype = Test;

    // A4 — reduced grant, restrictive test.
    [Test]
    procedure ReducedUnderRestrictive()
    var
        Reduced: Codeunit "Tier3 Perm Reduced";
    begin
        Reduced.InsertRow('T3D');
        Error('MEASURED arm=A4-reduced-under-restrictive inserted=Yes');
    end;

    // A5 — full grant, restrictive test. The discriminator: this is the only arm that can show an
    // object's `Permissions` property doing any work at all.
    [Test]
    procedure GrantUnderRestrictive()
    var
        Grant: Codeunit "Tier3 Perm Grant";
    begin
        Grant.InsertRow('T3E');
        Error('MEASURED arm=A5-grant-under-restrictive inserted=Yes');
    end;

    // A6 — no property, restrictive test. The floor.
    [Test]
    procedure NoPropertyUnderRestrictive()
    var
        None: Codeunit "Tier3 Perm None";
    begin
        None.InsertRow('T3F');
        Error('MEASURED arm=A6-no-property-under-restrictive inserted=Yes');
    end;
}
