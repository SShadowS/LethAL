// R83 — is `InherentPermissions` a better `PermissionReduce` target than `Permissions`?
//
// R13 measured that `Permissions` is purely ADDITIVE: reducing it is observable only in a session
// that already lacks the right, which is why a `PermissionReduce` kill needs the rare
// permission-lowering test. `InherentPermissions` is a DIFFERENT property and R13's decision
// explicitly does not cover it. R83 records the FOOTPRINT (2 sites on Continia Document Output,
// both codeunits, both `= X`) and states plainly that the SEMANTICS are unmeasured — that "it
// constrains rather than grants" comes from reading the compiler's option list, not from a run.
//
// This is that run, and it has two independent halves because the property means two different
// things depending on where it sits.
//
// C-ARMS (codeunit, Item, LOWERED session). The mode R13 found `Permissions` load-bearing in:
// `TestPermissions = Disabled` plus `LibraryLowerPermissions.SetO365Basic()`, which is what
// Continia Document Output's own tests do. Under SUPER every C arm would succeed and measure
// nothing.
//
// D-ARMS (probe-owned tables, SUPER session). This is R83's question in its literal form: can the
// property REFUSE something a SUPER session would otherwise be allowed? Deliberately NOT lowered —
// a probe-owned table sits outside every stock permission set, so under `SetO365Basic()` all three
// would be refused for a reason that has nothing to do with the variable under test (R13's own
// design note, learned the same way).
//
// The three D tables are identical except for the declaration, and the three-way comparison is
// what makes the answer unambiguous:
//   D0 (no property) succeeds + D1 (`R`) refused  -> the property CONSTRAINS
//   D0 refused + D2 (`RIMD`) succeeds + D1 refused -> purely ADDITIVE, same as `Permissions`
//   D0 and D1 both succeed                         -> inert in this session
//
// Results travel out through `Error` as everywhere else in this repo's probes: a FAILED test is
// the transport, not a broken experiment.
codeunit 71524 "R83 Probe"
{
    Subtype = Test;
    TestPermissions = Disabled;

    var
        LibraryLowerPermissions: Codeunit "Library - Lower Permissions";
        ItemNoTok: Label 'R83PROBE', Locked = true;
        RowKeyTok: Label 'R83ROW', Locked = true;

    // Seeds the row while still SUPER, so a failure after lowering can only be about the write.
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

    // C0 — THE CONTROL, and it is not optional. If the lowered session writes directly, the
    // lowering did not take and every C arm below is measuring nothing. That is R26's mistake (a
    // probe measuring its own declaration instead of the platform) written as an arm.
    [Test]
    procedure DirectWriteUnderLoweredSession()
    var
        Itm: Record Item;
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Itm.Get(ItemNoTok);
        Itm.Description := 'r83-direct';
        Itm.Modify(false);
        Error('MEASURED arm=C0-direct modified=Yes (CONTROL FAILED: the lowering did not take)');
    end;

    // C1 — the grant control. Known-succeeding under R13; reproduced so the arms below have a
    // comparator from the same run rather than from a citation.
    [Test]
    procedure GrantCalleeUnderLoweredSession()
    var
        Grant: Codeunit "R83 Grant Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Grant.Touch(ItemNoTok);
        Error('MEASURED arm=C1-permissions-grant modified=Yes');
    end;

    // C2 — the census's real site shape on its own: `InherentPermissions = X` and nothing else.
    [Test]
    procedure InherentOnlyUnderLoweredSession()
    var
        Inherent: Codeunit "R83 Inherent Only Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Inherent.Touch(ItemNoTok);
        Error('MEASURED arm=C2-inherent-only-X modified=Yes');
    end;

    // C3 — C2 with the property DELETED, which is the only edit a `PermissionReduce` operator can
    // make at a codeunit site (measured: `InherentPermissions` accepts only `X` there). If C2 and
    // C3 agree, the mutation is a no-op on this operation.
    [Test]
    procedure NoneCalleeUnderLoweredSession()
    var
        None: Codeunit "R83 None Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        None.Touch(ItemNoTok);
        Error('MEASURED arm=C3-no-property modified=Yes');
    end;

    // C4 — the exact mutation base at a real site: a grant beside `InherentPermissions = X`. C1 is
    // its MUTATED form (the same grant with the property deleted), so C1 vs C4 is the operator's
    // whole effect at a site that also carries a `Permissions` grant.
    [Test]
    procedure SiteShapeUnderLoweredSession()
    var
        Site: Codeunit "R83 Site Shape Callee";
    begin
        SeedItem();
        LibraryLowerPermissions.SetO365Basic();
        Site.Touch(ItemNoTok);
        Error('MEASURED arm=C4-grant-plus-X modified=Yes');
    end;

    // D0 — no property. The floor: what this session can do to a probe-owned table with nothing
    // declared at all.
    [Test]
    procedure OpenTableInsert()
    var
        R: Record "R83 Open Table";
    begin
        if R.Get(RowKeyTok) then
            R.Delete(false);
        R.Init();
        R."Key" := RowKeyTok;
        R.Insert(false);
        Error('MEASURED arm=D0-no-property inserted=Yes');
    end;

    // D1 — THE DECISIVE TABLE ARM. `R` alone: read, and no insert.
    [Test]
    procedure ReadOnlyTableInsert()
    var
        R: Record "R83 ReadOnly Table";
    begin
        if R.Get(RowKeyTok) then
            R.Delete(false);
        R.Init();
        R."Key" := RowKeyTok;
        R.Insert(false);
        Error('MEASURED arm=D1-inherent-R inserted=Yes');
    end;

    // D2 — `RIMD`, the shape `LethAL Control`'s own tables carry to work around the calling-user
    // gap (see MutationActive.Table.al). Present so a refusal at D0 can be told apart from a
    // refusal everywhere.
    [Test]
    procedure FullTableInsert()
    var
        R: Record "R83 Full Table";
    begin
        if R.Get(RowKeyTok) then
            R.Delete(false);
        R.Init();
        R."Key" := RowKeyTok;
        R.Insert(false);
        Error('MEASURED arm=D2-inherent-RIMD inserted=Yes');
    end;
}
