// R13 (Tier-3 operators) go/no-go probes. Two of `design.md`'s three sketched Tier-3 operators
// rest on a claim about BC that has never been measured here, and both are the kind of claim this
// project keeps paying for when it reasons instead of measuring.
//
// Same channel as the rest of this fixture: results travel out through `Error`, so the test shows
// as FAILED and its message is carried back verbatim by both the hub and the fenced path. A red
// test here is the transport, not a broken experiment.
//
// (1) `PermissionReduce` weakens an object's `Permissions` property. It can only ever kill a
//     mutant if that property can REFUSE something — i.e. if BC's permission model subtracts. R1
//     already measured that the fenced runner's user is SUPER and that a test declaring
//     `TestPermissions = Disabled` writes freely (real suites declare it: 77 of 77 codeunits in
//     Continia Document Output). What is NOT measured is whether a PRODUCTION object's own
//     reduced `Permissions` can refuse an operation anyway. Arms A1/A2/A3 settle that HERE, under
//     `TestPermissions = Disabled`; codeunit 79225 settles the restrictive case, which is the only
//     other one a real suite can be in.
//
// (2) `IsolationLevelSwap` deletes/weakens `LockTable()`. Its textbook kill mechanism needs a
//     second concurrent session, which the platform test runner refuses to give a test
//     (`StartSession` requires `TestIsolation = Disabled`). So the only reachable observable is a
//     SINGLE-session side effect of the lock, and R72 found the sharpest candidate: BC aborts the
//     whole transaction when `Codeunit.Run` is called with a write transaction open. If
//     `LockTable()` alone opens one, deleting it IS observable — but only through that platform
//     artifact, which says nothing about assertion quality. Arms M2a/M2b settle it A/B, because
//     R72's own abort message names no statement.
codeunit 79222 "Tier3 Probe"
{
    Subtype = Test;
    // R1: without this the Permissions Mock refuses every write and the probe measures its own
    // declaration instead of the platform. Codeunit 79225 deliberately OMITS it.
    TestPermissions = Disabled;

    // A1 — a production-shaped object whose OWN `Permissions` is reduced to read-only on the very
    // table it writes. This is exactly what a `PermissionReduce` mutant would produce. If BC's
    // model subtracts, this insert is refused and the operator has a kill. If it inserts, the
    // property cannot restrict and the mutant is unkillable by construction on this path.
    [Test]
    procedure ReducedPermissionsObjectInserts()
    var
        Reduced: Codeunit "Tier3 Perm Reduced";
        Probe: Record "Rec XRec Probe";
    begin
        if Probe.Get('T3A') then
            Probe.Delete(false);
        Reduced.InsertRow('T3A');
        Error('MEASURED arm=A1-reduced-permissions-object inserted=Yes');
    end;

    // A2 — the unmutated side: the same insert through an object that GRANTS what the write needs.
    [Test]
    procedure GrantingPermissionsObjectInserts()
    var
        Grant: Codeunit "Tier3 Perm Grant";
        Probe: Record "Rec XRec Probe";
    begin
        if Probe.Get('T3B') then
            Probe.Delete(false);
        Grant.InsertRow('T3B');
        Error('MEASURED arm=A2-granting-permissions-object inserted=Yes');
    end;

    // A3 — the bound: no `Permissions` property at all, which is what almost every AL object looks
    // like. If all three arms behave identically the property is inert on this path.
    [Test]
    procedure NoPermissionsPropertyInserts()
    var
        None: Codeunit "Tier3 Perm None";
        Probe: Record "Rec XRec Probe";
    begin
        if Probe.Get('T3C') then
            Probe.Delete(false);
        None.InsertRow('T3C');
        Error('MEASURED arm=A3-no-permissions-property inserted=Yes');
    end;

    // M2a — does `LockTable()` ALONE open a write transaction, so that a following `Codeunit.Run`
    // hits R72's platform abort? If it does, the test never reaches its own `Error` and dies with
    // BC's "An error occurred and the transaction is stopped." instead.
    [Test]
    procedure LockTableThenCodeunitRun()
    var
        Probe: Record "Rec XRec Probe";
        Ran: Boolean;
    begin
        Probe.LockTable();
        if Probe.FindFirst() then;
        Ran := Codeunit.Run(Codeunit::"Write Txn Target");
        Error('MEASURED arm=M2a-locktable-then-run ran=%1', Ran);
    end;

    // M2b — the control: the same read and the same call with no `LockTable()`, which is the shape
    // a `LockTable` DELETION leaves behind. R72 measured `Codeunit.Run` alone to be fine, but not
    // after a read and not in this codeunit, so it is re-measured rather than carried over.
    [Test]
    procedure ReadThenCodeunitRun()
    var
        Probe: Record "Rec XRec Probe";
        Ran: Boolean;
    begin
        if Probe.FindFirst() then;
        Ran := Codeunit.Run(Codeunit::"Write Txn Target");
        Error('MEASURED arm=M2b-read-then-run ran=%1', Ran);
    end;
}
