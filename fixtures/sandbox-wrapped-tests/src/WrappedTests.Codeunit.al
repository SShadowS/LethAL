namespace LethAL.SandboxWrapped.Tests;

using LethAL.SandboxWrapped;
using LethAL.SandboxWrapped.Pre;

codeunit 78950 "Wrapped Tests"
{
    Subtype = Test;

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
}
