namespace LethAL.SandboxWrapped.Tests;

using LethAL.SandboxWrapped;
using LethAL.SandboxWrapped.Pre;

codeunit 78950 "Wrapped Tests"
{
    Subtype = Test;
    // R550: BandYRun writes the plain table 78915. Without this, the RunMutant path runs a test codeunit
    // under restrictive test permissions and refuses the insert (measured on Cronus28, R-550 diag.md);
    // sandbox-data-tests declares it for the same measured reason, and a real BC suite declares it.
    TestPermissions = Disabled;

    var
        WrappedTop: Codeunit "Wrapped Top";
        WrappedTopTwin: Codeunit "Wrapped Top Twin";
        WrappedPre: Codeunit "Wrapped Pre";
        WrappedPreTwin: Codeunit "Wrapped Pre Twin";
        WrappedPair: Codeunit "Wrapped Pair";
        WrappedArms: Codeunit "Wrapped Arms";

    [Test]
    procedure GrowTop()
    begin
        if WrappedTop.Grow(20) <> 21 then
            Error('Grow(20) must be 21');
    end;

    [Test]
    procedure TwiceTop()
    begin
        if WrappedTop.Twice(3) <> 6 then
            Error('Twice(3) must be 6');
    end;

    [Test]
    procedure GrowTopTwin()
    begin
        if WrappedTopTwin.Grow(20) <> 21 then
            Error('Grow(20) must be 21');
    end;

    [Test]
    procedure TwiceTopTwin()
    begin
        if WrappedTopTwin.Twice(3) <> 6 then
            Error('Twice(3) must be 6');
    end;

    [Test]
    procedure GrowPre()
    begin
        if WrappedPre.Grow(20) <> 21 then
            Error('Grow(20) must be 21');
    end;

    [Test]
    procedure TwicePre()
    begin
        if WrappedPre.Twice(3) <> 6 then
            Error('Twice(3) must be 6');
    end;

    [Test]
    procedure GrowPreTwin()
    begin
        if WrappedPreTwin.Grow(20) <> 21 then
            Error('Grow(20) must be 21');
    end;

    [Test]
    procedure TwicePreTwin()
    begin
        if WrappedPreTwin.Twice(3) <> 6 then
            Error('Twice(3) must be 6');
    end;

    [Test]
    procedure PairPick()
    begin
        if WrappedPair.Pick(5) <> 1 then
            Error('Pick(5) must be 1');
    end;

    [Test]
    procedure ArmsPick()
    begin
        if WrappedArms.Pick(5) <> 1 then
            Error('Pick(5) must be 1');
    end;

    // R536: the wrapped table's field trigger and procedure, and the wrapped page's procedure
    // (called on a page variable, never opened), each against its unwrapped twin. Nothing is
    // inserted.
    [Test]
    procedure ClampTrigger()
    var
        Item: Record "Wrapped Trigger";
    begin
        Item.Validate(Qty, -5);
        if Item.Qty <> 0 then
            Error('Validate(Qty, -5) must clamp to 0');
    end;

    [Test]
    procedure ClampTriggerTwin()
    var
        Item: Record "Wrapped Trigger Twin";
    begin
        Item.Validate(Qty, -5);
        if Item.Qty <> 0 then
            Error('Validate(Qty, -5) must clamp to 0');
    end;

    [Test]
    procedure DoubledTrigger()
    var
        Item: Record "Wrapped Trigger";
    begin
        Item.Qty := 4;
        if Item.Doubled() <> 8 then
            Error('Doubled() of 4 must be 8');
    end;

    [Test]
    procedure DoubledTriggerTwin()
    var
        Item: Record "Wrapped Trigger Twin";
    begin
        Item.Qty := 4;
        if Item.Doubled() <> 8 then
            Error('Doubled() of 4 must be 8');
    end;

    [Test]
    procedure LabelView()
    var
        View: Page "Wrapped View";
    begin
        if View.Label(7) <> 'big' then
            Error('Label(7) must be big');
    end;

    [Test]
    procedure LabelViewTwin()
    var
        View: Page "Wrapped View Twin";
    begin
        if View.Label(7) <> 'big' then
            Error('Label(7) must be big');
    end;

    // R545: the wrapped page EXTENSION's procedure, called on a variable of the extended page
    // (never opened), and its unwrapped twin.
    [Test]
    procedure ScaledXtra()
    var
        View: Page "Wrapped View";
    begin
        if View.Scaled(4) <> 40 then
            Error('Scaled(4) must be 40');
    end;

    [Test]
    procedure ScaledXtraTwin()
    var
        View: Page "Wrapped View Twin";
    begin
        if View.Scaled(4) <> 40 then
            Error('Scaled(4) must be 40');
    end;

    // R550: the wrapped REPORT, reached on an un-run report variable (BandYDirect) and by running it
    // with no request page over four seeded rows (BandYRun: Band(1..4) = 1+1+2+2 = 6), and its
    // unwrapped twin. Each run test deletes its own rows first, so no backend's rollback matters.
    [Test]
    procedure BandYDirect()
    var
        Rep: Report "Wrapped Y Band";
    begin
        if Rep.Band(3) <> 2 then
            Error('Band(3) should be 2, got %1', Rep.Band(3));
        if Rep.Band(2) <> 1 then
            Error('Band(2) should be 1, got %1', Rep.Band(2));
    end;

    [Test]
    procedure BandYDirectTwin()
    var
        Rep: Report "Wrapped Y Band Twin";
    begin
        if Rep.Band(3) <> 2 then
            Error('Band(3) should be 2, got %1', Rep.Band(3));
        if Rep.Band(2) <> 1 then
            Error('Band(2) should be 1, got %1', Rep.Band(2));
    end;

    [Test]
    procedure BandYRun()
    var
        Rep: Report "Wrapped Y Band";
    begin
        SeedBandRows('BAND');
        Rep.UseRequestPage(false);
        Rep.RunModal();
        if Rep.GetTotal() <> 6 then
            Error('band total should be 6, got %1', Rep.GetTotal());
    end;

    [Test]
    procedure BandYRunTwin()
    var
        Rep: Report "Wrapped Y Band Twin";
    begin
        SeedBandRows('BANDTWIN');
        Rep.UseRequestPage(false);
        Rep.RunModal();
        if Rep.GetTotal() <> 6 then
            Error('band total should be 6, got %1', Rep.GetTotal());
    end;

    local procedure SeedBandRows(BandCode: Code[20])
    var
        Row: Record "Wrapped Band Row";
        I: Integer;
    begin
        Row.SetRange("Band Code", BandCode);
        Row.DeleteAll();
        for I := 1 to 4 do begin
            Row.Init();
            Row."Band Code" := BandCode;
            Row.Entry := I;
            Row.Qty := I;
            Row.Insert();
        end;
    end;
}
