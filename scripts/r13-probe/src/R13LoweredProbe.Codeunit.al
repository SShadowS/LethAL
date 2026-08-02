// R13 arm A8/A9 — the mode the first seven arms did not cover, named by an adversarial review of
// the R13 decision spec.
//
// Arms A1–A7 (fixtures/sandbox-probes) covered two modes: `TestPermissions = Disabled` (property
// inert) and Restrictive (everything refused). The review found a THIRD, and found it in the very
// project the census ran on: `U:/Git/do-rel2/Test/Src/E-Seal/CDOESealSetupTests.Codeunit.al`
// declares `TestPermissions = Disabled` — so it is inside the "77 of 77 declare it" evidence — and
// then calls `LibraryLowerPermissions.SetO365Basic()` in its own `Initialize()`. From that point
// permission checks are ON and the session is NOT SUPER while production code runs, which is
// exactly where an object's `Permissions` property is load-bearing (arm A5 already showed the
// property changes which right BC demands).
//
// If A8-grant succeeds while A8-reduced is refused, a `PermissionReduce` mutant is KILLABLE in a
// mode real suites use, and the decision spec's "unkillable in both of the two modes" is false.
//
// Results travel out through `Error` as everywhere else in this repo's probes: the test showing
// FAILED is the transport, not a broken experiment.
codeunit 71504 "R13 Lowered Probe"
{
    Subtype = Test;
    TestPermissions = Disabled;

    var
        LibraryLowerPermissions: Codeunit "Library - Lower Permissions";
        ItemNoTok: Label 'R13PROBE', Locked = true;

    // Seeds the row while still SUPER. Every arm calls this BEFORE lowering, so a failure after
    // lowering can only be about the write, never about the row not existing.
    local procedure SeedItem()
    var
        Itm: Record Item;
    begin
        if Itm.Get(ItemNoTok) then
            exit;
        Itm.Init();
        Itm."No." := ItemNoTok;
        Itm.Insert(false);
    end;

    // A8-grant — the unmutated side. The callee grants exactly what the write needs.
    [Test]
    procedure GrantCalleeUnderLoweredSession()
    var
        Grant: Codeunit "R13 Grant Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Grant.Touch(ItemNoTok);
        Error('MEASURED arm=A8-grant-under-lowered-session modified=Yes');
    end;

    // A8-reduced — the `PermissionReduce` mutant. THE decisive arm.
    [Test]
    procedure ReducedCalleeUnderLoweredSession()
    var
        Reduced: Codeunit "R13 Reduced Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Reduced.Touch(ItemNoTok);
        Error('MEASURED arm=A8-reduced-under-lowered-session modified=Yes');
    end;

    // A8-none — the floor: no property at all.
    [Test]
    procedure NoneCalleeUnderLoweredSession()
    var
        None: Codeunit "R13 None Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        None.Touch(ItemNoTok);
        Error('MEASURED arm=A8-none-under-lowered-session modified=Yes');
    end;

    // A8-control — does the lowered session write DIRECTLY from the test body? If it does, the
    // lowering did not take effect and every other arm above is measuring nothing. This is the
    // R26 mistake (a probe measuring itself) written as an arm instead of assumed away.
    [Test]
    procedure DirectWriteUnderLoweredSession()
    var
        Itm: Record Item;
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Itm.Get(ItemNoTok);
        Itm.Description := 'r13-direct';
        Itm.Modify(false);
        Error('MEASURED arm=A8-direct-write-under-lowered-session modified=Yes');
    end;

    // A9 — does a CALLER's grant cover a callee's write? Decides which cost bar applies.
    [Test]
    procedure CallerGrantCoversCalleeWrite()
    var
        Shadow: Codeunit "R13 Shadow Caller";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Shadow.TouchViaReducedCallee(ItemNoTok);
        Error('MEASURED arm=A9-caller-grant-covers-callee-write modified=Yes');
    end;
}
