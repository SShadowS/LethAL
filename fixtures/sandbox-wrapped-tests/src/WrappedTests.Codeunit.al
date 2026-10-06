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
}
